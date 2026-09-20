import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertAppUpgradeArtifactsSettled, assertManagedAppUpgrade, parseMacosSetupJob, settleMacosSetupBootstrap, type SetupJob } from "./macos-textbutler-app.ts";
import type { MacosAppIdentity } from "../packages/textbutler/src/macos-app.ts";

const executable = "/synthetic/owner/Applications/TextButler.app/Contents/MacOS/TextButler";
const plist = "/synthetic/owner/Library/Application Support/Textbutler/state/imessage-setup-launch.plist";
const generation = "12345678-1234-1234-1234-123456789abc";
const expected = { uid: 501, executable, plist, generation };
// Real launchctl print structure with synthetic identifiers. Coalitions repeat
// scalar field names, and a live first launch has no numeric exit code yet.
const running = `gui/501/app.textbutler.imessage-setup = {
\tactive count = 1
\tpath = ${plist}
\ttype = LaunchAgent
\tstate = running
\tprogram = ${executable}
\targuments = {
\t\t${executable}
\t\t--imessage-setup
\t}
\tinherited environment = {
\t\tSSH_AUTH_SOCK => /synthetic/run/socket
\t}
\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}
\tenvironment = {
\t\tOSLogRateLimit => 64
\t\tTEXTBUTLER_LAUNCH_AGENT_GENERATION => ${generation}
\t\tXPC_SERVICE_NAME => app.textbutler.imessage-setup
\t}
\tpid = 17975
\tlast exit code = (never exited)
\tresource coalition = {
\t\tID = 176604
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = app.textbutler.imessage-setup
\t}
\tjetsam coalition = {
\t\tID = 176605
\t\ttype = jetsam
\t\tstate = active
\t\tactive count = 1
\t\tname = app.textbutler.imessage-setup
\t}
\tproperties = runatload | inferred program
}
`;
const parse = (stdout: string) => parseMacosSetupJob({ exitCode: 0, stdout, stderr: "" }, expected);

test("joins a first running launch despite nested coalition states and never-exited marker", () => {
  expect(parse(running)).toEqual({ state: "owned", running: true, exitCode: null });
});
test("recognizes an exact completed launch with coalitions", () => {
  expect(parse(running.replace("state = running", "state = not running").replace("\tpid = 17975\n", "").replace("(never exited)", "0")))
    .toEqual({ state: "owned", running: false, exitCode: 0 });
});
test("nested fields cannot supply root job identity or state", () => {
  expect(parse(running.replace("\tstate = running\n", ""))).toEqual({ state: "unknown" });
  expect(parse(running.replace("\tpid = 17975\n", "").replace("\t\tID = 176604", "\t\tpid = 17975"))).toEqual({ state: "unknown" });
  expect(parse(running.replace(`\tpath = ${plist}\n`, "").replace("\t\tID = 176604", `\t\tpath = ${plist}`))).toEqual({ state: "unknown" });
});
test("only one root environment can establish the launch generation", () => {
  const environment = running.match(/\tenvironment = \{[\s\S]*?\n\t\}\n/u)![0];
  expect(parse(running.replace(environment, ""))).toEqual({ state: "unknown" });
  expect(parse(running.replace(environment, "").replace("\tresource coalition = {\n", `\tresource coalition = {\n${environment}`))).toEqual({ state: "unknown" });
  expect(parse(running.replace(environment, `${environment}${environment}`))).toEqual({ state: "unknown" });
});
test("generation, role, duplicate fields and incoherent states remain closed", () => {
  for (const changed of [
    running.replace(generation, "abcdefab-1234-1234-1234-123456789abc"),
    running.replace("\t\t--imessage-setup\n", "\t\t--daemon\n"),
    running.replace("\tstate = running\n", "\tstate = running\n\tstate = running\n"),
    running.replace("(never exited)", "0\n\tlast exit code = 1"),
    running.replace("state = running", "state = not running"),
    running.replace("state = running", "state = unknown"),
    running.replace("pid = 17975", "pid = 9999999999"),
    running.replace("(never exited)", "256"),
    running.slice(0, -2),
    `${running}state = running\n`,
  ]) expect(parse(changed)).toEqual({ state: "unknown" });
});

