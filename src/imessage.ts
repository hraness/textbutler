import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  CORPUS_SCHEMA_VERSION,
  type BodySource,
  type CorpusConversation,
  type CorpusMessage,
  type CorpusSnapshot,
  type MessageKind,
} from "./types.ts";
import { isolateMessageSource } from "./sqlite-snapshot.ts";

export const DEFAULT_IMESSAGE_DATABASE = join(
  homedir(),
  "Library",
  "Messages",
  "chat.db",
);

const APPLE_EPOCH_MILLISECONDS = Date.UTC(2001, 0, 1);
const DEFAULT_MAX_DATABASE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_CONFIGURABLE_DATABASE_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 5_000_000;
const MAX_CONFIGURABLE_MESSAGES = 10_000_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ATTRIBUTED_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURABLE_ATTRIBUTED_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 5_000;
const MAX_PAGE_SIZE = 20_000;
const MAX_HANDLES = 1_000_000;
const MAX_CHATS = 1_000_000;
const MAX_CHAT_HANDLE_JOINS = 5_000_000;
const MAX_TEXT_IDENTITY_BYTES = 4_096;
const MAX_SQLITE_SHM_BYTES = 64 * 1024 * 1024;
const SOURCE_SNAPSHOT_ATTEMPTS = 5;
const TYPEDSTREAM_MARKER = new TextEncoder().encode("streamtyped");
const NSSTRING_MARKER = new TextEncoder().encode("NSString");

type SqlBinding = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, unknown>;

export type SourceFile = Readonly<{
  path: string;
  stats: BigIntStats;
}>;

export type SourceSnapshot = Readonly<{
  source: SourceFile;
  path: string;
  temporaryDirectory: string;
}>;

type SnapshotMember = Readonly<{
  suffix: "" | "-wal" | "-journal";
  path: string;
  stats: BigIntStats;
}>;

type WarningCategory =
  | "spamOrCorrupt"
  | "unsupportedTimestamp"
  | "missingConversation"
  | "multipleConversations"
  | "missingSenderHandle"
  | "unsupportedAttributedBody";

const WARNING_LABELS: readonly Readonly<{
  category: WarningCategory;
  label: string;
}>[] = Object.freeze([
  { category: "spamOrCorrupt", label: "excluded spam or corrupt messages" },
  { category: "unsupportedTimestamp", label: "excluded messages with unsupported timestamps" },
  { category: "missingConversation", label: "excluded messages without conversations" },
  {
    category: "multipleConversations",
    label: "messages joined to multiple conversations (lowest chat ROWID selected)",
  },
  {
    category: "missingSenderHandle",
    label: "incoming messages referencing missing sender handles",
  },
  {
    category: "unsupportedAttributedBody",
    label: "unsupported or over-bound attributed bodies",
  },
]);

type HandleRecord = Readonly<{
  rowId: number;
  id: string;
  service: string | null;
  participantId: string;
}>;

type ChatRecord = Readonly<{
  rowId: number;
  conversation: CorpusConversation;
}>;

type MessagePageRow = Readonly<{
  sourceRowId: number;
  sourceGuid: string;
  service: string | null;
  handleId: number | null;
  dateText: string | null;
  isFromMe: number;
  text: string | null;
  textOverBound: number;
  attributedBody: Uint8Array | null;
  attributedBodyOverBound: number;
  itemType: number;
  associatedMessageType: number;
  associatedMessageGuid: string | null;
  threadOriginatorGuid: string | null;
  replyToGuid: string | null;
  isSystemMessage: number;
  isServiceMessage: number;
  isSpam: number;
  isCorrupt: number;
  editedDateText: string | null;
  retractedDateText: string | null;
  cacheHasAttachments: number;
}>;

export type ReadIMessageOptions = Readonly<{
  /** Per-install secret used to make stable, non-dictionary-guessable local IDs. */
  hmacKey: string | Uint8Array;
  maxDatabaseBytes?: number;
  maxMessages?: number;
  maxBodyBytes?: number;
  maxAttributedBodyBytes?: number;
  pageSize?: number;
}>;

