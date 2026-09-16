import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SqliteAccountLeases } from "@hraness/agentmixer";
import { automationId, parseAutomationGrant, type AutomationGrant } from "../../transport/src/automation-contract.ts";

export type RunState = "running" | "dispatching" | "submitted" | "failed" | "partial" | "indeterminate" | "cancelled" | "ignored" | "abandoned";
export type RunRecord = Readonly<{ id: string; contactId: string; eventId: string; state: RunState; reason: string; planDigest: string | null; startedAt: number; updatedAt: number }>;
export type GrantIntent = Readonly<{ id: string; contactId: string; enrollmentId: string; bindingDigest: string }>;
function grantIntent(value: GrantIntent): GrantIntent {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value.contactId) || !/^[a-f0-9]{64}$/u.test(value.bindingDigest)) throw new Error("Invalid grant intent scope");
  return { id: automationId(value.id), contactId: value.contactId, enrollmentId: automationId(value.enrollmentId), bindingDigest: value.bindingDigest };
}

/** Trusted daemon state, outside agent workspaces. One process owns recovery. */
export class RunJournal {
  private constructor(private readonly database: Database) {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, contactId TEXT NOT NULL, eventId TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT NOT NULL, planDigest TEXT, startedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(contactId, eventId)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_contact ON runs(contactId) WHERE state IN ('running','dispatching');
      CREATE TABLE IF NOT EXISTS pending_grants (id TEXT PRIMARY KEY, contactId TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_intents (id TEXT PRIMARY KEY, contactId TEXT NOT NULL, enrollmentId TEXT NOT NULL, bindingDigest TEXT NOT NULL);`);
  }
  static async open(path: string): Promise<RunJournal> {
    const absolute = resolve(path);
    const parent = dirname(absolute);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await lstat(parent);
    if (await realpath(parent) !== parent || !dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) throw new Error("Journal directory must be owned and private");
    // SQLite opens sibling sidecars itself; preflight every existing path before opening.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const info = await lstat(`${absolute}${suffix}`);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== dir.uid || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error("Unsafe journal file");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const handle = await open(absolute, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await handle.close();
    return new RunJournal(new Database(absolute, { strict: true }));
  }
  static memory(): RunJournal { return new RunJournal(new Database(":memory:", { strict: true })); }
  accountLeases(): SqliteAccountLeases { return new SqliteAccountLeases(this.database); }
  /** Commit before requesting any upstream grant; unknown results are looked up, never recreated. */
  recordGrantIntent(value: GrantIntent): void {
    const intent = grantIntent(value), existing = this.database.query<GrantIntent, [string]>("SELECT * FROM grant_intents WHERE id=?").get(intent.id);
    if (existing && JSON.stringify(grantIntent(existing)) !== JSON.stringify(intent)) throw new Error("Grant intent changed scope");
    if (!existing && (this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM grant_intents").get()?.count ?? 0) >= 1000) throw new Error("Grant intent recovery capacity reached");
    this.database.query("INSERT OR IGNORE INTO grant_intents VALUES(?,?,?,?)").run(intent.id, intent.contactId, intent.enrollmentId, intent.bindingDigest);
  }
  grantIntents(): readonly GrantIntent[] { return this.database.query<GrantIntent, []>("SELECT * FROM grant_intents ORDER BY id LIMIT 1001").all().map(grantIntent); }
  /** Only after authoritative absence or durable conversion to a returned grant. */
  clearGrantIntent(intentId: string): void { this.database.query("DELETE FROM grant_intents WHERE id=?").run(intentId); }
  /** Persist a returned capability before any cancellation check or owner-state publication. */
  recordPendingGrant(contactId: string, value: AutomationGrant, intentId?: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId)) throw new Error("Invalid pending grant contact");
    const grant = parseAutomationGrant(value), bytes = JSON.stringify(grant);
    const existing = this.database.query<{ value: string; contactId: string }, [string]>("SELECT value,contactId FROM pending_grants WHERE id=?").get(grant.id);
    if (existing && (existing.value !== bytes || existing.contactId !== contactId)) throw new Error("Pending grant identity changed");
    if (!existing && (this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pending_grants").get()?.count ?? 0) >= 1000) throw new Error("Pending grant recovery capacity reached");
    this.database.transaction(() => {
      if (intentId !== undefined) {
        const intent = this.database.query<GrantIntent, [string]>("SELECT * FROM grant_intents WHERE id=?").get(intentId);
        if (!intent || intent.contactId !== contactId || intent.enrollmentId !== grant.enrollmentId || intent.bindingDigest !== grant.expectedBindingDigest) throw new Error("Returned grant changed intent scope");
      }
      this.database.query("INSERT OR IGNORE INTO pending_grants VALUES(?,?,?)").run(grant.id, contactId, bytes);
      if (intentId !== undefined) this.clearGrantIntent(intentId);
    })();
  }
  pendingGrants(): readonly { contactId: string; grant: AutomationGrant }[] {
    return this.database.query<{ id: string; contactId: string; value: string }, []>("SELECT id,contactId,value FROM pending_grants ORDER BY id LIMIT 1001").all().map(row => {
      const grant = parseAutomationGrant(JSON.parse(row.value)); if (grant.id !== row.id) throw new Error("Pending grant identity changed");
      return { contactId: row.contactId, grant };
    });
  }
  /** Only after exact owner-state publication or proven revocation. */
  clearPendingGrant(grantId: string): void { this.database.query("DELETE FROM pending_grants WHERE id=?").run(grantId); }
  claim(id: string, contactId: string, eventId: string, now: number): boolean {
    // Check uncertainty in the same statement that claims the contact. Another run
    // may settle while this caller awaits provider readiness or account admission.
    return this.database.query(`INSERT OR IGNORE INTO runs
      SELECT ?, ?, ?, 'running', 'claimed', NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM runs WHERE contactId = ? AND state IN ('partial','indeterminate'))`)
      .run(id, contactId, eventId, now, now, contactId).changes === 1;
  }
  transition(id: string, expected: RunState, state: RunState, reason: string, now: number, planDigest: string | null = null): void {
    if (reason.length > 400 || (planDigest !== null && !/^[a-f0-9]{64}$/u.test(planDigest))) throw new Error("Invalid journal transition");
    const result = this.database.query("UPDATE runs SET state = ?, reason = ?, updatedAt = ?, planDigest = COALESCE(?, planDigest) WHERE id = ? AND state = ?").run(state, reason, now, planDigest, id, expected);
    if (result.changes !== 1) throw new Error("Run state changed");
  }
  recover(now: number): void {
    this.database.transaction(() => {
      this.database.query("UPDATE runs SET state = 'abandoned', reason = 'daemon-restarted', updatedAt = ? WHERE state = 'running'").run(now);
      this.database.query("UPDATE runs SET state = 'indeterminate', reason = 'restart-during-dispatch', updatedAt = ? WHERE state = 'dispatching'").run(now);
    })();
  }
  hasUncertainSend(contactId: string): boolean {
    return this.database.query("SELECT 1 FROM runs WHERE contactId = ? AND state IN ('partial','indeterminate') LIMIT 1").get(contactId) !== null;
  }
  repliesSince(contactId: string, since: number): number {
    const row = this.database.query<{ count: number }, [string, number]>("SELECT COUNT(*) AS count FROM runs WHERE contactId = ? AND startedAt >= ? AND state IN ('dispatching','submitted','partial','indeterminate')").get(contactId, since);
    return row?.count ?? 0;
  }
  recent(contactId: string, limit = 50): readonly RunRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid activity limit");
    return this.database.query<RunRecord, [string, number]>("SELECT * FROM runs WHERE contactId = ? ORDER BY startedAt DESC, id DESC LIMIT ?").all(contactId, limit);
  }
  close(): void { this.database.close(); }
}
