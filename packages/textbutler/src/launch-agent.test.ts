import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLaunchAgentLifecycle, LAUNCH_AGENT_LABEL, type LaunchAgentHost, type LaunchctlResult } from "./launch-agent.ts";
import { runTextbutlerCli } from "./cli.ts";
import { MACOS_APP_BUNDLE_ID, type MacosAppIdentity } from "./macos-app.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function decode(value: string): string { return value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"); }
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "tb-la-")); roots.push(root);
  const home = join(root, "owner & home"), dataDir = join(root, "data"), runtime = join(root, "bun"), entrypoint = join(root, "cli.ts");
  await mkdir(home, { mode: 0o700 }); await writeFile(runtime, "synthetic runtime; never executed", { mode: 0o700 }); await writeFile(entrypoint, "// synthetic entrypoint; never executed", { mode: 0o600 });
  const uid = process.getuid!(); const target = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
  const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`), receiptPath = join(dataDir, "state", "launch-agent.json");
  const calls: readonly string[][] = [];
  const state = { job: null as { path: string; args: string[]; program: string; generation: string | null } | null, bootstrap: "ok", bootout: "ok", process: "alive" as "alive" | "dead" | "unknown" };
  const complete = (exitCode = 0, stdout = "", stderr = ""): LaunchctlResult => ({ outcome: "completed", exitCode, stdout, stderr });
  const loadJob = async (): Promise<void> => {
    const plist = await readFile(plistPath, "utf8"); const array = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/su.exec(plist)?.[1];
    if (array === undefined) throw new Error("No fixed ProgramArguments");
    const args = [...array.matchAll(/<string>(.*?)<\/string>/gsu)].map(match => decode(match[1]!));
    state.job = { path: plistPath, program: args[0]!, args, generation: /<key>TEXTBUTLER_LAUNCH_AGENT_GENERATION<\/key><string>(.*?)<\/string>/u.exec(plist)?.[1] ?? null };
  };
  const host: LaunchAgentHost = { platform: "darwin", uid, home, runtime, entrypoint, processState: () => state.process, async run(args) {
    (calls as string[][]).push([...args]);
    if (args[0] === "print") {
      expect(args).toEqual(["print", target]);
      if (!state.job) return complete(113, "", `Bad request.\nCould not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: ${uid}\n`);
      return complete(0, `${target} = {\n\tpath = ${state.job.path}\n\tprogram = ${state.job.program}\n\targuments = {\n${state.job.args.map(arg => `\t\t${arg}\n`).join("")}\t}\n${state.job.generation === null ? "" : `\tenvironment = {\n\t\tTEXTBUTLER_LAUNCH_AGENT_GENERATION => ${state.job.generation}\n\t}\n`}\tstate = running\n\tpid = 1234567\n}\n`);
    }
    if (args[0] === "bootstrap") {
      expect(args).toEqual(["bootstrap", `gui/${uid}`, plistPath]);
      if (state.bootstrap === "unknown") return { outcome: "indeterminate", exitCode: null, stdout: "", stderr: "" };
      if (state.bootstrap === "failed") return complete(5);
      await loadJob(); return complete();
    }
    expect(args).toEqual(["bootout", "--wait", target]);
    if (state.bootout === "unknown") return { outcome: "indeterminate", exitCode: null, stdout: "", stderr: "" };
    state.job = null; return complete();
  } };
  return { root, dataDir, home, runtime, entrypoint, host, state, calls, plistPath, receiptPath, loadJob, lifecycle: createLaunchAgentLifecycle(host) };
}

test("installation creates a fixed private LaunchAgent, preserves data, and never repeats an admitted bootstrap", async () => {
  const f = await fixture();
  expect(await f.lifecycle.status(f.dataDir)).toMatchObject({ installation: "absent", service: "not-loaded" });
  await expect(lstat(f.dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.lifecycle.install(f.dataDir)).toMatchObject({ installation: "installed", service: "running", automaticReplies: "unavailable" });
  const settings = JSON.parse(await readFile(join(f.dataDir, "state", "settings.json"), "utf8")); expect(settings.settings).toMatchObject({ paused: true, contacts: [] });
  expect((await lstat(f.plistPath)).mode & 0o777).toBe(0o600);
  const plist = await readFile(f.plistPath, "utf8"); expect(plist).toContain("owner &amp; home"); expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>ProcessType</key><string>Standard</string>");
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  expect(receipt).toMatchObject({ schemaVersion: 4, application: null }); expect(receipt.plistText).toBe(plist);
  const args = f.state.job!.args;
  expect(args.slice(0, 4)).toEqual(["/usr/bin/env", "-i", `HOME=${f.home}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin"]);
  expect(args[4]).toBe("BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
  expect(args.slice(6)).toEqual([f.runtime, "--config=/dev/null", "--cwd=/", "--no-env-file", f.entrypoint, "daemon", "run", "--data-dir", f.dataDir]);
  expect(args[5]).toMatch(/^TEXTBUTLER_LAUNCH_AGENT_GENERATION=[a-f0-9-]{36}$/u);
  expect(await f.lifecycle.install(f.dataDir)).toMatchObject({ installation: "installed" });
  expect(f.calls.filter(args => args[0] === "bootstrap")).toHaveLength(1);
  expect(await f.lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "absent", service: "not-loaded" });
  await expect(lstat(f.plistPath)).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(f.dataDir, "state", "settings.json"), "utf8"))).toEqual(settings);
  expect(await f.lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "absent" });
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(1);
});