function fail(message: string): never {
  throw new Error(`iMessage source ${message}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array, namespace: string, value: string): string {
  return createHmac("sha256", key)
    .update(`message-like-me\0${namespace}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function hmacKey(value: string | Uint8Array): Uint8Array {
  const key = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!(key instanceof Uint8Array) || key.byteLength < 16 || key.byteLength > 1_024) {
    throw new Error("iMessage HMAC key must contain 16 through 1024 bytes");
  }
  return Uint8Array.from(key);
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

function ownedByCurrentUser(stats: BigIntStats): boolean {
  return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectSource(path: string, maximumBytes: number): SourceFile {
  if (!isAbsolute(path)) return fail("path must be absolute");
  const requested = resolve(path);
  const requestedStats = lstatSync(requested, { bigint: true });
  if (
    !requestedStats.isFile()
    || requestedStats.isSymbolicLink()
    || requestedStats.nlink !== 1n
    || !ownedByCurrentUser(requestedStats)
    || requestedStats.size < 1n
    || requestedStats.size > BigInt(maximumBytes)
  ) {
    return fail("must be one current-user-owned regular non-symlink file within the configured size bound");
  }
  const physicalPath = realpathSync(requested);
  const physicalStats = lstatSync(physicalPath, { bigint: true });
  if (!sameFile(requestedStats, physicalStats)) {
    return fail("changed identity while its path was resolved");
  }
  return Object.freeze({ path: physicalPath, stats: physicalStats });
}

function optionalStats(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateSidecar(path: string, stats: BigIntStats, maximumBytes: number): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1n
    || !ownedByCurrentUser(stats)
    || stats.size < 0n
    || stats.size > BigInt(maximumBytes)
  ) {
    return fail(`sidecar ${basename(path)} must be one current-user-owned regular non-symlink file within its size bound`);
  }
}

function snapshotMembers(
  source: SourceFile,
  maximumBytes: number,
): readonly SnapshotMember[] {
  const current = inspectSource(source.path, maximumBytes);
  if (!sameFile(source.stats, current.stats)) return fail("changed identity before its snapshot was isolated");
  const members: SnapshotMember[] = [{ suffix: "", path: current.path, stats: current.stats }];
  for (const suffix of ["-wal", "-journal"] as const) {
    const path = `${source.path}${suffix}`;
    const stats = optionalStats(path);
    if (stats === null) continue;
    validateSidecar(path, stats, maximumBytes);
    members.push(Object.freeze({ suffix, path, stats }));
  }
  const shmPath = `${source.path}-shm`;
  const shm = optionalStats(shmPath);
  if (shm !== null) validateSidecar(shmPath, shm, MAX_SQLITE_SHM_BYTES);
  const totalBytes = members.reduce((total, member) => total + member.stats.size, 0n);
  if (totalBytes > BigInt(maximumBytes) * 2n) {
    return fail("database and transactional sidecars exceed the configured snapshot size bound");
  }
  return Object.freeze(members);
}

function sameSnapshotMembers(
  left: readonly SnapshotMember[],
  right: readonly SnapshotMember[],
): boolean {
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

/**
 * SQLite read-only mode still writes WAL shared-memory coordination bytes. Work
 * only on a stable private clone so the source database and all sidecars remain
 * byte-for-byte untouched.
 */
export function isolateSource(source: SourceFile, maximumBytes: number): SourceSnapshot {
  const temporaryRoot = tmpdir();
  if (!isAbsolute(temporaryRoot)) return fail("requires an absolute temporary directory");
  const temporaryDirectory = mkdtempSync(join(temporaryRoot, "message-like-me-source-"));
  chmodSync(temporaryDirectory, 0o700);
  try {
    for (let attempt = 0; attempt < SOURCE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = snapshotMembers(source, maximumBytes);
      const attemptDirectory = join(temporaryDirectory, `attempt-${attempt}`);
      mkdirSync(attemptDirectory, { mode: 0o700 });
      let copyFailedForRace = false;
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
        if (code === "ENOENT" || code === "ESTALE") copyFailedForRace = true;
        else throw error;
      }
      const after = snapshotMembers(source, maximumBytes);
      if (!copyFailedForRace && sameSnapshotMembers(before, after)) {
        return Object.freeze({
          source: Object.freeze({ path: source.path, stats: before[0]!.stats }),
          path: join(attemptDirectory, basename(source.path)),
          temporaryDirectory,
        });
      }
      rmSync(attemptDirectory, { recursive: true, force: true });
    }
    return fail(`changed during ${SOURCE_SNAPSHOT_ATTEMPTS} attempts to isolate a consistent snapshot`);
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function allRows<T extends SqlRow>(
  database: Database,
  sql: string,
  ...bindings: SqlBinding[]
): T[] {
  return database.query(sql).all(...bindings) as T[];
}

function getRow<T extends SqlRow>(
  database: Database,
  sql: string,
  ...bindings: SqlBinding[]
): T | null {
  return database.query(sql).get(...bindings) as T | null;
}

function safeInteger(value: unknown, label: string): number;
function safeInteger(value: unknown, label: string, nullable: true): number | null;
function safeInteger(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(`${label} must be a safe integer`);
  }
  return value;
}

function flag(value: unknown, label: string, fallback = 0): number {
  if (value === null) return fallback;
  const parsed = safeInteger(value, label);
  if (parsed !== 0 && parsed !== 1) return fail(`${label} must be zero or one`);
  return parsed;
}

function privateText(value: unknown, label: string): string;
function privateText(
  value: unknown,
  label: string,
  nullable: false,
  allowEmpty?: boolean,
): string;
function privateText(
  value: unknown,
  label: string,
  nullable: true,
  allowEmpty?: boolean,
): string | null;
function privateText(
  value: unknown,
  label: string,
  nullable = false,
  allowEmpty = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > MAX_TEXT_IDENTITY_BYTES
    || value.includes("\u0000")
  ) return fail(`${label} must be bounded text`);
  return value;
}

function bodyText(value: unknown, label: string, maximumBytes: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail(`${label} must be text or null`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    return fail(`${label} exceeds the configured body bound`);
  }
  return value;
}

function blob(value: unknown, label: string): Uint8Array | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  return fail(`${label} must be binary data or null`);
}

function tableColumns(database: Database, table: string): readonly Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}>[] {
  return allRows<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>(database, `SELECT cid,name,type,\"notnull\",dflt_value,pk FROM pragma_table_info('${table}') ORDER BY cid`)
    .map((row) => Object.freeze({
      cid: safeInteger(row.cid, `${table} column ordinal`),
      name: privateText(row.name, `${table} column name`)!,
      type: privateText(row.type, `${table} column type`, false, true)!,
      notnull: safeInteger(row.notnull, `${table} column nullability`),
      dflt_value: row.dflt_value,
      pk: safeInteger(row.pk, `${table} column primary-key position`),
    }));
}

