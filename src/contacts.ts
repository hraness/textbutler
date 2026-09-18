import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json.ts";
import {
  CONTACTS_SCHEMA_VERSION,
  type AddressBookContact,
  type AddressBookSourceIdentity,
  type ContactHandle,
  type ContactsSnapshot,
} from "./types.ts";
import { isolateContactsSource } from "./sqlite-snapshot.ts";

export const DEFAULT_CONTACTS_DIRECTORY = join(
  homedir(),
  "Library",
  "Application Support",
  "AddressBook",
);

const DATABASE_NAME = /^AddressBook-v[1-9][0-9]*\.abcddb$/u;
const MAX_SOURCE_DATABASES = 64;
const MAX_SOURCE_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SHM_BYTES = 64 * 1024 * 1024;
const MAX_CONTACTS = 100_000;
const MAX_METHOD_ROWS = 500_000;
const MAX_TABLES = 512;
const MAX_COLUMNS_PER_TABLE = 512;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_LABEL_BYTES = 4_096;
const MAX_HANDLE_BYTES = 4_096;
const MAX_TOTAL_TEXT_BYTES = 128 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 5_000;
const MAX_PAGE_SIZE = 20_000;
const SNAPSHOT_ATTEMPTS = 5;

type Binding = string | number | bigint | Uint8Array | null;
type Row = Record<string, unknown>;

export type SourceFile = Readonly<{
  key: string;
  path: string;
  stats: BigIntStats;
}>;

type SnapshotMember = Readonly<{
  suffix: "" | "-wal" | "-journal";
  path: string;
  stats: BigIntStats;
}>;

export type IsolatedSource = Readonly<{
  source: SourceFile;
  path: string;
  temporaryDirectory: string;
}>;

type ContactRow = Readonly<{
  primaryKey: number;
  identifier: string;
  privateLabel: string | null;
  privateLabelBasis: AddressBookContact["privateLabelBasis"];
}>;

type ContactRowsRead = Readonly<{
  rows: readonly ContactRow[];
  textBytes: number;
}>;

export type NormalizedContactHandle = Readonly<{
  kind: "email" | "phone";
  normalizedValue: string;
}>;

type StoreRead = Readonly<{
  contacts: readonly AddressBookContact[];
  source: AddressBookSourceIdentity;
  invalidEmails: number;
  invalidPhones: number;
  withoutHandles: number;
  methodRows: number;
  textBytes: number;
}>;

export type ReadContactsOptions = Readonly<{
  hmacKey: string | Uint8Array;
  maxDatabaseBytes?: number;
  maxContacts?: number;
  pageSize?: number;
}>;

function fail(message: string): never {
  throw new Error(`Contacts source ${message}`);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function keyBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16 || bytes.byteLength > 1_024) {
    throw new Error("Contacts HMAC key must contain 16 through 1024 bytes");
  }
  return Uint8Array.from(bytes);
}

