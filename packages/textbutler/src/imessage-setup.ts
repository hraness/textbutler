import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createPrivateFileOnce, publishPrivateFile } from "@hraness/local-custody/atomic-publish";
import { assertOwnedPath, ensurePrivateDirectory, readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { acquireOwnerDatabase } from "./daemon-custody.ts";
import { loadHostConfig, type GhostgetHostConfig } from "./host-config.ts";

export const IMESSAGE_SETUP_RESULT = "imessage-setup-result.json";
export const IMESSAGE_SETUP_CUSTODY = "imessage-setup-custody.json";
export const IMESSAGE_SETUP_BINDING = "imessage-setup-binding.json";
// Pin the native startup and discovery-diagnostics contract; admission is separate.
const VERSION = "0.18.21", PROTOCOL = "ghostget.control/1";
const READ = "messaging.automation.read", SEND = "messaging.automation.send.text", ATTACHMENT = "messaging.automation.send.attachment";
const OPERATIONS = [READ, SEND, ATTACHMENT] as const;
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
class SetupError extends Error { constructor(readonly code: string, readonly settledRejection = false) { super(code); } }
function invalid(): never { throw new SetupError("connector-metadata-invalid"); }
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (keys && (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))) return invalid();
  return row;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
function digest(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/u.test(result)) return invalid(); return result; }
function rows(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) return invalid(); return value; }
function accountFrom(value: unknown, id: string) {
  const response = record(value, ["ok", "auth"]); if (response.ok !== true) return invalid();
  const accounts = rows(response.auth, 256).map(value => record(value));
  if (new Set(accounts.map(account => text(account.id))).size !== accounts.length) return invalid();
  const account = accounts.find(account => account.id === id); if (!account) return null;
  record(account, ["id", "kind", "realmFingerprint", "subject", "provider"]);
  if (account.kind !== "linked-device-store" || account.provider !== "imessage") throw new SetupError("existing-account-conflict");
  const fingerprint = text(account.realmFingerprint, 16); if (!/^[a-f0-9]{16}$/u.test(fingerprint)) return invalid();
  return { subject: account.subject === null ? null : text(account.subject, 1024), fingerprint };
}
type PermissionRequest = { action: "snapshot"; accountId: string }
  | { action: "permission.enable"; expectedRevision: number }
  | { action: "permission.set"; adapterId: "imessage-direct"; operationId: typeof OPERATIONS[number]; accountId: string; decision: "allow"; expectedRevision: number; expectedCapabilityDigest: string };
