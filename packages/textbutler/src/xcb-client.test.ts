import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXcbClient, parseXcbJson, XcbCapabilitiesError, XcbNotStarted, XCB_LIMITS, type XcbGenerateRequest } from "./xcb-client.ts";
import type { XcbHostConfig } from "./host-config.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(code: string, interpreter = process.execPath) {
  const root = await mkdtemp(join(tmpdir(), "textbutler-xcb-client-")); roots.push(root);
  const executable = join(root, "xcb-fixture");
  const bytes = `#!${interpreter}\n${code}\n`;
  await writeFile(executable, bytes, { mode: 0o700 });
  // macOS temp paths may contain a /var alias; setup records physical paths.
  const { realpath } = await import("node:fs/promises");
  const config: XcbHostConfig = { executable: await realpath(executable), stateHome: await realpath(root),
    sha256: createHash("sha256").update(bytes).digest("hex"), accounts: [{ provider: "claude", accountId: "synthetic", model: "claude/synthetic" }] };
  return { config, client: createXcbClient(config) };
}
const request: XcbGenerateRequest = { version: 1, account: "synthetic", model: "claude/synthetic", prompt: "No private data", timeoutMs: 1000, maxOutputBytes: 1024 };
const respond = `const r=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({version:1,status:"completed",requestId:"synthetic-one",account:r.account,model:r.model,text:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),hasSecret:!!process.env.TEXTBUTLER_SYNTHETIC_SECRET}),outcome:{terminal:"completed",joined:true,effects:"none"}}));`;
test("application launcher pins bytes, sends only the closed request and strips inherited environment", async () => {
  const f = await fixture(respond);
  process.env.TEXTBUTLER_SYNTHETIC_SECRET = "synthetic-only";
  try {
    const result = await f.client.generate(request, new AbortController().signal);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw Error("Fixture failed");
    expect(JSON.parse(result.text)).toEqual({ argv: ["--state", f.config.stateHome, "--json", "generate"], cwd: "/", hasSecret: false });
    await writeFile(f.config.executable, "replacement bytes");
    await expect(f.client.generate(request, new AbortController().signal)).rejects.toBeInstanceOf(XcbNotStarted);
  } finally { delete process.env.TEXTBUTLER_SYNTHETIC_SECRET; }
});
test("unsafe permissions and pre-aborted requests fail before the XCB process starts", async () => {
  const f = await fixture(respond); await chmod(f.config.executable, 0o777);
  await expect(f.client.generate(request, new AbortController().signal)).rejects.toBeInstanceOf(XcbNotStarted);
  await chmod(f.config.executable, 0o700);
  const aborted = new AbortController(); aborted.abort();
  await expect(f.client.generate(request, aborted.signal)).rejects.toBeInstanceOf(XcbNotStarted);
});
test("malformed output and signal termination are never a joined result", async () => {
  for (const code of ["console.log('not json');", "process.kill(process.pid,'SIGKILL');"]) {
    const f = await fixture(code);
    await expect(f.client.generate(request, new AbortController().signal)).rejects.toThrow("XCB_APPLICATION_RESPONSE_INVALID");
  }
});
test("native deadline asks the synthetic supervisor to join and accepts its failure envelope", async () => {
  const f = await fixture(`process.on("SIGINT",()=>{console.log(JSON.stringify({version:1,status:"failed",requestId:"synthetic-cancel",code:"cancelled",joined:true,effects:"none"}));process.exit(1)});setInterval(()=>{},1000);`);
  const result = await f.client.generate(request, new AbortController().signal);
  expect(result).toEqual({ version: 1, status: "failed", requestId: "synthetic-cancel", code: "cancelled", joined: true, effects: "none" });
});
test("JSON protocol rejects escaped duplicate keys, forbidden keys and excessive nesting", () => {
  expect(parseXcbJson('{"kind":"final","output":"synthetic"}')).toEqual({ kind: "final", output: "synthetic" });
  for (const value of ['{"kind":"tool","k\\u0069nd":"final"}', '{"__proto__":{}}', '["constructor",{"constructor":1}]', '['.repeat(25) + '0' + ']'.repeat(25)]) {
    expect(() => parseXcbJson(value)).toThrow();
  }
});

const wireCapabilities = { version: 1, supported: true, zeroTools: true, zeroHooks: true, ephemeral: true,
  limits: { maxInputBytes: 1_048_576, maxOutputBytes: 262_144, minTimeoutMs: 1000, maxTimeoutMs: 120_000 },
  accounts: [{ id: "synthetic-unavailable", label: "Synthetic", provider: "devin", enabled: true, busy: false,
    connected: false, runtimeAdmitted: false, available: false, reason: "application_not_qualified", models: [], qualification: null }] };