function hmac(key: Uint8Array, namespace: string, value: string): string {
  return createHmac("sha256", key)
    .update(`message-like-me\0${namespace}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function owned(stats: BigIntStats): boolean {
  return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function optionalStats(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function inspectDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) return fail(`${label} path must be absolute`);
  const requested = resolve(path);
  const before = lstatSync(requested, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || before.nlink < 1n || !owned(before)) {
    return fail(`${label} must be a current-user-owned physical directory`);
  }
  const physical = realpathSync(requested);
  const after = lstatSync(physical, { bigint: true });
  if (!sameFile(before, after)) return fail(`${label} changed identity while resolving`);
  return physical;
}

function inspectDatabase(path: string, key: string, maximumBytes: number): SourceFile {
  if (!isAbsolute(path)) return fail("database path must be absolute");
  const requested = resolve(path);
  const before = lstatSync(requested, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || !owned(before)
    || before.size < 1n
    || before.size > BigInt(maximumBytes)
  ) {
    return fail("database must be one current-user-owned regular non-symlink file within the configured size bound");
  }
  const physical = realpathSync(requested);
  const after = lstatSync(physical, { bigint: true });
  if (!sameFile(before, after)) return fail("database changed identity while resolving");
  return Object.freeze({ key, path: physical, stats: after });
}

function databaseInDirectory(
  directory: string,
  key: string,
  maximumBytes: number,
): SourceFile | null {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => DATABASE_NAME.test(entry.name));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) return fail("one source store contains multiple AddressBook databases");
  const name = candidates[0]?.name;
  if (name === undefined) return fail("one source store has no database name");
  return inspectDatabase(join(directory, name), key, maximumBytes);
}

function databasesInSources(
  sourcesPath: string,
  maximumBytes: number,
): SourceFile[] {
  const sources = inspectDirectory(sourcesPath, "Sources");
  const result: SourceFile[] = [];
  for (const entry of readdirSync(sources, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
    if (entry.isSymbolicLink()) return fail("Sources must not contain symbolic-link stores");
    if (!entry.isDirectory()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.name)) {
      return fail("source store directory name is invalid");
    }
    const storeDirectory = inspectDirectory(join(sources, entry.name), "source store");
    const source = databaseInDirectory(storeDirectory, entry.name, maximumBytes);
    if (source !== null) result.push(source);
  }
  return result;
}

function discoverDatabases(path: string, maximumBytes: number): readonly SourceFile[] {
  if (!isAbsolute(path)) return fail("AddressBook path must be absolute");
  const requested = resolve(path);
  const identity = lstatSync(requested, { bigint: true });
  let result: SourceFile[];
  if (identity.isFile() || identity.isSymbolicLink()) {
    if (!DATABASE_NAME.test(basename(requested))) {
      return fail("explicit database must be named AddressBook-vN.abcddb");
    }
    result = [inspectDatabase(requested, basename(dirname(requested)), maximumBytes)];
  } else {
    const directory = inspectDirectory(requested, "AddressBook root");
    if (basename(directory) === "Sources") {
      result = databasesInSources(directory, maximumBytes);
    } else {
      const sourcesStats = optionalStats(join(directory, "Sources"));
      result = sourcesStats === null ? [] : databasesInSources(join(directory, "Sources"), maximumBytes);
      if (result.length === 0) {
        const direct = databaseInDirectory(directory, basename(directory), maximumBytes);
        result = direct === null ? [] : [direct];
      }
    }
  }
  result.sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  if (result.length < 1) return fail("contains no supported AddressBook database");
  if (result.length > MAX_SOURCE_DATABASES) return fail("contains too many AddressBook databases");
  const total = result.reduce((bytes, source) => bytes + source.stats.size, 0n);
  if (total > BigInt(MAX_TOTAL_SOURCE_BYTES)) return fail("databases exceed the aggregate source size bound");
  return Object.freeze(result);
}

function validateSidecar(path: string, stats: BigIntStats, maximumBytes: number): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1n
    || !owned(stats)
    || stats.size < 0n
    || stats.size > BigInt(maximumBytes)
  ) return fail(`sidecar ${basename(path)} is not a bounded current-user-owned physical file`);
}

function snapshotMembers(source: SourceFile, maximumBytes: number): readonly SnapshotMember[] {
  const current = inspectDatabase(source.path, source.key, maximumBytes);
  if (!sameFile(source.stats, current.stats)) return fail("database changed identity before isolation");
  const members: SnapshotMember[] = [{ suffix: "", path: source.path, stats: current.stats }];
  for (const suffix of ["-wal", "-journal"] as const) {
    const sidecarPath = `${source.path}${suffix}`;
    const stats = optionalStats(sidecarPath);
    if (stats === null) continue;
    validateSidecar(sidecarPath, stats, maximumBytes);
    members.push({ suffix, path: sidecarPath, stats });
  }
  const shmPath = `${source.path}-shm`;
  const shm = optionalStats(shmPath);
  if (shm !== null) validateSidecar(shmPath, shm, MAX_SHM_BYTES);
  const total = members.reduce((bytes, member) => bytes + member.stats.size, 0n);
  if (total > BigInt(maximumBytes) * 2n) return fail("database and sidecars exceed the snapshot bound");
  return Object.freeze(members);
}

function sameMembers(left: readonly SnapshotMember[], right: readonly SnapshotMember[]): boolean {
  return left.length === right.length && left.every((member, index) => {
    const other = right[index];
    return other !== undefined
      && member.suffix === other.suffix
      && sameFile(member.stats, other.stats)
      && member.stats.size === other.stats.size
      && member.stats.mtimeNs === other.stats.mtimeNs
      && member.stats.ctimeNs === other.stats.ctimeNs;
  });
}

export function isolateSource(source: SourceFile, maximumBytes: number): IsolatedSource {
  const temporaryRoot = tmpdir();
  if (!isAbsolute(temporaryRoot)) return fail("requires an absolute temporary directory");
  const temporaryDirectory = mkdtempSync(join(temporaryRoot, "message-like-me-contacts-"));
  chmodSync(temporaryDirectory, 0o700);
  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = snapshotMembers(source, maximumBytes);
      const attemptDirectory = join(temporaryDirectory, `attempt-${attempt}`);
      mkdirSync(attemptDirectory, { mode: 0o700 });
      let raced = false;
      try {
        for (const member of before) {
          const destination = join(attemptDirectory, `${basename(source.path)}${member.suffix}`);
          copyFileSync(
            member.path,
            destination,
            fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
          );
          chmodSync(destination, 0o600);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESTALE") raced = true;
        else throw error;
      }
      const after = snapshotMembers(source, maximumBytes);
      if (!raced && sameMembers(before, after)) {
        return Object.freeze({
          source: Object.freeze({ ...source, stats: before[0]!.stats }),
          path: join(attemptDirectory, basename(source.path)),
          temporaryDirectory,
        });
      }
      rmSync(attemptDirectory, { recursive: true, force: true });
    }
    return fail(`changed during ${SNAPSHOT_ATTEMPTS} snapshot attempts`);
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function allRows<T extends Row>(database: Database, sql: string, ...bindings: Binding[]): T[] {
  return database.query(sql).all(...bindings) as T[];
}

function getRow<T extends Row>(database: Database, sql: string, ...bindings: Binding[]): T | null {
  return database.query(sql).get(...bindings) as T | null;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail(`${label} must be an integer`);
  return value;
}

function flag(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result !== 0 && result !== 1) return fail(`${label} must be zero or one`);
  return result;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return fail(`${label} must be bounded text`);
  return value;
}

function privateLabel(parts: readonly unknown[]): Readonly<{
  value: string | null;
  basis: AddressBookContact["privateLabelBasis"];
}> {
  const clean = parts.map((value) => {
    if (value === null) return null;
    if (typeof value !== "string") return fail("contact name field must be text or null");
    const normalized = value.normalize("NFKC").trim();
    if (normalized === "") return null;
    if (/\p{Cc}/u.test(normalized) || Buffer.byteLength(normalized, "utf8") > MAX_LABEL_BYTES) {
      return fail("contact label exceeds its text bound");
    }
    return normalized;
  });
  const display = clean[0];
  if (display !== null && display !== undefined) return { value: display, basis: "display-name" };
  const personal = clean.slice(1, 4).filter((value): value is string => value !== null).join(" ");
  if (personal !== "") return { value: personal, basis: "name-parts" };
  const organization = clean[4] ?? null;
  return { value: organization, basis: organization === null ? null : "organization" };
}

export function normalizeContactLabelQuery(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (
    normalized.length < 1
    || /\p{Cc}/u.test(normalized)
    || Buffer.byteLength(normalized, "utf8") > MAX_LABEL_BYTES
  ) return fail("private label query must be bounded text");
  return normalized;
}

function normalizeEmail(value: string): string | null {
  if (
    value.length > 254
    || !/^[\x21-\x7e]+$/u.test(value)
    || value.includes("\u0000")
  ) return null;
  const separator = value.indexOf("@");
  if (separator < 1 || separator !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
  ) return null;
  const labels = domain.split(".");
  if (
    domain.length > 253
    || labels.length < 2
    || labels.some((label) => label.length < 1
      || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))
  ) return null;
  return value.toLocaleLowerCase("en-US");
}

export function normalizeContactHandle(value: string): NormalizedContactHandle | null {
  const trimmed = value.trim();
  const email = normalizeEmail(trimmed);
  if (email !== null) {
    return Object.freeze({
      kind: "email",
      normalizedValue: email,
    });
  }
  const text = trimmed.normalize("NFKC");
  if (text === "" || /\p{Cc}/u.test(text) || Buffer.byteLength(text, "utf8") > MAX_HANDLE_BYTES) {
    return null;
  }
  const extension = text.match(/(?:\s*(?:ext\.?|extension|x|#)\s*\d{1,12})$/iu);
  const number = text.startsWith("+") ? text.slice(1) : text;
  if (extension !== null || !/^[0-9().\-\s]+$/u.test(number)) return null;
  const international = text.startsWith("+") || text.startsWith("00");
  const digits = text.replaceAll(/[^0-9]/gu, "");
  const canonicalDigits = text.startsWith("00") ? digits.slice(2) : digits;
  if (canonicalDigits.length < 7 || canonicalDigits.length > 15) return null;
  return Object.freeze({
    kind: "phone",
    normalizedValue: international ? `+${canonicalDigits}` : canonicalDigits,
  });
}

export function contactHandleMatchId(
  hmacKey: string | Uint8Array,
  handle: NormalizedContactHandle,
): string {
  return hmac(keyBytes(hmacKey), "contact-handle", `${handle.kind}\0${handle.normalizedValue}`);
}

function tableNames(database: Database): ReadonlySet<string> {
  const rows = allRows<{ name: string }>(
    database,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  if (rows.length > MAX_TABLES) return fail("schema contains too many tables");
  return new Set(rows.map((row) => boundedText(row.name, "table name", 256)));
}

function tableColumns(database: Database, table: string): readonly string[] {
  const rows = allRows<{ name: string }>(
    database,
    "SELECT name FROM pragma_table_info(?) ORDER BY cid",
    table,
  );
  if (rows.length > MAX_COLUMNS_PER_TABLE) return fail(`${table} contains too many columns`);
  return rows.map((row) => boundedText(row.name, `${table} column name`, 256));
}

function requireColumns(
  database: Database,
  table: string,
  required: readonly string[],
): ReadonlySet<string> {
  const columns = new Set(tableColumns(database, table));
  for (const column of required) {
    if (!columns.has(column)) return fail(`${table} is missing required column ${column}`);
  }
  return columns;
}

function boundedColumn(
  columns: ReadonlySet<string>,
  column: string,
  alias: string,
  maximumBytes: number,
): string {
  if (!columns.has(column)) return `NULL AS ${alias}, 0 AS ${alias}_over_bound`;
  return `CASE WHEN ${column} IS NULL OR length(CAST(${column} AS BLOB)) <= ${maximumBytes}
      THEN ${column} ELSE NULL END AS ${alias},
    CASE WHEN ${column} IS NOT NULL AND length(CAST(${column} AS BLOB)) > ${maximumBytes}
      THEN 1 ELSE 0 END AS ${alias}_over_bound`;
}

function countRows(database: Database, table: string, maximum: number): number {
  const count = integer(
    getRow<{ value: number }>(database, `SELECT count(*) AS value FROM ${table}`)?.value,
    `${table} row count`,
  );
  if (count < 0 || count > maximum) return fail(`${table} exceeds its row bound`);
  return count;
}

function contactEntityIds(
  database: Database,
  columns: ReadonlySet<string>,
): readonly number[] {
  const rows = allRows<{ Z_ENT: number; Z_NAME: string; Z_SUPER: number | null }>(database, `
    SELECT Z_ENT,Z_NAME,${columns.has("Z_SUPER") ? "Z_SUPER" : "NULL AS Z_SUPER"}
    FROM Z_PRIMARYKEY ORDER BY Z_ENT
  `);
  if (rows.length > MAX_TABLES) return fail("Z_PRIMARYKEY exceeds its entity bound");
  const parsed = rows.map((row) => ({
    entity: integer(row.Z_ENT, "AddressBook entity ID"),
    name: boundedText(row.Z_NAME, "AddressBook entity name", 256),
    parent: row.Z_SUPER === null ? null : integer(row.Z_SUPER, "AddressBook parent entity ID"),
  }));
  const roots = parsed.filter((row) => row.name === "ABCDContact").map((row) => row.entity);
  if (roots.length !== 1 || roots[0]! < 1) return fail("has no unique ABCDContact entity");
  const result = new Set(roots);
  for (;;) {
    let changed = false;
    for (const row of parsed) {
      if (row.parent !== null && result.has(row.parent) && !result.has(row.entity)) {
        result.add(row.entity);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return Object.freeze([...result].sort((left, right) => left - right));
}

function readContactRows(
  database: Database,
  columns: ReadonlySet<string>,
  entities: readonly number[],
  maximumContacts: number,
  pageSize: number,
): ContactRowsRead {
  const placeholders = entities.map(() => "?").join(",");
  const count = integer(getRow<{ value: number }>(
    database,
    `SELECT count(*) AS value FROM ZABCDRECORD WHERE Z_ENT IN (${placeholders})`,
    ...entities,
  )?.value, "contact row count");
  if (count < 0 || count > maximumContacts) return fail("contact rows exceed their bound");
  const result: ContactRow[] = [];
  const identifiers = new Set<string>();
  let after = 0;
  let textBytes = 0;
  for (;;) {
    const rows = allRows<Row>(database, `SELECT Z_PK AS primary_key,
      ${boundedColumn(columns, "ZUNIQUEID", "unique_id", MAX_IDENTIFIER_BYTES)},
      ${boundedColumn(columns, "ZNAME", "display_name", MAX_LABEL_BYTES)},
      ${boundedColumn(columns, "ZFIRSTNAME", "first_name", MAX_LABEL_BYTES)},
      ${boundedColumn(columns, "ZMIDDLENAME", "middle_name", MAX_LABEL_BYTES)},
      ${boundedColumn(columns, "ZLASTNAME", "last_name", MAX_LABEL_BYTES)},
      ${boundedColumn(columns, "ZORGANIZATION", "organization", MAX_LABEL_BYTES)}
      FROM ZABCDRECORD WHERE Z_ENT IN (${placeholders}) AND Z_PK > ? ORDER BY Z_PK LIMIT ?`,
    ...entities, after, pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const primaryKey = integer(row.primary_key, "contact primary key");
      if (primaryKey <= after) return fail("contact paging did not advance");
      for (const alias of ["unique_id", "display_name", "first_name", "middle_name", "last_name", "organization"] as const) {
        if (flag(row[`${alias}_over_bound`], `${alias} bound flag`) === 1) {
          return fail(`contact ${alias} exceeds its text bound`);
        }
      }
      const identifier = boundedText(row.unique_id, "contact identifier", MAX_IDENTIFIER_BYTES);
      if (identifiers.has(identifier)) return fail("contact identifiers are duplicated");
      identifiers.add(identifier);
      const label = privateLabel([
        row.display_name,
        row.first_name,
        row.middle_name,
        row.last_name,
        row.organization,
      ]);
      textBytes += Buffer.byteLength(identifier, "utf8");
      for (const alias of ["display_name", "first_name", "middle_name", "last_name", "organization"] as const) {
        const value = row[alias];
        if (typeof value === "string") textBytes += Buffer.byteLength(value, "utf8");
      }
      if (label.value !== null) textBytes += Buffer.byteLength(label.value, "utf8");
      if (textBytes > MAX_TOTAL_TEXT_BYTES) return fail("contact text exceeds its aggregate bound");
      result.push(Object.freeze({
        primaryKey,
        identifier,
        privateLabel: label.value,
        privateLabelBasis: label.basis,
      }));
      after = primaryKey;
    }
  }
  if (result.length !== count) return fail("contact paging count changed during its transaction");
  return Object.freeze({ rows: Object.freeze(result), textBytes });
}

function methodColumns(
  database: Database,
  table: "ZABCDEMAILADDRESS" | "ZABCDPHONENUMBER",
): Readonly<{ columns: ReadonlySet<string>; owner: "ZOWNER"; value: "ZADDRESS" | "ZFULLNUMBER" }> {
  const value = table === "ZABCDEMAILADDRESS" ? "ZADDRESS" : "ZFULLNUMBER";
  const columns = requireColumns(database, table, ["Z_PK", "ZOWNER", value]);
  return Object.freeze({ columns, owner: "ZOWNER", value });
}

function readMethods(
  database: Database,
  table: "ZABCDEMAILADDRESS" | "ZABCDPHONENUMBER",
  pageSize: number,
): Readonly<{
  byOwner: ReadonlyMap<number, readonly NormalizedContactHandle[]>;
  invalid: number;
  rows: number;
  textBytes: number;
}> {
  const expectedRows = countRows(database, table, MAX_METHOD_ROWS);
  const shape = methodColumns(database, table);
  const grouped = new Map<number, Map<string, NormalizedContactHandle>>();
  let after = 0;
  let invalid = 0;
  let textBytes = 0;
  let rowsRead = 0;
  for (;;) {
    const rows = allRows<Row>(database, `SELECT Z_PK AS primary_key, ${shape.owner} AS owner,
      ${boundedColumn(shape.columns, shape.value, "method_value", MAX_HANDLE_BYTES)}
      FROM ${table} WHERE Z_PK > ? ORDER BY Z_PK LIMIT ?`, after, pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const primaryKey = integer(row.primary_key, `${table} primary key`);
      if (primaryKey <= after) return fail(`${table} paging did not advance`);
      const owner = integer(row.owner, `${table} owner`);
      if (owner < 1) return fail(`${table} owner is invalid`);
      if (flag(row.method_value_over_bound, `${table} value bound flag`) === 1) {
        return fail(`${table} value exceeds its text bound`);
      }
      if (row.method_value !== null && typeof row.method_value !== "string") {
        return fail(`${table} value must be text or null`);
      }
      const raw = row.method_value as string | null;
      if (raw !== null) {
        textBytes += Buffer.byteLength(raw, "utf8");
        if (textBytes > MAX_TOTAL_TEXT_BYTES) return fail("contact methods exceed their aggregate text bound");
      }
      const handle = raw === null ? null : normalizeContactHandle(raw);
      const expectedKind = table === "ZABCDEMAILADDRESS" ? "email" : "phone";
      if (handle === null || handle.kind !== expectedKind) invalid += 1;
      else {
        const values = grouped.get(owner) ?? new Map<string, NormalizedContactHandle>();
        values.set(`${handle.kind}\0${handle.normalizedValue}`, handle);
        grouped.set(owner, values);
      }
      after = primaryKey;
      rowsRead += 1;
    }
  }
  if (rowsRead !== expectedRows) return fail(`${table} paging count changed during its transaction`);
  return Object.freeze({
    byOwner: new Map([...grouped.entries()].map(([owner, values]) => [
      owner,
      Object.freeze([...values.values()].sort((left, right) => {
        const kind = left.kind.localeCompare(right.kind, "en-US");
        return kind !== 0 ? kind : left.normalizedValue.localeCompare(right.normalizedValue, "en-US");
      })),
    ])),
    invalid,
    rows: rowsRead,
    textBytes,
  });
}

function modifiedAt(stats: BigIntStats): string {
  const milliseconds = Number(stats.mtimeMs);
  if (!Number.isFinite(milliseconds)) return fail("database modification time is invalid");
  return new Date(milliseconds).toISOString();
}

function readStore(
  source: SourceFile,
  key: Uint8Array,
  maximumBytes: number,
  maximumContacts: number,
  pageSize: number,
): StoreRead {
  const isolated = isolateContactsSource(source, maximumBytes);
  let database: Database | null = null;
  let transactionOpen = false;
  try {
    database = new Database(isolated.path, { strict: true });
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA query_only=ON");
    if (getRow<{ query_only: number }>(database, "PRAGMA query_only")?.query_only !== 1) {
      return fail("could not enable query-only mode");
    }
    database.exec("BEGIN");
    transactionOpen = true;
    const names = tableNames(database);
    if (!names.has("Z_PRIMARYKEY") || !names.has("ZABCDRECORD")) {
      return fail("has an unsupported AddressBook schema");
    }
    const primaryColumns = requireColumns(database, "Z_PRIMARYKEY", ["Z_ENT", "Z_NAME"]);
    const recordColumns = requireColumns(database, "ZABCDRECORD", ["Z_PK", "Z_ENT", "ZUNIQUEID"]);
    const entities = contactEntityIds(database, primaryColumns);
    const schema = [...names].sort((left, right) => left.localeCompare(right, "en-US"))
      .map((table) => ({ table, columns: tableColumns(database!, table) }));
    const schemaSha256 = sha256(canonicalJson(schema));
    const contactRead = readContactRows(
      database,
      recordColumns,
      entities,
      maximumContacts,
      pageSize,
    );
    const emails = names.has("ZABCDEMAILADDRESS")
      ? readMethods(database, "ZABCDEMAILADDRESS", pageSize)
      : { byOwner: new Map<number, readonly NormalizedContactHandle[]>(), invalid: 0, rows: 0, textBytes: 0 };
    const phones = names.has("ZABCDPHONENUMBER")
      ? readMethods(database, "ZABCDPHONENUMBER", pageSize)
      : { byOwner: new Map<number, readonly NormalizedContactHandle[]>(), invalid: 0, rows: 0, textBytes: 0 };
    if (emails.rows + phones.rows > MAX_METHOD_ROWS) {
      return fail("contact methods exceed their aggregate row bound");
    }
    if (contactRead.textBytes + emails.textBytes + phones.textBytes > MAX_TOTAL_TEXT_BYTES) {
      return fail("contact data exceeds its aggregate text bound");
    }
    const contactRows = contactRead.rows;
    const contactPrimaryKeys = new Set(contactRows.map((contact) => contact.primaryKey));
    for (const owner of [...emails.byOwner.keys(), ...phones.byOwner.keys()]) {
      if (!contactPrimaryKeys.has(owner)) return fail("contact method references a missing contact");
    }
    const contacts = contactRows.map((contact) => {
      const handles = [...(emails.byOwner.get(contact.primaryKey) ?? []),
        ...(phones.byOwner.get(contact.primaryKey) ?? [])]
        .sort((left, right) => {
          const kind = left.kind.localeCompare(right.kind, "en-US");
          return kind !== 0 ? kind : left.normalizedValue.localeCompare(right.normalizedValue, "en-US");
        }).map((handle): ContactHandle => Object.freeze({
          ...handle,
          matchId: contactHandleMatchId(key, handle),
        }));
      return Object.freeze({
        id: hmac(key, "addressbook-contact", `${source.key}\0${contact.identifier}`),
        privateLabel: contact.privateLabel,
        privateLabelBasis: contact.privateLabelBasis,
        handles: Object.freeze(handles),
      });
    }).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
    database.exec("COMMIT");
    transactionOpen = false;
    return Object.freeze({
      contacts: Object.freeze(contacts),
      source: Object.freeze({
        physicalPath: isolated.source.path,
        device: isolated.source.stats.dev.toString(),
        inode: isolated.source.stats.ino.toString(),
        bytes: Number(isolated.source.stats.size),
        modifiedAt: modifiedAt(isolated.source.stats),
        schemaSha256,
      }),
      invalidEmails: emails.invalid,
      invalidPhones: phones.invalid,
      withoutHandles: contacts.filter((contact) => contact.handles.length === 0).length,
      methodRows: emails.rows + phones.rows,
      textBytes: contactRead.textBytes + emails.textBytes + phones.textBytes,
    });
  } finally {
    if (transactionOpen && database !== null) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure remains authoritative.
      }
    }
    try {
      database?.close();
    } finally {
      rmSync(isolated.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

/** Read deterministic private labels and exact handles from macOS Contacts. */
export function readMacOSContacts(
  path: string,
  options: ReadContactsOptions,
): ContactsSnapshot {
  const key = keyBytes(options.hmacKey);
  const maximumBytes = boundedInteger(
    options.maxDatabaseBytes,
    MAX_SOURCE_DATABASE_BYTES,
    1,
    MAX_SOURCE_DATABASE_BYTES,
    "maxDatabaseBytes",
  );
  const maximumContacts = boundedInteger(
    options.maxContacts,
    MAX_CONTACTS,
    1,
    MAX_CONTACTS,
    "maxContacts",
  );
  const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, "pageSize");
  const sources = discoverDatabases(path, maximumBytes);
  const initialMembers = sources.map((source) => snapshotMembers(source, maximumBytes));
  const reads: StoreRead[] = [];
  let aggregateContacts = 0;
  let aggregateHandles = 0;
  let aggregateMethodRows = 0;
  let aggregateTextBytes = 0;
  for (const source of sources) {
    const read = readStore(source, key, maximumBytes, maximumContacts, pageSize);
    reads.push(read);
    aggregateContacts += read.contacts.length;
    aggregateHandles += read.contacts.reduce((sum, contact) => sum + contact.handles.length, 0);
    aggregateMethodRows += read.methodRows;
    aggregateTextBytes += read.textBytes;
    if (aggregateContacts > maximumContacts) return fail("contacts exceed their aggregate row bound");
    if (aggregateHandles > MAX_METHOD_ROWS) return fail("contact methods exceed their aggregate row bound");
    if (aggregateMethodRows > MAX_METHOD_ROWS) return fail("contact method rows exceed their aggregate bound");
    if (aggregateTextBytes > MAX_TOTAL_TEXT_BYTES) return fail("contact text exceeds its aggregate bound");
  }
  const finalSources = discoverDatabases(path, maximumBytes);
  if (
    finalSources.length !== sources.length
    || finalSources.some((source, index) => {
      const prior = sources[index];
      return prior === undefined
        || source.key !== prior.key
        || source.path !== prior.path
        || !sameFile(source.stats, prior.stats);
    })
    || finalSources.some((source, index) => !sameMembers(
      initialMembers[index] ?? [],
      snapshotMembers(source, maximumBytes),
    ))
  ) return fail("AddressBook store set changed during its snapshot");
  const contacts = reads.flatMap((read) => read.contacts)
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  const ids = new Set<string>();
  for (const contact of contacts) {
    if (ids.has(contact.id)) return fail("contains duplicate pseudonymous contact IDs");
    ids.add(contact.id);
  }
  const warnings: string[] = [];
  const invalidEmails = reads.reduce((sum, read) => sum + read.invalidEmails, 0);
  const invalidPhones = reads.reduce((sum, read) => sum + read.invalidPhones, 0);
  const withoutHandles = reads.reduce((sum, read) => sum + read.withoutHandles, 0);
  if (invalidEmails > 0) warnings.push(`ignored invalid email handles: ${invalidEmails}`);
  if (invalidPhones > 0) warnings.push(`ignored invalid phone handles: ${invalidPhones}`);
  if (withoutHandles > 0) warnings.push(`contacts without exact matchable handles: ${withoutHandles}`);
  const sourceIdentities = reads.map((read) => read.source);
  const snapshotSha256 = sha256(canonicalJson({
    schemaVersion: CONTACTS_SCHEMA_VERSION,
    sources: sources.map((source, index) => ({
      id: hmac(key, "addressbook-source", source.key),
      schemaSha256: sourceIdentities[index]!.schemaSha256,
    })),
    contacts,
    warnings,
  }));
  return Object.freeze({
    schemaVersion: CONTACTS_SCHEMA_VERSION,
    snapshotSha256,
    sources: Object.freeze(sourceIdentities),
    contacts: Object.freeze(contacts),
    warnings: Object.freeze(warnings),
  });
}