/** Narrow test port; no arbitrary command or provider operation is representable. */
export interface IMessageSetupPort {
  transportInstall(): Promise<unknown>;
  authList(): Promise<unknown>;
  authAdd(): Promise<void>;
  authBind(): Promise<unknown>;
  control(request: PermissionRequest): Promise<unknown>;
}
export type IMessageSetupProgress = { accountCreated: boolean; accountBound: boolean; managedEnabled: boolean; permissionsChanged: number; subjectDigest: string | null };
const progress = (): IMessageSetupProgress => ({ accountCreated: false, accountBound: false, managedEnabled: false, permissionsChanged: 0, subjectDigest: null });
function success(value: unknown): Record<string, unknown> {
  const response = record(value);
  if (response.ok !== true) {
    record(response, ["ok", "code", "message"]); text(response.code); text(response.message, 4096);
    // This exact shipped code denotes rejected CAS authorization. The process
    // port returns it only after normal helper shutdown and physical group join.
    if (response.code === "OPERATION_PERMISSION_CHANGED") throw new SetupError("permission-revision-rejected", true);
    throw new SetupError("connector-request-rejected");
  }
  record(response, ["ok", "data"]); return record(response.data);
}
function permissionSaved(value: unknown): void { const data = success(value); record(data, ["kind", "message"]); if (data.kind !== "success") return invalid(); text(data.message, 4096); }
function snapshot(value: unknown, id: string, subject: string, expectedAccountRevision?: string) {
  const data = success(value); record(data, ["kind", "snapshot"]); if (data.kind !== "snapshot") return invalid();
  const view = record(data.snapshot, ["version", "accountId", "accounts", "capabilities", "interfaces", "policy", "web", "approvals", "connectionProviders", "vault"]);
  if (view.version !== VERSION || view.accountId !== id) return invalid();
  const accounts = rows(view.accounts, 256).map(value => record(value));
  if (new Set(accounts.map(account => text(account.id))).size !== accounts.length) return invalid();
  const account = accounts.find(account => account.id === id);
  if (!account || account.provider !== "imessage" || account.kind !== "linked-device-store" || account.subject !== subject) throw new SetupError("account-identity-changed");
  const accountRevision = digest(account.revision);
  if (expectedAccountRevision !== undefined && accountRevision !== expectedAccountRevision) throw new SetupError("account-identity-changed");
  const policy = record(view.policy, ["managed", "revision"]);
  if (typeof policy.managed !== "boolean" || !Number.isSafeInteger(policy.revision) || Number(policy.revision) < 0) return invalid();
  const capabilities = rows(view.capabilities, 4096).map(value => record(value));
  const operations = OPERATIONS.map(operationId => {
    const matches = capabilities.filter(capability => capability.adapterId === "imessage-direct" && capability.operationId === operationId);
    if (matches.length !== 1) return invalid(); const capability = matches[0]!;
    record(capability, ["digest", "adapterId", "operationId", "pluginId", "surface", "transport", "risk", "effect", "state", "executorSource", "interfaceSource", "permission"]);
    if (capability.surface !== "imessage" || capability.transport !== "local-cli" || capability.state !== "available"
      || capability.executorSource !== "built-in" || capability.interfaceSource !== "bundled"
      || capability.risk !== (operationId === READ ? "R1" : "R3") || !["allow", "deny", "ask", "unmanaged"].includes(String(capability.permission))) throw new SetupError("automation-capability-unavailable");
    return { operationId, digest: digest(capability.digest), permission: capability.permission };
  });
  return { managed: policy.managed, revision: policy.revision as number, accountRevision, operations };
}

/** Auth commands never force/replace a locator. Each grant consumes a fresh
 * selected-account snapshot and Ghostget's authoritative CAS/digest check. */
export async function configureIMessage(port: IMessageSetupPort, accountId: string, state = progress(), onBound?: (subjectDigest: string) => Promise<void>): Promise<IMessageSetupProgress> {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(accountId)) throw new SetupError("explicit-imessage-account-required");
  // Provision the pinned native transport before linking; the bundled artifact
  // is admitted by its own hash pin and install is idempotent.
  const installed = record(await port.transportInstall());
  const keys = ["ok", "installed", "tool", "version", "executableSha256", ...(installed.alreadyPresent === undefined ? [] : ["alreadyPresent"])];
  record(installed, keys);
  if (installed.ok !== true || installed.installed !== true || installed.tool !== "imsg-private-transport"
    || (installed.alreadyPresent !== undefined && typeof installed.alreadyPresent !== "boolean")) invalid();
  text(installed.version, 128); digest(installed.executableSha256);
  const previous = accountFrom(await port.authList(), accountId);
  if (state.subjectDigest !== null && (previous?.subject === null || previous === null || sha(previous.subject) !== state.subjectDigest)) throw new SetupError("account-identity-changed");
  if (!previous) { await port.authAdd(); state.accountCreated = true; }
  const before = accountFrom(await port.authList(), accountId);
  if (!before || previous && (before.subject !== previous.subject || before.fingerprint !== previous.fingerprint)) throw new SetupError("account-identity-changed");
  let subject = before.subject, fingerprint = before.fingerprint;
  // Ghostget bind rotates auth incarnation even when subject bytes match. An
  // existing binding must survive repeat setup with its permissions intact.
  if (subject === null) {
    const bound = record(await port.authBind(), ["ok", "id", "site", "subject", "realmFingerprint"]);
    if (bound.ok !== true || bound.id !== accountId || bound.site !== "imessage") return invalid();
    subject = text(bound.subject, 1024); fingerprint = text(bound.realmFingerprint, 16);
    if (!/^[a-f0-9]{16}$/u.test(fingerprint)) return invalid();
  }
  const after = accountFrom(await port.authList(), accountId);
  if (!after || after.subject !== subject || after.fingerprint !== fingerprint) throw new SetupError("account-identity-changed");
  state.accountBound = true; state.subjectDigest = sha(subject);
  await onBound?.(state.subjectDigest);
  let view = snapshot(await port.control({ action: "snapshot", accountId }), accountId, subject);
  const accountRevision = view.accountRevision;
  if (!view.managed) { permissionSaved(await port.control({ action: "permission.enable", expectedRevision: view.revision })); state.managedEnabled = true; }
  for (const operationId of OPERATIONS) {
    view = snapshot(await port.control({ action: "snapshot", accountId }), accountId, subject, accountRevision);
    if (!view.managed) throw new SetupError("permission-policy-changed");
    const capability = view.operations.find(capability => capability.operationId === operationId)!;
    if (capability.permission === "allow") continue;
    permissionSaved(await port.control({ action: "permission.set", adapterId: "imessage-direct", operationId, accountId, decision: "allow", expectedRevision: view.revision, expectedCapabilityDigest: capability.digest }));
    state.permissionsChanged++;
  }
  view = snapshot(await port.control({ action: "snapshot", accountId }), accountId, subject, accountRevision);
  if (!view.managed || view.operations.some(capability => capability.permission !== "allow")) throw new SetupError("permission-verification-failed");
  const final = accountFrom(await port.authList(), accountId);
  if (!final || final.subject !== subject || final.fingerprint !== fingerprint) throw new SetupError("account-identity-changed");
  return state;
}

