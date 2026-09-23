import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AUTOMATION_PROTOCOL, AutomationOperationError, automationRemoteError, automationBoolean, automationHash, automationId, automationProvider, automationRecord, createGhostgetAutomationClient, type AutomationProvider, type GhostgetAutomationClient, type GhostgetAutomationInvoker } from "../../transport/src/automation.ts";

export interface GhostgetAutomationProcessOptions {
  executable: string;
  runtimeExecutable?: string;
  stateHome?: string;
  custodyDirectory: string;
  providers: readonly { provider: AutomationProvider; authId: string }[];
}
const MAX_FRAME = 24 * 1024 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_ERROR = 65536;
const CLEANUP_GRACE = 36000;
const RECOVERY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000] as const;
const RECOVERED_CUSTODY_LIMIT = 8;
export const AUTOMATION_CUSTODY_FILE = "ghostget-automation-custody.json";

/** Rejects invokes while the supervised transport recreates a faulted child.
 * Callers retry on their next tick; this is never a custody or process-exit
 * verdict and never a remote/provider answer. */
export class GhostgetTransportRecovering extends Error {
  readonly code = "transport-recovering";
  constructor() { super("Ghostget automation transport is recovering"); this.name = "GhostgetTransportRecovering"; }
}
/** The custody file is already claimed. Recovery decides whether it is stale. */
export class GhostgetCustodyHeldError extends Error {}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }

