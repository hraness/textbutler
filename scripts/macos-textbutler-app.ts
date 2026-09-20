import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { appFileDigest, appPhysicalDirectory, MACOS_APP_BUNDLE_ID, macosAppExecutable, macosAppPath, macosAppReceiptPath, macosLaunchGeneration, readMacosAppReceipt, verifyMacosApp, type MacosAppIdentity } from "../packages/textbutler/src/macos-app.ts";
import { physicalDirectory, readArtifact, validateBun, verifyDistribution } from "./textbutler-distribution.ts";

const SOURCE = fileURLToPath(new URL("../native/textbutler-launcher.c", import.meta.url));
const EXECUTION_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const INFO = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${MACOS_APP_BUNDLE_ID}</string><key>CFBundleExecutable</key><string>TextButler</string><key>CFBundleName</key><string>TextButler</string><key>CFBundleDisplayName</key><string>TextButler</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSUIElement</key><true/><key>NSAppleEventsUsageDescription</key><string>TextButler uses Messages to send replies that you enable.</string></dict></plist>\n`;
async function run(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([...args], { cwd: "/", env: EXECUTION_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" });
  let total = 0, overflow = false;
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) { total += chunk.length; if (total > 131072) { overflow = true; child.kill(); } else chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const [code, out, error] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
  if (code !== 0 || child.signalCode !== null || overflow) throw new Error(`TextButler native operation failed (${args[0]}): ${(error || out).slice(-8192)}`);
  return out;
}
async function syncDirectory(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await file.sync(); } finally { await file.close(); } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function publishPrivateArtifact(parent: string, name: string, bytes: Buffer): Promise<void> {
  if (!["macos-app.json", "imessage-setup-launch.json", "imessage-setup-launch.plist"].includes(name) || bytes.length < 1 || bytes.length > 65536) throw new Error("Invalid private app artifact.");
  await appPhysicalDirectory(parent, true);
  const target = join(parent, name), stage = join(parent, `.textbutler-app-${randomUUID()}`), file = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const identity = await file.stat();
  try {
    await file.writeFile(bytes); await file.sync();
    try { await link(stage, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await privateBytes(target)).equals(bytes)) throw error; }
  } finally {
    await file.close(); const current = await lstat(stage);
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile() || current.isSymbolicLink()) throw new Error("Private app staging identity changed and was preserved.");
    await unlink(stage); await syncDirectory(parent);
  }
}
async function seal(app: string): Promise<void> {
  for (const file of [join(app, "Contents", "Info.plist"), join(app, "Contents", "_CodeSignature", "CodeResources")]) await chmod(file, 0o400);
  await chmod(join(app, "Contents", "MacOS", "TextButler"), 0o500);
  for (const dir of [join(app, "Contents", "MacOS"), join(app, "Contents", "_CodeSignature"), join(app, "Contents"), app]) { await chmod(dir, 0o500); await syncDirectory(dir); }
}
async function removeGeneratedFinderMetadata(app: string): Promise<void> {
  // Finder may annotate a newly created .app while the owner's file picker is
  // open. Remove only these two non-code attributes from this generated app;
  // never clear quarantine, permissions, or attributes on input/user files.
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.uid !== process.getuid?.() || info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error("Generated app metadata has an unexpected owner or file type.");
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    const names = (await run(["/usr/bin/xattr", path])).split("\n");
    const remove = ["com.apple.FinderInfo", "com.apple.ResourceFork"].filter(name => names.includes(name));
    if (remove.length) {
      // The staged copy retains sealed input modes. Temporarily allow this
      // owner to remove Finder metadata, then restore exactly those modes.
      const mode = info.mode & 0o7777;
      try { await chmod(path, mode | 0o200); for (const name of remove) await run(["/usr/bin/xattr", "-d", name, path]); }
      finally { await chmod(path, mode); }
    }
  };
  await visit(app);
}

/** Copy verified bytes into a new private staging directory. Preserve security
 * metadata and normalize only Finder's two signing-incompatible attributes on
 * the generated copy; neither the source nor an installed app is modified. */
export async function stageTextbutlerMacosApp(identity: MacosAppIdentity, source: string, destination: string): Promise<void> {
  await verifyMacosApp(identity, source);
  await appPhysicalDirectory(dirname(destination), true);
  if (await exists(destination)) throw new Error("The app staging destination already exists and was preserved.");
  await run(["/usr/bin/ditto", "--rsrc", "--extattr", "--qtn", "--acl", source, destination]);
  await verifyMacosApp(identity, destination);
  await removeGeneratedFinderMetadata(destination);
  await seal(destination); await verifyMacosApp(identity, destination);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", destination]);
  await verifyMacosApp(identity, destination);
}

/** Native-only builder seam used by synthetic custody tests. Production callers
 * enter through buildTextbutlerMacosApp and its distribution admission. */
export async function compileTextbutlerMacosApp(input: {
  home: string; dataDir: string; appPath: string; runtime: string; runtimeSha256: string;
  entrypoint: string; entrypointSha256: string; output: string; syntheticAutomationPermission?: "allowed" | "denied";
}): Promise<{ directory: string; identity: MacosAppIdentity }> {
  if (process.platform !== "darwin" || process.getuid?.() === undefined || process.getuid() === 0) throw new Error("The TextButler app requires a non-root macOS build.");
  for (const key of ["home", "dataDir", "appPath", "runtime", "entrypoint", "output"] as const) macosAppPath(input[key]);
  if (input.appPath !== join(input.home, "Applications", "TextButler.app")) throw new Error("The app must use the exact owner Applications/TextButler.app path.");
  await appPhysicalDirectory(input.home, true);
  if (await appFileDigest(input.runtime, { executable: true }) !== input.runtimeSha256 || await appFileDigest(input.entrypoint) !== input.entrypointSha256) throw new Error("The admitted payload changed before the native build.");
  await mkdir(input.output, { mode: 0o700 }); await appPhysicalDirectory(input.output, true);
  const app = join(input.output, "TextButler.app"), executable = join(app, "Contents", "MacOS", "TextButler");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents", "Info.plist"), INFO, { flag: "wx", mode: 0o600 });
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "textbutler-native-build-"));
  try {
    const source = await readArtifact(SOURCE, 1024 * 1024), sourceSha256 = createHash("sha256").update(source).digest("hex");
    const compiledSource = join(scratch, "textbutler-launcher.c");
    await writeFile(compiledSource, source, { flag: "wx", mode: 0o400 });
    const messagesBundleId = (await run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", "/System/Applications/Messages.app/Contents/Info.plist"])).trim();
    if (messagesBundleId !== "com.apple.MobileSMS" && messagesBundleId !== "com.apple.iChat") throw new Error("The system Messages app has an unsupported identity.");
    const values = { TB_APP_PATH: input.appPath, TB_EXECUTABLE_PATH: macosAppExecutable(input), TB_HOME: input.home, TB_DATA_DIR: input.dataDir, TB_RUNTIME: input.runtime, TB_RUNTIME_SHA256: input.runtimeSha256, TB_ENTRYPOINT: input.entrypoint, TB_ENTRYPOINT_SHA256: input.entrypointSha256, TB_BUNDLE_ID: MACOS_APP_BUNDLE_ID, TB_MESSAGES_BUNDLE_ID: messagesBundleId };
    if (input.syntheticAutomationPermission !== undefined && !["allowed", "denied"].includes(input.syntheticAutomationPermission)) throw new Error("Invalid synthetic native permission fixture.");
    await writeFile(join(scratch, "textbutler-launch-config.h"), `${Object.entries(values).map(([key, value]) => `#define ${key} ${JSON.stringify(value)}`).join("\n")}\n#define TB_UID ${process.getuid()}\n${input.syntheticAutomationPermission === undefined ? "" : `#define TB_TEST_AUTOMATION_PERMISSION ${JSON.stringify(input.syntheticAutomationPermission)}\n`}`, { flag: "wx", mode: 0o600 });
    await run(["/usr/bin/xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-framework", "CoreFoundation", "-framework", "ApplicationServices", "-I", scratch, compiledSource, "-o", executable]);
    await removeGeneratedFinderMetadata(app);
    await run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", "--identifier", MACOS_APP_BUNDLE_ID, app]);
    await removeGeneratedFinderMetadata(app);
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
    const identity: MacosAppIdentity = { schemaVersion: 1, bundleId: MACOS_APP_BUNDLE_ID, signing: "ad-hoc", messagesBundleId, automationConsent: input.syntheticAutomationPermission === undefined ? "native-api" : "synthetic", appPath: input.appPath, home: input.home, dataDir: input.dataDir, runtime: input.runtime, entrypoint: input.entrypoint, runtimeSha256: input.runtimeSha256, entrypointSha256: input.entrypointSha256,
      executableSha256: await appFileDigest(executable, { executable: true }), infoPlistSha256: await appFileDigest(join(app, "Contents", "Info.plist")), signatureSha256: await appFileDigest(join(app, "Contents", "_CodeSignature", "CodeResources")), sourceSha256 };
    if (await appFileDigest(SOURCE) !== sourceSha256) throw new Error("The native launcher source changed during compilation; this build is not admitted.");
    await seal(app); await verifyMacosApp(identity, app);
    await publishPrivateArtifact(input.output, "macos-app.json", Buffer.from(`${JSON.stringify(identity)}\n`));
    await syncDirectory(input.output);
    return { directory: input.output, identity };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function buildTextbutlerMacosApp(options: { from: string; output: string; appPath?: string; dataDir?: string }): Promise<{ directory: string; identity: MacosAppIdentity }> {
  const distribution = await verifyDistribution(macosAppPath(options.from));
  if (distribution.manifest.runtime.platform !== "darwin" || distribution.manifest.runtime.arch !== process.arch || distribution.manifest.runtime.version !== Bun.version) throw new Error("The installed TextButler payload targets another runtime.");
  const runtime = await validateBun(process.execPath, distribution.manifest.runtime.sha256), home = homedir();
  return compileTextbutlerMacosApp({ home, dataDir: options.dataDir ?? join(home, "Library", "Application Support", "Textbutler"), appPath: options.appPath ?? join(home, "Applications", "TextButler.app"), runtime: runtime.path, runtimeSha256: distribution.manifest.runtime.sha256, entrypoint: join(options.from, "textbutler.mjs"), entrypointSha256: await appFileDigest(join(options.from, "textbutler.mjs")), output: options.output });
}

