import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { appFileDigest, appPhysicalDirectory, MACOS_APP_BUNDLE_ID, macosAppExecutable, macosAppPath, macosAppReceiptPath, macosLaunchGeneration, readMacosAppReceipt, verifyMacosApp, type MacosAppIdentity } from "../packages/textbutler/src/macos-app.ts";
import { physicalDirectory, readArtifact, validateBun, verifyDistribution } from "./textbutler-distribution.ts";
import { acquireOwnerDatabase } from "../packages/textbutler/src/daemon-custody.ts";
import { MESSAGES_AUTOMATION, MESSAGES_FDA } from "../packages/textbutler/src/permission-copy.ts";
import { prePrompt, recover, terminalPromptIO, type PromptIO } from "../packages/textbutler/src/permission-prompt.ts";

const SOURCE = fileURLToPath(new URL("../native/textbutler-launcher.c", import.meta.url));
const EXECUTION_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const INFO = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${MACOS_APP_BUNDLE_ID}</string><key>CFBundleExecutable</key><string>TextButler</string><key>CFBundleName</key><string>Textbutler</string><key>CFBundleDisplayName</key><string>Textbutler</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSUIElement</key><true/><key>NSAppleEventsUsageDescription</key><string>Textbutler sends replies through Messages only in the chats you turn on.</string></dict></plist>\n`;
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
  if (!["macos-app.json", "imessage-setup-launch.json", "imessage-setup-launch.plist", "macos-app-upgrade.json", "previous-macos-app.json", "next-macos-app.json", "outcome.json"].includes(name) || bytes.length < 1 || bytes.length > 65536) throw new Error("Invalid private app artifact.");
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

/** A codesigning identity is a keychain query string, never a path or flag. */
function signingIdentity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 256 || !/^[\x20-\x7e]+$/u.test(value) || value.startsWith("-")) throw new Error("Choose a printable codesigning identity name.");
  return value;
}
/** Native-only builder seam used by synthetic custody tests. Production callers
 * enter through buildTextbutlerMacosApp and its distribution admission. */
export async function compileTextbutlerMacosApp(input: {
  home: string; dataDir: string; appPath: string; runtime: string; runtimeSha256: string;
  entrypoint: string; entrypointSha256: string; output: string; signingIdentity?: string; syntheticAutomationPermission?: "allowed" | "denied";
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
    // A persistent signing identity keeps macOS permission grants bound to the
    // certificate across rebuilds; ad-hoc signing rebinds grants to each cdhash.
    const signer = input.signingIdentity === undefined ? "-" : signingIdentity(input.signingIdentity);
    await run(["/usr/bin/codesign", "--force", "--sign", signer, "--timestamp=none", "--identifier", MACOS_APP_BUNDLE_ID, app]);
    await removeGeneratedFinderMetadata(app);
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
    const identity: MacosAppIdentity = { schemaVersion: 1, bundleId: MACOS_APP_BUNDLE_ID, signing: input.signingIdentity === undefined ? "ad-hoc" : "certificate", messagesBundleId, automationConsent: input.syntheticAutomationPermission === undefined ? "native-api" : "synthetic", appPath: input.appPath, home: input.home, dataDir: input.dataDir, runtime: input.runtime, entrypoint: input.entrypoint, runtimeSha256: input.runtimeSha256, entrypointSha256: input.entrypointSha256,
      executableSha256: await appFileDigest(executable, { executable: true }), infoPlistSha256: await appFileDigest(join(app, "Contents", "Info.plist")), signatureSha256: await appFileDigest(join(app, "Contents", "_CodeSignature", "CodeResources")), sourceSha256 };
    if (await appFileDigest(SOURCE) !== sourceSha256) throw new Error("The native launcher source changed during compilation; this build is not admitted.");
    await seal(app); await verifyMacosApp(identity, app);
    await publishPrivateArtifact(input.output, "macos-app.json", Buffer.from(`${JSON.stringify(identity)}\n`));
    await syncDirectory(input.output);
    return { directory: input.output, identity };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function buildTextbutlerMacosApp(options: { from: string; output: string; appPath?: string; dataDir?: string; signingIdentity?: string }): Promise<{ directory: string; identity: MacosAppIdentity }> {
  const distribution = await verifyDistribution(macosAppPath(options.from));
  if (distribution.manifest.runtime.platform !== "darwin" || distribution.manifest.runtime.arch !== process.arch || distribution.manifest.runtime.version !== Bun.version) throw new Error("The installed TextButler payload targets another runtime.");
  const runtime = await validateBun(process.execPath, distribution.manifest.runtime.sha256), home = homedir();
  return compileTextbutlerMacosApp({ home, dataDir: options.dataDir ?? join(home, "Library", "Application Support", "Textbutler"), appPath: options.appPath ?? join(home, "Applications", "TextButler.app"), runtime: runtime.path, runtimeSha256: distribution.manifest.runtime.sha256, entrypoint: join(options.from, "textbutler.mjs"), entrypointSha256: await appFileDigest(join(options.from, "textbutler.mjs")), output: options.output, ...(options.signingIdentity === undefined ? {} : { signingIdentity: signingIdentity(options.signingIdentity) }) });
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
const UPGRADE_JOURNAL = "macos-app-upgrade.json", UPGRADE_ARCHIVE_LIMIT = 32;
const sameIdentity = (a: Stats, b: Stats): boolean => ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => a[key as keyof Stats] === b[key as keyof Stats]);
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
async function privateSnapshot(path: string): Promise<{ bytes: Buffer; identity: Stats }> {
  const before = await lstat(path), bytes = await privateBytes(path), after = await lstat(path);
  if (!sameIdentity(before, after)) throw new Error("The private app artifact changed during verification.");
  return { bytes, identity: after };
}
/** Exact receipt replacement is the second commit point after the app swap.
 * A retained journal fences a crash between these two filesystem operations. */
async function replaceAppReceipt(path: string, expected: Awaited<ReturnType<typeof privateSnapshot>>, bytes: Buffer): Promise<void> {
  const parent = dirname(path), stage = join(parent, `.textbutler-app-${randomUUID()}`);
  const file = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let owned = await file.stat(), published = false;
  try {
    await file.writeFile(bytes); await file.sync(); owned = await file.stat();
    const current = await privateSnapshot(path);
    if (!sameIdentity(expected.identity, current.identity) || !current.bytes.equals(expected.bytes) || !sameIdentity(owned, await lstat(stage))) throw new Error("The installed app receipt changed before upgrade; it was preserved.");
    await rename(stage, path); published = true; await syncDirectory(parent);
    if (!(await privateBytes(path)).equals(bytes)) throw new Error("App receipt publication is uncertain; preserve the upgrade journal.");
  } finally {
    await file.close();
    if (!published) {
      if (!sameIdentity(owned, await lstat(stage))) throw new Error("The app receipt staging identity changed and was preserved.");
      await unlink(stage); await syncDirectory(parent);
    }
  }
}
/** Compile a closed, one-transition helper. Its only commands inspect native
 * process paths or swap the two compiled, inode-bound app directories. */
async function appSwapHelper(current: string, staged: string): Promise<{ invoke(mode: "check" | "forward" | "rollback"): Promise<void>; close(): Promise<void> }> {
  const [old, next] = await Promise.all([lstat(current), lstat(staged)]);
  if (!old.isDirectory() || !next.isDirectory() || old.dev !== next.dev || old.uid !== process.getuid?.() || next.uid !== process.getuid?.()) throw new Error("App upgrade requires two owned directories on the same filesystem.");
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "textbutler-app-swap-")), executable = join(scratch, "swap");
  const source = `#include <sys/stat.h>