test("a foreign plist or service with the same label is never overwritten or stopped", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const original = await readFile(f.plistPath, "utf8"); await writeFile(f.plistPath, "owner sentinel", { mode: 0o600 });
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("exact recorded"); expect(await readFile(f.plistPath, "utf8")).toBe("owner sentinel");
  await writeFile(f.plistPath, original, { mode: 0o600 }); f.state.job!.args[4] = "FOREIGN_GENERATION";
  expect(await f.lifecycle.status(f.dataDir)).toMatchObject({ installation: "conflict", service: "unknown" });
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("no longer matches");
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(0);
});

test.each(["unknown", "failed"])("%s bootstrap preserves intent and requires positive reconciliation before retry", async outcome => {
  const f = await fixture(); f.state.bootstrap = outcome;
  expect(await f.lifecycle.install(f.dataDir)).toMatchObject({ installation: "indeterminate" });
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).phase).toBe("uncertain-install");
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("uncertain");
  expect(f.calls.filter(args => args[0] === "bootstrap")).toHaveLength(1);
  await f.loadJob();
  expect(await f.lifecycle.install(f.dataDir)).toMatchObject({ installation: "installed" });
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).phase).toBe("installed");
});

test("uncertain bootout preserves artifacts and cannot race a new install or removal", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir); f.state.bootout = "unknown";
  expect(await f.lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "indeterminate" });
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).phase).toBe("uncertain-remove");
  expect(await f.lifecycle.status(f.dataDir)).toMatchObject({ installation: "indeterminate" });
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("removal"); await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("removal");
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(1); expect(await readFile(f.plistPath, "utf8")).toContain(LAUNCH_AGENT_LABEL);
  f.state.job = null;
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("recorded process has stopped");
  f.state.process = "unknown";
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("recorded process has stopped");
  f.state.process = "dead";
  expect(await f.lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "absent" });
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(1);
  await expect(lstat(f.plistPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a removal interrupted after bootout reconciles only after the recorded process and operation owner stop", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  await writeFile(f.receiptPath, JSON.stringify({ ...receipt, phase: "removing" }), { mode: 0o600 });
  await writeFile(join(f.dataDir, "state", "launch-agent.lock"), JSON.stringify({ schemaVersion: 1, pid: 1234568, generation: "12345678-1234-1234-1234-123456789abc" }), { mode: 0o600 });
  f.state.job = null;
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("owner is uncertain");
  f.state.process = "dead";
  expect(await f.lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "absent" });
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(0);
});

test("a replacement during bootout prevents conditional artifact cleanup", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const run = f.host.run; const lifecycle = createLaunchAgentLifecycle({ ...f.host, async run(args) {
    const result = await run(args);
    if (args[0] === "bootout") await writeFile(f.plistPath, "replacement", { mode: 0o600 });
    return result;
  } });
  await expect(lifecycle.uninstall(f.dataDir)).rejects.toThrow("revision conflict"); expect(await readFile(f.plistPath, "utf8")).toBe("replacement");
  expect(await readFile(f.receiptPath, "utf8")).toContain('"phase":"removing"');
});

