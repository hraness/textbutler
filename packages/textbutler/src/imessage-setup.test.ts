import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureIMessage, IMESSAGE_SETUP_BINDING, IMESSAGE_SETUP_CUSTODY, IMESSAGE_SETUP_RESULT, runIMessageSetup, type IMessageSetupPort } from "./imessage-setup.ts";
import { runTextbutlerCli, CLI_USAGE } from "./cli.ts";
const ID = "synthetic-imessage", SUBJECT = "imessage:synthetic", READ = "messaging.automation.read", SEND = "messaging.automation.send.text";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function capability(operationId: string, revision: number, permission: string) {
  return { digest: String(revision + (operationId === READ ? 1 : 2)).padStart(64, "a"), adapterId: "imessage-direct", operationId, pluginId: "imessage", surface: "imessage", transport: "local-cli", risk: operationId === READ ? "R1" : "R3", effect: operationId === READ ? "none" : "synthetic scoped text", state: "available", executorSource: "built-in", interfaceSource: "bundled", permission };
}
function view(revision: number, managed: boolean, permissions: Record<string, string>) {
  return { version: "0.18.16", accountId: ID, accounts: [{ id: ID, provider: "imessage", kind: "linked-device-store", subject: SUBJECT, revision: "c".repeat(64), status: "configured", source: null, tokenStorage: null }],
    capabilities: [READ, SEND].map(operation => capability(operation, revision, managed ? permissions[operation] ?? "deny" : "unmanaged")), interfaces: [], policy: { managed, revision }, web: { revision: 0, gatewayOnly: false, rules: [] }, approvals: [], connectionProviders: [], vault: { provider: "1password", available: true, purpose: "x-user-token-import" } };
}
function fixture(existing = false, alreadyAllowed = false) {
  let auth: { id: string; kind: string; provider: string; subject: string | null; realmFingerprint: string } | null = existing ? { id: ID, kind: "linked-device-store", provider: "imessage", subject: SUBJECT, realmFingerprint: "b".repeat(16) } : null;
  let revision = alreadyAllowed ? 3 : 0, managed = alreadyAllowed;
  const permissions: Record<string, string> = alreadyAllowed ? { [READ]: "allow", [SEND]: "allow" } : {};
  const calls: Array<{ action: string; [key: string]: unknown }> = [];
  let transform: (value: ReturnType<typeof view>) => unknown = value => value;
  const port: IMessageSetupPort = {
    async authList() { calls.push({ action: "auth.list" }); return { ok: true, auth: auth ? [{ ...auth }] : [] }; },
    async authAdd() { calls.push({ action: "auth.add" }); if (auth) throw Error("no replacement"); auth = { id: ID, kind: "linked-device-store", provider: "imessage", subject: null, realmFingerprint: "a".repeat(16) }; },
    async authBind() { calls.push({ action: "auth.bind" }); auth = { ...auth!, subject: SUBJECT, realmFingerprint: "b".repeat(16) }; return { ok: true, id: ID, site: "imessage", subject: SUBJECT, realmFingerprint: "b".repeat(16) }; },
    async control(request) {
      calls.push({ ...request });
      if (request.action === "snapshot") return { ok: true, data: { kind: "snapshot", snapshot: transform(view(revision, managed, permissions)) } };
      expect(request.expectedRevision).toBe(revision);
      if (request.action === "permission.enable") managed = true;
      else { expect(request.accountId).toBe(ID); expect(request.adapterId).toBe("imessage-direct"); expect(request.expectedCapabilityDigest).toBe(capability(request.operationId, revision, "deny").digest); permissions[request.operationId] = request.decision; }
      revision++; return { ok: true, data: { kind: "success", message: "Saved." } };
    },
  };
  return { port, calls, replaceAuth(value: typeof auth) { auth = value; }, transform(value: typeof transform) { transform = value; } };
}
test("fresh setup grants only two exact operations from fresh CAS-bound snapshots", async () => {
  const f = fixture();
  expect(await configureIMessage(f.port, ID)).toMatchObject({ accountCreated: true, accountBound: true, managedEnabled: true, permissionsChanged: 2 });
  expect(f.calls.filter(call => call.action === "permission.set").map(call => [call.operationId, call.expectedRevision])).toEqual([[READ, 1], [SEND, 2]]);
  for (const call of f.calls.filter(call => call.action === "permission.set")) expect(call).toMatchObject({ adapterId: "imessage-direct", accountId: ID, decision: "allow", expectedCapabilityDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(f.calls.filter(call => call.action === "snapshot")).toHaveLength(4);
});
test("completed existing account setup is repeatable without account or permission replacement", async () => {
  const f = fixture(true, true);
  f.port.authBind = async () => { throw new Error("Rebinding would rotate the existing account incarnation"); };
  expect(await configureIMessage(f.port, ID)).toMatchObject({ accountCreated: false, managedEnabled: false, permissionsChanged: 0 });
  expect(f.calls.some(call => call.action === "auth.add" || call.action === "auth.bind" || call.action.startsWith("permission."))).toBe(false);
});
test("binding publication must settle before any permission mutation", async () => {
  const f = fixture();
  await expect(configureIMessage(f.port, ID, undefined, async subjectDigest => {
    expect(subjectDigest).toMatch(/^[a-f0-9]{64}$/u);
    throw new Error("synthetic binding publication failed");
  })).rejects.toThrow("synthetic binding publication failed");
  expect(f.calls.some(call => call.action === "snapshot" || call.action.startsWith("permission."))).toBe(false);
});
test("wrong existing provider or kind is refused before bind or permissions", async () => {
  for (const changed of [{ provider: "whatsapp" }, { kind: "oauth-token-file" }]) {
    const f = fixture(); f.replaceAuth({ id: ID, kind: "linked-device-store", provider: "imessage", subject: SUBJECT, realmFingerprint: "b".repeat(16), ...changed });
    await expect(configureIMessage(f.port, ID)).rejects.toThrow("existing-account-conflict");
    expect(f.calls.map(call => call.action)).toEqual(["auth.list"]);
  }
});
test("an existing subject changing during setup is never replaced or authorized", async () => {
  const f = fixture(true), list = f.port.authList; let reads = 0;
  f.port.authList = async () => { const response = await list() as { ok: true; auth: Array<Record<string, unknown>> }; return ++reads === 1 ? response : { ...response, auth: response.auth.map(account => ({ ...account, subject: "imessage:other" })) }; };
  await expect(configureIMessage(f.port, ID)).rejects.toThrow("account-identity-changed");
  expect(f.calls.some(call => call.action === "auth.bind" || call.action.startsWith("permission."))).toBe(false);
});
test("foreign, duplicate, malformed and unavailable capabilities never receive grants", async () => {
  const transforms = [
    (v: ReturnType<typeof view>) => ({ ...v, accountId: "other" }),
    (v: ReturnType<typeof view>) => ({ ...v, version: "0.18.17" }),
    (v: ReturnType<typeof view>) => ({ ...v, capabilities: [...v.capabilities, v.capabilities[0]] }),
    (v: ReturnType<typeof view>) => ({ ...v, capabilities: v.capabilities.map(c => ({ ...c, digest: "bad" })) }),
    (v: ReturnType<typeof view>) => ({ ...v, capabilities: v.capabilities.map(c => ({ ...c, interfaceSource: "user" })) }),
    (v: ReturnType<typeof view>) => ({ ...v, capabilities: v.capabilities.map(c => ({ ...c, state: "unsupported" })) }),
  ];
  for (const transform of transforms) { const f = fixture(true); f.transform(transform); await expect(configureIMessage(f.port, ID)).rejects.toThrow(); expect(f.calls.some(c => c.action.startsWith("permission."))).toBe(false); }
});
test("account revision drift after permission activation is fenced before grant", async () => {
  const f = fixture(true); let reads = 0;
  f.transform(v => ++reads === 1 ? v : { ...v, accounts: v.accounts.map(a => ({ ...a, revision: "d".repeat(64) })) });
  await expect(configureIMessage(f.port, ID)).rejects.toThrow("account-identity-changed");
  expect(f.calls.filter(c => c.action === "permission.set")).toHaveLength(0);
});
test("failed grant is not retried and final permissions must both be allowed", async () => {
  const f = fixture(true, true);
  f.transform(v => ({ ...v, capabilities: v.capabilities.map(c => ({ ...c, permission: "deny" })) }));
  await expect(configureIMessage(f.port, ID)).rejects.toThrow("permission-verification-failed");
  expect(f.calls.filter(c => c.action === "permission.set")).toHaveLength(2);
  const rejected = fixture(true, true); rejected.port.control = async () => ({ ok: false, code: "OPERATION_PERMISSION_CHANGED", message: "Refresh." });
  await expect(configureIMessage(rejected.port, ID)).rejects.toThrow("permission-revision-rejected");
});

async function processFixture(mode = "normal") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-imessage-setup-"))); roots.push(root);
  const packageRoot = join(root, "ghostget"), home = join(root, "home"), dataDir = join(root, "data"), stateHome = join(root, "connector-state");
  for (const path of [packageRoot, home, dataDir, stateHome, join(dataDir, "state"), join(packageRoot, "src"), join(packageRoot, "src", "control")]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@hraness/ghostget", version: "0.18.16", type: "module" }), { mode: 0o600 });
  const common = `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const root=process.env.GHOSTGET_STATE_HOME, file=join(root,"fixture.json"), log=join(root,"calls.jsonl");
const state=JSON.parse(readFileSync(file,"utf8"));
const save=()=>writeFileSync(file,JSON.stringify(state));
const record=(call)=>appendFileSync(log,JSON.stringify({call,pid:process.pid,cwd:process.cwd(),runtimeArgs:process.execArgv,env:process.env})+"\\n");
const id=${JSON.stringify(ID)}, subject=${JSON.stringify(SUBJECT)}, read=${JSON.stringify(READ)}, send=${JSON.stringify(SEND)};
`;
  await writeFile(join(packageRoot, "src", "cli.ts"), common + `
import { spawn } from "node:child_process";
const args=process.argv.slice(2);record(args);
if(state.mode==="failed-cli")process.exit(1);
if(state.mode==="hang"){setInterval(()=>{},1000);await new Promise(()=>{});}
if(state.mode==="orphan"){const child=spawn(process.execPath,["--no-env-file","--no-install","-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(join(root,"orphan.json"),JSON.stringify({pid:child.pid,group:process.pid}));child.unref();}
if(args.join(" ")==="auth list --json") console.log(JSON.stringify({ok:true,auth:state.auth?[state.auth]:[]}));
else if(args.length===7&&args[0]==="auth"&&args[1]==="add"&&args[2]===id&&args[3]==="--linked-device"&&args[4]==="imessage"&&args[5]==="--device-store"&&args[6]===join(process.env.HOME,"Library","Messages")&&!state.auth){state.auth={id,kind:"linked-device-store",provider:"imessage",subject:null,realmFingerprint:"a".repeat(16)};save();console.log("Saved synthetic locator.");}
else if(args.join(" ")===\`auth bind \${id} --site imessage --json\`){state.auth={...state.auth,subject,realmFingerprint:"b".repeat(16)};save();console.log(JSON.stringify({ok:true,id,site:"imessage",subject,realmFingerprint:"b".repeat(16)}));}
else process.exit(2);
`, { mode: 0o600 });
  await writeFile(join(packageRoot, "src", "control", "helper.ts"), common + `
let buffer="";process.stdin.on("data",chunk=>{buffer+=chunk;const at=buffer.indexOf("\\n");if(at<0)return;const frame=JSON.parse(buffer.slice(0,at)),request=frame.request;record(request);
let data;
if(request.action==="snapshot")data={kind:"snapshot",snapshot:{version:"0.18.16",accountId:id,accounts:[{id,provider:"imessage",kind:"linked-device-store",subject,revision:"c".repeat(64)}],capabilities:[read,send].map(operationId=>({digest:String(state.revision+(operationId===read?1:2)).padStart(64,"a"),adapterId:"imessage-direct",operationId,pluginId:"imessage",surface:"imessage",transport:"local-cli",risk:operationId===read?"R1":"R3",effect:"synthetic",state:"available",executorSource:"built-in",interfaceSource:"bundled",permission:state.managed?state.permissions[operationId]??"deny":"unmanaged"})),interfaces:[],policy:{managed:state.managed,revision:state.revision},web:{},approvals:[],connectionProviders:[],vault:{}}};
else if(request.action==="permission.enable"&&request.expectedRevision===state.revision){state.managed=true;state.revision++;save();data={kind:"success",message:"Enabled."};}
else if(request.action==="permission.set"&&state.mode==="stale"){console.log(JSON.stringify({id:frame.id,protocol:frame.protocol,ok:false,code:"OPERATION_PERMISSION_CHANGED",message:"Refresh."}));return;}
else if(request.action==="permission.set"&&request.accountId===id&&request.adapterId==="imessage-direct"&&[read,send].includes(request.operationId)&&request.expectedRevision===state.revision&&request.expectedCapabilityDigest===String(state.revision+(request.operationId===read?1:2)).padStart(64,"a")){state.permissions[request.operationId]="allow";state.revision++;save();data={kind:"success",message:"Saved."};}
else process.exit(2);
console.log(JSON.stringify({id:state.mode==="wrong-id"?"wrong-id":frame.id,protocol:frame.protocol,ok:true,data}));
});
`, { mode: 0o600 });
  await writeFile(join(stateHome, "fixture.json"), JSON.stringify({ mode, auth: null, managed: false, revision: 0, permissions: {} }), { mode: 0o600 });
  const runtimeExecutable = await realpath(process.execPath), executable = join(packageRoot, "src", "cli.ts");
  await writeFile(join(dataDir, "state", "host.json"), JSON.stringify({ schemaVersion: 1, ghostget: { executable, runtimeExecutable, authId: ID, stateHome, automationAccounts: [{ provider: "imessage", authId: ID }] } }), { mode: 0o600 });
  return { root, packageRoot, home, dataDir, stateHome, executable, options: { home, platform: "darwin", automationPermission: "allowed", launchGeneration: "12345678-1234-1234-1234-123456789abc", processLimits: { commandMs: 2000, cleanupMs: 100 } }, async calls() { try { return (await readFile(join(stateHome, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } } };
}
test("real child setup has closed argv/environment, durable results, and repeatable completed state", async () => {
  const f = await processFixture();
  const result = await runIMessageSetup(f.dataDir, f.options);
  expect(result).toMatchObject({ ok: true, status: "completed", custody: "released", launchGeneration: f.options.launchGeneration, progress: { accountCreated: true, permissionsChanged: 2 } });
  expect(JSON.parse(await readFile(join(f.dataDir, "state", IMESSAGE_SETUP_RESULT), "utf8"))).toEqual(result);
  expect((await lstat(join(f.dataDir, "state", IMESSAGE_SETUP_RESULT))).mode & 0o777).toBe(0o600);
  const bindingPath = join(f.dataDir, "state", IMESSAGE_SETUP_BINDING);
  const bindingBytes = await readFile(bindingPath);
  expect(JSON.parse(bindingBytes.toString("utf8"))).toEqual({ schemaVersion: 1, accountDigest: result.accountDigest, subjectDigest: result.progress.subjectDigest });
  expect(bindingBytes.byteLength).toBeLessThanOrEqual(1024);
  expect((await lstat(bindingPath)).mode & 0o777).toBe(0o600);
  await expect(lstat(join(f.dataDir, "state", IMESSAGE_SETUP_CUSTODY))).rejects.toMatchObject({ code: "ENOENT" });
  const calls = await f.calls();
  expect(calls.length).toBeGreaterThan(6);
  for (const call of calls) {
    expect(call.cwd).toBe(f.packageRoot); expect(call.runtimeArgs).toContain("--no-env-file"); expect(call.runtimeArgs).toContain("--no-install");
    expect(call.runtimeArgs.some((arg: string) => arg.startsWith("--cwd") || arg.startsWith("--config"))).toBe(false);
    expect(call.env.HOME).toBe(f.home); expect(call.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin"); expect(call.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");
    expect(Object.keys(call.env).sort()).toEqual(["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "GHOSTGET_STATE_HOME", "HOME", "HRANESS_SUPPORT_AUDIENCE", "HRANESS_SUPPORT_EMAIL", "PATH"].sort());
  }
  const again = await runIMessageSetup(f.dataDir, f.options);
  expect(again).toMatchObject({ ok: true, progress: { accountCreated: false, managedEnabled: false, permissionsChanged: 0 } });
  expect(again.attemptId).not.toBe(result.attemptId);
  expect((await f.calls()).filter(call => Array.isArray(call.call) && call.call[0] === "auth" && call.call[1] === "bind")).toHaveLength(1);
  expect(await readFile(bindingPath)).toEqual(bindingBytes);
}, 20000);
test("established identity survives denied preflight and loss of the latest result", async () => {
  for (const removeLatest of [false, true]) {
    const f = await processFixture(), completed = await runIMessageSetup(f.dataDir, f.options);
    expect(completed.ok).toBe(true);
    const bindingPath = join(f.dataDir, "state", IMESSAGE_SETUP_BINDING), bindingBytes = await readFile(bindingPath), callsBefore = await f.calls();
    expect(await runIMessageSetup(f.dataDir, { ...f.options, automationPermission: "denied" })).toMatchObject({ status: "blocked", code: "automation-permission-denied", accountDigest: completed.accountDigest, progress: { subjectDigest: completed.progress.subjectDigest } });
    expect((await f.calls()).length).toBe(callsBefore.length);
    if (removeLatest) await rm(join(f.dataDir, "state", IMESSAGE_SETUP_RESULT));
    const fixturePath = join(f.stateHome, "fixture.json"), state = JSON.parse(await readFile(fixturePath, "utf8"));
    state.auth.subject = "imessage:replacement"; state.auth.realmFingerprint = "d".repeat(16);
    await writeFile(fixturePath, JSON.stringify(state), { mode: 0o600 });
    expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ ok: false, code: "account-identity-changed", custody: "retained" });
    expect((await f.calls()).slice(callsBefore.length).map(call => call.call)).toEqual([["auth", "list", "--json"]]);
    expect(await readFile(bindingPath)).toEqual(bindingBytes);
  }
}, 20000);
test("malformed authoritative binding is preserved and cannot be treated as fresh setup", async () => {
  for (const bytes of ["{}", JSON.stringify({ schemaVersion: 1, accountDigest: "a".repeat(64), subjectDigest: "b".repeat(64), extra: true })]) {
    const f = await processFixture(), path = join(f.dataDir, "state", IMESSAGE_SETUP_BINDING);
    await writeFile(path, bytes, { mode: 0o600 });
    expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ ok: false, status: "blocked", code: "setup-binding-invalid", custody: "not-acquired" });
    expect(await f.calls()).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe(bytes);
  }
});
test("wrong helper identity retains custody and blocks any new child on explicit repeat", async () => {
  const f = await processFixture("wrong-id");
  expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ status: "recovery-required", custody: "retained" });
  const calls = (await f.calls()).length;
  expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ ok: false, code: "prior-setup-needs-recovery", custody: "retained" });
  expect((await f.calls()).length).toBe(calls);
  expect((await lstat(join(f.dataDir, "state", IMESSAGE_SETUP_CUSTODY))).isFile()).toBe(true);
}, 10000);
test("known joined permission CAS rejection is archived, released, and never retried automatically", async () => {
  const f = await processFixture("stale");
  expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ ok: false, status: "blocked", code: "permission-revision-rejected", custody: "released" });
  expect((await f.calls()).filter(call => call.call.action === "permission.set")).toHaveLength(1);
  await expect(lstat(join(f.dataDir, "state", IMESSAGE_SETUP_CUSTODY))).rejects.toMatchObject({ code: "ENOENT" });
}, 10000);
test("failed child preserves evidence, while symlinked executable is refused before launch", async () => {
  const f = await processFixture("failed-cli");
  expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ status: "recovery-required", custody: "retained", code: "process-custody-unproven" });
  const unsafe = await processFixture(); const source = await readFile(unsafe.executable, "utf8");
  await writeFile(join(unsafe.packageRoot, "actual.ts"), source, { mode: 0o600 }); await rm(unsafe.executable); await symlink(join(unsafe.packageRoot, "actual.ts"), unsafe.executable);
  expect(await runIMessageSetup(unsafe.dataDir, unsafe.options)).toMatchObject({ ok: false, status: "blocked", custody: "not-acquired", code: "unsafe-connector-path" });
  expect(await unsafe.calls()).toHaveLength(0);
}, 10000);
test("a command deadline joins its child and retains cancellation custody", async () => {
  const f = await processFixture("hang");
  expect(await runIMessageSetup(f.dataDir, { ...f.options, processLimits: { commandMs: 150, cleanupMs: 100 } })).toMatchObject({ ok: false, status: "recovery-required", custody: "retained", code: "process-custody-unproven" });
  const calls = await f.calls(); expect(calls).toHaveLength(1);
  expect(() => process.kill(calls[0].pid, 0)).toThrow();
}, 10000);
test("normal leader exit with a remaining group is stopped and cannot clear custody", async () => {
  const f = await processFixture("orphan");
  expect(await runIMessageSetup(f.dataDir, f.options)).toMatchObject({ ok: false, status: "recovery-required", custody: "retained", code: "process-custody-unproven" });
  const descendant = JSON.parse(await readFile(join(f.stateHome, "orphan.json"), "utf8"));
  expect(() => process.kill(-descendant.group, 0)).toThrow();
}, 10000);
test("the app setup CLI accepts only its exact role with explicit data directory", async () => {
  for (const args of [["app", "imessage-setup"], ["app", "imessage-setup", "--force"], ["app", "imessage-setup", "auth", "remove"]]) await expect(runTextbutlerCli(args, { write() {} })).rejects.toThrow(CLI_USAGE);
});
test("denied, unavailable and unverified native Automation states block before any connector child", async () => {
  for (const automationPermission of ["denied", "unavailable", "", "unexpected"]) {
    const f = await processFixture();
    const expected = automationPermission === "denied" || automationPermission === "unavailable" ? automationPermission : "unverified";
    expect(await runIMessageSetup(f.dataDir, { ...f.options, automationPermission })).toMatchObject({ ok: false, status: "blocked", custody: "not-acquired", automationPermission: expected, code: `automation-permission-${expected}` });
    expect(await f.calls()).toHaveLength(0);
  }
});
test("invalid native launch generations are rejected before any connector child", async () => {
  for (const launchGeneration of ["", "------------------------------------", "12345678-1234-1234-1234-123456789ABC"]) {
    const f = await processFixture();
    expect(await runIMessageSetup(f.dataDir, { ...f.options, launchGeneration })).toMatchObject({ ok: false, status: "blocked", custody: "not-acquired", launchGeneration: null, code: "invalid-launch-generation" });
    expect(await f.calls()).toHaveLength(0);
  }
});
