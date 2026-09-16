import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect, Layer } from "effect";
import { commandFailure, type CommandFailure } from "./command-failure.ts";
import { CliError } from "./errors.ts";
import { SKILL_INSTALL_PAIR, type SkillInstallName, type SkillInstallPlan, type SkillInstallTransaction } from "./skill-install-model.ts";
import { SkillInstallPlatform, type SkillInstallPlatformService } from "./skill-install-program.ts";
import { bundledEnsoulSkillPath, bundledSkillPath, type SkillInstallOptions } from "./skill-install.ts";

// The bundled pair currently has 22 files, seven directories and 175,482 bytes.
// These per-skill bounds also apply to a forced replacement's cleanup inventory.
const MAX_ENTRIES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
type Entry = Readonly<{ name: string; stat: BigIntStats; digest?: string }>;
type Observation = Readonly<{ path: string; stat: BigIntStats }>;
type Inventory = readonly Entry[];
type Item = Readonly<{ source: string; destination: string; sourceInventory: Inventory; original: Inventory | null }>;
type Plan = { parents: Observation[]; missing: string[]; root: string; items: Record<SkillInstallName, Item> };
type ItemState = { stage: string; backup: string; staged: Entry[]; backupAttempted: boolean; publishAttempted: boolean };
type Transaction = { plan: Plan; lock: string; lockAttempted: boolean; lockStat?: BigIntStats; directory: string; directoryAttempted: boolean; directoryStat?: BigIntStats; items: Record<SkillInstallName, ItemState> };

const plans = new WeakMap<SkillInstallPlan, Plan>();
const transactions = new WeakMap<SkillInstallTransaction, Transaction>();
const unsafe = (): CliError => new CliError("unsafe-path", "Skill installation path changed or cannot be used safely");
const bounded = (): CliError => new CliError("invalid-data", "Skill directory exceeds the supported physical inventory bounds");
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function optionalStat(path: string): Promise<BigIntStats | null> {
  try { return await fs.lstat(path, { bigint: true }); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}
function physical(stat: BigIntStats): void {
  if (typeof process.getuid !== "function" || (!stat.isDirectory() && !stat.isFile()) || stat.uid !== BigInt(process.getuid())) throw unsafe();
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
    && left.isDirectory() === right.isDirectory()
    && (left.isDirectory() || (left.size === right.size && left.nlink === right.nlink
      && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs));
}
async function assertIdentity(path: string, expected: BigIntStats): Promise<void> {
  const actual = await optionalStat(path);
  if (actual === null || !same(actual, expected)) throw unsafe();
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

/** Neither a raw primary nor a raw cleanup value is used as an absence sentinel. */
class ReadCloseFailure {
  constructor(readonly primary: unknown, readonly cleanup: unknown) {}
}
function nativeFailure(error: unknown): CommandFailure & { readonly nativeCleanupCauses?: readonly unknown[] } {
  const cleanup: unknown[] = [];
  while (error instanceof ReadCloseFailure) {
    cleanup.push(error.cleanup);
    error = error.primary;
  }
  return cleanup.length === 0 ? commandFailure(error)
    : { ...commandFailure(error), nativeCleanupCauses: Object.freeze(cleanup.reverse()) };
}

/** Bounded descriptor reads retain both causes without mutating foreign errors. */
async function digestFile(path: string, expected: BigIntStats): Promise<string> {
  if (expected.size > BigInt(MAX_FILE_BYTES) || expected.size < 0n) throw bounded();
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let result: { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: unknown };
  try {
    if (!same(await handle.stat({ bigint: true }), expected)) throw unsafe();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(16 * 1024);
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(expected.size) + 1 - count), count);
      count += bytesRead;
      if (count > Number(expected.size)) throw unsafe();
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (count !== Number(expected.size) || !same(await handle.stat({ bigint: true }), expected)) throw unsafe();
    result = { ok: true, value: hash.digest("hex") };
  } catch (error) { result = { ok: false, error }; }
  try { await handle.close(); }
  catch (error) { if (!result.ok) throw new ReadCloseFailure(result.error, error); throw error; }
  if (!result.ok) throw result.error;
  return result.value;
}