async function trustedFile(path: string, executable = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new SetupError("unsafe-connector-path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || ![process.getuid?.(), 0].includes(before.uid) || (before.mode & 0o022) !== 0
      || before.size < 1 || before.size > (executable ? 256 * 1024 * 1024 : 1_048_576) || executable && !(before.mode & 0o111)) throw new SetupError("unsafe-connector-path");
    const hash = createHash("sha256"), bytes = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < before.size) { const read = await handle.read(bytes, 0, Math.min(bytes.length, before.size - offset), offset); if (!read.bytesRead) throw new SetupError("connector-changed"); hash.update(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead; }
    const after = await lstat(path);
    if (["dev", "ino", "mode", "nlink", "uid", "size", "mtimeMs", "ctimeMs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new SetupError("connector-changed");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
type ProcessLimits = { commandMs: number; cleanupMs: number };
const LIMITS: ProcessLimits = { commandMs: 35_000, cleanupMs: 36_000 };
/** Every child has a separate owned process group. Only normal exit, ended
 * pipes, valid output and absence of that group constitute settlement. */
async function childOutput(runtime: string, entrypoint: string, argv: readonly string[], cwd: string, env: Record<string, string>, signal: AbortSignal, limits: ProcessLimits, request?: PermissionRequest): Promise<Buffer> {
  signal.throwIfAborted();
  return await new Promise((resolve_, reject) => {
    const child = spawn(runtime, ["--no-env-file", "--no-install", entrypoint, ...argv], { cwd, env, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const id = randomUUID(), chunks: Buffer[] = []; let stdout = 0, stderr = 0, failed = false, finished = false, responseSeen = false, exited = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined, final: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => { if (child.pid !== undefined) { try { process.kill(-child.pid, name); } catch { /* physical join below remains authoritative */ } } };
    const groupExists = () => { if (child.pid === undefined) return false; try { process.kill(-child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
    const finish = (error?: Error, value?: Buffer) => {
      if (finished) return; finished = true; clearTimeout(timer); if (cleanup) clearTimeout(cleanup); if (final) clearTimeout(final); signal.removeEventListener("abort", stop);
      if (error) reject(error); else resolve_(value!);
    };
    const stop = () => {
      if (failed || finished) return; failed = true;
      if (exited && !groupExists()) { finish(new SetupError("process-custody-unproven")); return; }
      kill("SIGTERM");
      cleanup = setTimeout(() => {
        kill("SIGKILL");
        if (exited && !groupExists()) { finish(new SetupError("process-custody-unproven")); return; }
        final = setTimeout(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(new SetupError("process-custody-unproven")); }, 5000);
      }, limits.cleanupMs);
    };
    const timer = setTimeout(stop, limits.commandMs);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", stop); child.stdin.on("error", stop);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) stop(); });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.length; if (stdout > 4_194_304 || responseSeen && request !== undefined) { stop(); return; } chunks.push(chunk);
      if (request !== undefined && chunk.includes(10)) {
        responseSeen = true;
        try {
          const bytes = Buffer.concat(chunks); if (bytes.indexOf(10) !== bytes.length - 1) throw Error();
          const response = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          record(response, response.ok === true ? ["id", "protocol", "ok", "data"] : ["id", "protocol", "ok", "code", "message"]);
          if (response.id !== id || response.protocol !== PROTOCOL || typeof response.ok !== "boolean") throw Error();
          child.stdin.end();
        } catch { stop(); }
      }
    });
    child.once("close", (code, exitSignal) => {
      exited = true;
      if (groupExists()) { stop(); return; }
      if (failed || code !== 0 || exitSignal !== null || request !== undefined && !responseSeen) { finish(new SetupError("process-custody-unproven")); return; }
      finish(undefined, Buffer.concat(chunks));
    });
    if (request === undefined) child.stdin.end();
    else child.stdin.write(`${JSON.stringify({ id, protocol: PROTOCOL, request })}\n`);
    if (signal.aborted) stop();
  });
}
async function productionPort(config: GhostgetHostConfig, accountId: string, home: string, signal: AbortSignal, limits: ProcessLimits): Promise<IMessageSetupPort> {
  if (!config.runtimeExecutable || !config.stateHome) throw new SetupError("explicit-connector-paths-required");
  const root = dirname(dirname(config.executable)), helper = join(root, "src", "control", "helper.ts"), manifest = join(root, "package.json");
  if (config.executable !== join(root, "src", "cli.ts")) throw new SetupError("supported-connector-entrypoint-required");
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || ![process.getuid?.(), 0].includes(directory.uid) || (directory.mode & 0o022) !== 0 || await realpath(root) !== root) throw new SetupError("unsafe-connector-path");
  await assertOwnedPath(config.stateHome, { kind: "directory", canonical: true, ownerOnly: true });
  if (!isAbsolute(home) || resolve(home) !== home || await realpath(home) !== home) throw new SetupError("unsafe-home-path");
  const files = [config.executable, helper, manifest, config.runtimeExecutable];
  const hashes = await Promise.all(files.map((path, index) => trustedFile(path, index === 3)));
  const packageBytes = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(65_537), read = await packageBytes.read(bytes, 0, bytes.length, 0), content = bytes.subarray(0, read.bytesRead);
    if (read.bytesRead > 65_536 || sha(content) !== hashes[2]) throw new SetupError("connector-changed");
    const pkg = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
    if (pkg.name !== "@hraness/ghostget" || pkg.version !== VERSION) throw new SetupError("unsupported-connector-version");
  } finally { await packageBytes.close(); }
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", GHOSTGET_STATE_HOME: config.stateHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT_EMAIL: "off" };
  const invoke = async (entrypoint: string, args: readonly string[], request?: PermissionRequest) => {
    signal.throwIfAborted();
    await assertOwnedPath(config.stateHome!, { kind: "directory", canonical: true, ownerOnly: true });
    const current = await Promise.all(files.map((path, index) => trustedFile(path, index === 3)));
    if (current.some((hash, index) => hash !== hashes[index])) throw new SetupError("connector-changed");
    const value = await childOutput(config.runtimeExecutable!, entrypoint, args, root, env, signal, limits, request);
    const after = await Promise.all(files.map((path, index) => trustedFile(path, index === 3)));
    if (after.some((hash, index) => hash !== hashes[index])) throw new SetupError("connector-changed");
    return value;
  };
  const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return {
    async transportInstall() { return json(await invoke(config.executable, ["imessage", "transport", "install", "--json"])); },
    async authList() { return json(await invoke(config.executable, ["auth", "list", "--json"])); },
    async authAdd() { await invoke(config.executable, ["auth", "add", accountId, "--linked-device", "imessage", "--device-store", join(home, "Library", "Messages")]); },
    async authBind() { return json(await invoke(config.executable, ["auth", "bind", accountId, "--site", "imessage", "--json"])); },
    async control(request) { const response = record(json(await invoke(helper, [], request))); const { id: _id, protocol: _protocol, ...body } = response; return body; },
  };
}

export type IMessageSetupResult = { schemaVersion: 1; ok: boolean; status: "completed" | "blocked" | "recovery-required"; code: string; attemptId: string;
  startedAt: number; finishedAt: number; configurationDigest: string | null; accountDigest: string | null; progress: IMessageSetupProgress; custody: "released" | "retained" | "not-acquired";
  automationPermission: "allowed" | "denied" | "unavailable" | "unverified"; launchGeneration: string | null };
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
type SetupBinding = { schemaVersion: 1; accountDigest: string; subjectDigest: string };
async function readBinding(state: string): Promise<SetupBinding | null> {
  try {
    const value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readOwnedFileStable(join(state, IMESSAGE_SETUP_BINDING), 1024))), ["schemaVersion", "accountDigest", "subjectDigest"]);
    if (value.schemaVersion !== 1) throw new SetupError("setup-binding-invalid");
    return { schemaVersion: 1, accountDigest: digest(value.accountDigest), subjectDigest: digest(value.subjectDigest) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SetupError("setup-binding-invalid");
  }
}
/** Fixed app role. No Messages/Contacts reads, enrollment, sends, credentials
 * copying, raw policy writes, force flags or arbitrary command passthrough. */
export async function runIMessageSetup(dataDir: string, options: { signal?: AbortSignal; platform?: string; home?: string; processLimits?: ProcessLimits; automationPermission?: string; launchGeneration?: string } = {}): Promise<IMessageSetupResult> {
  const automation = options.automationPermission ?? process.env.TEXTBUTLER_IMESSAGE_AUTOMATION;
  const generation = options.launchGeneration ?? process.env.TEXTBUTLER_LAUNCH_AGENT_GENERATION;
  const result: IMessageSetupResult = { schemaVersion: 1, ok: false, status: "blocked", code: "setup-unavailable", attemptId: randomUUID(), startedAt: Date.now(), finishedAt: 0,
    configurationDigest: null, accountDigest: null, progress: progress(), custody: "not-acquired",
    automationPermission: automation === "allowed" || automation === "denied" || automation === "unavailable" ? automation : "unverified",
    launchGeneration: typeof generation === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(generation) ? generation : null };
  let lock: Awaited<ReturnType<typeof acquireOwnerDatabase>> | undefined, state: string | undefined, archive: string | undefined, claimed: { dev: number; ino: number } | undefined;
  const controller = new AbortController(), stop = () => controller.abort();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  const timer = setTimeout(stop, 120_000); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const save = async () => {
    if (!state || !archive) return;
    const bytes = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(bytes) > 8192) throw new SetupError("setup-result-too-large");
    if (await createPrivateFileOnce(archive, `${result.attemptId}.${result.status}.json`, bytes) !== "created") throw new SetupError("setup-result-already-exists");
    await publishPrivateFile(state, IMESSAGE_SETUP_RESULT, bytes);
  };
  const releaseSettled = async (code: string) => {
    if (!claimed || !state || !archive) throw new SetupError("setup-custody-changed");
    const custody = join(state, IMESSAGE_SETUP_CUSTODY);
    const completion = { ...result, finishedAt: Date.now(), status: "settled", code };
    if (await createPrivateFileOnce(archive, `${result.attemptId}.settled.json`, `${JSON.stringify(completion)}\n`) !== "created") throw new SetupError("setup-result-already-exists");
    const current = await assertOwnedPath(custody, { kind: "file", canonical: true, ownerOnly: true, maximumBytes: 4096n });
    const marker = record(JSON.parse((await readOwnedFileStable(custody, 4096)).toString("utf8")));
    if (current.dev !== claimed.dev || current.ino !== claimed.ino || marker.attemptId !== result.attemptId) throw new SetupError("setup-custody-changed");
    await unlink(custody); await syncDirectory(state); result.custody = "released";
  };
  try {
    if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir) throw new SetupError("private-data-directory-required");
    await assertOwnedPath(dataDir, { kind: "directory", canonical: true, ownerOnly: true });
    lock = await acquireOwnerDatabase(dataDir, "daemon-custody");
    state = join(dataDir, "state"); const history = await ensurePrivateDirectory(join(state, "imessage-setup-results"));
    let entries = 0;
    // Reserve settlement + final outcome slots; never exceed 256 retained files.
    for await (const _entry of await opendir(history)) if (++entries > 254) throw new SetupError("setup-result-history-full");
    archive = history;
    // Identity is independent of attempt outcomes. A denied preflight or a
    // crash while publishing the latest result cannot erase prior binding.
    const binding = await readBinding(state);
    if (binding) { result.accountDigest = binding.accountDigest; result.progress.subjectDigest = binding.subjectDigest; }
    if ((options.platform ?? process.platform) !== "darwin") throw new SetupError("macos-app-required");
    if (generation !== undefined && result.launchGeneration === null) throw new SetupError("invalid-launch-generation");
    // The fixed native app role obtains this status from macOS without sending
    // a message. Direct CLI execution cannot infer Automation permission.
    if (result.automationPermission !== "allowed") throw new SetupError(`automation-permission-${result.automationPermission}`);
    const config = await loadHostConfig(dataDir), ghostget = config.ghostget;
    const selected = ghostget?.automationAccounts?.find(account => account.provider === "imessage");
    if (!ghostget || !selected) throw new SetupError("explicit-imessage-account-required");
    result.configurationDigest = sha(JSON.stringify(config));
    if (binding && binding.accountDigest !== sha(selected.authId)) throw new SetupError("account-identity-changed");
    result.accountDigest = sha(selected.authId);
    const limits = options.processLimits ?? LIMITS;
    if (![limits.commandMs, limits.cleanupMs].every(value => Number.isSafeInteger(value) && value >= 10) || limits.commandMs > LIMITS.commandMs || limits.cleanupMs > LIMITS.cleanupMs) throw new SetupError("invalid-process-limits");
    const port = await productionPort(ghostget, selected.authId, options.home ?? homedir(), signal, limits);
    const custody = join(state, IMESSAGE_SETUP_CUSTODY);
    let file;
    try { file = await open(custody, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new SetupError("prior-setup-needs-recovery"); }
    claimed = await file.stat(); result.custody = "retained";
    try { await file.writeFile(`${JSON.stringify({ schemaVersion: 1, attemptId: result.attemptId, startedAt: result.startedAt, configurationDigest: result.configurationDigest, accountDigest: result.accountDigest, status: "in-flight-or-unreconciled" })}\n`); await file.sync(); } finally { await file.close(); }
    await syncDirectory(state);
    await configureIMessage(port, selected.authId, result.progress, async subjectDigest => {
      const established: SetupBinding = { schemaVersion: 1, accountDigest: result.accountDigest!, subjectDigest };
      // Write once before any permission mutation, and never replace even a
      // malformed receipt. The in-flight marker fences a failed publication.
      await createPrivateFileOnce(state!, IMESSAGE_SETUP_BINDING, `${JSON.stringify(established)}\n`);
      const stored = await readBinding(state!);
      if (!stored || stored.accountDigest !== established.accountDigest || stored.subjectDigest !== subjectDigest) throw new SetupError("account-identity-changed");
    }); signal.throwIfAborted();
    if (sha(JSON.stringify(await loadHostConfig(dataDir))) !== result.configurationDigest) throw new SetupError("host-configuration-changed");
    // Preserve settlement metadata before releasing the exact marker. A crash
    // before release remains blocked; no credentials or receipts are removed.
    await releaseSettled("permissions-verified");
    result.ok = true; result.status = "completed"; result.code = "imessage-linked-permissions-verified";
  } catch (error) {
    result.code = error instanceof SetupError ? error.code : "setup-could-not-be-confirmed";
    if (claimed && error instanceof SetupError && error.settledRejection && !signal.aborted) {
      try { await releaseSettled(result.code); }
      catch { result.status = "recovery-required"; result.custody = "retained"; result.code = "setup-custody-changed"; }
    } else if (claimed || result.code === "prior-setup-needs-recovery") { result.status = "recovery-required"; result.custody = "retained"; }
  } finally {
    clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); result.finishedAt = Date.now();
    try { await save(); } finally { lock?.close(); }
  }
  return result;
}