test("unsafe paths, mutable runtime, unknown sockets, and active lifecycle locks fail closed", async () => {
  const f = await fixture(); await chmod(f.runtime, 0o777);
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("runtime"); await chmod(f.runtime, 0o700);
  await mkdir(f.dataDir, { mode: 0o700 }); await writeFile(join(f.dataDir, "daemon.sock"), "unknown entry", { mode: 0o600 });
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("socket"); expect(await readFile(join(f.dataDir, "daemon.sock"), "utf8")).toBe("unknown entry");
  const lock = join(f.dataDir, "state", "launch-agent.lock");
  await writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, generation: "12345678-1234-1234-1234-123456789abc" }), { mode: 0o600 });
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("owner is uncertain");
  expect(f.calls.filter(args => args[0] !== "print")).toHaveLength(0);
  const linked = join(f.root, "linked-home"); await symlink(f.home, linked);
  await expect(createLaunchAgentLifecycle({ ...f.host, home: linked }).install(f.dataDir)).rejects.toThrow("physical");
});

test("the lifecycle refuses another installation identity or data directory", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const alternate = join(f.root, "other-cli.ts"); await writeFile(alternate, "// another fixture", { mode: 0o600 });
  await expect(createLaunchAgentLifecycle({ ...f.host, entrypoint: alternate }).install(f.dataDir)).rejects.toThrow("another runtime or entrypoint");
  await expect(f.lifecycle.install(join(f.root, "other-data"))).rejects.toThrow("exact recorded");
  expect(f.calls.filter(args => args[0] === "bootstrap")).toHaveLength(1);
});

test("CLI install, status, and uninstall use the lifecycle while reporting control health separately", async () => {
  const f = await fixture(), lines: string[] = [], output = { write: (text: string): void => { lines.push(text); } }, options = { launchAgent: f.lifecycle };
  expect(await runTextbutlerCli(["daemon", "install", "--data-dir", f.dataDir], output, options)).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, launchAgent: { installation: "installed" }, automaticReplies: "unavailable" });
  expect(await runTextbutlerCli(["daemon", "status", "--data-dir", f.dataDir], output, options)).toBe(1);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: false, daemon: { status: "disconnected" }, launchAgent: { service: "running" } });
  expect(await runTextbutlerCli(["daemon", "uninstall", "--data-dir", f.dataDir], output, options)).toBe(0);
});

test("unsupported platforms never invoke launchctl", async () => {
  const f = await fixture(), lifecycle = createLaunchAgentLifecycle({ ...f.host, platform: "linux" });
  expect(await lifecycle.status(f.dataDir)).toMatchObject({ installation: "unsupported" });
  await expect(lifecycle.install(f.dataDir)).rejects.toThrow("macOS"); await expect(lifecycle.uninstall(f.dataDir)).rejects.toThrow("macOS");
  expect(f.calls).toHaveLength(0);
});

test("daemon login arguments ignore planted startup configuration and inherited preload options", async () => {
  const f = await fixture(), runtime = await realpath(process.execPath), injected = join(f.home, "injected.js");
  await writeFile(injected, 'process.stdout.write("UNSAFE-PRELOAD\\n");');
  await writeFile(join(f.home, ".bunfig.toml"), `preload = [${JSON.stringify(injected)}]\n`);
  await writeFile(f.entrypoint, 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), home: process.env.HOME, generation: process.env.TEXTBUTLER_LAUNCH_AGENT_GENERATION, inherited: process.env.TEXTBUTLER_INJECTED }) + "\\n");');
  await createLaunchAgentLifecycle({ ...f.host, runtime }).install(f.dataDir);
  await writeFile(join(f.dataDir, "bunfig.toml"), `preload = [${JSON.stringify(injected)}]\n`);
  await writeFile(join(f.dataDir, ".env"), "TEXTBUTLER_INJECTED=from-file\n");
  expect(await readFile(f.plistPath, "utf8")).toContain("<key>WorkingDirectory</key><string>/</string>");
  const child = Bun.spawn(f.state.job!.args, { cwd: f.dataDir,
    env: { HOME: f.home, BUN_OPTIONS: `--preload=${injected}`, NODE_OPTIONS: `--require=${injected}`, TEXTBUTLER_INJECTED: "from-environment" }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(stderr).toBe(""); expect(stdout).not.toContain("UNSAFE-PRELOAD");
  expect(JSON.parse(stdout)).toEqual({ cwd: "/", home: f.home, generation: JSON.parse(await readFile(f.receiptPath, "utf8")).generation,
    args: ["daemon", "run", "--data-dir", f.dataDir] });
});