async function inventory(root: string): Promise<Inventory> {
  const entries: Entry[] = [];
  let bytes = 0n;
  const visit = async (name: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || name.length > 4096 || entries.length >= MAX_ENTRIES) throw bounded();
    const path = join(root, name);
    const stat = await fs.lstat(path, { bigint: true });
    physical(stat);
    if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > BigInt(MAX_TOTAL_BYTES)) throw bounded();
      entries.push({ name, stat, digest: await digestFile(path, stat) });
    } else {
      entries.push({ name, stat });
      // Incremental directory reads bound input before building any entry array.
      const directory = await fs.opendir(path);
      let read: { readonly ok: true } | { readonly ok: false; readonly error: unknown } = { ok: true };
      try {
        for (;;) {
          const child = await directory.read();
          if (child === null) break;
          await visit(join(name, child.name), depth + 1);
        }
      } catch (error) { read = { ok: false, error }; }
      try { await directory.close(); }
      catch (error) { if (!read.ok) throw new ReadCloseFailure(read.error, error); throw error; }
      if (!read.ok) throw read.error;
      await assertIdentity(path, stat);
    }
  };
  await visit("", 0);
  if (!entries[0]?.stat.isDirectory()) throw unsafe();
  return entries;
}

function sameContents(left: Inventory, right: Inventory): boolean {
  const byName = new Map(right.map(entry => [entry.name, entry]));
  return left.length === right.length && left.every(entry => {
    const other = byName.get(entry.name);
    return other !== undefined && entry.stat.isDirectory() === other.stat.isDirectory()
      && entry.stat.size === (entry.stat.isFile() ? other.stat.size : entry.stat.size)
      && entry.digest === other.digest;
  });
}
async function assertInventory(root: string, expected: Inventory): Promise<void> {
  const actual = await inventory(root);
  if (!sameContents(expected, actual)) throw unsafe();
  const byName = new Map(actual.map(entry => [entry.name, entry.stat]));
  if (!expected.every(entry => { const value = byName.get(entry.name); return value !== undefined && same(entry.stat, value); })) throw unsafe();
}
async function parents(plan: Plan): Promise<void> {
  for (const parent of plan.parents) await assertIdentity(parent.path, parent.stat);
}
function state(token: SkillInstallTransaction): Transaction {
  const value = transactions.get(token);
  if (value === undefined) throw unsafe();
  return value;
}
async function custody(transaction: Transaction): Promise<void> {
  await parents(transaction.plan);
  if (transaction.lockStat !== undefined) await assertIdentity(transaction.lock, transaction.lockStat);
  if (transaction.directoryStat !== undefined) await assertIdentity(transaction.directory, transaction.directoryStat);
}
async function absent(path: string): Promise<void> { if (await optionalStat(path) !== null) throw unsafe(); }

/** Resolve existing aliases once, then acquire only the bounded missing suffix. */
async function projectAnchor(requested: string): Promise<{ anchor: string; parents: Observation[]; missing: string[] }> {
  let cursor = resolve(requested);
  if (Buffer.byteLength(cursor, "utf8") > 4096) throw unsafe();
  const suffix: string[] = [];
  for (;;) {
    let existing: string;
    try { existing = await fs.realpath(cursor); }
    catch (error) {
      if (!isMissing(error)) throw error;
      // A dangling alias is not a missing directory we are entitled to create.
      if (await optionalStat(cursor) !== null || suffix.length >= 64) throw unsafe();
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
      continue;
    }
    const stat = await fs.lstat(existing, { bigint: true });
    physical(stat);
    if (!stat.isDirectory()) throw unsafe();
    const missing: string[] = [];
    let anchor = existing;
    for (const name of suffix.reverse()) { anchor = join(anchor, name); missing.push(anchor); }
    return { anchor, parents: [{ path: existing, stat }], missing };
  }
}

