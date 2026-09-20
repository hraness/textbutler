/** Explicit reconciliation for the reviewed Ghostget 0.18.16 bind-startup crash.
 * This releases only a proven pre-permission setup fence. It never reruns setup,
 * changes auth/policy, grants permissions, sends, or recovers Ghostget custody.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateFileOnce } from "@hraness/local-custody/atomic-publish";
import { assertOwnedPath } from "@hraness/local-custody/private-paths";
import { acquireOwnerDatabase } from "../packages/textbutler/src/daemon-custody.ts";
import { loadHostConfig } from "../packages/textbutler/src/host-config.ts";
import { appFileDigest, macosAppPath, macosAppReceiptPath, readMacosAppReceipt, verifyMacosApp } from "../packages/textbutler/src/macos-app.ts";
import { parseXcbJson } from "../packages/textbutler/src/xcb-client.ts";

const KIND = "textbutler.imessage-setup-legacy-bind-crash.v1";
const MARKER = "imessage-setup-custody.json", RESULT = "imessage-setup-result.json";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const IMGS_SHA = "46c4c73c81c7db2d516c2d467c66aff03c73de196996d646bc8afce0ea85cff6";
const IMSG_UUID = "45f877b9-040f-32ee-b879-d572757cddf6";
// Reviewed shipped closure: subject-probe cleanup publishes its native group,
// proves quiescence, removes its operation root, and only then releases admission.
// This legacy recovery does not silently accept a fixed/upgraded connector.
const LEGACY_FILES: Readonly<Record<string, string>> = Object.freeze({
  "package.json": "4111723ac71cfb26eca02b0304435e53be7405dfa7d63d502c088660bc921766",
  "src/cli.ts": "907a72bc4ebedffe76b2b4422778ff523eb131fb5a1413c2f106127ad42358cb",
  "src/ghostget.ts": "3bc7a36d1e779362fb65ca03232033254becf40938c2bef7ba9dee3606bae835",
  "src/auth.ts": "46257c1f9b7e857686ea539e7fe1ea876ea7f5e94737e0ace34ff71f21673476",
  "src/providers/imessage-direct-runtime.ts": "619c52e48c22bba73ec45f146d266bf1041ebfd4e9ccbef71480db883c94b0e4",
  "src/local-cli-admission.ts": "eee2e695a37a2ec40030fcb76d4542157101de08a2685e65c940b003c37b2476",
  "src/web-session-cleanup-admission.ts": "15c1e32f264c8c9903c677f778b8f0116386f5bfc48e866bbd40b6deb16a9c44",
  "src/provider-plugin-cleanup-execution.ts": "c98a3184684d1c7330a9dc6aa8f421c95b6dc3e0670b855788123b83dd779b1c",
  "src/provider-plugin-cleanup-resource.ts": "bae044f05b212001a9981ff689dbb95fbd74e0608363d98afdde82e6e9d770fe",
  "src/process-identity.ts": "31ef084cefeae24a8c35eb0ad128ac3cae8404f50e045b95465f7bfaf7e9694a",
  "src/operation-permission-store.ts": "fefafa36df595a018943a201434519123fc95b2f7e817e2679b165e2256702fb",
});
const EMPTY_DIRECTORIES = ["provider-plugin-state/.web-session-cleanup-admissions", "run-journals/linked-device-lifecycle",
  "run-journals/linked-device-lifecycle-admissions", "read-projection-control/admissions", "provider-plugins/locks"] as const;
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function require_(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  require_(value !== null && typeof value === "object" && !Array.isArray(value), "reconcile-invalid-object");
  const row = value as Record<string, unknown>;
  if (keys) require_(Object.keys(row).sort().join(",") === [...keys].sort().join(","), "reconcile-unknown-fields");
  return row;
}
function digest(value: unknown): string { require_(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "reconcile-invalid-digest"); return value; }
function uuid(value: unknown): string { require_(typeof value === "string" && UUID.test(value), "reconcile-invalid-uuid"); return value; }
function integer(value: unknown): number { require_(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "reconcile-invalid-integer"); return value; }
function json(bytes: Buffer): unknown { return parseXcbJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Captured = { bytes: Buffer; identity: Identity; sha256: string };
async function capture(path: string, maximum: number, privateFile = true): Promise<Captured> {
  macosAppPath(path);
  require_(await realpath(path) === path, "reconcile-nonphysical-file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    require_(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && (before.mode & (privateFile ? 0o077 : 0o022)) === 0
      && before.size > 0 && before.size <= maximum, "reconcile-unsafe-file");
    const bytes = Buffer.alloc(before.size + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(), current = await lstat(path);
    for (const key of ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"] as const) require_(before[key] === after[key] && before[key] === current[key], "reconcile-file-changed");
    require_(bytesRead === before.size, "reconcile-short-read");
    const data = bytes.subarray(0, bytesRead);
    return { bytes: data, sha256: sha(data), identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } finally { await file.close(); }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("reconcile-required-absence-not-proven");
}
async function empty(path: string): Promise<void> {
  await assertOwnedPath(path, { kind: "directory", canonical: true, ownerOnly: true });
  const directory = await opendir(path, { bufferSize: 1 });
  try { require_(await directory.read() === null, "reconcile-connector-custody-not-quiescent"); }
  finally { await directory.close(); }
}
export async function requireReconciliationHistorySpace(path: string): Promise<void> {
  await assertOwnedPath(path, { kind: "directory", canonical: true, ownerOnly: true });
  const directory = await opendir(path, { bufferSize: 1 });
  try { for (let count = 0; await directory.read() !== null; count++) require_(count < 255, "reconcile-history-full"); }
  finally { await directory.close(); }
}
export type LegacySetupWitness = { schemaVersion: 1; kind: typeof KIND; attemptId: string; markerSha256: string; resultSha256: string;
  configurationDigest: string; accountDigest: string; applicationReceiptSha256: string; crash: { path: string; sha256: string } };
export function parseLegacySetupWitness(value: unknown): LegacySetupWitness {
  const row = record(value, ["schemaVersion", "kind", "attemptId", "markerSha256", "resultSha256", "configurationDigest", "accountDigest", "applicationReceiptSha256", "crash"]);
  require_(row.schemaVersion === 1 && row.kind === KIND, "reconcile-witness-version");
  const crash = record(row.crash, ["path", "sha256"]);
  return { schemaVersion: 1, kind: KIND, attemptId: uuid(row.attemptId), markerSha256: digest(row.markerSha256), resultSha256: digest(row.resultSha256),
    configurationDigest: digest(row.configurationDigest), accountDigest: digest(row.accountDigest), applicationReceiptSha256: digest(row.applicationReceiptSha256),
    crash: { path: macosAppPath(crash.path), sha256: digest(crash.sha256) } };
}
export function validateLegacyAttempt(markerValue: unknown, resultValue: unknown, witness: LegacySetupWitness): { startedAt: number; finishedAt: number; launchGeneration: string } {
  const marker = record(markerValue, ["schemaVersion", "attemptId", "startedAt", "configurationDigest", "accountDigest", "status"]);
  const result = record(resultValue, ["schemaVersion", "ok", "status", "code", "attemptId", "startedAt", "finishedAt", "configurationDigest", "accountDigest", "progress", "custody", "automationPermission", "launchGeneration"]);
  require_(marker.schemaVersion === 1 && result.schemaVersion === 1 && marker.status === "in-flight-or-unreconciled"
    && result.ok === false && result.status === "recovery-required" && result.code === "process-custody-unproven" && result.custody === "retained"
    && result.automationPermission === "allowed", "reconcile-unsupported-outcome");
  for (const key of ["attemptId", "configurationDigest", "accountDigest"] as const) require_(marker[key] === witness[key] && result[key] === witness[key], "reconcile-attempt-binding-mismatch");
  const startedAt = integer(marker.startedAt), finishedAt = integer(result.finishedAt);
  require_(result.startedAt === startedAt && finishedAt >= startedAt && finishedAt - startedAt < 120_000, "reconcile-attempt-time");
  const progress = record(result.progress, ["accountCreated", "accountBound", "managedEnabled", "permissionsChanged", "subjectDigest"]);
  require_(progress.accountCreated === true && progress.accountBound === false && progress.managedEnabled === false && progress.permissionsChanged === 0 && progress.subjectDigest === null,
    "reconcile-not-an-unbound-prepermission-failure");
  return { startedAt, finishedAt, launchGeneration: uuid(result.launchGeneration) };
}
export function validateOriginalSetupEvidence(marker: Buffer, result: Buffer, archive: Buffer, witness: LegacySetupWitness) {
  require_(sha(marker) === witness.markerSha256 && sha(result) === witness.resultSha256, "reconcile-original-evidence-changed");
  require_(archive.equals(result), "reconcile-original-result-not-archived");
  return validateLegacyAttempt(json(marker), json(result), witness);
}
export type CrashProof = { incident: string; pid: number; parentPid: number; responsiblePid: number; startedAt: number; exitedAt: number; imageUuid: string };
export function parseLegacyCrash(bytes: Buffer, attempt: { startedAt: number; finishedAt: number }): CrashProof {
  const newline = bytes.indexOf(10); require_(newline > 0, "reconcile-invalid-crash-framing");
  const header = record(json(bytes.subarray(0, newline))), crash = record(json(bytes.subarray(newline + 1)));
  require_(header.app_name === "imsg" && header.bug_type === "309" && header.incident_id === crash.incident, "reconcile-crash-header");
  require_(crash.procName === "imsg" && crash.parentProc === "bun" && crash.responsibleProc === "TextButler"
    && crash.coalitionName === "app.textbutler.imessage-setup" && crash.procPath === "/private/tmp/*/imsg", "reconcile-crash-lineage");
  const exception = record(crash.exception), termination = record(crash.termination);
  require_(exception.type === "EXC_BREAKPOINT" && exception.signal === "SIGTRAP" && termination.namespace === "SIGNAL" && termination.code === 5
    && integer(crash.procExitAbsTime) > integer(crash.procStartAbsTime), "reconcile-no-positive-crash-exit");
  require_(typeof crash.procLaunch === "string" && typeof crash.captureTime === "string", "reconcile-crash-time");
  const startedAt = Date.parse(crash.procLaunch), exitedAt = Date.parse(crash.captureTime);
  require_(Number.isFinite(startedAt) && Number.isFinite(exitedAt) && startedAt >= attempt.startedAt && exitedAt >= startedAt && exitedAt <= attempt.finishedAt,
    "reconcile-crash-outside-attempt");
  require_(Array.isArray(crash.usedImages) && crash.usedImages.length <= 512, "reconcile-crash-images");
  const images = crash.usedImages.map(value => record(value)).filter(image => image.name === "imsg");
  require_(images.length === 1 && images[0]!.uuid === IMSG_UUID && images[0]!.path === crash.procPath, "reconcile-crash-binary-mismatch");
  require_(Array.isArray(crash.threads) && crash.threads.length <= 256 && Number.isSafeInteger(crash.faultingThread), "reconcile-crash-thread");
  const frames = record(crash.threads[Number(crash.faultingThread)]).frames;
  require_(Array.isArray(frames) && frames.length <= 1024, "reconcile-crash-frames");
  const symbols = frames.map(value => record(value).symbol);
  require_(symbols.includes("closure #1 in variable initialization expression of static NSBundle.phoneNumberKit")
    && symbols.includes("specialized static RpcCommand.run(values:runtime:contactResolverFactory:)"), "reconcile-different-crash");
  const pid = integer(crash.pid), parentPid = integer(crash.parentPid), responsiblePid = integer(crash.responsiblePid);
  require_(new Set([pid, parentPid, responsiblePid]).size === 3 && Math.max(pid, parentPid, responsiblePid) <= 2 ** 31 - 1, "reconcile-crash-pids");
  require_(typeof crash.incident === "string", "reconcile-crash-incident");
  return { incident: uuid(crash.incident.toLowerCase()), pid, parentPid, responsiblePid, startedAt, exitedAt, imageUuid: IMSG_UUID };
}
function processAbsent(pid: number): void {
  for (const target of [pid, -pid]) {
    try { process.kill(target, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw new Error("reconcile-process-unknown"); }
    throw new Error("reconcile-process-or-group-present");
  }
}
async function launchJobAbsent(label: string): Promise<void> {
  const uid = process.getuid?.(); require_(uid !== undefined, "reconcile-missing-uid");
  const child = Bun.spawn(["/bin/launchctl", "print", `gui/${uid}/${label}`], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
  let count = 0;
  const capture_ = async (stream: ReadableStream<Uint8Array>) => { const chunks: Uint8Array[] = []; for await (const chunk of stream) { count += chunk.length; if (count > 65536) child.kill(); else chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); };
  // A rejected reader must still join the fixed read-only child before returning.
  const outputs = await Promise.allSettled([child.exited, capture_(child.stdout), capture_(child.stderr)]);
  require_(count <= 65536, "reconcile-launchd-output-bound");
  require_(outputs.every(value => value.status === "fulfilled"), "reconcile-launchd-read-failed");
  const [code, stdout, stderr] = outputs.map(value => value.status === "fulfilled" ? value.value : undefined);
  require_(code === 113 && child.signalCode === null && stdout === "" && stderr === `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`, "reconcile-launch-job-not-proven-absent");
}
export function validateUnboundAuth(value: unknown, authId: string, home: string): void {
  const auth = record(value, ["schemaVersion", "id", "kind", "provider", "path", "realmKey"]);
  const path = join(home, "Library", "Messages");
  const realm = sha(`io-linked-device-realm-v1\0${JSON.stringify({ kind: "linked-device-store", provider: "imessage", storePath: path })}`);
  require_(auth.schemaVersion === 1 && auth.id === authId && auth.kind === "linked-device-store" && auth.provider === "imessage" && auth.path === path && auth.realmKey === realm,
    "reconcile-auth-no-longer-exact-unbound-locator");
}
export type ReconciliationSnapshot = { marker: Captured; resultSha256: string; evidenceSha256: string; witness: LegacySetupWitness;
  crash: CrashProof; authSha256: string; launchGeneration: string; applicationReceiptSha256: string; observations: { processGroupsAbsent: true; launchJobsAbsent: true; cleanupAdmissionsEmpty: true; unboundAuth: true; permissionsAbsent: true } };
async function inspect(dataDir: string, evidencePath: string): Promise<ReconciliationSnapshot> {
  require_(process.platform === "darwin", "reconcile-macos-required");
  const state = join(dataDir, "state"), evidence = await capture(evidencePath, 8192), witness = parseLegacySetupWitness(json(evidence.bytes));
  const marker = await capture(join(state, MARKER), 4096), result = await capture(join(state, RESULT), 8192);
  const archived = await capture(join(state, "imessage-setup-results", `${witness.attemptId}.recovery-required.json`), 8192);
  const attempt = validateOriginalSetupEvidence(marker.bytes, result.bytes, archived.bytes, witness);
  const appReceipt = await capture(macosAppReceiptPath(dataDir), 65536);
  require_(appReceipt.sha256 === witness.applicationReceiptSha256, "reconcile-app-receipt-changed");
  const app = await readMacosAppReceipt(macosAppReceiptPath(dataDir));
  require_(app.dataDir === dataDir && app.home === homedir() && app.automationConsent === "native-api", "reconcile-app-owner-mismatch");
  await verifyMacosApp(app);
  const config = await loadHostConfig(dataDir), connector = config.ghostget, selected = connector?.automationAccounts?.find(row => row.provider === "imessage");
  require_(sha(JSON.stringify(config)) === witness.configurationDigest && connector !== undefined && selected !== undefined
    && sha(selected.authId) === witness.accountDigest && connector.stateHome !== undefined && connector.runtimeExecutable === app.runtime, "reconcile-authorizing-config-changed");
  await assertOwnedPath(connector.stateHome, { kind: "directory", canonical: true, ownerOnly: true });
  const root = dirname(dirname(connector.executable));
  require_(connector.executable === join(root, "src/cli.ts"), "reconcile-connector-entrypoint");
  for (const [relative, expected] of Object.entries(LEGACY_FILES)) require_(await appFileDigest(join(root, relative), { maximum: 2_097_152 }) === expected, "reconcile-legacy-connector-changed");
  require_(await appFileDigest(join(connector.stateHome, "tools/imsg/0.14.1+private-transport.3/imsg"), { executable: true }) === IMGS_SHA, "reconcile-native-helper-changed");
  const reports = join(app.home, "Library/Logs/DiagnosticReports");
  require_(dirname(witness.crash.path) === reports && /^imsg-\d{4}-\d{2}-\d{2}-\d{6}\.ips$/u.test(witness.crash.path.slice(reports.length + 1)), "reconcile-crash-path");
  const crashFile = await capture(witness.crash.path, 2_097_152, false);
  require_(crashFile.sha256 === witness.crash.sha256, "reconcile-crash-bytes-changed");
  const crash = parseLegacyCrash(crashFile.bytes, attempt);
  for (const pid of [crash.pid, crash.parentPid, crash.responsiblePid]) processAbsent(pid);
  await launchJobAbsent("app.textbutler.imessage-setup"); await launchJobAbsent("app.textbutler.daemon");
  for (const name of ["imessage-setup-launch.json", "imessage-setup-launch.plist", "imessage-setup-binding.json"]) await absent(join(state, name));
  for (const relative of EMPTY_DIRECTORIES) await empty(join(connector.stateHome, relative));
  for (const relative of ["operation-permissions/managed.json", "operation-permissions/policy.json", "control/owner.json", "control/agent.sock"]) await absent(join(connector.stateHome, relative));
  const auth = await capture(join(connector.stateHome, "auth", `${selected.authId}.json`), 4096);
  validateUnboundAuth(json(auth.bytes), selected.authId, app.home);
  return { marker, resultSha256: result.sha256, evidenceSha256: evidence.sha256, witness, crash, authSha256: auth.sha256,
    launchGeneration: attempt.launchGeneration, applicationReceiptSha256: appReceipt.sha256,
    observations: { processGroupsAbsent: true, launchJobsAbsent: true, cleanupAdmissionsEmpty: true, unboundAuth: true, permissionsAbsent: true } };
}
function comparable(snapshot: ReconciliationSnapshot): string { return JSON.stringify({ ...snapshot, marker: { sha256: snapshot.marker.sha256, identity: snapshot.marker.identity } }); }
export function validateExistingSettlement(existing: Buffer, proposed: string): void {
  const wanted = record(json(Buffer.from(proposed))), prior = record(json(existing), Object.keys(wanted));
  const timestamp = integer(prior.reconciledAt);
  require_(timestamp <= Date.now(), "reconcile-settlement-time");
  require_(JSON.stringify({ ...prior, reconciledAt: 0 }) === JSON.stringify({ ...wanted, reconciledAt: 0 }), "reconcile-settlement-changed");
}
export interface ReconciliationPort {
  inspect(): Promise<ReconciliationSnapshot>;
  archive(name: string, bytes: string): Promise<void>;
  release(marker: Captured): Promise<void>;
}
/** Testable settlement order; production supplies no CLI-selected callbacks. */
export async function settleLegacySetup(port: ReconciliationPort): Promise<{ ok: true; status: "reconciled"; attemptId: string }> {
  const before = await port.inspect(), next = await port.inspect();
  require_(comparable(before) === comparable(next), "reconcile-observation-drift");
  const receipt = { schemaVersion: 1, kind: "textbutler.imessage-setup-reconciliation.v1", reconciledAt: Date.now(),
    status: "settled-failed-before-permissions", attemptId: before.witness.attemptId,
    originalMarker: json(before.marker.bytes), originalMarkerSha256: before.marker.sha256, originalMarkerIdentity: before.marker.identity, originalResultSha256: before.resultSha256,
    evidenceSha256: before.evidenceSha256, applicationReceiptSha256: before.applicationReceiptSha256, configurationDigest: before.witness.configurationDigest,
    accountDigest: before.witness.accountDigest, authSha256: before.authSha256, launchGeneration: before.launchGeneration,
    crashReportSha256: before.witness.crash.sha256, crash: before.crash, observations: before.observations,
    connectorReviewedSourceDigests: LEGACY_FILES, noReplay: true };
  const bytes = `${JSON.stringify(receipt)}\n`; require_(Buffer.byteLength(bytes) <= 16384, "reconcile-receipt-bound");
  await port.archive(`${before.witness.attemptId}.reconciled.json`, bytes);
  const final = await port.inspect(); require_(comparable(before) === comparable(final), "reconcile-observation-drift-after-archive");
  await port.release(before.marker);
  return { ok: true, status: "reconciled", attemptId: before.witness.attemptId };
}
export async function releaseLegacyMarker(state: string, expected: Captured): Promise<void> {
  const current = await capture(join(state, MARKER), 4096);
  require_(current.sha256 === expected.sha256 && JSON.stringify(current.identity) === JSON.stringify(expected.identity), "reconcile-marker-replaced");
  await unlink(join(state, MARKER));
  const directory = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function reconcileLegacyIMessageSetup(dataDir: string, evidencePath: string) {
  macosAppPath(dataDir); macosAppPath(evidencePath);
  await assertOwnedPath(dataDir, { kind: "directory", canonical: true, ownerOnly: true });
  const lock = await acquireOwnerDatabase(dataDir, "daemon-custody");
  try {
    const state = join(dataDir, "state"), archive = join(state, "imessage-setup-results");
    await requireReconciliationHistorySpace(archive);
    return await settleLegacySetup({ inspect: () => inspect(dataDir, evidencePath),
      archive: async (name, bytes) => {
        if (await createPrivateFileOnce(archive, name, bytes) !== "created") validateExistingSettlement((await capture(join(archive, name), 16384)).bytes, bytes);
      }, release: expected => releaseLegacyMarker(state, expected) });
  } finally { lock.close(); }
}
export function parseReconcileArgs(args: readonly string[]): { dataDir: string; evidence: string } {
  require_(args.length === 4 && args[0] === "--data-dir" && args[2] === "--evidence", "Usage: bun scripts/reconcile-imessage-setup.ts --data-dir /absolute/private/data --evidence /absolute/private/witness.json");
  return { dataDir: macosAppPath(args[1]), evidence: macosAppPath(args[3]) };
}
if (import.meta.main) {
  try { const args = parseReconcileArgs(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(await reconcileLegacyIMessageSetup(args.dataDir, args.evidence))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, status: "reconciliation-not-confirmed", code: error instanceof Error && /^reconcile-[a-z-]+$/u.test(error.message) ? error.message : "reconcile-could-not-be-proven" })}\n`); process.exitCode = 1; }
}