function tableNames(database: Database): ReadonlySet<string> {
  return new Set(allRows<{ name: string }>(
    database,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).map((row) => privateText(row.name, "table name")!));
}

type SourceSchema = Readonly<{
  hash: string;
  tables: ReadonlyMap<string, ReadonlySet<string>>;
  hasAttachmentJoin: boolean;
}>;

function inspectSchema(database: Database): SourceSchema {
  const names = tableNames(database);
  const required: Readonly<Record<string, readonly string[]>> = Object.freeze({
    message: ["ROWID", "guid", "service", "handle_id", "date", "is_from_me"],
    handle: ["ROWID", "id", "service"],
    chat: ["ROWID", "guid", "style"],
    chat_message_join: ["chat_id", "message_id"],
    chat_handle_join: ["chat_id", "handle_id"],
  });
  const inspected = new Map<string, ReturnType<typeof tableColumns>>();
  const sets = new Map<string, ReadonlySet<string>>();
  for (const [table, columns] of Object.entries(required)) {
    if (!names.has(table)) return fail(`is missing required table ${table}`);
    const shape = tableColumns(database, table);
    const set = new Set(shape.map((column) => column.name));
    for (const column of columns) {
      if (!set.has(column)) return fail(`${table} is missing required column ${column}`);
    }
    inspected.set(table, shape);
    sets.set(table, set);
  }
  const messageColumns = sets.get("message");
  if (messageColumns === undefined || (!messageColumns.has("text") && !messageColumns.has("attributedBody"))) {
    return fail("message must expose text or attributedBody");
  }
  let hasAttachmentJoin = false;
  if (names.has("message_attachment_join")) {
    const shape = tableColumns(database, "message_attachment_join");
    const set = new Set(shape.map((column) => column.name));
    for (const column of ["message_id", "attachment_id"]) {
      if (!set.has(column)) return fail(`message_attachment_join is missing required column ${column}`);
    }
    inspected.set("message_attachment_join", shape);
    sets.set("message_attachment_join", set);
    hasAttachmentJoin = true;
  }
  const serialized = [...inspected.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([table, columns]) => ({ table, columns }));
  return Object.freeze({ hash: sha256(stableJson(serialized)), tables: sets, hasAttachmentJoin });
}

function boundedTableCount(database: Database, table: string, maximum: number): number {
  const row = getRow<{ value: number }>(database, `SELECT count(*) AS value FROM ${table}`);
  const count = safeInteger(row?.value, `${table} row count`);
  if (count === null || count < 0 || count > maximum) {
    return fail(`${table} exceeds its supported row bound`);
  }
  return count;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  const last = haystack.byteLength - needle.byteLength;
  for (let offset = Math.max(0, start); offset <= last; offset += 1) {
    let match = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        match = false;
        break;
      }
    }
    if (match) return offset;
  }
  return -1;
}