async function preflight(options: SkillInstallOptions): Promise<Plan> {
  const { anchor, parents: observed, missing } = await projectAnchor(options.scope === "user" ? homedir() : options.projectDirectory ?? process.cwd());
  const folder = options.target === "agents" ? ".agents" : options.target === "codex" ? ".codex" : ".claude";
  const root = join(anchor, folder, "skills");
  for (const path of [join(anchor, folder), root]) {
    const stat = await optionalStat(path);
    if (stat === null) missing.push(path);
    else {
      physical(stat);
      if (!stat.isDirectory()) throw unsafe();
      observed.push({ path, stat });
    }
  }
  const items = {} as Record<SkillInstallName, Item>;
  for (const name of SKILL_INSTALL_PAIR) {
    const sourcePath = name === "message-like-me" ? bundledSkillPath() : bundledEnsoulSkillPath();
    const sourceStat = await optionalStat(sourcePath);
    if (sourceStat === null) throw new CliError("not-found", `Bundled ${name} skill is missing at ${sourcePath}`);
    physical(sourceStat);
    if (!sourceStat.isDirectory()) throw unsafe();
    const source = await fs.realpath(sourcePath);
    if (contains(source, root) || contains(root, source)) throw unsafe();
    const sourceInventory = await inventory(source);
    const destination = join(root, name);
    const current = await optionalStat(destination);
    if (current !== null) {
      physical(current);
      if (!current.isDirectory()) throw new CliError("unsafe-path", `Refusing to replace non-directory ${destination}`);
      if (!options.force) throw new CliError("conflict", `Skill already exists at ${destination}; pass --force to replace both bundled skills`);
    }
    items[name] = { source, destination, sourceInventory, original: current === null ? null : await inventory(destination) };
  }
  return { parents: observed, missing, root, items };
}

/** Remove only individually observed leaves, then empty directories; never sweep unknown contents. */
async function removeObserved(transaction: Transaction, root: string, entries: Inventory): Promise<void> {
  for (const entry of [...entries].reverse()) {
    await custody(transaction);
    for (const parent of entries) {
      if (parent.stat.isDirectory() && contains(join(root, parent.name), join(root, entry.name))) {
        await assertIdentity(join(root, parent.name), parent.stat);
      }
    }
    const path = join(root, entry.name);
    await assertIdentity(path, entry.stat);
    if (entry.stat.isDirectory()) await fs.rmdir(path);
    else await fs.unlink(path);
  }
}

const foreign = <A>(operation: () => Promise<A>): Effect.Effect<A, CommandFailure> =>
  Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: nativeFailure }));

