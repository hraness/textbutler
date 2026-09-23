import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeOwnerState } from "./control-service.ts";
import { daemonSocketPath } from "./daemon.ts";
import { acquireOwnerDatabase } from "./daemon-custody.ts";
import { macosAppExecutable, macosLaunchGeneration, parseMacosAppIdentity, readInstalledMacosApp, type MacosAppIdentity } from "./macos-app.ts";

export const LAUNCH_AGENT_LABEL = "app.textbutler.daemon";
type LaunchAgentLabel = typeof LAUNCH_AGENT_LABEL;
const MAX_BYTES = 65_536;
type Phase = "prepared" | "installing" | "installed" | "removing" | "uncertain-install" | "uncertain-remove";
type Receipt = { label: LaunchAgentLabel; uid: number; home: string; dataDir: string; runtime: string; entrypoint: string; generation: string; phase: Phase; servicePid: number | null } & ({ schemaVersion: 1 | 2 } | { schemaVersion: 3; application: MacosAppIdentity } | { schemaVersion: 4; application: MacosAppIdentity | null; plistText: string });
/** Everything render needs; a version-4 receipt also records the result. */
type RenderableReceipt = { label: LaunchAgentLabel; schemaVersion: number; application?: MacosAppIdentity | null; home: string; dataDir: string; runtime: string; entrypoint: string; generation: string };
type FileSnapshot = { text: string; dev: number; ino: number };
export type LaunchctlResult = { outcome: "completed" | "indeterminate"; exitCode: number | null; stdout: string; stderr: string };
export interface LaunchAgentHost {
  readonly platform: string;
  readonly uid: number;
  readonly home: string;
  readonly runtime: string;
  readonly entrypoint: string;
  /** Trusted installation reader: invalid app receipts must throw, never fall back. */
  application?(dataDir: string): Promise<MacosAppIdentity | null>;
  /** Trusted host port. The lifecycle supplies only closed launchctl commands. */
  run(args: readonly string[]): Promise<LaunchctlResult>;
  processState(pid: number): "alive" | "dead" | "unknown";
}
export interface LaunchAgentStatus {
  readonly label: LaunchAgentLabel;
  readonly installation: "absent" | "installed" | "conflict" | "indeterminate" | "unsupported";
  readonly service: "not-loaded" | "loaded" | "running" | "unknown";
  readonly plistPath: string;
  readonly pid: number | null;
  readonly detail: string;
  readonly automaticReplies: "unavailable";
}
export interface LaunchAgentLifecycle {
  status(dataDir: string): Promise<LaunchAgentStatus>;
  install(dataDir: string): Promise<LaunchAgentStatus>;
  uninstall(dataDir: string): Promise<LaunchAgentStatus>;
}
class LifecycleError extends Error {}
function fail(message: string): never { throw new LifecycleError(message); }
function path(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || resolve(value) !== value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f{}"\\]/u.test(value)) fail("LaunchAgent paths must be bounded physical absolute paths.");
  return value;
}
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
/** Apply the same startup boundary to immediate and login launches. Bun must
 * not discover owner configuration or inherit preloads before our code runs. */
