import { expect, test } from "bun:test";
import { parseMacosSetupJob } from "./macos-textbutler-app.ts";

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
