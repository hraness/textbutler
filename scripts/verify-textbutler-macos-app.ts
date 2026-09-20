import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { appFileDigest, macosAppExecutable, verifyMacosApp } from "../packages/textbutler/src/macos-app.ts";
import { compileTextbutlerMacosApp, parseMacosSetupJob, stageTextbutlerMacosApp, upgradeVerifiedMacosApp } from "./macos-textbutler-app.ts";

/** Run through the mac-native host lane. Fixtures never address Messages or
 * launchctl; native custody is verified against an inert synthetic payload. */
export async function verifyTextbutlerMacosApp(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Run this explicit native verifier on macOS.");
  // Native execution rejects shared-writable ancestors such as /tmp. Keep this
  // synthetic home in the owner's private cache, outside cloud-synced Documents
  // whose file provider can change Finder metadata during a signing assertion.
  const root = await mkdtemp(join(await realpath(join(homedir(), "Library", "Caches")), "textbutler-native-test-"));
  let app: string | undefined;
  let metadataStage: string | undefined;
  try {
    process.stderr.write("native-check: build fixtures\n");
    const home = join(root, "owner"), dataDir = join(home, "data"), runtime = await realpath(process.execPath), entrypoint = join(root, "fixture.mjs");
    app = join(home, "Applications", "TextButler.app"); await mkdir(join(home, "Applications"), { recursive: true, mode: 0o700 }); await mkdir(dataDir, { mode: 0o700 });
    const source = `import { existsSync } from "node:fs";\nconst row={args:process.argv.slice(2),parent:process.ppid,home:process.env.HOME,cwd:process.cwd(),inherited:process.env.TB_INJECTED,generation:process.env.TEXTBUTLER_LAUNCH_AGENT_GENERATION,automation:process.env.TEXTBUTLER_IMESSAGE_AUTOMATION};\nif(existsSync(${JSON.stringify(join(dataDir, "wait"))})){process.on('SIGTERM',()=>{process.stdout.write('joined\\n');process.exit(0)});process.stdout.write('ready\\n');setInterval(()=>{},1000)}else{process.stdout.write(JSON.stringify(row)+'\\n')}\n`;
    await writeFile(entrypoint, source, { mode: 0o400 });
    const output = join(root, "build"), built = await compileTextbutlerMacosApp({ home, dataDir, appPath: app, runtime, runtimeSha256: await appFileDigest(runtime, { executable: true }), entrypoint, entrypointSha256: await appFileDigest(entrypoint), output, syntheticAutomationPermission: "allowed" });
    // Compile and sign the real consent-API branch too, but never execute its
    // setup role in verification: only the owner may see that system prompt.
    const production = await compileTextbutlerMacosApp({ home, dataDir, appPath: app, runtime, runtimeSha256: built.identity.runtimeSha256, entrypoint, entrypointSha256: built.identity.entrypointSha256, output: join(root, "native-api-build") });
    assert.equal(production.identity.automationConsent, "native-api");
    process.stderr.write("native-check: staged signing metadata\n");
    const metadataSource = join(production.directory, "TextButler.app"), metadataInfo = join(metadataSource, "Contents", "Info.plist");
    const command = (executable: string, args: readonly string[]) => spawnSync(executable, [...args], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
    const xattr = (args: readonly string[]) => { const result = command("/usr/bin/xattr", args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    await chmod(metadataSource, 0o700); await chmod(metadataInfo, 0o600);
    xattr(["-wx", "com.apple.FinderInfo", `54455354${"00".repeat(28)}`, metadataSource]);
    xattr(["-w", "com.apple.ResourceFork", "synthetic resource fork", metadataInfo]);
    xattr(["-w", "com.apple.quarantine", "0081;00000000;TextButlerMetadataFixture;", metadataSource]);
    xattr(["-w", "com.textbutler.fixture", "preserve unrelated metadata", metadataSource]);
    await chmod(metadataSource, 0o500); await chmod(metadataInfo, 0o400);
    const attributeBytes = (path: string, name: string) => xattr(["-px", name, path]).replaceAll(/\s/gu, "");
    const sourceNames = xattr([metadataSource]).split("\n");
    const retainedNames = ["com.apple.quarantine", "com.textbutler.fixture", ...sourceNames.filter(name => name === "com.apple.provenance" || name.startsWith("com.apple.fileprovider."))];
    const retained = retainedNames.map(name => [name, attributeBytes(metadataSource, name)] as const);
    const sourceFinder = attributeBytes(metadataSource, "com.apple.FinderInfo"), sourceResource = attributeBytes(metadataInfo, "com.apple.ResourceFork");
    assert.notEqual(command("/usr/bin/codesign", ["--verify", "--deep", "--strict", metadataSource]).status, 0);
    // Like the production Applications staging directory, this copy must be
    // outside a cloud-synced Documents provider that may re-add FinderInfo.
    metadataStage = await mkdtemp(join(await realpath(tmpdir()), "textbutler-metadata-stage-")); const clean = join(metadataStage, "TextButler.app");
    await stageTextbutlerMacosApp(production.identity, metadataSource, clean);
    const strict = command("/usr/bin/codesign", ["--verify", "--deep", "--strict", clean]); assert.equal(strict.status, 0, strict.stderr);
    assert(!xattr([clean]).split("\n").includes("com.apple.FinderInfo"));
    assert(!xattr([join(clean, "Contents", "Info.plist")]).split("\n").includes("com.apple.ResourceFork"));
    for (const [name, bytes] of retained) {
      // ditto --qtn preserves quarantine through macOS, which may update the
      // copied flag/provenance string. Never restore older security bytes.
      const copied = attributeBytes(clean, name);
      if (name === "com.apple.quarantine") assert(copied.length > 0); else assert.equal(copied, bytes);
      assert.equal(attributeBytes(metadataSource, name), bytes);
    }
    assert.equal(attributeBytes(metadataSource, "com.apple.FinderInfo"), sourceFinder); assert.equal(attributeBytes(metadataInfo, "com.apple.ResourceFork"), sourceResource);
    await verifyMacosApp(production.identity, metadataSource); await verifyMacosApp(production.identity, clean);
    await assert.rejects(stageTextbutlerMacosApp(production.identity, metadataSource, clean), /already exists/u);
    await chmod(join(output, "TextButler.app"), 0o700); await rename(join(output, "TextButler.app"), app); await chmod(app, 0o500); await verifyMacosApp(built.identity);
    process.stderr.write("native-check: fixed roles\n");
    const executable = macosAppExecutable(built.identity), generation = "12345678-1234-1234-1234-123456789abc";
    const run = (args: readonly string[], stopOnReady = false, program = executable, onReady?: () => Promise<void>) => new Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }>((resolve, reject) => {
      process.stderr.write(`native-check: execute ${args.join(" ") || "menu"}\n`);
      const child = spawn(program, [...args], { cwd: dataDir, env: { HOME: "/untrusted", PATH: "/untrusted", TB_INJECTED: "inherited", BUN_OPTIONS: "--preload=/unknown-file", TEXTBUTLER_LAUNCH_AGENT_GENERATION: generation }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false, stopped = false, probeError: unknown, probe: Promise<void> | undefined;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 15_000);
      const hardTimer = setTimeout(() => child.kill("SIGKILL"), 70_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 65_536) child.kill("SIGTERM"); if (stopOnReady && !stopped && stdout === "ready\n") { stopped = true; probe = (async () => { try { await onReady?.(); } catch (error) { probeError = error; } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } })(); } });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 65_536) child.kill("SIGTERM"); });
      child.once("error", error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
      child.once("close", code => { clearTimeout(timer); clearTimeout(hardTimer); void (async () => { await probe; if (probeError) reject(probeError); else if (timedOut) reject(new Error(`Native fixture timed out: ${args.join(" ")}; ${stderr}`)); else resolve({ code, stdout, stderr, pid: child.pid }); })(); });
    });
    for (const [flags, role] of [[[], ["menubar", "--foreground"]], [["--daemon"], ["daemon", "run"]], [["--imessage-setup"], ["app", "imessage-setup"]]] as const) {
      const result = await run(flags); assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { args: [...role, "--data-dir", dataDir], parent: result.pid, home, cwd: "/", ...(flags[0] === "--daemon" || flags[0] === "--imessage-setup" ? { generation } : {}), ...(flags[0] === "--imessage-setup" ? { automation: "allowed" } : {}) });
    }
    assert.notEqual((await run(["--daemon", "--eval", "unexpected"])).code, 0);
    assert.notEqual((await run(["--unknown"])).code, 0);
    process.stderr.write("native-check: signal and join\n");
    await writeFile(join(dataDir, "wait"), "synthetic", { mode: 0o600 });
    const waited = await run(["--daemon"], true);
    assert.equal(waited.code, 0); assert.equal(waited.stdout, "ready\njoined\n"); assert.equal(waited.stderr, "");
    process.stderr.write("native-check: drift and relocation\n");
    await rm(join(dataDir, "wait"));
    const prior = await readFile(entrypoint); await chmod(entrypoint, 0o600); await writeFile(entrypoint, `${source}\n// changed\n`); assert.notEqual((await run(["--daemon"])).code, 0); await writeFile(entrypoint, prior); await chmod(entrypoint, 0o400);
    const moved = join(home, "Other.app"); await cp(app, moved, { recursive: true });
    assert.notEqual((await run(["--daemon"], false, join(moved, "Contents", "MacOS", "TextButler"))).code, 0);
    const uid = process.getuid!(), plist = join(dataDir, "state", "imessage-setup-launch.plist"), target = `gui/${uid}/app.textbutler.imessage-setup`;
    const stdout = `${target} = {\npath = ${plist}\nprogram = ${executable}\narguments = {\n${executable}\n--imessage-setup\n}\nenvironment = {\nTEXTBUTLER_LAUNCH_AGENT_GENERATION => ${generation}\n}\nstate = not running\nlast exit code = 0\n}\n`;
    assert.deepEqual(parseMacosSetupJob({ exitCode: 0, stdout, stderr: "" }, { uid, plist, executable, generation }), { state: "owned", running: false, exitCode: 0 });
    assert.deepEqual(parseMacosSetupJob({ exitCode: 0, stdout: stdout.replace("--imessage-setup", "--daemon"), stderr: "" }, { uid, plist, executable, generation }), { state: "unknown" });
    process.stderr.write("native-check: managed app upgrade custody and rollback\n");
    const nextEntry = join(root, "next-fixture.mjs"); await writeFile(nextEntry, `${source}\n// synthetic next payload\n`, { mode: 0o400 });
    const next = await compileTextbutlerMacosApp({ home, dataDir, appPath: app, runtime, runtimeSha256: built.identity.runtimeSha256, entrypoint: nextEntry, entrypointSha256: await appFileDigest(nextEntry), output: join(root, "next-build"), syntheticAutomationPermission: "allowed" });
    const state = join(dataDir, "state"); await mkdir(state, { mode: 0o700 });
    const receipt = join(state, "macos-app.json"), previousBytes = Buffer.from(`${JSON.stringify(built.identity)}\n`), journal = join(state, "macos-app-upgrade.json");
    await writeFile(receipt, previousBytes, { mode: 0o600 });
    const nextSource = join(next.directory, "TextButler.app"), noJobs = async () => {};
    // The fixture skips only launchctl lookup for this synthetic owner; the
    // real bounded libproc scan and inode-bound RENAME_SWAP still execute.
    await writeFile(join(dataDir, "wait"), "synthetic", { mode: 0o600 });
    const active = await run(["--daemon"], true, executable, async () => {
      await assert.rejects(upgradeVerifiedMacosApp(built.identity, next.identity, nextSource, { assertIdle: noJobs }), /native app process active/u);
      assert((await readFile(receipt)).equals(previousBytes)); await assert.rejects(lstat(journal), { code: "ENOENT" });
    });
    assert.equal(active.code, 0); await rm(join(dataDir, "wait"));
    // macOS keeps kernel command metadata for an unlinked running executable.
    // A different complete command is unrelated; a matching native command
    // whose path is unavailable must keep the upgrade closed.
    const deletedSource = join(root, "deleted-process.c");
    await writeFile(deletedSource, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); for (;;) pause(); }\n', { mode: 0o600 });
    for (const [name, rejection] of [["Unrelated", /synthetic unrelated pre-swap/u], ["TextButler", /native process identity unavailable/u]] as const) {
      const deletedExecutable = join(root, name), compiled = command("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror", deletedSource, "-o", deletedExecutable]);
      assert.equal(compiled.status, 0, compiled.stderr);
      await run([], true, deletedExecutable, async () => {
        await rm(deletedExecutable);
        await assert.rejects(upgradeVerifiedMacosApp(built.identity, next.identity, nextSource, { assertIdle: noJobs, async beforeSwap() { throw new Error("synthetic unrelated pre-swap"); } }), rejection);
        assert((await readFile(receipt)).equals(previousBytes)); await assert.rejects(lstat(journal), { code: "ENOENT" });
      });
    }
    await assert.rejects(upgradeVerifiedMacosApp(built.identity, next.identity, nextSource, { assertIdle: noJobs, async beforeSwap() { throw new Error("synthetic pre-swap interruption"); } }), /synthetic pre-swap interruption/u);
    await verifyMacosApp(built.identity); assert((await readFile(receipt)).equals(previousBytes)); await assert.rejects(lstat(journal), { code: "ENOENT" });
    await assert.rejects(upgradeVerifiedMacosApp(built.identity, next.identity, nextSource, { assertIdle: noJobs, async afterSwap() { throw new Error("synthetic post-swap failure"); } }), /synthetic post-swap failure/u);
    await verifyMacosApp(built.identity); assert((await readFile(receipt)).equals(previousBytes)); await assert.rejects(lstat(journal), { code: "ENOENT" });
    assert.equal((await lstat(app)).mode & 0o7777, 0o500);
    assert.equal(command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]).status, 0);
    const upgraded = await upgradeVerifiedMacosApp(built.identity, next.identity, nextSource, { assertIdle: noJobs });
    await verifyMacosApp(next.identity); await verifyMacosApp(built.identity, join(upgraded.archive, "TextButler.app"));
    for (const path of [app, join(upgraded.archive, "TextButler.app")]) { assert.equal((await lstat(path)).mode & 0o7777, 0o500); assert.equal(command("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]).status, 0); }
    assert((await readFile(join(upgraded.archive, "previous-macos-app.json"))).equals(previousBytes));
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), next.identity); assert.equal((await lstat(receipt)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(upgraded.archive, "outcome.json"), "utf8")).status, "completed");
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    const archives = join(home, "Applications", ".textbutler-app-upgrades"), entries = await readdir(archives);
    const outcomes = await Promise.all(entries.map(async name => { try { return JSON.parse(await readFile(join(archives, name, "outcome.json"), "utf8")).status; } catch { return null; } }));
    assert(outcomes.includes("not-activated")); assert(outcomes.includes("rolled-back"));
    await assert.rejects(upgradeVerifiedMacosApp(next.identity, built.identity, join(upgraded.archive, "TextButler.app"), { assertIdle: noJobs, async beforeReceipt() { await writeFile(receipt, "synthetic changed receipt"); } }), /settlement is uncertain/u);
    assert.equal(await readFile(receipt, "utf8"), "synthetic changed receipt"); assert((await lstat(journal)).isFile());
    const uncertain = JSON.parse(await readFile(journal, "utf8"));
    await verifyMacosApp(built.identity); await verifyMacosApp(next.identity, join(archives, uncertain.generation, "TextButler.app"));
    assert.deepEqual(JSON.parse(await readFile(join(archives, uncertain.generation, "previous-macos-app.json"), "utf8")), next.identity);
    assert.deepEqual(JSON.parse(await readFile(join(archives, uncertain.generation, "next-macos-app.json"), "utf8")), built.identity);
    await assert.rejects(upgradeVerifiedMacosApp(next.identity, built.identity, join(upgraded.archive, "TextButler.app"), { assertIdle: noJobs }), /previous app upgrade needs reconciliation/u);
    // A separate synthetic owner proves changed journal custody prevents
    // rollback itself, without clearing or reusing the uncertain first case.
    const journalHome = join(root, "journal-owner"), journalData = join(journalHome, "data"), journalApp = join(journalHome, "Applications", "TextButler.app");
    await mkdir(join(journalHome, "Applications"), { recursive: true, mode: 0o700 }); await mkdir(join(journalData, "state"), { recursive: true, mode: 0o700 });
    const journalBuild = async (entry: string, output: string) => compileTextbutlerMacosApp({ home: journalHome, dataDir: journalData, appPath: journalApp, runtime, runtimeSha256: built.identity.runtimeSha256, entrypoint: entry, entrypointSha256: await appFileDigest(entry), output: join(root, output), syntheticAutomationPermission: "allowed" });
    const journalOld = await journalBuild(entrypoint, "journal-old"), journalNext = await journalBuild(nextEntry, "journal-next");
    const journalOldSource = join(journalOld.directory, "TextButler.app"); await chmod(journalOldSource, 0o700); await rename(journalOldSource, journalApp); await chmod(journalApp, 0o500);
    const changedJournal = join(journalData, "state", "macos-app-upgrade.json"), journalReceipt = join(journalData, "state", "macos-app.json"), journalPrevious = Buffer.from(`${JSON.stringify(journalOld.identity)}\n`);
    await writeFile(journalReceipt, journalPrevious, { mode: 0o600 });
    let changedGeneration = "";
    await assert.rejects(upgradeVerifiedMacosApp(journalOld.identity, journalNext.identity, join(journalNext.directory, "TextButler.app"), { assertIdle: noJobs, async afterSwap() {
      changedGeneration = JSON.parse(await readFile(changedJournal, "utf8")).generation;
      await writeFile(changedJournal, "synthetic changed journal"); throw new Error("synthetic journal replacement after swap");
    } }), /settlement is uncertain/u);
    const changedArchive = join(journalHome, "Applications", ".textbutler-app-upgrades", changedGeneration);
    assert.equal(await readFile(changedJournal, "utf8"), "synthetic changed journal"); assert((await readFile(journalReceipt)).equals(journalPrevious));
    await verifyMacosApp(journalNext.identity); await verifyMacosApp(journalOld.identity, join(changedArchive, "TextButler.app"));
    assert((await readFile(join(changedArchive, "previous-macos-app.json"))).equals(journalPrevious));
    await assert.rejects(lstat(join(changedArchive, "outcome.json")), { code: "ENOENT" });
    // A failed pre-swap mode restoration must also retain custody: byte and
    // code-signature identity alone cannot settle a partially writable root.
    const modeHome = join(root, "mode-owner"), modeData = join(modeHome, "data"), modeApp = join(modeHome, "Applications", "TextButler.app");
    await mkdir(join(modeHome, "Applications"), { recursive: true, mode: 0o700 }); await mkdir(join(modeData, "state"), { recursive: true, mode: 0o700 });
    const modeBuild = async (entry: string, output: string) => compileTextbutlerMacosApp({ home: modeHome, dataDir: modeData, appPath: modeApp, runtime, runtimeSha256: built.identity.runtimeSha256, entrypoint: entry, entrypointSha256: await appFileDigest(entry), output: join(root, output), syntheticAutomationPermission: "allowed" });
    const modeOld = await modeBuild(entrypoint, "mode-old"), modeNext = await modeBuild(nextEntry, "mode-next"), modeOldSource = join(modeOld.directory, "TextButler.app");
    await chmod(modeOldSource, 0o700); await rename(modeOldSource, modeApp); await chmod(modeApp, 0o500);
    const modeJournal = join(modeData, "state", "macos-app-upgrade.json"), modeReceipt = join(modeData, "state", "macos-app.json"), modePrevious = Buffer.from(`${JSON.stringify(modeOld.identity)}\n`);
    await writeFile(modeReceipt, modePrevious, { mode: 0o600 });
    await assert.rejects(upgradeVerifiedMacosApp(modeOld.identity, modeNext.identity, join(modeNext.directory, "TextButler.app"), { assertIdle: noJobs, async beforeSwap() { await chmod(modeApp, 0o700); throw new Error("synthetic failed pre-swap mode restoration"); } }), /settlement is uncertain/u);
    const modeTransaction = JSON.parse(await readFile(modeJournal, "utf8")), modeArchive = join(modeHome, "Applications", ".textbutler-app-upgrades", modeTransaction.generation);
    assert.equal((await lstat(modeApp)).mode & 0o7777, 0o700); assert((await readFile(modeReceipt)).equals(modePrevious));
    await verifyMacosApp(modeOld.identity); await verifyMacosApp(modeNext.identity, join(modeArchive, "TextButler.app"));
    await assert.rejects(lstat(join(modeArchive, "outcome.json")), { code: "ENOENT" });
    process.stdout.write("TextButler native app: signing metadata preservation, fixed roles, process custody, managed app swap/rollback/retained evidence, and exact setup job parsing passed. No private messages or OS permissions accessed.\n");
  } finally {
    process.stderr.write("native-check: cleanup\n");
    // Only freshly created synthetic files are removed. Make sealed fixture
    // directories writable for cleanup; the installed app is never a target.
    const makeWritable = async (path: string): Promise<void> => { const { readdir, lstat } = await import("node:fs/promises"); const info = await lstat(path); if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await makeWritable(join(path, name)); } };
    await makeWritable(root); await rm(root, { recursive: true, force: true });
    if (metadataStage !== undefined) { await makeWritable(metadataStage); await rm(metadataStage, { recursive: true, force: true }); }
  }
}
if (import.meta.main) { try { await verifyTextbutlerMacosApp(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : "Native app verification failed."}\n`); process.exitCode = 1; } }
