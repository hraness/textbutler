import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, link, lstat, open, rename, unlink } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { assertOwnedPath, ensurePrivateDirectory } from "@hraness/local-custody/private-paths";

const APPLICATION_ID = 0x54424355;
type SocketIdentity = { dev: number; ino: number };
type Custody = { schemaVersion: 1; uid: number; pid: number; generation: string; staging: string; dev: number; ino: number };
const currentUid = (): number => process.getuid?.() ?? -1;
function stopped(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function identity(path: string): Promise<SocketIdentity | null> {
  try {
    return await assertOwnedPath(path, { kind: "socket", exactMode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("An unknown or unsafe Textbutler socket entry already exists.", { cause: error });
  }
}
function same(a: SocketIdentity | null, b: SocketIdentity): boolean { return a !== null && a.dev === b.dev && a.ino === b.ino; }
async function refused(path: string): Promise<boolean> {
  return await new Promise(resolve_ => {
    const socket = connect(path); let settled = false;
    const finish = (value: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve_(value); };
    const timer = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(false));
    // Bun on macOS returns ENOENT for a crash-orphaned socket inode. The caller
    // separately proves the exact recorded inode still exists and its PID died.
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
    socket.once("close", () => finish(false));
  });
}
function parse(value: string): Custody {
  const input: unknown = JSON.parse(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid daemon custody.");
  const item = input as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "dev,generation,ino,pid,schemaVersion,staging,uid" || item.schemaVersion !== 1 || item.uid !== currentUid() || !Number.isSafeInteger(item.pid) || Number(item.pid) < 1 || Number(item.pid) > 2 ** 31 - 1 || !Number.isSafeInteger(item.dev) || Number(item.dev) < 0 || !Number.isSafeInteger(item.ino) || Number(item.ino) < 1 || typeof item.generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(item.generation) || typeof item.staging !== "string" || !/^\.s-[a-f0-9]{8}$/u.test(item.staging)) throw new Error("Invalid daemon custody.");
  return item as unknown as Custody;
}
async function privateFile(path: string): Promise<void> {
  try {
    await assertOwnedPath(path, { kind: "file", ownerOnly: true, canonical: true, maximumBytes: 1_048_576n });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("Unsafe daemon custody database.", { cause: error });
  }
}
async function initializeDatabase(path: string, stateDir: string, applicationId: number): Promise<void> {
  try { await lstat(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staged = join(stateDir, `.custody-${randomUUID()}`);
  const file = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await file.close();
  let db: Database | undefined;
  try {
    db = new Database(staged, { strict: true });
    db.exec("PRAGMA synchronous=FULL"); db.exec("PRAGMA fullfsync=ON"); db.exec(`PRAGMA application_id=${applicationId}`); db.exec("PRAGMA user_version=1"); db.exec("CREATE TABLE ownership (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL)");
    db.close(); db = undefined;
    try { await link(staged, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { db?.close(); await unlink(staged); await syncDirectory(stateDir); }
}

/** Internal owner-state mutex. Committed writes retain the exclusive OS lock. */
export async function acquireOwnerDatabase(dataDir: string, name: "daemon-custody" | "launch-agent-custody"): Promise<Database> {
  if (name !== "daemon-custody" && name !== "launch-agent-custody") throw new Error("Unknown owner lock name.");
  const stateDir = await ensurePrivateDirectory(join(dataDir, "state")), databasePath = join(stateDir, `${name}.sqlite`);
  const applicationId = name === "daemon-custody" ? APPLICATION_ID : APPLICATION_ID + 1;
  await initializeDatabase(databasePath, stateDir, applicationId); await privateFile(databasePath);
  for (const suffix of ["-journal", "-wal", "-shm"]) { try { await privateFile(`${databasePath}${suffix}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  const db = new Database(databasePath, { strict: true });
  try {
    // Separate calls: Bun may continue a multi-statement exec after BEGIN fails,
    // which would obscure SQLITE_BUSY with the subsequent COMMIT error.
    db.exec("PRAGMA busy_timeout=0"); db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE"); db.exec("COMMIT");
    if ((db.query("PRAGMA application_id").get() as { application_id: number }).application_id !== applicationId || (db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 1 || (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='ownership'").get() as { sql?: string } | null)?.sql !== "CREATE TABLE ownership (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL)") throw new Error("Unrecognized daemon custody database.");
    db.exec("PRAGMA journal_mode=DELETE"); db.exec("PRAGMA synchronous=FULL"); db.exec("PRAGMA fullfsync=ON");
    return db;
  } catch (error) { db.close(); if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("A Textbutler daemon or lifecycle owner already exists."); throw error; }
}

/** An OS-released SQLite exclusive lock, retained across committed custody updates. */
export class DaemonCustody {
  private closed = false;
  private published: SocketIdentity | undefined;
  private readonly staging: string;
  private constructor(private readonly dataDir: string, private readonly db: Database, readonly socketPath: string) { this.staging = join(dataDir, `.s-${randomBytes(4).toString("hex")}`); }

  static async acquire(dataDir: string, socketPath: string): Promise<DaemonCustody> {
    const db = await acquireOwnerDatabase(dataDir, "daemon-custody");
    try {
      const custody = new DaemonCustody(dataDir, db, socketPath);
      await custody.recover();
      return custody;
    } catch (error) { db.close(); throw error; }
  }
  private read(): Custody | null {
    const rows = this.db.query("SELECT id,value FROM ownership").all() as { id: number; value: string }[];
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0]!.id !== 1 || typeof rows[0]!.value !== "string" || Buffer.byteLength(rows[0]!.value) > 4096) throw new Error("Invalid daemon custody rows.");
    return parse(rows[0]!.value);
  }
  private async recover(): Promise<void> {
    const record = this.read(), canonical = await identity(this.socketPath);
    if (record === null) { if (canonical) throw new Error("An unrecorded Textbutler socket entry already exists."); return; }
    if (!stopped(record.pid)) throw new Error("The recorded Textbutler socket owner is still active or uncertain.");
    const staged = join(this.dataDir, record.staging), stagedIdentity = await identity(staged);
    for (const [path, found] of [[this.socketPath, canonical], [staged, stagedIdentity]] as const) {
      if (found === null) continue;
      if (!same(found, record) || !await refused(path) || !same(await identity(path), record) || !stopped(record.pid)) throw new Error("The recorded Textbutler socket is replaced, served, or uncertain.");
      await unlink(path); await syncDirectory(this.dataDir);
    }
    this.db.exec("DELETE FROM ownership;");
  }
  /** Bind privately, commit inode custody, then publish the canonical socket name. */
  async publish(server: Server): Promise<void> {
    if (this.closed || this.published) throw new Error("Daemon custody is not available for publication.");
    if (Buffer.byteLength(this.staging) > 100) throw new Error("Textbutler staging socket exceeds its platform limit.");
    await new Promise<void>((resolve_, reject) => {
      const failed = (error: Error): void => { server.off("listening", ready); reject(error); };
      const ready = (): void => { server.off("error", failed); resolve_(); };
      server.once("error", failed); server.once("listening", ready); server.listen(this.staging);
    });
    await chmod(this.staging, 0o600);
    const bound = (await identity(this.staging))!;
    const record: Custody = { schemaVersion: 1, uid: currentUid(), pid: process.pid, generation: randomUUID(), staging: this.staging.slice(this.dataDir.length + 1), ...bound };
    this.db.query("INSERT INTO ownership (id,value) VALUES (1,?)").run(JSON.stringify(record));
    if (await identity(this.socketPath) !== null) throw new Error("A Textbutler socket entry already exists.");
    await rename(this.staging, this.socketPath); this.published = bound;
    await syncDirectory(this.dataDir);
  }
  /** Caller closes the listener first. A changed pathname is always preserved. */
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try {
      const record = this.read();
      if (record !== null && record.pid === process.pid) {
        for (const target of [this.socketPath, join(this.dataDir, record.staging)]) {
          const found = await identity(target);
          if (found === null) continue;
          if (!same(found, record)) throw new Error("The daemon socket changed before cleanup; its custody is retained.");
          await unlink(target); await syncDirectory(this.dataDir);
        }
        this.db.exec("DELETE FROM ownership;");
      }
    } finally { this.db.close(); }
  }
}