type CustodyRecord = { operationId: string; hostPid: number; processGroup: number | null };
function parseCustodyRecord(value: unknown): CustodyRecord {
  const record = automationRecord(value, ["schemaVersion", "operationId", "hostPid", "processGroup", "configurationSha256", "startedAt", "status"]);
  if (record.schemaVersion !== 1 || typeof record.operationId !== "string" || record.operationId.length > 64
    || !Number.isSafeInteger(record.hostPid) || (record.hostPid as number) < 1
    || !(record.processGroup === null || Number.isSafeInteger(record.processGroup) && (record.processGroup as number) > 0)
    || typeof record.configurationSha256 !== "string" || typeof record.startedAt !== "string" || record.startedAt.length > 64
    || typeof record.status !== "string" || record.status.length > 64) throw new Error("Unrecognized Ghostget custody record");
  return { operationId: record.operationId, hostPid: record.hostPid as number, processGroup: record.processGroup as number | null };
}
async function claim(options: GhostgetAutomationProcessOptions, processGroup: number | null): Promise<() => Promise<void>> {
  const dir = await lstat(options.custodyDirectory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || await realpath(options.custodyDirectory) !== options.custodyDirectory) throw new Error("Ghostget custody needs private physical owner state");
  const path = join(options.custodyDirectory, AUTOMATION_CUSTODY_FILE);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new GhostgetCustodyHeldError("Previous Ghostget automation custody needs owner recovery before another process can start"); }
  const identity = await file.stat();
  try { await file.writeFile(JSON.stringify({ schemaVersion: 1, operationId: randomUUID(), hostPid: process.pid, processGroup, configurationSha256: automationHash(options), startedAt: new Date().toISOString(), status: "in-flight-or-unreconciled" }) + "\n"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(options.custodyDirectory);
  return async () => {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== process.getuid?.() || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error("Ghostget custody identity changed");
    await unlink(path); await syncDirectory(options.custodyDirectory);
  };
}

type CustodyReclaim = "absent" | "reclaimed" | "wait" | "refused";
/** A custody file is evidence, never a lease: it may be reclaimed only when the
 * recorded owner is independently proven dead and its recorded process group is
 * independently proven absent. A live owner or a live group is never touched,
 * and the recovered file is renamed rather than deleted so the takeover is
 * auditable. Missing group evidence means the group might be alive: refuse. */
async function reclaimCustody(directory: string): Promise<CustodyReclaim> {
  const path = join(directory, AUTOMATION_CUSTODY_FILE);
  const observed = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (observed === null) return "absent";
  if (!observed.isFile() || observed.isSymbolicLink() || observed.uid !== process.getuid?.() || observed.nlink !== 1 || (observed.mode & 0o077) !== 0 || observed.size > 8192) throw new Error("Ghostget custody identity changed");
  const record = parseCustodyRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path))));
  const own = record.hostPid === process.pid;
  if (!own && pidAlive(record.hostPid)) return "refused";
  if (record.processGroup !== null && groupAlive(record.processGroup)) return "wait";
  // Re-verify identity and both liveness proofs immediately before the rename:
  // nothing may interpose a live claim between the read and the recovery.
  const again = await lstat(path);
  if (!again.isFile() || again.isSymbolicLink() || again.dev !== observed.dev || again.ino !== observed.ino || again.uid !== process.getuid?.() || again.nlink !== 1 || (again.mode & 0o077) !== 0) throw new Error("Ghostget custody identity changed");
  if (!own && pidAlive(record.hostPid)) return "refused";
  if (record.processGroup !== null && groupAlive(record.processGroup)) return "wait";
  await rename(path, `${path}.recovered-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await syncDirectory(directory);
  const recovered = (await readdir(directory)).filter(name => name.startsWith(`${AUTOMATION_CUSTODY_FILE}.recovered-`)).sort();
  for (const stale of recovered.slice(0, Math.max(0, recovered.length - RECOVERED_CUSTODY_LIMIT))) await unlink(join(directory, stale)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  return "reclaimed";
}

/** Starts only a trusted owner-installed Ghostget CLI. Model requests cannot
 * choose executables, argv, providers, auth IDs, state paths or credentials.
 * A failed/forced shutdown preserves custody, including separately grouped
 * provider children. Exit of this immediate child alone is never sufficient. */
export async function createGhostgetAutomationProcess(input: GhostgetAutomationProcessOptions) {
  const options = structuredClone(input);
  for (const path of [options.executable, options.custodyDirectory, options.runtimeExecutable, options.stateHome]) if (path !== undefined && !isAbsolute(path)) throw new Error("Ghostget host paths must be absolute");
  if (!options.providers.length || options.providers.length > 3 || new Set(options.providers.map(row => row.provider)).size !== options.providers.length) throw new Error("One explicit account per messaging network is required");
  for (const row of options.providers) { automationProvider(row.provider); automationId(row.authId); }
  const environment: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT_EMAIL: "off" };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR"]) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  if (options.stateHome !== undefined) environment.GHOSTGET_STATE_HOME = options.stateHome;
  const argv = ["messaging", "automation", "serve", "--stdio"];
  // The child is spawned before custody is claimed so its detached group can be
  // recorded: later recovery may reclaim this file only when that exact group is
  // independently absent. A refused claim kills the unclaimed child at once,
  // before any initialize frame reaches it.
  const child = spawn(options.runtimeExecutable ?? options.executable, options.runtimeExecutable === undefined ? argv : ["--no-env-file", "--no-install", options.executable, ...argv], { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
  let spawnFailure: Error | undefined;
  const earlyError = (error: Error) => { spawnFailure = error; };
  child.once("error", earlyError);
  let release: () => Promise<void>;
  try { release = await claim(options, child.pid ?? null); }
  catch (error) {
    child.off("error", earlyError); child.on("error", () => { /* settled by close */ });
    if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch { /* close owns the result */ }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    throw error;
  }
  child.off("error", earlyError);
  if (spawnFailure !== undefined || child.pid === undefined) {
    child.on("error", () => { /* settled by close */ });
    if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch { /* close owns the result */ }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    throw new Error("Ghostget automation child failed to start", { cause: spawnFailure });
  }
  type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; abort?: () => void; signal?: AbortSignal };
  const pending = new Map<string, Pending>();
  const chunks: Buffer[] = [];
  let buffered = 0, scanned = 0, errors = 0, fault = false, closing = false, exited = false, cleanAcknowledgment = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined, finalTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectSettlement: ((reason: Error) => void) | undefined, resolveClosed: (() => void) | undefined, rejectClosed: ((reason: Error) => void) | undefined;
  const groupExists = () => { if (child.pid === undefined) return false; return groupAlive(child.pid); };
  const kill = (signal: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch { /* close owns the result */ } } };
  const clear = (id: string, entry: Pending) => { pending.delete(id); clearTimeout(entry.timer); if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort); };
  const stop = () => {
    if (fault) return; fault = true;
    for (const [id, entry] of pending) { clear(id, entry); entry.reject(new AutomationOperationError("transport-unavailable")); }
    kill("SIGTERM"); if (!exited) forceTimer = setTimeout(() => {
      kill("SIGKILL");
      finalTimer = setTimeout(() => {
        // An inherited pipe or an unjoinable child must not trap the owner
        // daemon forever. Retain custody; no receipt or cleanup is fabricated.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        const reason = new Error("Ghostget process did not join; durable custody is retained");
        rejectClosed?.(reason);
        rejectSettlement?.(reason);
      }, 5000);
    }, CLEANUP_GRACE);
  };
  const settled = new Promise<void>((resolve, reject) => {
    rejectSettlement = reject;
    child.once("error", stop);
    child.once("close", (code, signal) => {
      exited = true; if (forceTimer) clearTimeout(forceTimer); if (finalTimer) clearTimeout(finalTimer); resolveClosed?.();
      if (code !== 0 || signal !== null || !cleanAcknowledgment || pending.size || buffered || groupExists()) stop();
      if (fault) reject(new Error("Ghostget automation cleanup needs owner recovery")); else resolve();
    });
  });
  void settled.catch(() => undefined);
  // `closed` resolves on the child's close event regardless of fault and
  // rejects only when the child never joins: the supervisor's independent
  // process-exit signal. Unlike `settled`, a faulted close still resolves it.
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => undefined);
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.length; if (errors > MAX_ERROR) stop(); });
  child.stdout.on("data", (bytes: Buffer) => {
    if (fault) return;
    chunks.push(bytes); buffered += bytes.length;
    try {
      // Frames are extracted straight from the chunk list; bytes are copied
      // only when they form a complete NDJSON frame, never per data event.
      // `scanned` marks head bytes already proven to hold no newline.
      let offset = 0, at = -1;
      for (const chunk of chunks) {
        const from = Math.max(0, scanned - offset);
        if (from < chunk.length) {
          const found = chunk.indexOf(10, from);
          if (found !== -1) { at = offset + found; break; }
        }
        offset += chunk.length;
      }
      if (at === -1) { scanned = buffered; if (buffered > MAX_RESPONSE) throw new Error("Oversized Ghostget frame"); return; }
      while (at !== -1) {
        if (at > MAX_RESPONSE) throw new Error("Oversized Ghostget frame");
        const frame = Buffer.allocUnsafe(at); let copied = 0, index = 0;
        while (copied < at) { const chunk = chunks[index]!; const take = Math.min(chunk.length, at - copied); chunk.copy(frame, copied, 0, take); copied += take; index++; }
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        let drop = at + 1;
        while (drop > 0) { const head = chunks[0]!; if (head.length <= drop) { chunks.shift(); drop -= head.length; } else { chunks[0] = head.subarray(drop); drop = 0; } }
        buffered -= at + 1; scanned = 0;
        const raw = value as Record<string, unknown>;
        const row = automationRecord(value, raw?.ok === true ? ["protocol", "id", "ok", "result"] : ["protocol", "id", "ok", "error"]);
        if (row.protocol !== AUTOMATION_PROTOCOL || typeof row.id !== "string" || typeof row.ok !== "boolean") throw new Error("Ghostget protocol changed");
        const entry = pending.get(row.id); if (!entry) throw new Error("Unexpected Ghostget response");
        if (row.ok) { clear(row.id, entry); entry.resolve(row.result); }
        else {
          const error = automationRecord(row.error, ["code", "message"]);
          if (typeof error.code !== "string" || !["invalid-request", "not-ready", "unavailable", "recovery-required"].includes(error.code) || typeof error.message !== "string" || error.message.length > 1024) throw new Error("Ghostget error contract changed");
          const failure = automationRemoteError(error.code, error.message);
          clear(row.id, entry); entry.reject(failure);
          if (error.code === "recovery-required") stop();
        }
        offset = 0; at = -1;
        for (const chunk of chunks) {
          const found = chunk.indexOf(10);
          if (found !== -1) { at = offset + found; break; }
          offset += chunk.length;
        }
        if (at === -1) scanned = buffered;
      }
      if (buffered > MAX_RESPONSE) throw new Error("Oversized Ghostget frame");
    } catch { stop(); }
  });
  child.stdin.on("error", stop);
  const send: GhostgetAutomationInvoker = (method, params, signal) => {
    if (fault || exited || closing && method !== "close") return Promise.reject(new AutomationOperationError("transport-unavailable"));
    if (pending.size >= 9) return Promise.reject(new AutomationOperationError("queue-capacity"));
    try { signal?.throwIfAborted(); } catch { return Promise.reject(new Error("Ghostget operation cancelled before dispatch")); }
    const id = randomUUID(), frame = JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id, method, params }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME) return Promise.reject(new Error("Ghostget request exceeds its frame bound"));
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: setTimeout(stop, 180000) };
      pending.set(id, entry);
      child.stdin.write(frame, error => { if (error) stop(); });
    });
  };
  let normalChain: Promise<unknown> = Promise.resolve(), queued = 0;
  const invoke: GhostgetAutomationInvoker = (method, params, signal) => {
    if (["cancel", "revoke", "close"].includes(method)) return send(method, params, signal);
    if (queued >= 16) return Promise.reject(new AutomationOperationError("queue-capacity"));
    queued++;
    const task = normalChain.catch(() => undefined).then(() => send(method, params, signal)).finally(() => { queued--; });
    normalChain = task; return task;
  };
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      try {
        const result = automationRecord(await invoke("close", {}), ["closed"]);
        if (!automationBoolean(result.closed)) throw new Error("Ghostget did not acknowledge cleanup");
        cleanAcknowledgment = true; child.stdin.end();
        // A successful response without process exit is not complete cleanup.
        const timer = setTimeout(stop, CLEANUP_GRACE);
        try { await settled; } finally { clearTimeout(timer); }
        await release();
      } catch (error) { stop(); await settled.catch(() => undefined); throw error; }
    })();
    return closePromise;
  };
  try {
    const ready = automationRecord(await invoke("initialize", { providers: options.providers }), ["initialized"]);
    if (ready.initialized !== true) throw new Error("Ghostget automation setup failed");
    return { client: createGhostgetAutomationClient(invoke), invoke, faulted: () => fault || exited, closed, close };
  } catch (error) { stop(); await settled.catch(() => undefined); throw error; }
}

export interface SupervisedGhostgetAutomation {
  readonly client: GhostgetAutomationClient;
  /** Live transport diagnostic for the owner status surface: null while the
   * child is healthy or the supervisor is closed, otherwise the exact
   * "recovering" or "needs attention" detail the daemon should publish. */
  recovery(): { readonly state: "unavailable"; readonly detail: string } | null;
  close(): Promise<void>;
}

/** Keeps one messaging client valid across child-process faults. A faulted or
 * exited child is recreated under bounded backoff after its recorded process
 * group is independently proven absent; until then invokes fail fast so the
 * polling reply loop simply retries on its next tick. Custody of a genuinely
 * live other owner is still refused, and an unjoinable child stops recovery
 * instead of manufacturing exit evidence. */
export async function createSupervisedGhostgetAutomation(input: GhostgetAutomationProcessOptions, dependencies: {
  /** Synthetic tests only: makes recovery scheduling deterministic. */
  delay?: (ms: number) => Promise<void>;
} = {}): Promise<SupervisedGhostgetAutomation> {
  const options = structuredClone(input);
  const sleep = dependencies.delay ?? ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); (timer as unknown as { unref?: () => void }).unref?.(); }));
  type Child = Awaited<ReturnType<typeof createGhostgetAutomationProcess>>;
  let inner: Child | undefined, done = false, unrecoverable = false, attempts = 0, work: Promise<void> | undefined, closePromise: Promise<void> | undefined;

  const watch = (child: Child): void => {
    child.closed.then(() => {
      // The child is proven closed; custody is reclaimed once its recorded
      // process group is independently proven absent too.
      if (done || inner !== child) return;
      inner = undefined; ensure();
    }, () => {
      // An unjoinable child is not proven dead: retain custody and stop.
      if (inner === child) inner = undefined;
      unrecoverable = true;
    });
  };
  const recover = async (): Promise<void> => {
    while (!done && !unrecoverable) {
      await sleep(RECOVERY_DELAYS_MS[Math.min(attempts, RECOVERY_DELAYS_MS.length - 1)]!);
      if (attempts < RECOVERY_DELAYS_MS.length - 1) attempts++;
      let outcome: CustodyReclaim;
      try { outcome = await reclaimCustody(options.custodyDirectory); }
      catch { unrecoverable = true; return; }
      if (outcome === "refused") { unrecoverable = true; return; }
      if (outcome === "wait") continue;
      try {
        const child = await createGhostgetAutomationProcess(options);
        if (done) { await child.close().catch(() => undefined); return; }
        inner = child; attempts = 0; watch(child); return;
      } catch { /* Every failure keeps custody; the bounded schedule retries. */ }
    }
  };
  const ensure = (): void => {
    if (done || unrecoverable || work !== undefined) return;
    // A scheduler or unexpected failure stops recovery rather than escaping.
    work = recover().catch(() => { unrecoverable = true; }).finally(() => { work = undefined; });
  };
  const invoke: GhostgetAutomationInvoker = (method, params, signal) => {
    if (done || unrecoverable) return Promise.reject(new AutomationOperationError("transport-unavailable"));
    const child = inner;
    if (child === undefined || child.faulted()) { ensure(); return Promise.reject(new GhostgetTransportRecovering()); }
    return child.invoke(method, params, signal).catch((error: unknown) => {
      // A local transport fault starts recovery immediately rather than
      // waiting for the close event. A remote "unavailable" code from a still
      // healthy child is only a provider condition, so it is not a kick.
      if (!done && child.faulted() && error instanceof AutomationOperationError && error.code === "transport-unavailable") ensure();
      throw error;
    });
  };
  try {
    inner = await createGhostgetAutomationProcess(options);
  } catch (error) {
    // A previous owner's custody may start here only when it is independently
    // proven dead; any live evidence keeps the original recovery error.
    if (!(error instanceof GhostgetCustodyHeldError)) throw error;
    const outcome = await reclaimCustody(options.custodyDirectory).catch(() => "refused" as const);
    if (outcome !== "reclaimed" && outcome !== "absent") throw error;
    inner = await createGhostgetAutomationProcess(options);
  }
  watch(inner);
  return {
    client: createGhostgetAutomationClient(invoke),
    recovery() {
      if (done || (inner !== undefined && !inner.faulted())) return null;
      return unrecoverable
        ? { state: "unavailable", detail: "Ghostget automation stopped and its process custody could not be proven safe to recover. Owner attention is required before replies resume." }
        : { state: "unavailable", detail: "Ghostget automation is recovering after a transport failure. Automatic replies resume once the child process is verified and restarted." };
    },
    close() {
      closePromise ??= (async () => {
        done = true;
        const child = inner; inner = undefined;
        // Only a healthy child can complete the verified close handshake. A
        // faulted child's custody file is retained for the next owner start.
        if (child !== undefined && !child.faulted()) await child.close();
      })();
      return closePromise;
    },
  };
}