#include <sys/stdio.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *current=${JSON.stringify(current)}, *staged=${JSON.stringify(staged)};
static int directory(const char *path, uint64_t dev, uint64_t ino) {
  struct stat st; char physical[PATH_MAX];
  return realpath(path,physical)!=NULL && strcmp(path,physical)==0 && lstat(path,&st)==0 && S_ISDIR(st.st_mode) && st.st_uid==${process.getuid()} && !(st.st_mode&0022) && (uint64_t)st.st_dev==dev && (uint64_t)st.st_ino==ino;
}
static int in_app(const char *path, const char *app) { size_t n=strlen(app); return strncmp(path,app,n)==0 && path[n]=='/'; }
static int idle(void) {
  pid_t pids[32768]; int size=proc_listpids(PROC_UID_ONLY,${process.getuid()},pids,sizeof(pids));
  if(size<=0 || size>=(int)sizeof(pids) || size%(int)sizeof(pid_t)) { fprintf(stderr,"native process inventory unavailable\\n"); return 0; }
  for(int i=0;i<size/(int)sizeof(pid_t);i++) {
    if(pids[i]<=0) continue;
    char path[PROC_PIDPATHINFO_MAXSIZE]; errno=0; int count=proc_pidpath(pids[i],path,sizeof(path));
    if(count<=0) {
      int reason=errno; if(reason==ESRCH) continue;
      // A deleted unrelated executable can have no path while still running.
      // This verified supervisor never renames its kernel command. Require
      // complete same-owner metadata before excluding a different command;
      // a missing or matching command remains uncertain, never idle.
      struct proc_bsdinfo info={0}; errno=0;
      int bytes=proc_pidinfo(pids[i],PROC_PIDTBSDINFO,0,&info,sizeof(info));
      if(bytes<=0 && errno==ESRCH) continue;
      if(reason==ENOENT && bytes==(int)sizeof(info) && info.pbi_pid==(uint32_t)pids[i] && info.pbi_uid==${process.getuid()} && info.pbi_comm[0] && memchr(info.pbi_comm,0,sizeof(info.pbi_comm)) && strcmp(info.pbi_comm,"TextButler")!=0) continue;
      fprintf(stderr,"native process identity unavailable\\n"); return 0;
    }
    if(count>=(int)sizeof(path) || in_app(path,current) || in_app(path,staged)) { fprintf(stderr,"native app process active or path truncated\\n"); return 0; }
  }
  return 1;
}
static int swap_apps(int forward) {
  int a=open(current,O_RDONLY|O_DIRECTORY|O_NOFOLLOW), b=open(staged,O_RDONLY|O_DIRECTORY|O_NOFOLLOW), result=66;
  mode_t first_mode=forward ? ${old.mode & 0o7777} : ${next.mode & 0o7777}, second_mode=forward ? ${next.mode & 0o7777} : ${old.mode & 0o7777};
  struct stat first,second;
  if(a<0 || b<0 || fstat(a,&first)!=0 || fstat(b,&second)!=0) goto done;
  if((uint64_t)first.st_dev!=${old.dev}ULL || (uint64_t)second.st_dev!=${next.dev}ULL ||
    (uint64_t)first.st_ino!=(forward ? ${old.ino}ULL : ${next.ino}ULL) || (uint64_t)second.st_ino!=(forward ? ${next.ino}ULL : ${old.ino}ULL)) goto done;
  if(!directory(current,first.st_dev,first.st_ino) || !directory(staged,second.st_dev,second.st_ino)) goto done;
  // Darwin needs writable directory roots for this rename. Retained file
  // descriptors restore the initially pinned inode modes after exchanging
  // names, including a rollback after a partially failed mode restoration.
  if(fchmod(a,first_mode|0200)!=0) goto done;
  if(fchmod(b,second_mode|0200)!=0) { (void)fchmod(a,first_mode); goto done; }
  if(directory(current,first.st_dev,first.st_ino) && directory(staged,second.st_dev,second.st_ino) && idle()) {
    if(renamex_np(current,staged,RENAME_SWAP)==0) result=0; else perror("app directory swap");
  }
  if(fchmod(a,first_mode)!=0) result=66;
  if(fchmod(b,second_mode)!=0) result=66;
  if(fsync(a)!=0) result=66;
  if(fsync(b)!=0) result=66;
done:
  if(a>=0) close(a);
  if(b>=0) close(b);
  return result;
}
int main(int argc,char **argv) {
  if(argc!=2 || getuid()!=${process.getuid()} || geteuid()!=getuid()) return 64;
  int forward=directory(current,${old.dev}ULL,${old.ino}ULL) && directory(staged,${next.dev}ULL,${next.ino}ULL);
  int backward=directory(current,${next.dev}ULL,${next.ino}ULL) && directory(staged,${old.dev}ULL,${old.ino}ULL);
  if(!forward && !backward) { fprintf(stderr,"app directory identity changed\\n"); return 65; }
  if(!idle()) return 65;
  if(strcmp(argv[1],"check")==0) {
    struct stat first,second;
    if(lstat(current,&first)!=0 || lstat(staged,&second)!=0 || (first.st_mode&07777)!=(forward ? ${old.mode & 0o7777} : ${next.mode & 0o7777}) || (second.st_mode&07777)!=(forward ? ${next.mode & 0o7777} : ${old.mode & 0o7777})) { fprintf(stderr,"app directory modes unsettled\\n"); return 65; }
    return 0;
  }
  if((strcmp(argv[1],"forward")==0 && forward) || (strcmp(argv[1],"rollback")==0 && backward)) return swap_apps(forward);
  return 64;
}
`;
  try {
    await writeFile(join(scratch, "swap.c"), source, { flag: "wx", mode: 0o600 });
    await run(["/usr/bin/xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", join(scratch, "swap.c"), "-o", executable]);
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
  return { async invoke(mode) { await run([executable, mode]); }, async close() { await rm(scratch, { recursive: true, force: true }); } };
}
async function assertAppUpgradeIdle(): Promise<void> {
  const uid = process.getuid!();
  for (const label of ["app.textbutler.daemon", "app.textbutler.imessage-setup"]) {
    const result = await setupLaunchctl(["print", `gui/${uid}/${label}`]);
    if (result.exitCode !== 113 || result.stdout !== "" || result.stderr !== `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`) throw new Error("Stop and settle TextButler's daemon and setup jobs before upgrading its app.");
  }
}
export async function assertAppUpgradeArtifactsSettled(identity: MacosAppIdentity): Promise<void> {
  const state = join(identity.dataDir, "state");
  const paths = [join(identity.dataDir, "daemon.sock"), join(identity.home, "Library", "LaunchAgents", "app.textbutler.daemon.plist"),
    ...["launch-agent.json", "launch-agent.lock", "imessage-setup-launch.json", "imessage-setup-launch.plist", "imessage-setup-custody.json", "ghostget-automation-custody.json", "ghostget-read-custody.json"].map(name => join(state, name))];
  for (const path of paths) if (await exists(path)) throw new Error("TextButler has retained service or connector custody. Settle it through its supported owner flow before app upgrade.");
}
export function assertManagedAppUpgrade(previous: MacosAppIdentity, next: MacosAppIdentity): void {
  for (const key of ["appPath", "home", "dataDir", "bundleId", "signing", "messagesBundleId", "automationConsent"] as const)
    if (previous[key] !== next[key]) throw new Error("The app upgrade must preserve its managed owner, location and permission target.");
}
/** Native test seam for the exact verified swap transaction. The public
 * installer separately admits production distributions and native consent.
 * Hooks are in-process fixture code, never CLI input or owner configuration. */
export async function upgradeVerifiedMacosApp(previous: MacosAppIdentity, next: MacosAppIdentity, source: string,
  hooks: { assertIdle?: () => Promise<void>; beforeSwap?: () => Promise<void>; afterSwap?: () => Promise<void>; beforeReceipt?: () => Promise<void> } = {}): Promise<{ archive: string }> {
  assertManagedAppUpgrade(previous, next);
  const state = join(next.dataDir, "state"), receipt = macosAppReceiptPath(next.dataDir), journal = join(state, UPGRADE_JOURNAL);
  const lifecycle = await acquireOwnerDatabase(next.dataDir, "launch-agent-custody");
  let daemon: Awaited<ReturnType<typeof acquireOwnerDatabase>> | undefined, helper: Awaited<ReturnType<typeof appSwapHelper>> | undefined;
  try {
    daemon = await acquireOwnerDatabase(next.dataDir, "daemon-custody");
    if (await exists(journal)) throw new Error("A previous app upgrade needs reconciliation; all app and receipt evidence was preserved.");
    const idle = async () => { await assertAppUpgradeArtifactsSettled(next); await (hooks.assertIdle?.() ?? assertAppUpgradeIdle()); };
    await idle(); await verifyMacosApp(previous); await verifyMacosApp(next, source);
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", previous.appPath]);
    const saved = await privateSnapshot(receipt);
    if (JSON.stringify(await readMacosAppReceipt(receipt)) !== JSON.stringify(previous)) throw new Error("The installed app receipt changed before upgrade.");
    const root = join(dirname(next.appPath), ".textbutler-app-upgrades"); await physicalDirectory(root, true);
    if ((await lstat(root)).mode & 0o077) throw new Error("App upgrade archives must be private.");
    let count = 0; for await (const entry of await opendir(root)) if (++count >= UPGRADE_ARCHIVE_LIMIT || !/^[a-f0-9-]{36}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("The app upgrade archive inventory is full or unknown; it was preserved.");
    const generation = randomUUID(), archive = join(root, generation); await mkdir(archive, { mode: 0o700 }); await syncDirectory(root);
    const slot = join(archive, "TextButler.app"), nextBytes = Buffer.from(`${JSON.stringify(next)}\n`);
    await publishPrivateArtifact(archive, "previous-macos-app.json", saved.bytes); await publishPrivateArtifact(archive, "next-macos-app.json", nextBytes);
    await stageTextbutlerMacosApp(next, source, slot); helper = await appSwapHelper(next.appPath, slot); await helper.invoke("check");
    const transaction = Buffer.from(`${JSON.stringify({ schemaVersion: 1, generation, previousReceiptSha256: hash(saved.bytes), nextReceiptSha256: hash(nextBytes), startedAt: Date.now() })}\n`);
    await publishPrivateArtifact(state, UPGRADE_JOURNAL, transaction);
    const journalSnapshot = await privateSnapshot(journal);
    const journalUnchanged = async () => {
      const observed = await privateSnapshot(journal);
      if (!sameIdentity(journalSnapshot.identity, observed.identity) || !observed.bytes.equals(transaction)) throw new Error("The upgrade journal changed and was preserved.");
    };
    const complete = async (status: "completed" | "rolled-back" | "not-activated") => {
      await journalUnchanged();
      await publishPrivateArtifact(archive, "outcome.json", Buffer.from(`${JSON.stringify({ schemaVersion: 1, generation, status, finishedAt: Date.now() })}\n`));
      await journalUnchanged();
      await removeExact(journal, transaction);
    };
    const receiptUnchanged = async () => { const current = await privateSnapshot(receipt); if (!sameIdentity(saved.identity, current.identity) || !current.bytes.equals(saved.bytes)) throw new Error("The installed app receipt changed during upgrade."); };
    try {
      await hooks.beforeSwap?.(); await idle(); await receiptUnchanged(); await verifyMacosApp(previous); await verifyMacosApp(next, slot);
      await journalUnchanged(); await helper.invoke("forward"); await syncDirectory(dirname(next.appPath)); await syncDirectory(archive);
      await hooks.afterSwap?.(); await verifyMacosApp(next); await verifyMacosApp(previous, slot);
      await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", next.appPath]);
      await hooks.beforeReceipt?.(); await idle(); await helper.invoke("check"); await receiptUnchanged();
      await journalUnchanged(); await replaceAppReceipt(receipt, saved, nextBytes);
      await verifyMacosApp(next); await complete("completed");
      return { archive };
    } catch (error) {
      // Roll back only the still-unpublished receipt and exact idle app pair.
      // Any changed receipt, app, process or journal retains custody instead.
      try {
        await idle(); await receiptUnchanged(); await journalUnchanged(); await helper.invoke("check");
        let swapped = false;
        try { await verifyMacosApp(next); await verifyMacosApp(previous, slot); swapped = true; }
        catch { await verifyMacosApp(previous); await verifyMacosApp(next, slot); }
        if (swapped) { await journalUnchanged(); await helper.invoke("rollback"); await syncDirectory(dirname(next.appPath)); await syncDirectory(archive); await verifyMacosApp(previous); await verifyMacosApp(next, slot); }
        await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", previous.appPath]);
        await complete(swapped ? "rolled-back" : "not-activated");
      } catch { throw new Error("App upgrade settlement is uncertain. Both apps, receipts and the upgrade journal were preserved; do not retry blindly.", { cause: error }); }
      throw error;
    }
  } finally { try { await helper?.close(); } finally { daemon?.close(); lifecycle.close(); } }
}

export async function installTextbutlerMacosApp(options: { from: string; upgrade?: boolean }): Promise<{ appPath: string; receiptPath: string; alreadyInstalled: boolean; signing: MacosAppIdentity["signing"]; previous?: { archive: string } }> {
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
  if (await exists(join(identity.dataDir, "state", UPGRADE_JOURNAL))) throw new Error("A previous app upgrade needs reconciliation; all app and receipt evidence was preserved.");
  if (await exists(receiptPath)) {
    const previous = await readMacosAppReceipt(receiptPath);
    if (JSON.stringify(previous) !== JSON.stringify(identity)) {
      if (options.upgrade !== true) throw new Error("Another TextButler app receipt exists and was preserved. Use --upgrade only for its verified, stopped managed installation.");
      const previousPayload = await verifyDistribution(dirname(previous.entrypoint));
      if (previousPayload.manifest.runtime.sha256 !== previous.runtimeSha256) throw new Error("The previous app payload no longer matches its recorded runtime.");
      const retained = await upgradeVerifiedMacosApp(previous, identity, app);
      return { appPath: identity.appPath, receiptPath, alreadyInstalled: false, signing: identity.signing, previous: retained };
    }
    await verifyMacosApp(identity);
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", identity.appPath]);
    return { appPath: identity.appPath, receiptPath, alreadyInstalled: true, signing: identity.signing };
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
  return { appPath: identity.appPath, receiptPath, alreadyInstalled: false, signing: identity.signing };
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
async function setupLaunchctl(args: readonly string[], timeoutMs = 20000): Promise<SetupCommandResult> {
  const child = Bun.spawn(["/bin/launchctl", ...args], { env: EXECUTION_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  let size = 0, overflow = false;
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => { const chunks: Uint8Array[] = []; for await (const bytes of stream) { size += bytes.length; if (size > 131072) { overflow = true; child.kill(); } else chunks.push(bytes); } return Buffer.concat(chunks).toString("utf8"); };
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, capture(child.stdout), capture(child.stderr)]);
  if (overflow || child.signalCode !== null) throw new Error("The app setup launchd outcome is uncertain; its exact artifacts were retained.");
  return { exitCode, stdout, stderr };
}
/** Bootstrap may return before print exposes a stable job state. Re-read only;
 * the existing parser must still prove exact ownership before proceeding. */
export async function settleMacosSetupBootstrap(exitCode: number, inspect: (timeoutMs: number) => Promise<SetupJob>, timing = { now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms) }): Promise<void> {
  const uncertain = () => new Error("App setup bootstrap is uncertain; the exact launch artifacts were retained.");
  if (exitCode !== 0) throw uncertain();
  const deadline = timing.now() + 4000;
  // The iteration bound also prevents a stalled test or host clock from
  // creating an unbounded observation loop. Never submit bootstrap again.
  for (let attempt = 0; attempt < 40; attempt++) {
    const remaining = deadline - timing.now();
    if (remaining <= 0) throw uncertain();
    const job = await inspect(Math.max(1, Math.ceil(remaining)));
    if (timing.now() > deadline) throw uncertain();
    if (job.state === "owned") return;
    if (job.state !== "unknown") throw uncertain();
    const wait = Math.min(100, deadline - timing.now());
    if (wait <= 0) throw uncertain();
    await timing.sleep(wait);
  }
  throw uncertain();
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
  const expected: { uid: number; plist: string; executable: string; generation?: string } = { uid, plist, executable: macosAppExecutable(application) }, inspect = async (timeoutMs?: number) => parseMacosSetupJob(await setupLaunchctl(["print", target], timeoutMs), expected);
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
    await settleMacosSetupBootstrap(result.exitCode, inspect);
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
type SetupLauncher = (options: { dataDir: string }) => Promise<{ status: "completed" | "blocked" | "recovery-required" | "pending"; resultPath: string; code?: string }>;
/** App setup with the Automation notice first and plain recovery after a
 * denial. stdout keeps its one JSON result; notices go to stderr. */
export async function runImessageSetupWithNotices(dataDir: string, io: PromptIO, launch: SetupLauncher, write: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  // macOS shows the Automation dialog to the person at the Mac even when an
  // agent runs this, so an unattended run still proceeds.
  const outcome = await prePrompt({ ...MESSAGES_AUTOMATION, whenUnattended: "proceed" }, io);
  if (outcome === "skip") { write(`${JSON.stringify({ ok: false, status: "skipped", detail: "App setup was skipped. Nothing changed." })}\n`); return 1; }
  const result = await launch({ dataDir });
  write(`${JSON.stringify({ ok: result.status === "completed", ...result })}\n`);
  if (result.code === "automation-permission-denied") await recover(MESSAGES_AUTOMATION, "denied", io);
  else if (result.code === "automation-permission-unavailable" || result.code === "automation-permission-unverified") await recover(MESSAGES_AUTOMATION, "unknown", io);
  return result.status === "completed" ? 0 : 1;
}
if (import.meta.main) {
  try {
    const [action, ...args] = process.argv.slice(2), values = new Map<string, string>(); let upgrade = false;
    for (let at = 0; at < args.length;) {
      const key = args[at++]!;
      if (key === "--upgrade" && action === "install" && !upgrade) { upgrade = true; continue; }
      const value = args[at++]; if (!["--from", "--output", "--app-path", "--data-dir", "--signing-identity"].includes(key) || value === undefined || values.has(key)) throw new Error("Use build --from ABS --output ABS [--app-path ABS] [--data-dir ABS] [--signing-identity NAME], or install --from ABS [--upgrade]."); values.set(key, key === "--signing-identity" ? signingIdentity(value) : macosAppPath(value));
    }
    const from = values.get("--from");
    if (action === "imessage-setup" && values.size === 1 && values.has("--data-dir")) process.exitCode = await runImessageSetupWithNotices(values.get("--data-dir")!, terminalPromptIO(), launchTextbutlerImessageSetup);
    else if (action === "build" && from !== undefined) { const output = values.get("--output"); if (!output) throw new Error("Choose a new --output directory."); const appPath = values.get("--app-path"), dataDir = values.get("--data-dir"), signer = values.get("--signing-identity"); const result = await buildTextbutlerMacosApp({ from, output, ...(appPath === undefined ? {} : { appPath }), ...(dataDir === undefined ? {} : { dataDir }), ...(signer === undefined ? {} : { signingIdentity: signer }) }); process.stdout.write(`${JSON.stringify({ ok: true, ...result, detail: result.identity.signing === "certificate" ? "Local certificate-signed app built; macOS permission grants stay bound to this signing identity across rebuilds." : "Local ad-hoc signed app built; no service or permission was changed. Approval must be verified again after rebuilding this identity." })}\n`); }
    else if (action === "install" && from !== undefined && values.size === 1) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...await installTextbutlerMacosApp({ from, upgrade }), detail: "App installed inertly. Owner settings and services are unchanged. Verify macOS permissions for the new app identity; use normal System Settings if reapproval is required." })}\n`);
      await prePrompt({ ...MESSAGES_FDA, whenUnattended: "proceed" }, terminalPromptIO());
    }
    else throw new Error("Use build or install with its exact arguments.");
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "TextButler app operation failed."}\n`); process.exitCode = 1; }
}