export function isolatedBunInvocation(options: { home: string; runtime: string; entrypoint: string; args: readonly string[]; generation?: string }): { executable: string; args: readonly string[] } {
  path(options.home); path(options.runtime); path(options.entrypoint);
  if (options.generation !== undefined && !/^[a-f0-9-]{36}$/u.test(options.generation)) fail("Invalid launch generation.");
  return { executable: "/usr/bin/env", args: ["-i", `HOME=${options.home}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    ...(options.generation === undefined ? [] : [`TEXTBUTLER_LAUNCH_AGENT_GENERATION=${options.generation}`]),
    options.runtime, "--config=/dev/null", "--cwd=/", "--no-env-file", options.entrypoint, ...options.args] };
}
function argsFor(receipt: RenderableReceipt): readonly string[] {
  if (receipt.application != null) return [macosAppExecutable(receipt.application), "--daemon"];
  // Keep the old bytes recognizable so an existing service can be removed
  // safely before replacing its startup contract.
  if (receipt.schemaVersion === 1) return ["/usr/bin/env", "-i", `HOME=${receipt.home}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", `TEXTBUTLER_LAUNCH_AGENT_GENERATION=${receipt.generation}`, receipt.runtime, "--no-env-file", receipt.entrypoint, "daemon", "run", "--data-dir", receipt.dataDir];
  const invocation = isolatedBunInvocation({ ...receipt, args: ["daemon", "run", "--data-dir", receipt.dataDir] });
  return [invocation.executable, ...invocation.args];
}
function plistPath(home: string, label: LaunchAgentLabel = LAUNCH_AGENT_LABEL): string { return join(home, "Library", "LaunchAgents", `${label}.plist`); }
const CURRENT_PROCESS_TYPE = "Standard";
// Every ProcessType value a shipped template has rendered. Receipts written
// before the receipt recorded its artifact verify against this closed set of
// exact historical renders, never against arbitrary bytes.
const HISTORICAL_PROCESS_TYPES = ["Background", "Standard"] as const;
function render(receipt: RenderableReceipt, processType: string = CURRENT_PROCESS_TYPE): string {
  const application = receipt.application != null ? `<key>AssociatedBundleIdentifiers</key><array><string>${xml(receipt.application.bundleId)}</string></array>\n<key>EnvironmentVariables</key><dict><key>TEXTBUTLER_LAUNCH_AGENT_GENERATION</key><string>${receipt.generation}</string></dict>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${receipt.label}</string>\n<key>ProgramArguments</key><array>${argsFor(receipt).map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n${application}<key>WorkingDirectory</key><string>${xml(receipt.schemaVersion === 1 ? receipt.dataDir : "/")}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>${receipt.application != null ? 60 : 15}</integer>\n<key>ProcessType</key><string>${processType}</string>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
}
/** The artifact a receipt binds when producing bytes: recorded for schema 4,
 * the current contract render for older receipts being advanced. */
function expectedPlistText(receipt: Receipt): string { return receipt.schemaVersion === 4 ? receipt.plistText : render(receipt); }
/** The artifacts a receipt accepts when verifying an installation: the
 * recorded bytes for schema 4, or every known historical render for a
 * receipt written before it recorded its artifact. A launch-template change
 * can therefore never strand a service an earlier binary installed. */
function expectedPlistTexts(receipt: Receipt): readonly string[] {
  if (receipt.schemaVersion === 4) return [receipt.plistText];
  return HISTORICAL_PROCESS_TYPES.map(processType => render(receipt, processType));
}

function parseReceipt(text: string, host: LaunchAgentHost, dataDir: string): Receipt {
  const item: unknown = JSON.parse(text);
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("Invalid LaunchAgent receipt.");
  const r = item as Record<string, unknown>;
  const label = LAUNCH_AGENT_LABEL;
  const keys = `${r.schemaVersion === 3 || r.schemaVersion === 4 ? "application," : ""}dataDir,entrypoint,generation,home,label,phase,${r.schemaVersion === 4 ? "plistText," : ""}runtime,schemaVersion,servicePid,uid`;
  if (Object.keys(r).sort().join(",") !== keys || r.schemaVersion !== 1 && r.schemaVersion !== 2 && r.schemaVersion !== 3 && r.schemaVersion !== 4 || r.label !== label || r.uid !== host.uid || r.home !== host.home || r.dataDir !== dataDir || typeof r.generation !== "string" || !/^[0-9a-f-]{36}$/u.test(r.generation) || !["prepared", "installing", "installed", "removing", "uncertain-install", "uncertain-remove"].includes(String(r.phase)) || r.servicePid !== null && (!Number.isSafeInteger(r.servicePid) || Number(r.servicePid) < 1 || Number(r.servicePid) > 2 ** 31 - 1)) fail("The LaunchAgent receipt does not match this owner and data directory.");
  path(r.home); path(r.dataDir); path(r.runtime); path(r.entrypoint);
  if (r.schemaVersion === 4 && (typeof r.plistText !== "string" || Buffer.byteLength(r.plistText) > MAX_BYTES || !r.plistText.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !r.plistText.includes(`<key>Label</key><string>${label}</string>`))) fail("The LaunchAgent receipt does not match this owner and data directory.");
  if (r.schemaVersion === 3 || r.schemaVersion === 4 && r.application !== null) {
    const app = parseMacosAppIdentity(r.application);
    for (const key of ["home", "dataDir", "runtime", "entrypoint"] as const) if (app[key] !== r[key]) fail("The recorded TextButler app does not match its service.");
  }
  return r as unknown as Receipt;
}
async function readOwned(target: string, uid: number): Promise<FileSnapshot | null> {
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    if (await realpath(dirname(target)) !== dirname(target)) fail("Linked LaunchAgent state directory.");
    const parent = await lstat(dirname(target));
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) fail("Unsafe LaunchAgent state directory.");
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o077) !== 0 || before.size > MAX_BYTES) fail("Unsafe LaunchAgent state file.");
    const bytes = Buffer.alloc(MAX_BYTES + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
    if (bytesRead !== before.size || bytesRead > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("LaunchAgent state changed while reading.");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)), dev: before.dev, ino: before.ino };
  } finally { await handle.close(); }
}
function same(a: FileSnapshot | null, b: FileSnapshot | null): boolean { return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino && a.text === b.text; }
async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function updateFile(target: string, expected: FileSnapshot | null, text: string | null, uid: number): Promise<FileSnapshot | null> {
  if (await realpath(dirname(target)) !== dirname(target) || !same(await readOwned(target, uid), expected)) fail("LaunchAgent state revision conflict.");
  if (text === null) { if (expected) { await unlink(target); await syncDirectory(dirname(target)); } return null; }
  if (Buffer.byteLength(text) > MAX_BYTES) fail("LaunchAgent state exceeds its limit.");
  const staged = join(dirname(target), `.textbutler-${randomUUID()}`);
  const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text); await handle.sync(); await handle.close();
    if (!same(await readOwned(target, uid), expected)) fail("LaunchAgent state revision conflict.");
    if (expected === null) await link(staged, target); else await rename(staged, target);
    // Persist intent and artifact directory entries before asking launchd to act.
    await syncDirectory(dirname(target));
  } finally { await handle.close().catch(() => {}); await unlink(staged).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  return await readOwned(target, uid);
}
async function directory(target: string, uid: number, create: boolean): Promise<void> {
  if (create) { try { await mkdir(target, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0 || await realpath(target) !== target) fail("LaunchAgent directories must be physical and owned, without shared write access.");
}
async function executable(target: string, uid: number, execute: boolean): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || ![0, uid].includes(info.uid) || (info.mode & 0o022) !== 0 || execute && !(info.mode & 0o111) || await realpath(target) !== target) fail("The recorded Textbutler runtime or entrypoint is unsafe.");
}
type Job = { state: "absent" | "owned" | "unknown"; running: boolean; pid: number | null };
function parseJob(result: LaunchctlResult, receipt: Receipt | null, host: LaunchAgentHost): Job {
  const absent = { state: "absent", running: false, pid: null } as const;
  const unknown = { state: "unknown", running: false, pid: null } as const;
  if (result.outcome !== "completed" || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_BYTES) return unknown;
  const label = receipt?.label ?? LAUNCH_AGENT_LABEL;
  if (result.exitCode === 113 && result.stdout === "" && result.stderr === `Bad request.\nCould not find service "${label}" in domain for user gui: ${host.uid}\n`) return absent;
  if (result.exitCode !== 0 || !receipt || !result.stdout.startsWith(`gui/${host.uid}/${label} = {\n`)) return unknown;
  const lines = result.stdout.split("\n").map(line => line.trim());
  const field = (key: string): string | null => { const values = lines.filter(line => line.startsWith(`${key} = `)); return values.length === 1 ? values[0]!.slice(key.length + 3) : null; };
  const start = lines.indexOf("arguments = {"); const end = lines.indexOf("}", start + 1);
  if (field("path") !== plistPath(host.home, label) || field("program") !== argsFor(receipt)[0] || start === -1 || end === -1 || JSON.stringify(lines.slice(start + 1, end)) !== JSON.stringify(argsFor(receipt))) return unknown;
  if ("application" in receipt && receipt.application != null && macosLaunchGeneration(result.stdout) !== receipt.generation) return unknown;
  const pidText = field("pid"); const pid = pidText !== null && /^[1-9][0-9]*$/u.test(pidText) ? Number(pidText) : null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1)) return unknown;
  return { state: "owned", running: field("state") === "running" && pid !== null, pid };
}
async function runLaunchctl(args: readonly string[]): Promise<LaunchctlResult> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try { child = Bun.spawn(["/bin/launchctl", ...args], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" }); }
  catch { return { outcome: "indeterminate", exitCode: null, stdout: "", stderr: "" }; }
  let size = 0, overflow = false;
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = []; const reader = stream.getReader();
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > MAX_BYTES) { overflow = true; child.kill("SIGKILL"); continue; } chunks.push(item.value); } } finally { reader.releaseLock(); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
    return { outcome: overflow || child.signalCode !== null ? "indeterminate" : "completed", exitCode, stdout, stderr };
  } catch { child.kill("SIGKILL"); await child.exited; return { outcome: "indeterminate", exitCode: null, stdout: "", stderr: "" }; }
}
export function defaultLaunchAgentHost(entrypoint?: string): LaunchAgentHost {
  const identity = { home: homedir(), runtime: process.execPath, entrypoint: entrypoint ?? fileURLToPath(new URL("cli.ts", import.meta.url)) };
  return { platform: process.platform, uid: process.getuid?.() ?? -1, ...identity, run: runLaunchctl,
    application(dataDir) { return readInstalledMacosApp({ ...identity, dataDir }); },
    processState(pid) { try { process.kill(pid, 0); return "alive"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; } } };
}

export function createLaunchAgentLifecycle(host: LaunchAgentHost = defaultLaunchAgentHost()): LaunchAgentLifecycle {
  const label = LAUNCH_AGENT_LABEL;
  const target = `gui/${host.uid}/${label}`, plist = plistPath(host.home, label);
  const view = (installation: LaunchAgentStatus["installation"], job: Job, detail: string): LaunchAgentStatus => ({ label, installation, service: job.state === "absent" ? "not-loaded" : job.state === "unknown" ? "unknown" : job.running ? "running" : "loaded", plistPath: plist, pid: job.pid, detail, automaticReplies: "unavailable" });
  const newReceipt = (application: MacosAppIdentity | null, dataDir: string): Receipt => {
    const base: RenderableReceipt & { schemaVersion: 4 } = { schemaVersion: 4, application, label, home: host.home, dataDir, runtime: host.runtime, entrypoint: host.entrypoint, generation: randomUUID() };
    return { ...base, application, uid: host.uid, phase: "prepared", servicePid: null, plistText: render(base) };
  };
  // Advance a receipt whose service is not running to the current contract.
  // Schema 4 records the rendered plist, so later contract changes verify
  // against recorded bytes instead of whatever the current binary renders.
  const migrateReceipt = (receipt: Receipt, application: MacosAppIdentity | null): Receipt => {
    const base: RenderableReceipt & { schemaVersion: 4 } = { schemaVersion: 4, application, label, home: receipt.home, dataDir: receipt.dataDir, runtime: receipt.runtime, entrypoint: receipt.entrypoint, generation: receipt.generation };
    return { ...base, application, uid: receipt.uid, phase: receipt.phase, servicePid: null, plistText: render(base) };
  };
  const inspect = async (dataDir: string) => {
    path(host.home); path(dataDir); await directory(host.home, host.uid, false);
    for (const parent of [join(host.home, "Library"), dirname(plist), dataDir, join(dataDir, "state")]) {
      try { await directory(parent, host.uid, false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const receiptFile = join(dataDir, "state", "launch-agent.json");
    const stored = await readOwned(receiptFile, host.uid); const receipt = stored ? parseReceipt(stored.text, host, dataDir) : null;
    const installed = await readOwned(plist, host.uid);
    if (installed && (!receipt || !expectedPlistTexts(receipt).includes(installed.text))) fail("The LaunchAgent plist is not the exact recorded Textbutler artifact.");
    const job = parseJob(await host.run(["print", target]), receipt, host);
    return { receiptFile, stored, receipt, installed, job };
  };
  const locked = async <T>(dataDir: string, work: () => Promise<T>): Promise<T> => {
    // Serialize stale-lock reconciliation too; conditional pathname checks alone
    // cannot arbitrate two processes trying to replace the same dead-owner lock.
    const ownerDatabase = await acquireOwnerDatabase(dataDir, "launch-agent-custody");
    try {
      const lock = join(dataDir, "state", "launch-agent.lock"); const content = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, generation: randomUUID() })}\n`;
      let previous = await readOwned(lock, host.uid);
      if (previous) {
        const value = JSON.parse(previous.text) as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "generation,pid,schemaVersion" || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || Number(value.pid) > 2 ** 31 - 1 || typeof value.generation !== "string" || !/^[a-f0-9-]{36}$/u.test(value.generation) || host.processState(Number(value.pid)) !== "dead") fail("Another LaunchAgent operation is active or its owner is uncertain.");
        await updateFile(lock, previous, null, host.uid); previous = null;
      }
      const claim = await updateFile(lock, previous, content, host.uid);
      try { return await work(); } finally { await updateFile(lock, claim, null, host.uid); }
    } finally { ownerDatabase.close(); }
  };
  const supported = (): void => { if (host.platform !== "darwin" || !Number.isSafeInteger(host.uid) || host.uid < 1) fail("LaunchAgent installation requires a non-root macOS user session."); };
  return {
    async status(dataDir) {
      if (host.platform !== "darwin") return view("unsupported", { state: "unknown", running: false, pid: null }, "LaunchAgents are available only on macOS.");
      try {
        const state = await inspect(dataDir);
        if (!state.receipt && !state.installed && state.job.state === "absent") return view("absent", state.job, "No Textbutler LaunchAgent is installed.");
        if (state.job.state === "unknown") return view("conflict", state.job, "Loaded service identity is absent, changed, or unverified; no service mutation is allowed.");
        if (state.receipt && state.installed && state.job.state === "owned" && !["removing", "uncertain-remove"].includes(state.receipt.phase)) return view("installed", state.job, "Exact owner LaunchAgent is loaded. Control-service health is reported separately; automatic replies remain unavailable.");
        return view("indeterminate", state.job, "Installation is staged or a prior operation needs reconciliation. Owner data and artifacts are preserved.");
      } catch { return view("conflict", { state: "unknown", running: false, pid: null }, "LaunchAgent state is unsafe or does not match this owner and data directory."); }
    },
    async install(dataDir) {
      supported(); path(host.home); path(dataDir); path(host.runtime); path(host.entrypoint); daemonSocketPath(dataDir);
      await directory(host.home, host.uid, false); await directory(join(host.home, "Library"), host.uid, true); await directory(dirname(plist), host.uid, true);
      await executable(host.runtime, host.uid, true); await executable(host.entrypoint, host.uid, false);
      const application = await host.application?.(dataDir) ?? null;
      if (application) { parseMacosAppIdentity(application); if (application.automationConsent !== "native-api") fail("Synthetic app consent cannot authorize an installed service."); for (const key of ["home", "runtime", "entrypoint"] as const) if (application[key] !== host[key]) fail("The installed app belongs to another runtime or entrypoint."); if (application.dataDir !== dataDir) fail("The installed app belongs to another data directory."); }
      await initializeOwnerState(dataDir);
      return await locked(dataDir, async () => {
        const state = await inspect(dataDir);
        if (state.job.state === "unknown") fail("Existing LaunchAgent service ownership cannot be verified.");
        let receipt: Receipt = state.receipt ?? newReceipt(application, dataDir);
        if (receipt.schemaVersion === 1) fail("The recorded service uses the previous startup contract. Uninstall it, then install again to apply startup isolation; owner settings are retained.");
        if (receipt.runtime !== host.runtime || receipt.entrypoint !== host.entrypoint) fail("The installed LaunchAgent uses another runtime or entrypoint. Uninstall it before changing its launch identity.");
        const recordedApp = "application" in receipt ? receipt.application : null;
        if (JSON.stringify(recordedApp ?? null) !== JSON.stringify(application)) fail("The installed LaunchAgent uses another app identity. Uninstall it before changing its launch identity; owner settings are retained.");
        if (state.job.state === "owned") {
          if (!state.installed || !state.stored) fail("The loaded service is missing its exact installation artifacts.");
          if (["removing", "uncertain-remove"].includes(receipt.phase)) fail("A previous removal is still uncertain; do not race it with another operation.");
          if (receipt.schemaVersion < 4) fail("The recorded service uses an earlier launch contract. Uninstall it, then install again to apply the current contract; owner settings are retained.");
          if (receipt.phase !== "installed" || receipt.servicePid !== state.job.pid) await updateFile(state.receiptFile, state.stored, `${JSON.stringify({ ...receipt, phase: "installed", servicePid: state.job.pid })}\n`, host.uid);
          return view("installed", state.job, "The exact owner LaunchAgent is already loaded; no duplicate bootstrap was requested.");
        }
        if (receipt.phase !== "prepared" && receipt.phase !== "installed") fail("A prior LaunchAgent operation is uncertain; do not repeat it blindly.");
        // No service is running: an older recorded contract is advanced in
        // place so its artifacts verify against the recorded plist bytes.
        if (receipt.schemaVersion === 2 || receipt.schemaVersion === 3) receipt = migrateReceipt(receipt, application);
        try { await lstat(daemonSocketPath(dataDir)); fail("An existing daemon socket must be reconciled before bootstrapping a service."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        let stored = state.stored;
        const serialized = `${JSON.stringify(receipt)}\n`;
        const plistText = expectedPlistText(receipt);
        // Replacing an artifact an earlier contract recorded: write the plist
        // first so an interruption still verifies against the older receipt's
        // historical renders instead of stranding a newer receipt behind them.
        if (state.installed !== null && state.installed.text !== plistText) await updateFile(plist, state.installed, plistText, host.uid);
        if (stored === null || stored.text !== serialized) stored = await updateFile(state.receiptFile, stored, serialized, host.uid);
        if (state.installed === null) await updateFile(plist, null, plistText, host.uid);
        receipt = { ...receipt, phase: "installing" }; stored = await updateFile(state.receiptFile, stored, `${JSON.stringify(receipt)}\n`, host.uid);
        const result = await host.run(["bootstrap", `gui/${host.uid}`, plist]);
        const job = parseJob(await host.run(["print", target]), receipt, host);
        receipt = { ...receipt, phase: job.state === "owned" ? "installed" : "uncertain-install", servicePid: job.pid };
        await updateFile(state.receiptFile, stored, `${JSON.stringify(receipt)}\n`, host.uid);
        if (job.state !== "owned" || result.outcome !== "completed" || result.exitCode !== 0) return view("indeterminate", job, "Bootstrap outcome requires reconciliation. The exact plist and receipt are retained; no retry or rollback was attempted.");
        return view("installed", job, "Textbutler is registered for this user's graphical login session. New settings start paused; existing settings are preserved. Automatic replies remain unavailable.");
      });
    },
    async uninstall(dataDir) {
      supported(); path(dataDir);
      const initial = await inspect(dataDir);
      if (!initial.receipt && !initial.installed && initial.job.state === "absent") return view("absent", initial.job, "No Textbutler LaunchAgent is installed. Owner data is unchanged.");
      if (!initial.receipt || !initial.installed) fail("An incomplete or foreign LaunchAgent must be reconciled before removal.");
      return await locked(dataDir, async () => {
        const state = await inspect(dataDir);
        if (!state.receipt || !state.installed || !state.stored || state.job.state === "unknown") fail("The loaded service or artifact no longer matches the recorded installation.");
        const reconcilingRemoval = ["removing", "uncertain-remove"].includes(state.receipt.phase);
        if (reconcilingRemoval && (state.job.state !== "absent" || state.receipt.servicePid === null || host.processState(state.receipt.servicePid) !== "dead")) fail("A previous removal is still uncertain; preserve its artifacts until the job is absent and its recorded process has stopped.");
        if (state.job.state === "absent" && !["installed", "prepared"].includes(state.receipt.phase) && !reconcilingRemoval) fail("The prior service operation is uncertain; retain its artifacts for reconciliation.");
        let stored = state.stored;
        if (state.job.state === "owned") {
          const removing: Receipt = { ...state.receipt, phase: "removing", servicePid: state.job.pid }; stored = (await updateFile(state.receiptFile, stored, `${JSON.stringify(removing)}\n`, host.uid))!;
          const result = await host.run(["bootout", "--wait", target]);
          const job = parseJob(await host.run(["print", target]), removing, host);
          if (result.outcome !== "completed" || result.exitCode !== 0 || job.state !== "absent") {
            await updateFile(state.receiptFile, stored, `${JSON.stringify({ ...removing, phase: "uncertain-remove" })}\n`, host.uid);
            return view("indeterminate", job, "Service removal did not complete conclusively. Its plist, receipt and owner data are preserved.");
          }
        }
        await updateFile(plist, state.installed, null, host.uid);
        await updateFile(state.receiptFile, stored, null, host.uid);
        return view("absent", { state: "absent", running: false, pid: null }, "The recorded LaunchAgent was removed. Contact memory, settings and activity remain intact.");
      });
    },
  };
}