test("the previous startup contract remains removable without silent replacement", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  receipt.schemaVersion = 1; delete receipt.application; delete receipt.plistText;
  await writeFile(f.receiptPath, `${JSON.stringify(receipt)}\n`);
  const current = await readFile(f.plistPath, "utf8");
  const previous = current.replace("<string>--config=/dev/null</string><string>--cwd=/</string>", "")
    .replace("<string>BUN_RUNTIME_TRANSPILER_CACHE_PATH=0</string>", "")
    .replace("<key>ProcessType</key><string>Standard</string>", "<key>ProcessType</key><string>Background</string>")
    .replace("<key>WorkingDirectory</key><string>/</string>", `<key>WorkingDirectory</key><string>${f.dataDir}</string>`);
  await writeFile(f.plistPath, previous); await f.loadJob();
  expect((await f.lifecycle.status(f.dataDir)).installation).toBe("installed");
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("previous startup contract");
  expect(await readFile(f.plistPath, "utf8")).toBe(previous);
  expect((await f.lifecycle.uninstall(f.dataDir)).installation).toBe("absent");
  expect((await f.lifecycle.install(f.dataDir)).installation).toBe("installed");
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).schemaVersion).toBe(4);
});

function nativeIdentity(f: Awaited<ReturnType<typeof fixture>>): MacosAppIdentity {
  return { schemaVersion: 1, bundleId: MACOS_APP_BUNDLE_ID, signing: "ad-hoc", messagesBundleId: "com.apple.MobileSMS", automationConsent: "native-api", home: f.home, dataDir: f.dataDir,
    runtime: f.runtime, entrypoint: f.entrypoint, appPath: join(f.home, "Applications", "TextButler.app"),
    runtimeSha256: "a".repeat(64), entrypointSha256: "b".repeat(64), executableSha256: "c".repeat(64), infoPlistSha256: "d".repeat(64), signatureSha256: "e".repeat(64), sourceSha256: "f".repeat(64) };
}
test("an admitted app is the direct launchd executable with a separate bundle identity and shutdown grace", async () => {
  const f = await fixture(), application = nativeIdentity(f), lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => application });
  expect(await lifecycle.install(f.dataDir)).toMatchObject({ installation: "installed", service: "running" });
  const plist = await readFile(f.plistPath, "utf8"), receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  expect(f.state.job!.args).toEqual([join(application.appPath, "Contents", "MacOS", "TextButler"), "--daemon"]);
  expect(plist).toContain(`<key>AssociatedBundleIdentifiers</key><array><string>${MACOS_APP_BUNDLE_ID}</string></array>`);
  expect(plist).toContain("<key>ExitTimeOut</key><integer>60</integer>");
  expect(plist).toContain(`<key>TEXTBUTLER_LAUNCH_AGENT_GENERATION</key><string>${receipt.generation}</string>`);
  expect(receipt).toMatchObject({ schemaVersion: 4, application });
  expect(receipt.plistText).toBe(plist); expect(plist).toContain("<key>ProcessType</key><string>Standard</string>");
  expect(await lifecycle.install(f.dataDir)).toMatchObject({ installation: "installed" });
  expect(f.calls.filter(args => args[0] === "bootstrap")).toHaveLength(1);
  expect(await lifecycle.uninstall(f.dataDir)).toMatchObject({ installation: "absent" });
});
test("moving from the legacy Bun service to the app requires normal removal and retains settings", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const settingsPath = join(f.dataDir, "state", "settings.json"), before = await readFile(settingsPath, "utf8");
  const lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => nativeIdentity(f) });
  await expect(lifecycle.install(f.dataDir)).rejects.toThrow("another app identity");
  expect(f.state.job!.args[0]).toBe("/usr/bin/env");
  await lifecycle.uninstall(f.dataDir); await lifecycle.install(f.dataDir);
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).schemaVersion).toBe(4);
  expect(await readFile(settingsPath, "utf8")).toBe(before);
});
test("changed app admission never falls back to shared Bun or changes an owned service", async () => {
  const f = await fixture(), application = nativeIdentity(f);
  const lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => application }); await lifecycle.install(f.dataDir);
  await expect(createLaunchAgentLifecycle({ ...f.host, application: async () => ({ ...application, executableSha256: "0".repeat(64) }) }).install(f.dataDir)).rejects.toThrow("another app identity");
  await expect(createLaunchAgentLifecycle({ ...f.host, application: async () => { throw new Error("changed app"); } }).install(f.dataDir)).rejects.toThrow("changed app");
  expect(f.calls.filter(args => args[0] === "bootstrap")).toHaveLength(1);
  // Removal uses the exact recorded job even if the install receipt is now
  // unavailable. It does not need to execute the changed app to stop launchd.
  expect(await createLaunchAgentLifecycle({ ...f.host, application: async () => { throw new Error("changed app"); } }).uninstall(f.dataDir)).toMatchObject({ installation: "absent" });
});

