import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SqliteAccountLeases } from "@hraness/agentmixer";
import { automationId, parseAutomationGrant, type AutomationGrant } from "../../transport/src/automation-contract.ts";

export type RunState = "running" | "dispatching" | "submitted" | "failed" | "partial" | "indeterminate" | "cancelled" | "ignored" | "abandoned";
export type RunRecord = Readonly<{ id: string; contactId: string; eventId: string; state: RunState; reason: string; planDigest: string | null; startedAt: number; updatedAt: number }>;
export type GrantIntent = Readonly<{ id: string; contactId: string; enrollmentId: string; bindingDigest: string }>;
const RUN_RETENTION_MS = 90 * 86_400_000;
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
      CREATE INDEX IF NOT EXISTS runs_updated ON runs(updatedAt);
      CREATE TABLE IF NOT EXISTS pending_grants (id TEXT PRIMARY KEY, contactId TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_intents (id TEXT PRIMARY KEY, contactId TEXT NOT NULL, enrollmentId TEXT NOT NULL, bindingDigest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sent_messages (messageId TEXT PRIMARY KEY, contactId TEXT NOT NULL, runId TEXT NOT NULL, sentAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sent_messages_contact ON sent_messages(contactId, sentAt);
      CREATE TABLE IF NOT EXISTS habitat_state (contactId TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_reservations (id TEXT PRIMARY KEY, day INTEGER NOT NULL, microUsd INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS api_reservations_day ON api_reservations(day);
      CREATE TABLE IF NOT EXISTS api_settlements (id TEXT PRIMARY KEY, generationId TEXT UNIQUE NOT NULL, microUsd INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS habitat_evidence (contactId TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(contactId,digest));`);
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
  apiUsage(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid usage clock");
    return this.database.query<{ total: number }, [number]>("SELECT COALESCE(SUM(COALESCE(s.microUsd,r.microUsd)),0) AS total FROM api_reservations r LEFT JOIN api_settlements s ON s.id=r.id WHERE r.day=?")
      .get(Math.floor(now / 86_400_000))!.total;
  }
  reserveApiUsage(id: string, now: number, microUsd: number, limit: number): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(id) || !Number.isSafeInteger(microUsd) || microUsd < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000_000) throw Error("Invalid API reservation");
    this.database.transaction(() => {
      if (this.database.query("SELECT 1 FROM api_reservations WHERE id=?").get(id)) throw Error("API operation already reserved; no retry");
      if (this.apiUsage(now) + microUsd > limit) throw Error("Daily API budget exhausted");
      this.database.query("DELETE FROM api_reservations WHERE day < ?").run(Math.floor(now / 86_400_000) - 90);
      if ((this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM api_reservations").get()?.count ?? 0) >= 100_000) throw Error("API reservation capacity reached");
      this.database.query("INSERT INTO api_reservations VALUES(?,?,?)").run(id, Math.floor(now / 86_400_000), microUsd);
    })();
  }
  /** Provider-reported cost replaces the reservation's conservative estimate. The provider's
   * generation identity deduplicates settlement of an ambiguous response; absent it, the
   * original reservation stands. */
  settleApiUsage(id: string, generationId: string, microUsd: number): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(generationId) || !Number.isSafeInteger(microUsd) || microUsd < 1 || microUsd > 10_000_000) throw Error("Invalid API settlement");
    this.database.transaction(() => {
      if (!this.database.query("SELECT 1 FROM api_reservations WHERE id=?").get(id)) throw Error("API settlement identity changed");
      const previous = this.database.query<{ generationId: string; microUsd: number }, [string]>("SELECT generationId,microUsd FROM api_settlements WHERE id=?").get(id);
      if (previous) { if (previous.generationId !== generationId || previous.microUsd !== microUsd) throw Error("API settlement identity changed"); return; }
      this.database.query("INSERT INTO api_settlements VALUES(?,?,?)").run(id, generationId, microUsd);
      if ((this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM api_settlements").get()?.count ?? 0) > 100_000) throw Error("API settlement capacity reached");
      this.database.query("DELETE FROM api_settlements WHERE id NOT IN (SELECT id FROM api_reservations)").run();
    })();
  }
  recordHabitatEvidence(contactId: string, digest: string, value: string, now: number): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId) || !/^sha256:[a-f0-9]{64}$/u.test(digest)
      || Buffer.byteLength(value) > 262_144 || !Number.isSafeInteger(now) || now < 0) throw Error("Invalid habitat evidence");
    this.database.transaction(() => {
      const previous = this.database.query<{ value: string }, [string, string]>("SELECT value FROM habitat_evidence WHERE contactId=? AND digest=?").get(contactId, digest);
      if (previous && previous.value !== value) throw Error("Habitat evidence identity changed");
      if (previous) return;
      if ((this.database.query<{ count: number }, []>("SELECT COUNT(DISTINCT contactId) AS count FROM habitat_evidence").get()?.count ?? 0) >= 128
        && !this.database.query("SELECT 1 FROM habitat_evidence WHERE contactId=? LIMIT 1").get(contactId)) throw Error("Habitat evidence capacity reached");
      this.database.query("INSERT INTO habitat_evidence VALUES(?,?,?,?)").run(contactId, digest, value, now);
      this.database.query("DELETE FROM habitat_evidence WHERE contactId=? AND digest NOT IN (SELECT digest FROM habitat_evidence WHERE contactId=? ORDER BY at DESC,digest DESC LIMIT 32)").run(contactId, contactId);
    })();
  }
  habitatEvidence(contactId: string, digest: string): string | null {
    return this.database.query<{ value: string }, [string, string]>("SELECT value FROM habitat_evidence WHERE contactId=? AND digest=?").get(contactId, digest)?.value ?? null;
  }
  habitatState(contactId: string): { revision: number; value: string } | null {
    return this.database.query<{ revision: number; value: string }, [string]>("SELECT revision,value FROM habitat_state WHERE contactId=?").get(contactId);
  }
  writeHabitatState(contactId: string, expectedRevision: number, value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || Buffer.byteLength(value) > 524_288) throw Error("Invalid habitat state");
    this.database.transaction(() => {
      const previous = this.habitatState(contactId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw Error("Habitat state conflict");
      if (!previous && (this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM habitat_state").get()?.count ?? 0) >= 128) throw Error("Habitat capacity reached");
      this.database.query("INSERT INTO habitat_state VALUES(?,?,?) ON CONFLICT(contactId) DO UPDATE SET revision=excluded.revision,value=excluded.value")
        .run(contactId, expectedRevision + 1, value);
    })();
  }
  /** Commit before requesting any upstream grant; unknown results are looked up, never recreated. */
  recordGrantIntent(value: GrantIntent): void {
    const intent = grantIntent(value), existing = this.database.query<GrantIntent, [string]>("SELECT * FROM grant_intents WHERE id=?").get(intent.id);
    if (existing && JSON.stringify(grantIntent(existing)) !== JSON.stringify(intent)) throw new Error("Grant intent changed scope");
    if (!existing && (this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM grant_intents").get()?.count ?? 0) >= 1000) throw new Error("Grant intent recovery capacity reached");
    this.database.query("INSERT OR IGNORE INTO grant_intents VALUES(?,?,?,?)").run(intent.id, intent.contactId, intent.enrollmentId, intent.bindingDigest);
  }
  grantIntents(contactId?: string): readonly GrantIntent[] {
    return (contactId === undefined
      ? this.database.query<GrantIntent, []>("SELECT * FROM grant_intents ORDER BY id LIMIT 1001").all()
      : this.database.query<GrantIntent, [string]>("SELECT * FROM grant_intents WHERE contactId = ? ORDER BY id LIMIT 1001").all(contactId)).map(grantIntent);
  }
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
  pendingGrants(contactId?: string): readonly { contactId: string; grant: AutomationGrant }[] {
    return (contactId === undefined
      ? this.database.query<{ id: string; contactId: string; value: string }, []>("SELECT id,contactId,value FROM pending_grants ORDER BY id LIMIT 1001").all()
      : this.database.query<{ id: string; contactId: string; value: string }, [string]>("SELECT id,contactId,value FROM pending_grants WHERE contactId = ? ORDER BY id LIMIT 1001").all(contactId)).map(row => {
      const grant = parseAutomationGrant(JSON.parse(row.value)); if (grant.id !== row.id) throw new Error("Pending grant identity changed");
      return { contactId: row.contactId, grant };
    });
  }
  /** Only after exact owner-state publication or proven revocation. */
  clearPendingGrant(grantId: string): void { this.database.query("DELETE FROM pending_grants WHERE id=?").run(grantId); }
  claim(id: string, contactId: string, eventId: string, now: number): boolean {
    // Check uncertainty in the same statement that claims the contact. Another run
    // may settle while this caller awaits provider readiness or account admission.
    let claimed = false;
    this.database.transaction(() => {
      this.database.query("DELETE FROM runs WHERE state NOT IN ('partial','indeterminate') AND updatedAt < ?").run(now - RUN_RETENTION_MS);
      claimed = this.database.query(`INSERT OR IGNORE INTO runs
        SELECT ?, ?, ?, 'running', 'claimed', NULL, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM runs WHERE contactId = ? AND state IN ('partial','indeterminate'))`)
        .run(id, contactId, eventId, now, now, contactId).changes === 1;
    })();
    return claimed;
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
  /** Every open send intent blocks this contact until an owner-attested or
   * observed-history resolution. Never auto-resolve on age alone. */
  uncertainRuns(contactId: string): readonly RunRecord[] {
    return this.database.query<RunRecord, [string]>("SELECT * FROM runs WHERE contactId = ? AND state IN ('partial','indeterminate') ORDER BY startedAt DESC LIMIT 8").all(contactId);
  }
  reconcile(runId: string, state: "submitted" | "failed" | "abandoned", reason: string, now: number): void {
    if (reason.length > 400 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid journal reconciliation");
    const result = this.database.query("UPDATE runs SET state = ?, reason = ?, updatedAt = ? WHERE id = ? AND state IN ('partial','indeterminate')").run(state, reason, now, runId);
    if (result.changes !== 1) throw new Error("Run state changed");
  }
  /** Trusted provenance for disclosure-free sends: which upstream message IDs this
   * daemon dispatched. Cleared markers never leave butler output indistinguishable. */
  recordSentMessages(contactId: string, runId: string, messageIds: readonly (string | null)[], now: number): void {
    const ids = messageIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 512);
    if (!ids.length) return;
    this.database.transaction(() => {
      this.database.query("DELETE FROM sent_messages WHERE sentAt < ?").run(now - 90 * 86_400_000);
      for (const id of ids.slice(0, 8)) this.database.query("INSERT OR IGNORE INTO sent_messages VALUES(?,?,?,?)").run(id, contactId, runId, now);
      while ((this.database.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM sent_messages WHERE contactId = ?").get(contactId)?.count ?? 0) > 2000) {
        this.database.query("DELETE FROM sent_messages WHERE contactId = ? AND sentAt = (SELECT MIN(sentAt) FROM sent_messages WHERE contactId = ?)").run(contactId, contactId);
      }
    })();
  }
  isButlerMessage(contactId: string, messageId: string): boolean {
    return this.database.query("SELECT 1 FROM sent_messages WHERE messageId = ? AND contactId = ? LIMIT 1").get(messageId, contactId) !== null;
  }
  /** Self-chat inbound echoes arrive under fresh IDs; text-less ones carry no
   * disclosure wrap, so send recency is the only signal they are ours. */
  lastButlerSendAt(contactId: string): number | null {
    const row = this.database.query<{ sentAt: number | null }, [string]>("SELECT MAX(sentAt) AS sentAt FROM sent_messages WHERE contactId = ?").get(contactId);
    return row?.sentAt ?? null;
  }
  /** Message IDs are provider-unique; bootstrap uses the global form before a contact exists. */
  knownSentMessage(messageId: string): boolean {
    return this.database.query("SELECT 1 FROM sent_messages WHERE messageId = ? LIMIT 1").get(messageId) !== null;
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