function settlingClock() {
  let now = 0;
  const waits: number[] = [];
  return { waits, timing: { now: () => now, async sleep(ms: number) { waits.push(ms); now += ms; } }, advance(ms: number) { now += ms; } };
}
test("successful bootstrap observes unknown then exactly owned without broadening the parser", async () => {
  const clock = settlingClock(), budgets: number[] = [];
  const observations = [parse(running.replace("state = running", "state = spawning")), parse(running)];
  expect(observations[0]).toEqual({ state: "unknown" });
  await settleMacosSetupBootstrap(0, async budget => { budgets.push(budget); return observations.shift()!; }, clock.timing);
  expect(budgets).toEqual([4000, 3900]);
  expect(clock.waits).toEqual([100]);
});
test("a persistent unknown or mismatched job exhausts the bounded observation window", async () => {
  for (const output of [running.replace("state = running", "state = spawning"), running.replace(generation, "abcdefab-1234-1234-1234-123456789abc")]) {
    const clock = settlingClock(), budgets: number[] = [];
    await expect(settleMacosSetupBootstrap(0, async budget => { budgets.push(budget); return parse(output); }, clock.timing)).rejects.toThrow("exact launch artifacts were retained");
    expect(budgets).toHaveLength(40);
    expect(budgets[0]).toBe(4000); expect(budgets.at(-1)).toBe(100);
    expect(clock.waits.reduce((total, ms) => total + ms, 0)).toBe(4000);
  }
});
test("failed bootstrap and absent jobs never enter a retry loop", async () => {
  const clock = settlingClock(); let reads = 0;
  const inspect = async (): Promise<SetupJob> => { reads++; return { state: "absent" }; };
  await expect(settleMacosSetupBootstrap(1, inspect, clock.timing)).rejects.toThrow("bootstrap is uncertain");
  expect(reads).toBe(0);
  await expect(settleMacosSetupBootstrap(0, inspect, clock.timing)).rejects.toThrow("bootstrap is uncertain");
  expect(reads).toBe(1); expect(clock.waits).toEqual([]);
});
test("a late owned response or failed observation cannot authorize continuation", async () => {
  const clock = settlingClock();
  await expect(settleMacosSetupBootstrap(0, async () => { clock.advance(4001); return parse(running); }, clock.timing)).rejects.toThrow("bootstrap is uncertain");
  let reads = 0;
  await expect(settleMacosSetupBootstrap(0, async () => { reads++; throw new Error("synthetic read deadline"); }, clock.timing)).rejects.toThrow("synthetic read deadline");
  expect(reads).toBe(1); expect(clock.waits).toEqual([]);
});

const upgradeRoots: string[] = [];
afterEach(async () => { for (const root of upgradeRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
const appIdentity: MacosAppIdentity = {
  schemaVersion: 1, bundleId: "app.textbutler.desktop", signing: "ad-hoc", messagesBundleId: "com.apple.MobileSMS", automationConsent: "native-api",
  home: "/synthetic/owner", appPath: "/synthetic/owner/Applications/TextButler.app", dataDir: "/synthetic/owner/data", runtime: "/synthetic/bun", entrypoint: "/synthetic/old/textbutler.mjs",
  runtimeSha256: "a".repeat(64), entrypointSha256: "b".repeat(64), executableSha256: "c".repeat(64), infoPlistSha256: "d".repeat(64), signatureSha256: "e".repeat(64), sourceSha256: "f".repeat(64),
};
test("managed app upgrades preserve owner, location and permission identity while accepting new payload pins", () => {
  expect(() => assertManagedAppUpgrade(appIdentity, { ...appIdentity, entrypoint: "/synthetic/new/textbutler.mjs", entrypointSha256: "a".repeat(64), executableSha256: "b".repeat(64) })).not.toThrow();
  for (const changed of [{ home: "/synthetic/other" }, { appPath: "/synthetic/other.app" }, { dataDir: "/synthetic/other-data" }, { bundleId: "other" }, { signing: "other" }, { messagesBundleId: "com.apple.iChat" }, { automationConsent: "synthetic" }])
    expect(() => assertManagedAppUpgrade(appIdentity, { ...appIdentity, ...changed } as MacosAppIdentity)).toThrow("preserve its managed owner");
});
test("app upgrade refuses and preserves every service or connector custody artifact", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-app-upgrade-state-"))); upgradeRoots.push(root);
  const home = join(root, "home"), dataDir = join(root, "data");
  await mkdir(join(dataDir, "state"), { recursive: true, mode: 0o700 }); await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
  const identity = { ...appIdentity, home, dataDir };
  await expect(assertAppUpgradeArtifactsSettled(identity)).resolves.toBeUndefined();
  const paths = [join(dataDir, "daemon.sock"), join(home, "Library", "LaunchAgents", "app.textbutler.daemon.plist"),
    ...["launch-agent.json", "launch-agent.lock", "imessage-setup-launch.json", "imessage-setup-launch.plist", "imessage-setup-custody.json", "ghostget-automation-custody.json", "ghostget-read-custody.json"].map(name => join(dataDir, "state", name))];
  for (const path of paths) {
    await writeFile(path, "synthetic retained custody", { mode: 0o600 });
    await expect(assertAppUpgradeArtifactsSettled(identity)).rejects.toThrow("retained service or connector custody");
    expect(await readFile(path, "utf8")).toBe("synthetic retained custody");
    await rm(path);
  }
});