test("capabilities accept unrelated unavailable providers without starting inference", async () => {
  const f = await fixture(`if(process.argv.at(-1)!=="--capabilities" || await Bun.stdin.text()!=="")process.exit(2);console.log(${JSON.stringify(JSON.stringify(wireCapabilities))});`);
  expect(await f.client.capabilities(new AbortController().signal)).toMatchObject({ supported: true,
    accounts: [{ provider: "devin", available: false, models: [] }] });
});
test("capabilities accept the renamed name/email account schema", async () => {
  const renamed = { ...wireCapabilities, accounts: [{ id: "synthetic-renamed", name: "claude/a_synthet", email: "synthetic@example.invalid",
    provider: "claude", enabled: true, busy: false, connected: true, runtimeAdmitted: true, available: true, reason: null,
    models: [{ key: "claude/synthetic", label: "Synthetic", observedAtMs: 1 }], qualification: null }] };
  const f = await fixture(`if(process.argv.at(-1)!=="--capabilities" || await Bun.stdin.text()!=="")process.exit(2);console.log(${JSON.stringify(JSON.stringify(renamed))});`);
  expect(await f.client.capabilities(new AbortController().signal)).toMatchObject({ supported: true,
    accounts: [{ id: "synthetic-renamed", label: "claude/a_synthet", provider: "claude", available: true }] });
});
test("capabilities reject accounts without a display identity field", async () => {
  const anonymous = { ...wireCapabilities, accounts: [{ id: "synthetic-anon", provider: "devin", enabled: true, busy: false,
    connected: false, runtimeAdmitted: false, available: false, reason: null, models: [] }] };
  const f = await fixture(`console.log(${JSON.stringify(JSON.stringify(anonymous))});`);
  await expect(f.client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code: "invalid-schema" });
});
test("capabilities distinguish unsafe, changed and unavailable executables before spawn", async () => {
  const f = await fixture("throw Error('must not run');");
  await chmod(f.config.executable, 0o777);
  await expect(f.client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code: "executable-unsafe" });
  await chmod(f.config.executable, 0o700); await writeFile(f.config.executable, "changed");
  await expect(f.client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code: "executable-changed" });
  await rm(f.config.executable);
  await expect(f.client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code: "executable-unavailable" });
});
test("capabilities distinguish spawn, exit, JSON and schema failures without exposing output", async () => {
  const cases = [
    { source: "", interpreter: "/synthetic/nonexistent-xcb-interpreter", code: "not-started" },
    { source: "console.error('SYNTHETIC_PRIVATE_STDERR');process.exit(7);", code: "exit" },
    { source: "process.kill(process.pid,'SIGTERM');", code: "exit" },
    { source: "console.log('SYNTHETIC_PRIVATE_STDOUT');", code: "invalid-json" },
    { source: "process.stdout.write(Buffer.from([255]));", code: "invalid-json" },
    { source: "console.log('{\"version\":1,\"version\":1}');", code: "invalid-json" },
    { source: "console.log(JSON.stringify({secret:'SYNTHETIC_PRIVATE_SCHEMA'}));", code: "invalid-schema" },
  ];
  for (const item of cases) {
    const f = await fixture(item.source, item.interpreter);
    const error = await f.client.capabilities(new AbortController().signal).then(() => null, error => error);
    expect(error).toBeInstanceOf(XcbCapabilitiesError); expect(error.code).toBe(item.code);
    expect(String(error)).not.toContain("SYNTHETIC_PRIVATE"); expect(error.cause).toBeUndefined();
  }
});
test("capabilities retain both output limits and classify the first stop cause", async () => {
  for (const [stream, count] of [["stdout", XCB_LIMITS.response + 1], ["stderr", 65_537]] as const) {
    const f = await fixture(`process.${stream}.write('x'.repeat(${count}));setInterval(()=>{},1000);`);
    await expect(f.client.capabilities(new AbortController().signal)).rejects.toMatchObject({ code: "output-limit" });
  }
});
test("capability discovery has a bounded 90s deadline and late valid output cannot erase timeout", async () => {
  const f = await fixture(`const state=process.argv[process.argv.indexOf('--state')+1];process.on('SIGINT',async()=>{console.log(${JSON.stringify(JSON.stringify(wireCapabilities))});await Bun.write(state+'/joined','joined');process.exit(0)});await Bun.write(state+'/ready','ready');setInterval(()=>{},1000);`);
  let delay: number | undefined, deadline: (() => void) | undefined;
  const client = createXcbClient(f.config, { capabilityTimer: (callback, delayMs) => { delay = delayMs; deadline = callback; return setTimeout(callback, 3000); } });
  const result = client.capabilities(new AbortController().signal).then(() => null, error => error);
  const ready = async () => { try { await access(join(f.config.stateHome, "ready")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  const waitUntil = Date.now() + 2000;
  while (!await ready() && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 10));
  const wasReady = await ready(); deadline?.();
  expect(await result).toMatchObject({ code: "timeout" }); expect(wasReady).toBe(true);
  expect(await Bun.file(join(f.config.stateHome, "joined")).exists()).toBe(true);
  expect(delay).toBe(90_000); expect(XCB_LIMITS.capabilitiesMs + XCB_LIMITS.cleanupMs).toBeLessThan(120_000);
});
test("capability timer and diagnostic errors do not change generation settlement", async () => {
  const f = await fixture(respond), client = createXcbClient(f.config, { capabilityTimer: () => { throw Error("Generation used the capability timer"); } });
  expect((await client.generate(request, new AbortController().signal)).status).toBe("completed");
  await writeFile(f.config.executable, "changed");
  await expect(client.generate(request, new AbortController().signal)).rejects.toBeInstanceOf(XcbNotStarted);
});
