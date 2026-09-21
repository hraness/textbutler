import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AUTOMATION_PROTOCOL, AutomationOperationError, automationRemoteError, automationBoolean, automationHash, automationId, automationProvider, automationRecord, createGhostgetAutomationClient, type AutomationProvider, type GhostgetAutomationInvoker } from "../../transport/src/automation.ts";

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
export const AUTOMATION_CUSTODY_FILE = "ghostget-automation-custody.json";
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function claim(options: GhostgetAutomationProcessOptions): Promise<() => Promise<void>> {
  const dir = await lstat(options.custodyDirectory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 || await realpath(options.custodyDirectory) !== options.custodyDirectory) throw new Error("Ghostget custody needs private physical owner state");
  const path = join(options.custodyDirectory, AUTOMATION_CUSTODY_FILE);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("Previous Ghostget automation custody needs owner recovery before another process can start"); }
  const identity = await file.stat();
  try { await file.writeFile(JSON.stringify({ schemaVersion: 1, operationId: randomUUID(), hostPid: process.pid, configurationSha256: automationHash(options), startedAt: new Date().toISOString(), status: "in-flight-or-unreconciled" }) + "\n"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(options.custodyDirectory);
  return async () => {
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== process.getuid?.() || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error("Ghostget custody identity changed");
    await unlink(path); await syncDirectory(options.custodyDirectory);
  };
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
  const release = await claim(options);
  const environment: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT_EMAIL: "off" };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR"]) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  if (options.stateHome !== undefined) environment.GHOSTGET_STATE_HOME = options.stateHome;
  const argv = ["messaging", "automation", "serve", "--stdio"];
  const child = spawn(options.runtimeExecutable ?? options.executable, options.runtimeExecutable === undefined ? argv : ["--no-env-file", "--no-install", options.executable, ...argv], { shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
  type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; abort?: () => void; signal?: AbortSignal };
  const pending = new Map<string, Pending>();
  let output = Buffer.alloc(0), errors = 0, fault = false, closing = false, exited = false, cleanAcknowledgment = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined, finalTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectSettlement: ((reason: Error) => void) | undefined;
  const groupExists = () => { if (child.pid === undefined) return false; try { process.kill(-child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
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
        rejectSettlement?.(new Error("Ghostget process did not join; durable custody is retained"));
      }, 5000);
    }, CLEANUP_GRACE);
  };
  const settled = new Promise<void>((resolve, reject) => {
    rejectSettlement = reject;
    child.once("error", stop);
    child.once("close", (code, signal) => {
      exited = true; if (forceTimer) clearTimeout(forceTimer); if (finalTimer) clearTimeout(finalTimer);
      if (code !== 0 || signal !== null || !cleanAcknowledgment || pending.size || output.length || groupExists()) stop();
      if (fault) reject(new Error("Ghostget automation cleanup needs owner recovery")); else resolve();
    });
  });
  void settled.catch(() => undefined);
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.length; if (errors > MAX_ERROR) stop(); });
  child.stdout.on("data", (bytes: Buffer) => {
    if (fault) return;
    output = Buffer.concat([output, bytes]);
    try {
      let at: number;
      while ((at = output.indexOf(10)) !== -1) {
        if (at > MAX_RESPONSE) throw new Error("Oversized Ghostget frame");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(0, at))); output = output.subarray(at + 1);
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
      }
      if (output.length > MAX_RESPONSE) throw new Error("Oversized Ghostget frame");
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
    return { client: createGhostgetAutomationClient(invoke), close };
  } catch (error) { stop(); await settled.catch(() => undefined); throw error; }
}
