import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { appFileDigest, macosAppExecutable, verifyMacosApp } from "../packages/textbutler/src/macos-app.ts";
import { compileTextbutlerMacosApp, parseMacosSetupJob } from "./macos-textbutler-app.ts";

/** Run through the mac-native host lane. Fixtures never address Messages or
 * launchctl; native custody is verified against an inert synthetic payload. */
export async function verifyTextbutlerMacosApp(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Run this explicit native verifier on macOS.");
  // The native supervisor deliberately rejects shared-writable ancestors such
  // as /tmp. Keep the synthetic home in this caller-owned checkout instead.
  const root = await mkdtemp(join(await realpath(process.cwd()), ".textbutler-native-test-"));
  let app: string | undefined;
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
    await chmod(join(output, "TextButler.app"), 0o700); await rename(join(output, "TextButler.app"), app); await chmod(app, 0o500); await verifyMacosApp(built.identity);
    process.stderr.write("native-check: fixed roles\n");
    const executable = macosAppExecutable(built.identity), generation = "12345678-1234-1234-1234-123456789abc";
    const run = (args: readonly string[], stopOnReady = false, program = executable) => new Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }>((resolve, reject) => {
      process.stderr.write(`native-check: execute ${args.join(" ") || "menu"}\n`);
      const child = spawn(program, [...args], { cwd: dataDir, env: { HOME: "/untrusted", PATH: "/untrusted", TB_INJECTED: "inherited", BUN_OPTIONS: "--preload=/unknown-file", TEXTBUTLER_LAUNCH_AGENT_GENERATION: generation }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false, stopped = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 15_000);
      const hardTimer = setTimeout(() => child.kill("SIGKILL"), 70_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 65_536) child.kill("SIGTERM"); if (stopOnReady && !stopped && stdout === "ready\n") { stopped = true; child.kill("SIGTERM"); } });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 65_536) child.kill("SIGTERM"); });
      child.once("error", error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
      child.once("close", code => { clearTimeout(timer); clearTimeout(hardTimer); if (timedOut) reject(new Error(`Native fixture timed out: ${args.join(" ")}; ${stderr}`)); else resolve({ code, stdout, stderr, pid: child.pid }); });
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
    process.stdout.write("TextButler native app: 3 fixed roles, sanitized environment, parent ownership, signal/join, changed payload/relocation rejection, and exact setup job parsing passed. No private messages or OS permissions accessed.\n");
  } finally {
    process.stderr.write("native-check: cleanup\n");
    // Only freshly created synthetic files are removed. Make sealed fixture
    // directories writable for cleanup; the installed app is never a target.
    const makeWritable = async (path: string): Promise<void> => { const { readdir, lstat } = await import("node:fs/promises"); const info = await lstat(path); if (info.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await makeWritable(join(path, name)); } };
    await makeWritable(root); await rm(root, { recursive: true, force: true });
  }
}
if (import.meta.main) { try { await verifyTextbutlerMacosApp(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : "Native app verification failed."}\n`); process.exitCode = 1; } }