// Reproduce an installation recorded by an older binary: the same plist with
// the earlier template's ProcessType=Background plus the earlier receipt
// schema, then reload the job launchd would report for it.
async function downgrade(f: Awaited<ReturnType<typeof fixture>>, schemaVersion: 2 | 3): Promise<string> {
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8")) as Record<string, unknown>;
  const prior: Record<string, unknown> = { ...receipt, schemaVersion };
  delete prior.plistText; if (schemaVersion === 2) delete prior.application;
  await writeFile(f.receiptPath, `${JSON.stringify(prior)}\n`, { mode: 0o600 });
  const priorPlist = (await readFile(f.plistPath, "utf8")).replace("<key>ProcessType</key><string>Standard</string>", "<key>ProcessType</key><string>Background</string>");
  await writeFile(f.plistPath, priorPlist, { mode: 0o600 });
  await f.loadJob();
  return priorPlist;
}
test("a service recorded by an older binary remains verifiable and removable", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const priorPlist = await downgrade(f, 2);
  expect((await f.lifecycle.status(f.dataDir)).installation).toBe("installed");
  await expect(f.lifecycle.install(f.dataDir)).rejects.toThrow("earlier launch contract");
  expect(await readFile(f.plistPath, "utf8")).toBe(priorPlist);
  expect((await f.lifecycle.uninstall(f.dataDir)).installation).toBe("absent");
  expect((await f.lifecycle.install(f.dataDir)).installation).toBe("installed");
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  expect(receipt.schemaVersion).toBe(4); expect(await readFile(f.plistPath, "utf8")).toBe(receipt.plistText);
});
test("the prior app-bound launch contract remains verifiable and removable", async () => {
  const f = await fixture(), application = nativeIdentity(f);
  const lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => application });
  await lifecycle.install(f.dataDir);
  const priorPlist = await downgrade(f, 3);
  expect((await lifecycle.status(f.dataDir)).installation).toBe("installed");
  await expect(lifecycle.install(f.dataDir)).rejects.toThrow("earlier launch contract");
  expect(await readFile(f.plistPath, "utf8")).toBe(priorPlist);
  expect((await lifecycle.uninstall(f.dataDir)).installation).toBe("absent");
  expect((await lifecycle.install(f.dataDir)).installation).toBe("installed");
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  expect(receipt).toMatchObject({ schemaVersion: 4, application });
  expect(await readFile(f.plistPath, "utf8")).toContain("<key>ProcessType</key><string>Standard</string>");
});
test("an older recorded contract migrates forward only while its service is absent", async () => {
  const f = await fixture(), application = nativeIdentity(f);
  const lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => application });
  await lifecycle.install(f.dataDir);
  await downgrade(f, 3);
  f.state.job = null;
  expect((await lifecycle.install(f.dataDir)).installation).toBe("installed");
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  expect(receipt).toMatchObject({ schemaVersion: 4, application });
  const plist = await readFile(f.plistPath, "utf8");
  expect(plist).toBe(receipt.plistText); expect(plist).toContain("<key>ProcessType</key><string>Standard</string>");
  expect(f.state.job!.args).toEqual([join(application.appPath, "Contents", "MacOS", "TextButler"), "--daemon"]);
});
test("a receipt whose recorded artifact was replaced fails closed", async () => {
  const f = await fixture(); await f.lifecycle.install(f.dataDir);
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  receipt.plistText = receipt.plistText.replace("<key>ProcessType</key><string>Standard</string>", "<key>ProcessType</key><string>Background</string>");
  await writeFile(f.receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  expect((await f.lifecycle.status(f.dataDir)).installation).toBe("conflict");
  await expect(f.lifecycle.uninstall(f.dataDir)).rejects.toThrow("exact recorded");
  expect(await readFile(f.plistPath, "utf8")).toContain("<key>ProcessType</key><string>Standard</string>");
});
test("schema3 refuses another loaded generation even at the same executable and plist path", async () => {
  const f = await fixture(), lifecycle = createLaunchAgentLifecycle({ ...f.host, application: async () => nativeIdentity(f) }); await lifecycle.install(f.dataDir);
  f.state.job!.generation = "00000000-0000-0000-0000-000000000000";
  expect(await lifecycle.status(f.dataDir)).toMatchObject({ installation: "conflict", service: "unknown" });
  await expect(lifecycle.uninstall(f.dataDir)).rejects.toThrow("no longer matches");
  expect(f.calls.filter(args => args[0] === "bootout")).toHaveLength(0);
});