/** Darwin's supported exclusive rename prevents a raced destination from being
 * replaced. The temporary publisher has no FDA or product runtime role. */
async function publishApp(source: string, destination: string): Promise<void> {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "textbutler-native-publish-"));
  try {
    const code = "#include <stdio.h>\n#include <sys/stdio.h>\nint main(int argc, char **argv) { if (argc != 3) return 64; if (renamex_np(argv[1], argv[2], RENAME_EXCL) != 0) { perror(\"exclusive app publication\"); return 1; } return 0; }\n";
    await writeFile(join(scratch, "publish.c"), code, { flag: "wx", mode: 0o600 });
    await run(["/usr/bin/xcrun", "clang", "-Wall", "-Wextra", "-Werror", "-O2", join(scratch, "publish.c"), "-o", join(scratch, "publish")]);
    await run([join(scratch, "publish"), source, destination]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function installTextbutlerMacosApp(options: { from: string }): Promise<{ appPath: string; receiptPath: string; alreadyInstalled: boolean; signing: "ad-hoc" }> {
  if (process.platform !== "darwin") throw new Error("TextButler.app requires macOS.");
  const from = macosAppPath(options.from), identity = await readMacosAppReceipt(join(from, "macos-app.json"));
  if (identity.automationConsent !== "native-api") throw new Error("A synthetic permission fixture cannot be installed as TextButler.app.");
  if (identity.home !== homedir()) throw new Error("The app was built for another owner home.");
  const app = join(from, "TextButler.app"), receiptPath = macosAppReceiptPath(identity.dataDir), parent = dirname(identity.appPath);
  if (JSON.stringify((await readdir(from)).sort()) !== JSON.stringify(["TextButler.app", "macos-app.json"].sort())) throw new Error("The app build contains unexpected files.");
  await verifyMacosApp(identity, app);
  const payload = await verifyDistribution(dirname(identity.entrypoint));
  if (payload.manifest.runtime.sha256 !== identity.runtimeSha256) throw new Error("The app's installed payload no longer matches its runtime pin.");
  await physicalDirectory(parent, true); await physicalDirectory(identity.dataDir, true); await physicalDirectory(dirname(receiptPath), true);
  if (await exists(receiptPath)) {
    if (JSON.stringify(await readMacosAppReceipt(receiptPath)) !== JSON.stringify(identity)) throw new Error("Another TextButler app receipt exists and was preserved. A managed upgrade must retain its prior identity and permission evidence.");
    await verifyMacosApp(identity);
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", identity.appPath]);
    return { appPath: identity.appPath, receiptPath, alreadyInstalled: true, signing: "ad-hoc" };
  }
  // A prior complete app with no receipt can be recovered only when every byte
  // equals this verified build. Foreign or partial apps remain untouched.
  if (await exists(identity.appPath)) await verifyMacosApp(identity);
  else {
    const staged = await mkdtemp(join(parent, ".textbutler-app-stage-"));
    try {
      const copy = join(staged, "TextButler.app");
      await stageTextbutlerMacosApp(identity, app, copy);
      await chmod(copy, 0o700); await publishApp(copy, identity.appPath); await seal(identity.appPath); await syncDirectory(parent);
    } finally { if ((await readdir(staged)).length === 0) await rmdir(staged); }
  }
  await verifyMacosApp(identity);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", identity.appPath]);
  await publishPrivateArtifact(dirname(receiptPath), "macos-app.json", Buffer.from(`${JSON.stringify(identity)}\n`)); await syncDirectory(dirname(receiptPath));
  return { appPath: identity.appPath, receiptPath, alreadyInstalled: false, signing: "ad-hoc" };
}

const SETUP_LABEL = "app.textbutler.imessage-setup";
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
interface SetupLaunch { schemaVersion: 1; application: MacosAppIdentity; generation: string; startedAt: number }
type SetupCommandResult = { exitCode: number; stdout: string; stderr: string };
export type SetupJob = { state: "absent" } | { state: "owned"; running: boolean; exitCode: number | null } | { state: "unknown" };
/** Closed parser: a similarly named job is never sufficient ownership proof. */
export function parseMacosSetupJob(result: SetupCommandResult, expected: { uid: number; plist: string; executable: string; generation?: string }): SetupJob {
  if (result.exitCode === 113 && result.stdout === "" && result.stderr === `Bad request.\nCould not find service "${SETUP_LABEL}" in domain for user gui: ${expected.uid}\n`) return { state: "absent" };
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 131072 || !result.stdout.startsWith(`gui/${expected.uid}/${SETUP_LABEL} = {\n`)) return { state: "unknown" };
  const lines = result.stdout.split("\n").map(line => line.trim()), top: string[] = [], args: string[] = [], environment: string[] = [];
  let depth = 1, argumentBlocks = 0, environmentBlocks = 0, inArguments = false, inEnvironment = false;
  for (const line of lines.slice(1)) {
    if (depth === 0) { if (line !== "") return { state: "unknown" }; continue; }
    if (depth === 1) {
      top.push(line);
      if (line === "arguments = {") { argumentBlocks++; inArguments = true; }
      if (line === "environment = {") { environmentBlocks++; inEnvironment = true; }
    } else if (depth === 2 && line !== "}") { if (inArguments) args.push(line); if (inEnvironment) environment.push(line); }
    if (line === "}") { if (depth === 2) { inArguments = false; inEnvironment = false; } depth--; }
    else if (line.endsWith(" = {")) depth++;
  }
  if (depth !== 0) return { state: "unknown" };
  if (["path", "program", "state", "pid", "last exit code"].some(key => top.filter(line => line.startsWith(`${key} = `)).length > 1)) return { state: "unknown" };
  const fields = (key: string): string | null => { const found = top.filter(line => line.startsWith(`${key} = `)); return found.length === 1 ? found[0]!.slice(key.length + 3) : null; };
  if (fields("path") !== expected.plist || fields("program") !== expected.executable || argumentBlocks !== 1 || JSON.stringify(args) !== JSON.stringify([expected.executable, "--imessage-setup"])) return { state: "unknown" };
  if (expected.generation === undefined || environmentBlocks !== 1 || macosLaunchGeneration(`environment = {\n${environment.join("\n")}\n}\n`) !== expected.generation) return { state: "unknown" };
  const observedExit = fields("last exit code"), exit = observedExit === "(never exited)" ? null : observedExit, pid = fields("pid");
  if (pid !== null && (!/^[1-9][0-9]{0,9}$/u.test(pid) || Number(pid) > 2 ** 31 - 1) || exit !== null && (!/^[0-9]{1,3}$/u.test(exit) || Number(exit) > 255)) return { state: "unknown" };
  const state = fields("state");
  if (state !== "running" && state !== "not running" || state === "running" && pid === null || state === "not running" && pid !== null) return { state: "unknown" };
  return { state: "owned", running: state === "running", exitCode: exit === null ? null : Number(exit) };
}
async function setupLaunchctl(args: readonly string[]): Promise<SetupCommandResult> {
  const child = Bun.spawn(["/bin/launchctl", ...args], { env: EXECUTION_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, killSignal: "SIGKILL" });
  let size = 0, overflow = false;
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => { const chunks: Uint8Array[] = []; for await (const bytes of stream) { size += bytes.length; if (size > 131072) { overflow = true; child.kill(); } else chunks.push(bytes); } return Buffer.concat(chunks).toString("utf8"); };
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
  if (overflow || child.signalCode !== null) throw new Error("The app setup launchd outcome is uncertain; its exact artifacts were retained.");
  return { exitCode, stdout, stderr };
}
function setupPlist(record: SetupLaunch): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${SETUP_LABEL}</string><key>ProgramArguments</key><array><string>${xml(macosAppExecutable(record.application))}</string><string>--imessage-setup</string></array><key>AssociatedBundleIdentifiers</key><array><string>${MACOS_APP_BUNDLE_ID}</string></array><key>EnvironmentVariables</key><dict><key>TEXTBUTLER_LAUNCH_AGENT_GENERATION</key><string>${record.generation}</string></dict><key>RunAtLoad</key><true/><key>WorkingDirectory</key><string>/</string><key>LimitLoadToSessionType</key><string>Aqua</string><key>ExitTimeOut</key><integer>60</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`;
}
async function privateBytes(path: string): Promise<Buffer> { const info = await lstat(path); if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("App setup metadata must remain private."); return readArtifact(path, 65536); }
async function removeExact(path: string, bytes: Buffer): Promise<void> { const before = await lstat(path); if (!(await privateBytes(path)).equals(bytes)) throw new Error("App setup metadata changed and was preserved."); const after = await lstat(path); if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error("App setup metadata changed and was preserved."); await unlink(path); await syncDirectory(dirname(path)); }
/** Only this fixed app role is submitted to launchd. Running the app executable
 * directly as a terminal child is not evidence of app-scoped TCC permission. */
export async function launchTextbutlerImessageSetup(options: { dataDir: string; waitMs?: number }): Promise<{ status: "completed" | "blocked" | "recovery-required" | "pending"; resultPath: string; code?: string }> {
  if (process.platform !== "darwin") throw new Error("App setup requires macOS.");
  const dataDir = macosAppPath(options.dataDir), application = await readMacosAppReceipt(macosAppReceiptPath(dataDir));
  if (application.automationConsent !== "native-api") throw new Error("A synthetic permission fixture cannot authorize app setup.");
  if (application.home !== homedir() || application.dataDir !== dataDir || application.runtime !== await realpath(process.execPath)) throw new Error("The app setup request does not match this installed owner/runtime.");
  await verifyMacosApp(application);
  const uid = process.getuid!(), target = `gui/${uid}/${SETUP_LABEL}`, state = join(dataDir, "state"), recordPath = join(state, "imessage-setup-launch.json"), plist = join(state, "imessage-setup-launch.plist"), resultPath = join(state, "imessage-setup-result.json");
  const expected: { uid: number; plist: string; executable: string; generation?: string } = { uid, plist, executable: macosAppExecutable(application) }, inspect = async () => parseMacosSetupJob(await setupLaunchctl(["print", target]), expected);
  let record: SetupLaunch, recordBytes: Buffer, plistBytes: Buffer;
  if (await exists(recordPath)) {
    recordBytes = await privateBytes(recordPath); const raw: unknown = JSON.parse(recordBytes.toString("utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The previous app setup launch needs reconciliation.");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "application,generation,schemaVersion,startedAt" || value.schemaVersion !== 1 || typeof value.generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.generation) || !Number.isSafeInteger(value.startedAt) || Number(value.startedAt) < 0 || JSON.stringify(value.application) !== JSON.stringify(application)) throw new Error("The previous app setup launch identity changed; it was preserved.");
    record = value as unknown as SetupLaunch; expected.generation = record.generation; plistBytes = await privateBytes(plist);
    if (plistBytes.toString("utf8") !== setupPlist(record) || (await inspect()).state !== "owned") throw new Error("The previous app setup job is unknown; preserve it and reconcile before retrying.");
  } else {
    if (await exists(plist) || (await inspect()).state !== "absent") throw new Error("An unknown app setup job or artifact exists and was preserved.");
    record = { schemaVersion: 1, application, generation: randomUUID(), startedAt: Date.now() }; expected.generation = record.generation; recordBytes = Buffer.from(`${JSON.stringify(record)}\n`); plistBytes = Buffer.from(setupPlist(record));
    await publishPrivateArtifact(state, "imessage-setup-launch.json", recordBytes); await publishPrivateArtifact(state, "imessage-setup-launch.plist", plistBytes);
    await verifyMacosApp(application);
    if ((await inspect()).state !== "absent") throw new Error("App setup job ownership changed before bootstrap; artifacts were retained.");
    const result = await setupLaunchctl(["bootstrap", `gui/${uid}`, plist]);
    if (result.exitCode !== 0 || (await inspect()).state !== "owned") throw new Error("App setup bootstrap is uncertain; the exact launch artifacts were retained.");
  }
  const waitMs = options.waitMs ?? 180000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 180000) throw new Error("App setup wait must be between zero and 180 seconds.");
  const deadline = performance.now() + waitMs;
  for (;;) {
    const job = await inspect();
    if (job.state !== "owned") throw new Error("App setup job ownership is uncertain; no job or artifacts were removed.");
    if (!job.running && job.exitCode !== null) {
      const raw: unknown = JSON.parse((await privateBytes(resultPath)).toString("utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("App setup exited without a verified result; artifacts were retained.");
      const result = raw as Record<string, unknown>;
      if (result.schemaVersion !== 1 || result.launchGeneration !== record.generation || typeof result.ok !== "boolean" || !["completed", "blocked", "recovery-required"].includes(String(result.status)) || typeof result.code !== "string" || !/^[a-z0-9-]{1,96}$/u.test(result.code) || !Number.isSafeInteger(result.startedAt) || !Number.isSafeInteger(result.finishedAt) || Number(result.startedAt) < record.startedAt || Number(result.finishedAt) < Number(result.startedAt) || (job.exitCode === 0) !== result.ok || (result.status === "completed") !== result.ok) throw new Error("App setup result does not match its completed launch; artifacts were retained.");
      if (!(await privateBytes(recordPath)).equals(recordBytes) || !(await privateBytes(plist)).equals(plistBytes)) throw new Error("App setup artifacts changed and were preserved.");
      const current = await inspect(); if (current.state !== "owned" || current.running || current.exitCode !== job.exitCode) throw new Error("App setup changed before cleanup; no job was removed.");
      const stopped = await setupLaunchctl(["bootout", "--wait", target]);
      if (stopped.exitCode !== 0 || (await inspect()).state !== "absent") throw new Error("Completed app setup removal is uncertain; its artifacts were retained.");
      await removeExact(plist, plistBytes); await removeExact(recordPath, recordBytes);
      return { status: result.status as "completed" | "blocked" | "recovery-required", resultPath, code: result.code };
    }
    if (performance.now() >= deadline) return { status: "pending", resultPath };
    await Bun.sleep(Math.min(1000, Math.max(1, deadline - performance.now())));
  }
}
if (import.meta.main) {
  try {
    const [action, ...args] = process.argv.slice(2), values = new Map<string, string>();
    for (let at = 0; at < args.length; at += 2) { const key = args[at]!, value = args[at + 1]; if (!["--from", "--output", "--app-path", "--data-dir"].includes(key) || value === undefined || values.has(key)) throw new Error("Use build --from ABS --output ABS [--app-path ABS] [--data-dir ABS], or install --from ABS."); values.set(key, macosAppPath(value)); }
    const from = values.get("--from");
    if (action === "imessage-setup" && values.size === 1 && values.has("--data-dir")) { const result = await launchTextbutlerImessageSetup({ dataDir: values.get("--data-dir")! }); process.stdout.write(`${JSON.stringify({ ok: result.status === "completed", ...result })}\n`); if (result.status !== "completed") process.exitCode = 1; }
    else if (action === "build" && from !== undefined) { const output = values.get("--output"); if (!output) throw new Error("Choose a new --output directory."); const appPath = values.get("--app-path"), dataDir = values.get("--data-dir"); const result = await buildTextbutlerMacosApp({ from, output, ...(appPath === undefined ? {} : { appPath }), ...(dataDir === undefined ? {} : { dataDir }) }); process.stdout.write(`${JSON.stringify({ ok: true, ...result, detail: "Local ad-hoc signed app built; no service or permission was changed. Approval must be verified again after rebuilding this identity." })}\n`); }
    else if (action === "install" && from !== undefined && values.size === 1) process.stdout.write(`${JSON.stringify({ ok: true, ...await installTextbutlerMacosApp({ from }), detail: "App installed inertly. Owner settings, services and macOS permissions are unchanged." })}\n`);
    else throw new Error("Use build or install with its exact arguments.");
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "TextButler app operation failed."}\n`); process.exitCode = 1; }
}
