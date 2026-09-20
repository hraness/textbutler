import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXcbClient, parseXcbJson, XcbNotStarted, type XcbGenerateRequest } from "./xcb-client.ts";
import type { XcbHostConfig } from "./host-config.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(code: string) {
  const root = await mkdtemp(join(tmpdir(), "textbutler-xcb-client-")); roots.push(root);
  const executable = join(root, "xcb-fixture");
  const bytes = `#!${process.execPath}\n${code}\n`;
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