export const skillInstallPlatform: SkillInstallPlatformService = {
  preflight: options => foreign(async () => {
    const plan = await preflight(options);
    const token: SkillInstallPlan = Object.freeze({ _tag: "SkillInstallPlan" });
    plans.set(token, plan);
    return token;
  }),
  transaction: token => Effect.try({ try: () => {
    const plan = plans.get(token);
    if (plan === undefined) throw unsafe();
    const directory = join(plan.root, `.skill-install.${randomBytes(16).toString("hex")}`);
    const itemState = (name: SkillInstallName): ItemState => ({ stage: join(directory, `${name}.stage`), backup: join(directory, `${name}.backup`), staged: [], backupAttempted: false, publishAttempted: false });
    const transaction: SkillInstallTransaction = Object.freeze({ _tag: "SkillInstallTransaction" });
    transactions.set(transaction, { plan, lock: join(plan.root, ".message-like-me.install-lock"), lockAttempted: false, directory, directoryAttempted: false,
      items: { "message-like-me": itemState("message-like-me"), ensoul: itemState("ensoul") } });
    return transaction;
  }, catch: commandFailure }),
  acquire: token => foreign(async () => {
    const transaction = state(token);
    await parents(transaction.plan);
    for (const path of transaction.plan.missing) {
      await parents(transaction.plan);
      await fs.mkdir(path, { mode: 0o700 });
      const stat = await fs.lstat(path, { bigint: true });
      physical(stat);
      if (!stat.isDirectory()) throw unsafe();
      transaction.plan.parents.push({ path, stat });
    }
    await parents(transaction.plan);
    transaction.lockAttempted = true;
    await fs.mkdir(transaction.lock, { mode: 0o700 });
    transaction.lockStat = await fs.lstat(transaction.lock, { bigint: true });
    physical(transaction.lockStat);
    if (!transaction.lockStat.isDirectory()) throw unsafe();
    await custody(transaction);
    transaction.directoryAttempted = true;
    await fs.mkdir(transaction.directory, { mode: 0o700 });
    transaction.directoryStat = await fs.lstat(transaction.directory, { bigint: true });
    physical(transaction.directoryStat);
    if (!transaction.directoryStat.isDirectory()) throw unsafe();
  }),
  copy: (token, name) => foreign(async () => {
    const transaction = state(token);
    const item = transaction.plan.items[name];
    const current = transaction.items[name];
    await custody(transaction);
    await assertInventory(item.source, item.sourceInventory);
    for (const entry of item.sourceInventory) {
      await custody(transaction);
      for (const parent of current.staged) {
        if (parent.stat.isDirectory() && contains(join(current.stage, parent.name), join(current.stage, entry.name))) {
          await assertIdentity(join(current.stage, parent.name), parent.stat);
        }
      }
      const target = join(current.stage, entry.name);
      await assertIdentity(join(item.source, entry.name), entry.stat);
      if (entry.stat.isDirectory()) await fs.mkdir(target, { mode: 0o700 });
      else await fs.cp(join(item.source, entry.name), target, { force: false, errorOnExist: true, dereference: false });
      const stat = await fs.lstat(target, { bigint: true });
      physical(stat);
      if (stat.isDirectory() !== entry.stat.isDirectory()) throw unsafe();
      // Register each acknowledged owned entry before any subsequent native work.
      current.staged.push({ name: entry.name, stat, ...(entry.digest === undefined ? {} : { digest: entry.digest }) });
    }
    const copied = await inventory(current.stage);
    if (!sameContents(item.sourceInventory, copied)) throw unsafe();
    await assertInventory(item.source, item.sourceInventory);
    // Stage identities include the actual copied bytes, not an assumed cp result.
    current.staged = [...copied];
  }),
  backup: (token, name) => foreign(async () => {
    const transaction = state(token);
    const item = transaction.plan.items[name];
    const current = transaction.items[name];
    await custody(transaction);
    await absent(current.backup);
    if (item.original === null) { await absent(item.destination); return; }
    await assertInventory(item.destination, item.original);
    await custody(transaction);
    current.backupAttempted = true;
    await fs.rename(item.destination, current.backup);
  }),
  publish: (token, name) => foreign(async () => {
    const transaction = state(token);
    const item = transaction.plan.items[name];
    const current = transaction.items[name];
    await custody(transaction);
    await assertInventory(current.stage, current.staged);
    await custody(transaction);
    await absent(item.destination);
    current.publishAttempted = true;
    await fs.rename(current.stage, item.destination);
  }),
  cleanup: (token, name, phase) => foreign(async () => {
    const transaction = state(token);
    if (phase === "lock-cleanup") {
      if (transaction.lockStat === undefined) {
        if (transaction.lockAttempted) { await parents(transaction.plan); await absent(transaction.lock); }
        return;
      }
      await parents(transaction.plan);
      await assertIdentity(transaction.lock, transaction.lockStat);
      await fs.rmdir(transaction.lock);
      return;
    }
    if (phase === "transaction-cleanup") {
      if (transaction.directoryStat === undefined) {
        if (transaction.directoryAttempted) { await parents(transaction.plan); await absent(transaction.directory); }
        return;
      }
      await custody(transaction);
      await fs.rmdir(transaction.directory);
      return;
    }
    if (name === "pair") throw unsafe();
    const current = transaction.items[name];
    const item = transaction.plan.items[name];
    if (phase === "rollback-published") {
      if (!current.publishAttempted) return;
      await custody(transaction);
      const destination = await optionalStat(item.destination);
      if (destination === null) return;
      const root = current.staged[0];
      if (root === undefined || !same(root.stat, destination)) throw unsafe();
      await removeObserved(transaction, item.destination, current.staged);
    } else if (phase === "restore-backup") {
      if (!current.backupAttempted || item.original === null) return;
      await custody(transaction);
      if (await optionalStat(current.backup) === null) {
        await assertInventory(item.destination, item.original);
        return;
      }
      await assertInventory(current.backup, item.original);
      await absent(item.destination);
      await fs.rename(current.backup, item.destination);
    } else if (phase === "stage-cleanup") {
      if (current.staged.length === 0) return;
      await custody(transaction);
      if (await optionalStat(current.stage) !== null) await removeObserved(transaction, current.stage, current.staged);
    } else if (phase === "backup-cleanup") {
      if (item.original !== null) await removeObserved(transaction, current.backup, item.original);
    }
  }),
  destinations: token => foreign(async () => {
    const transaction = state(token);
    await custody(transaction);
    for (const name of SKILL_INSTALL_PAIR) await assertInventory(transaction.plan.items[name].destination, transaction.items[name].staged);
    return Object.freeze({ messageLikeMe: await fs.realpath(transaction.plan.items["message-like-me"].destination), ensoul: await fs.realpath(transaction.plan.items.ensoul.destination) });
  }),
};

export const skillInstallPlatformLive = Layer.succeed(SkillInstallPlatform, skillInstallPlatform);