function typedstreamLength(
  bytes: Uint8Array,
  offset: number,
  maximum: number,
): Readonly<{ length: number; next: number }> | null {
  const marker = bytes[offset];
  if (marker === undefined) return null;
  if (marker <= 0x7f) {
    return marker <= maximum ? Object.freeze({ length: marker, next: offset + 1 }) : null;
  }
  const width = marker === 0x81 ? 2 : marker === 0x82 ? 4 : marker === 0x83 ? 8 : 0;
  if (width === 0 || offset + 1 + width > bytes.byteLength) return null;
  let length = 0n;
  for (let index = width - 1; index >= 0; index -= 1) {
    length = (length << 8n) | BigInt(bytes[offset + 1 + index]!);
  }
  if (length > BigInt(maximum) || length > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Object.freeze({ length: Number(length), next: offset + 1 + width });
}

function decodeStringPayload(payload: Uint8Array): string | null {
  try {
    if (payload.byteLength >= 2 && payload[0] === 0xff && payload[1] === 0xfe) {
      return new TextDecoder("utf-16le", { fatal: true }).decode(payload.subarray(2));
    }
    if (payload.byteLength >= 2 && payload[0] === 0xfe && payload[1] === 0xff) {
      const swapped = new Uint8Array(payload.byteLength - 2);
      for (let index = 2; index + 1 < payload.byteLength; index += 2) {
        swapped[index - 2] = payload[index + 1]!;
        swapped[index - 1] = payload[index]!;
      }
      if (swapped.byteLength % 2 !== 0) return null;
      return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

/**
 * Extract the inline NSString payload from Apple's legacy typedstream envelope.
 * This is a bounded byte parser; it never invokes an Objective-C unarchiver.
 */
export function decodeAttributedBody(
  value: Uint8Array,
  maximumBlobBytes = DEFAULT_MAX_ATTRIBUTED_BODY_BYTES,
  maximumBodyBytes = DEFAULT_MAX_BODY_BYTES,
): string | null {
  if (
    !(value instanceof Uint8Array)
    || !Number.isSafeInteger(maximumBlobBytes)
    || !Number.isSafeInteger(maximumBodyBytes)
    || maximumBlobBytes < 1
    || maximumBodyBytes < 1
    || value.byteLength < TYPEDSTREAM_MARKER.byteLength
    || value.byteLength > maximumBlobBytes
    || indexOfBytes(value, TYPEDSTREAM_MARKER, 0) < 0
  ) return null;

  let searchFrom = 0;
  for (;;) {
    const marker = indexOfBytes(value, NSSTRING_MARKER, searchFrom);
    if (marker < 0) return null;
    const markerEnd = marker + NSSTRING_MARKER.byteLength;
    const end = Math.min(value.byteLength - 1, markerEnd + 32);
    const preferredTag = markerEnd + 4;
    const tagOffsets = [
      ...(preferredTag <= end ? [preferredTag] : []),
      ...Array.from({ length: Math.max(0, end - markerEnd + 1) }, (_unused, index) => markerEnd + index)
        .filter((offset) => offset !== preferredTag),
    ];
    for (const tagOffset of tagOffsets) {
      if (value[tagOffset] !== 0x2b) continue;
      const length = typedstreamLength(value, tagOffset + 1, maximumBodyBytes);
      if (length === null || length.next + length.length > value.byteLength) continue;
      const decoded = decodeStringPayload(value.subarray(length.next, length.next + length.length));
      if (
        decoded !== null
        && !decoded.includes("\u0000")
        && Buffer.byteLength(decoded, "utf8") <= maximumBodyBytes
      ) return decoded;
    }
    searchFrom = markerEnd;
  }
}

function appleTimestamp(value: string | null): string | null {
  if (value === null || value === "" || value === "0") return null;
  let millisecondsSinceEpoch: number;
  if (/^[0-9]+$/u.test(value)) {
    const raw = BigInt(value);
    if (raw <= 0n || raw > 4_000_000_000_000_000_000n) return null;
    if (raw < 4_000_000_000n) millisecondsSinceEpoch = Number(raw * 1_000n);
    else if (raw < 4_000_000_000_000n) millisecondsSinceEpoch = Number(raw);
    else if (raw < 4_000_000_000_000_000n) millisecondsSinceEpoch = Number(raw / 1_000n);
    else millisecondsSinceEpoch = Number(raw / 1_000_000n);
  } else if (/^[0-9]+\.[0-9]+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 4_000_000_000) return null;
    millisecondsSinceEpoch = Math.trunc(seconds * 1_000);
  } else return null;
  if (!Number.isSafeInteger(millisecondsSinceEpoch)) return null;
  const result = new Date(APPLE_EPOCH_MILLISECONDS + millisecondsSinceEpoch);
  const year = result.getUTCFullYear();
  return year >= 2001 && year <= 2200 ? result.toISOString() : null;
}

function hasAppleTimestampMarker(value: string | null): boolean {
  if (value === null || value === "") return false;
  return !/^0+(?:\.0+)?$/u.test(value);
}

function columnExpression(
  columns: ReadonlySet<string>,
  column: string,
  expression: string,
  alias: string,
): string {
  return columns.has(column) ? `${expression} AS ${alias}` : `NULL AS ${alias}`;
}

function boundedTextExpression(
  columns: ReadonlySet<string>,
  column: string,
  maximumBytes: number,
): string {
  if (!columns.has(column)) return "NULL AS message_text, 0 AS message_text_over_bound";
  return `CASE WHEN ${column} IS NULL OR length(CAST(${column} AS BLOB)) <= ${maximumBytes}
    THEN ${column} ELSE NULL END AS message_text,
    CASE WHEN ${column} IS NOT NULL AND length(CAST(${column} AS BLOB)) > ${maximumBytes}
    THEN 1 ELSE 0 END AS message_text_over_bound`;
}

function boundedBlobExpression(
  columns: ReadonlySet<string>,
  column: string,
  maximumBytes: number,
): string {
  if (!columns.has(column)) {
    return "NULL AS attributed_body, 0 AS attributed_body_over_bound";
  }
  return `CASE WHEN ${column} IS NULL OR length(${column}) <= ${maximumBytes}
    THEN ${column} ELSE NULL END AS attributed_body,
    CASE WHEN ${column} IS NOT NULL AND length(${column}) > ${maximumBytes}
    THEN 1 ELSE 0 END AS attributed_body_over_bound`;
}

function loadHandles(database: Database, key: Uint8Array): ReadonlyMap<number, HandleRecord> {
  boundedTableCount(database, "handle", MAX_HANDLES);
  const result = new Map<number, HandleRecord>();
  for (const row of allRows<{ ROWID: number; id: string; service: string | null }>(
    database,
    "SELECT ROWID,id,service FROM handle ORDER BY ROWID",
  )) {
    const rowId = safeInteger(row.ROWID, "handle ROWID")!;
    const id = privateText(row.id, "handle identity")!;
    const service = privateText(row.service, "handle service", true);
    if (result.has(rowId)) return fail("contains duplicate handle ROWIDs");
    result.set(rowId, Object.freeze({
      rowId,
      id,
      service,
      participantId: hmac(key, "participant", `${service ?? ""}\0${id}`),
    }));
  }
  return result;
}

function loadChats(
  database: Database,
  schema: SourceSchema,
  handles: ReadonlyMap<number, HandleRecord>,
  key: Uint8Array,
): ReadonlyMap<number, ChatRecord> {
  boundedTableCount(database, "chat", MAX_CHATS);
  boundedTableCount(database, "chat_handle_join", MAX_CHAT_HANDLE_JOINS);
  const handleIds = new Map<number, Set<number>>();
  for (const row of allRows<{ chat_id: number; handle_id: number }>(
    database,
    "SELECT chat_id,handle_id FROM chat_handle_join ORDER BY chat_id,handle_id",
  )) {
    const chatId = safeInteger(row.chat_id, "chat participant chat ID")!;
    const handleId = safeInteger(row.handle_id, "chat participant handle ID")!;
    if (!handles.has(handleId)) return fail("chat participant references a missing handle");
    const set = handleIds.get(chatId) ?? new Set<number>();
    set.add(handleId);
    handleIds.set(chatId, set);
  }
  const columns = schema.tables.get("chat");
  if (columns === undefined) return fail("chat schema disappeared");
  const rows = allRows<SqlRow>(database, `SELECT ROWID,guid,style,
    ${columnExpression(columns, "display_name", "display_name", "display_name")},
    ${columnExpression(columns, "service_name", "service_name", "service_name")}
    FROM chat ORDER BY ROWID`);
  const result = new Map<number, ChatRecord>();
  const conversationIds = new Set<string>();
  for (const row of rows) {
    const rowId = safeInteger(row.ROWID, "chat ROWID")!;
    const sourceKey = privateText(row.guid, "chat GUID")!;
    safeInteger(row.style, "chat style", true);
    const privateLabel = privateText(row.display_name, "chat display name", true, true);
    const declaredService = privateText(row.service_name, "chat service", true, true);
    const participants = [...(handleIds.get(rowId) ?? new Set<number>())]
      .sort((left, right) => left - right)
      .map((handleId) => handles.get(handleId)!)
      .filter((handle): handle is HandleRecord => handle !== undefined);
    const services = [...new Set(participants.map((participant) => participant.service)
      .filter((service): service is string => service !== null))].sort();
    const conversation: CorpusConversation = Object.freeze({
      id: hmac(key, "conversation", sourceKey),
      sourceKey,
      privateLabel,
      service: declaredService === null || declaredService === ""
        ? services.length === 1 ? services[0]! : null
        : declaredService,
      participantCount: participants.length,
      participantIds: Object.freeze(participants.map((participant) => participant.participantId)),
      privateParticipants: Object.freeze(participants.map((participant) => participant.id)),
      group: participants.length > 1,
    });
    if (result.has(rowId) || conversationIds.has(conversation.id)) {
      return fail("contains duplicate chat identities");
    }
    result.set(rowId, Object.freeze({ rowId, conversation }));
    conversationIds.add(conversation.id);
  }
  return result;
}

function loadChatJoins(database: Database, first: number, last: number): ReadonlyMap<number, readonly number[]> {
  const grouped = new Map<number, Set<number>>();
  for (const row of allRows<{ message_id: number; chat_id: number }>(database, `SELECT message_id,chat_id
    FROM chat_message_join WHERE message_id BETWEEN ? AND ? ORDER BY message_id,chat_id`, first, last)) {
    const messageId = safeInteger(row.message_id, "chat-message message ID")!;
    const chatId = safeInteger(row.chat_id, "chat-message chat ID")!;
    const values = grouped.get(messageId) ?? new Set<number>();
    values.add(chatId);
    grouped.set(messageId, values);
  }
  return new Map([...grouped.entries()].map(([messageId, values]) => [
    messageId,
    Object.freeze([...values].sort((left, right) => left - right)),
  ]));
}

function loadAttachmentCounts(
  database: Database,
  schema: SourceSchema,
  first: number,
  last: number,
): ReadonlyMap<number, number> {
  if (!schema.hasAttachmentJoin) return new Map();
  const result = new Map<number, number>();
  for (const row of allRows<{ message_id: number; value: number }>(database, `SELECT message_id,
    count(DISTINCT attachment_id) AS value FROM message_attachment_join
    WHERE message_id BETWEEN ? AND ? GROUP BY message_id ORDER BY message_id`, first, last)) {
    const messageId = safeInteger(row.message_id, "attachment message ID")!;
    const count = safeInteger(row.value, "message attachment count")!;
    if (count < 0) return fail("contains a negative attachment count");
    result.set(messageId, count);
  }
  return result;
}

function messageRows(
  database: Database,
  schema: SourceSchema,
  afterRowId: number,
  pageSize: number,
  maximumBodyBytes: number,
  maximumAttributedBodyBytes: number,
): readonly MessagePageRow[] {
  const columns = schema.tables.get("message");
  if (columns === undefined) return fail("message schema disappeared");
  const rows = allRows<SqlRow>(database, `SELECT
    ROWID AS source_rowid,guid,service,handle_id,CAST(date AS TEXT) AS date_text,is_from_me,
    ${boundedTextExpression(columns, "text", maximumBodyBytes)},
    ${boundedBlobExpression(columns, "attributedBody", maximumAttributedBodyBytes)},
    ${columnExpression(columns, "item_type", "item_type", "item_type")},
    ${columnExpression(columns, "associated_message_type", "associated_message_type", "associated_message_type")},
    ${columnExpression(columns, "associated_message_guid", "associated_message_guid", "associated_message_guid")},
    ${columnExpression(columns, "thread_originator_guid", "thread_originator_guid", "thread_originator_guid")},
    ${columnExpression(columns, "reply_to_guid", "reply_to_guid", "reply_to_guid")},
    ${columnExpression(columns, "is_system_message", "is_system_message", "is_system_message")},
    ${columnExpression(columns, "is_service_message", "is_service_message", "is_service_message")},
    ${columnExpression(columns, "is_spam", "is_spam", "is_spam")},
    ${columnExpression(columns, "is_corrupt", "is_corrupt", "is_corrupt")},
    ${columnExpression(columns, "date_edited", "CAST(date_edited AS TEXT)", "date_edited_text")},
    ${columnExpression(columns, "date_retracted", "CAST(date_retracted AS TEXT)", "date_retracted_text")},
    ${columnExpression(columns, "cache_has_attachments", "cache_has_attachments", "cache_has_attachments")}
    FROM message WHERE ROWID>? ORDER BY ROWID LIMIT ?`, afterRowId, pageSize);
  return rows.map((row) => Object.freeze({
    sourceRowId: safeInteger(row.source_rowid, "message ROWID")!,
    sourceGuid: privateText(row.guid, "message GUID")!,
    service: privateText(row.service, "message service", true, true),
    handleId: safeInteger(row.handle_id, "message sender handle ID", true),
    dateText: privateText(row.date_text, "message date", true, true),
    isFromMe: flag(row.is_from_me, "message direction"),
    text: bodyText(row.message_text, "message text", maximumBodyBytes),
    textOverBound: flag(row.message_text_over_bound, "message text bound flag"),
    attributedBody: blob(row.attributed_body, "message attributed body"),
    attributedBodyOverBound: flag(
      row.attributed_body_over_bound,
      "message attributed-body bound flag",
    ),
    itemType: row.item_type === null ? 0 : safeInteger(row.item_type, "message item type")!,
    associatedMessageType: row.associated_message_type === null
      ? 0
      : safeInteger(row.associated_message_type, "message associated-message type")!,
    associatedMessageGuid: privateText(row.associated_message_guid, "associated message GUID", true, true),
    threadOriginatorGuid: privateText(row.thread_originator_guid, "thread originator GUID", true, true),
    replyToGuid: privateText(row.reply_to_guid, "reply-to GUID", true, true),
    isSystemMessage: flag(row.is_system_message, "message system flag"),
    isServiceMessage: flag(row.is_service_message, "message service flag"),
    isSpam: flag(row.is_spam, "message spam flag"),
    isCorrupt: flag(row.is_corrupt, "message corrupt flag"),
    editedDateText: privateText(row.date_edited_text, "message edited date", true, true),
    retractedDateText: privateText(row.date_retracted_text, "message retracted date", true, true),
    cacheHasAttachments: flag(row.cache_has_attachments, "message attachment cache flag"),
  }));
}

function messageBody(
  row: MessagePageRow,
  maximumAttributedBodyBytes: number,
  maximumBodyBytes: number,
): Readonly<{ body: string | null; bodySource: BodySource }> {
  if (row.text !== null) return Object.freeze({ body: row.text, bodySource: "text" });
  if (row.attributedBody !== null) {
    const decoded = decodeAttributedBody(
      row.attributedBody,
      maximumAttributedBodyBytes,
      maximumBodyBytes,
    );
    if (decoded !== null) return Object.freeze({ body: decoded, bodySource: "attributed-body" });
  }
  return Object.freeze({ body: null, bodySource: "unavailable" });
}

function messageKind(row: MessagePageRow, body: string | null, attachmentCount: number): MessageKind {
  if (row.associatedMessageType !== 0 || (row.associatedMessageGuid ?? "") !== "") return "reaction";
  if (row.itemType !== 0 || row.isSystemMessage !== 0 || row.isServiceMessage !== 0) return "system";
  if (body !== null) return "text";
  if (attachmentCount > 0 || row.cacheHasAttachments === 1) return "attachment";
  return "unknown";
}

function sourceModifiedAt(stats: BigIntStats): string {
  const milliseconds = Number(stats.mtimeMs);
  if (!Number.isFinite(milliseconds)) return fail("has an invalid modification time");
  return new Date(milliseconds).toISOString();
}

function aggregateWarnings(
  counts: Readonly<Record<WarningCategory, number>>,
  hasAttachmentJoin: boolean,
): readonly string[] {
  const warnings: string[] = [];
  if (!hasAttachmentJoin) {
    warnings.push("message_attachment_join is unavailable; attachment counts are presence lower bounds");
  }
  for (const { category, label } of WARNING_LABELS) {
    const count = counts[category];
    if (count > 0) warnings.push(`${label}: ${count}`);
  }
  return Object.freeze(warnings);
}

/** Read one consistent, bounded snapshot of the local Messages database. */
export function readIMessageDatabase(
  path: string,
  options: ReadIMessageOptions,
): CorpusSnapshot {
  const key = hmacKey(options.hmacKey);
  const maximumDatabaseBytes = boundedInteger(
    options.maxDatabaseBytes,
    DEFAULT_MAX_DATABASE_BYTES,
    1,
    MAX_CONFIGURABLE_DATABASE_BYTES,
    "maxDatabaseBytes",
  );
  const maximumMessages = boundedInteger(
    options.maxMessages,
    DEFAULT_MAX_MESSAGES,
    1,
    MAX_CONFIGURABLE_MESSAGES,
    "maxMessages",
  );
  const maximumBodyBytes = boundedInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    1,
    MAX_CONFIGURABLE_BODY_BYTES,
    "maxBodyBytes",
  );
  const maximumAttributedBodyBytes = boundedInteger(
    options.maxAttributedBodyBytes,
    DEFAULT_MAX_ATTRIBUTED_BODY_BYTES,
    1,
    MAX_CONFIGURABLE_ATTRIBUTED_BODY_BYTES,
    "maxAttributedBodyBytes",
  );
  const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, "pageSize");
  const requestedSource = inspectSource(path, maximumDatabaseBytes);
  const isolated = isolateMessageSource(requestedSource, maximumDatabaseBytes);
  const source = isolated.source;
  let database: Database | null = null;
  let transactionOpen = false;
  try {
    // The clone is disposable and may be recovered by SQLite. No SQLite handle
    // is ever opened on the authoritative source database or its sidecars.
    database = new Database(isolated.path, { strict: true });
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA query_only=ON");
    const queryOnly = getRow<{ query_only: number }>(database, "PRAGMA query_only");
    if (queryOnly?.query_only !== 1) return fail("could not enable query-only mode");
    database.exec("BEGIN");
    transactionOpen = true;
    const schema = inspectSchema(database);
    boundedTableCount(database, "message", maximumMessages);
    const handles = loadHandles(database, key);
    const chats = loadChats(database, schema, handles, key);
    const warningCounts: Record<WarningCategory, number> = {
      spamOrCorrupt: 0,
      unsupportedTimestamp: 0,
      missingConversation: 0,
      multipleConversations: 0,
      missingSenderHandle: 0,
      unsupportedAttributedBody: 0,
    };
    const messages: CorpusMessage[] = [];
    const messageIds = new Set<string>();
    let afterRowId = 0;
    for (;;) {
      const page = messageRows(
        database,
        schema,
        afterRowId,
        pageSize,
        maximumBodyBytes,
        maximumAttributedBodyBytes,
      );
      if (page.length === 0) break;
      const first = page[0]?.sourceRowId;
      const last = page.at(-1)?.sourceRowId;
      if (first === undefined || last === undefined || first <= afterRowId || last < first) {
        return fail("message paging order is inconsistent");
      }
      const joins = loadChatJoins(database, first, last);
      const attachments = loadAttachmentCounts(database, schema, first, last);
      for (const row of page) {
        const id = hmac(key, "message", row.sourceGuid);
        if (messageIds.has(id)) return fail("contains duplicate message GUIDs");
        if (row.isSpam === 1 || row.isCorrupt === 1) {
          warningCounts.spamOrCorrupt += 1;
          continue;
        }
        if (row.textOverBound === 1) {
          return fail(`message text ${id} exceeds the configured body bound`);
        }
        if (row.attributedBodyOverBound === 1) {
          return fail(`attributed body ${id} exceeds the configured attributed-body bound`);
        }
        const sentAt = appleTimestamp(row.dateText);
        if (sentAt === null) {
          warningCounts.unsupportedTimestamp += 1;
          continue;
        }
        const chatIds = joins.get(row.sourceRowId) ?? [];
        const chatId = chatIds[0];
        if (chatId === undefined) {
          warningCounts.missingConversation += 1;
          continue;
        }
        if (chatIds.length > 1) {
          warningCounts.multipleConversations += 1;
        }
        const chat = chats.get(chatId);
        if (chat === undefined) return fail("message references a missing chat");
        if (row.isFromMe === 0 && row.handleId !== null && !handles.has(row.handleId)) {
          warningCounts.missingSenderHandle += 1;
        }
        const decodedBody = messageBody(row, maximumAttributedBodyBytes, maximumBodyBytes);
        if (row.text === null && row.attributedBody !== null && decodedBody.body === null) {
          warningCounts.unsupportedAttributedBody += 1;
        }
        const attachmentCount = attachments.get(row.sourceRowId)
          ?? (row.cacheHasAttachments === 1 ? 1 : 0);
        const kind = messageKind(row, decodedBody.body, attachmentCount);
        const retractedAt = appleTimestamp(row.retractedDateText);
        const retainBody = !hasAppleTimestampMarker(row.retractedDateText)
          && kind !== "reaction"
          && kind !== "system";
        const body = retainBody
          ? decodedBody
          : Object.freeze({ body: null, bodySource: "unavailable" as const });
        messages.push(Object.freeze({
          id,
          sourceRowId: row.sourceRowId,
          sourceGuid: row.sourceGuid,
          conversationId: chat.conversation.id,
          sentAt,
          direction: row.isFromMe === 1 ? "outgoing" : "incoming",
          body: body.body,
          bodySource: body.bodySource,
          kind,
          replyToSourceGuid: (row.threadOriginatorGuid || row.replyToGuid) ?? null,
          replyState: row.threadOriginatorGuid || row.replyToGuid ? "explicit" : "none",
          editedAt: appleTimestamp(row.editedDateText),
          retractedAt,
          service: row.service === "" ? null : row.service,
          attachmentCount,
        }));
        messageIds.add(id);
      }
      afterRowId = last;
    }
    messages.sort((left, right) => {
      const time = left.sentAt.localeCompare(right.sentAt, "en-US");
      return time !== 0 ? time : left.sourceRowId - right.sourceRowId || left.id.localeCompare(right.id, "en-US");
    });
    const conversations = [...chats.values()].map((chat) => chat.conversation)
      .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
    database.exec("COMMIT");
    transactionOpen = false;
    const snapshotSha256 = sha256(stableJson({
      schemaVersion: CORPUS_SCHEMA_VERSION,
      schemaSha256: schema.hash,
      conversations,
      messages,
    }));
    return Object.freeze({
      schemaVersion: CORPUS_SCHEMA_VERSION,
      source: Object.freeze({
        physicalPath: source.path,
        device: source.stats.dev.toString(),
        inode: source.stats.ino.toString(),
        bytes: Number(source.stats.size),
        modifiedAt: sourceModifiedAt(source.stats),
        schemaSha256: schema.hash,
        snapshotSha256,
      }),
      conversations: Object.freeze(conversations),
      messages: Object.freeze(messages),
      warnings: aggregateWarnings(warningCounts, schema.hasAttachmentJoin),
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
