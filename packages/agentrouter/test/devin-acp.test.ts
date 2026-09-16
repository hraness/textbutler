import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  denyPermissionOutcome, devinAcpFraming, DEVIN_ACP_MAX_FRAME_BYTES,
  parseAcpInbound, parsePermissionRequest, parseSessionUpdate, validatePermissionOutcome,
} from "../src/devin-acp.ts";
import { DevinAcpClient } from "../src/devin-client.ts";
import type { BoundedProviderProcess } from "../src/provider-process.ts";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));

describe("devinAcpFraming", () => {
  const collect = async (input: string | Buffer): Promise<string[]> => {
    const framed = devinAcpFraming();
    const chunks: string[] = [];
    framed.on("data", chunk => chunks.push(chunk.toString("utf8")));
    const done = new Promise<void>((resolve, reject) => { framed.on("end", resolve); framed.on("error", reject); });
    framed.end(input);
    await done;
    return chunks;
  };

  test("emits each complete line and validates the trailing partial line", async () => {
    const frames = await collect('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"n"}\n{"jsonrpc":"2.0","method":"tail"}');
    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[2]!).method).toBe("tail");
  });

  test("rejects an over-bound frame, non-JSON, non-object and non-UTF8 input", async () => {
    await expect(collect(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(DEVIN_ACP_MAX_FRAME_BYTES)}"}\n`)).rejects.toThrow("FRAME_LIMIT");
    await expect(collect("not json\n")).rejects.toThrow("FRAME_JSON");
    await expect(collect("[1,2]\n")).rejects.toThrow("FRAME_SHAPE");
    await expect(collect(Buffer.from([0xff, 0xfe, 0x0a]))).rejects.toThrow();
  });
});

describe("parseAcpInbound", () => {
  test("accepts responses, requests and notifications; rejects malformed envelopes", () => {
    expect(parseAcpInbound({ jsonrpc: "2.0", id: 3, result: { ok: true } })).toMatchObject({ kind: "response", id: 3 });
    expect(parseAcpInbound({ jsonrpc: "2.0", id: "x", error: { code: -1, message: "no" } })).toMatchObject({ kind: "errorResponse" });
    expect(parseAcpInbound({ jsonrpc: "2.0", method: "session/update", params: {} })).toMatchObject({ kind: "notification" });
    expect(parseAcpInbound({ jsonrpc: "2.0", id: 9, method: "fs/read", params: {} })).toMatchObject({ kind: "request", id: 9 });
    for (const bad of [
      [{ jsonrpc: "2.0", id: 1, result: {} }],
      { id: 1, result: {} },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: null, method: "x" },
      { jsonrpc: "2.0", id: 1, method: "x", result: {} },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } },
    ]) expect(() => parseAcpInbound(bad)).toThrow("DEVIN_ACP_");
  });
});

describe("session/update facts", () => {
  test("maps text chunks and usage; other updates become protocol notices", () => {
    expect(parseSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }))
      .toEqual([{ type: "assistantDelta", sessionId: "s1", text: "hi" }]);
    expect(parseSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "usage_update", used: 10, size: 100, inputTokens: 4, outputTokens: 6 } }))
      .toEqual([{ type: "usageUpdated", sessionId: "s1", used: 10, size: 100, inputTokens: 4, outputTokens: 6 }]);
    expect(parseSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "t" } }))
      .toEqual([{ type: "protocolNotice", sessionId: "s1", method: "session/update:tool_call" }]);
    expect(() => parseSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "usage_update", used: -1, size: 1 } })).toThrow();
  });
});

describe("permission requests", () => {
  const params = { sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "run", kind: "execute", status: "pending" },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ] };
  test("parses the request and validates outcomes against offered options", () => {
    const request = parsePermissionRequest(7, params);
    expect(request.requestId).toBe("n:7");
    expect(request.sessionId).toBe("s1");
    expect(validatePermissionOutcome({ outcome: "selected", optionId: "allow" }, request.options))
      .toEqual({ outcome: "selected", optionId: "allow" });
    expect(() => validatePermissionOutcome({ outcome: "selected", optionId: "forged" }, request.options)).toThrow("PERMISSION_OPTION_UNKNOWN");
    expect(denyPermissionOutcome(request.options)).toEqual({ outcome: "selected", optionId: "deny" });
    expect(denyPermissionOutcome([])).toEqual({ outcome: "cancelled" });
    expect(() => parsePermissionRequest(7, { ...params, options: [...params.options, params.options[0]!] })).toThrow("PERMISSION_OPTIONS");
  });
});

/** Scripted ACP peer over the real client/codec; no provider process is launched. */
function peer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let stopped = false, joined = false, joinFails = false;
  const written: Record<string, unknown>[] = [];
  let buffer = "";
  stdin.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.length > 0) written.push(JSON.parse(line));
    }
  });
  const process_ = {
    stdin, stdout,
    get killed() { return stopped; }, exitCode: null, signalCode: null,
    kill: () => { stopped = true; events.emit("exit", 0); return true; },
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => events.once(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => events.off(event, listener),
  } as unknown as SpawnedProcess;
  const handle: BoundedProviderProcess = {
    process: process_,
    isStopped: () => stopped,
    stopAndJoin: async () => { if (joinFails) throw new Error("JOIN_REFUSED"); stopped = true; joined = true; stdout.destroy(); },
  };
  const respond = (id: string | number, result: unknown) => stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const failResponse = (id: string | number, code = -32000, message = "denied") =>
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  const request = (id: string | number, method: string, params: unknown) =>
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const notify = (method: string, params: unknown) => stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const lastWritten = () => written.at(-1);
  const raw = (bytes: string) => stdout.write(bytes);
  return { handle, written, respond, failResponse, request, notify, lastWritten, raw,
    isStopped: () => stopped, isJoined: () => joined, exitNow: () => { stopped = true; events.emit("exit", 0); },
    setJoinFails: (value: boolean) => { joinFails = value; }, destroyStdout: () => stdout.destroy() };
}

const INITIALIZE = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
const SESSION = { sessionId: "devin_s1", modes: { currentModeId: "plan" }, configOptions: [] };

async function established() {
  const p = peer();
  const client = new DevinAcpClient({ process: p.handle });
  const init = client.initialize();
  await tick();
  p.respond(p.lastWritten()!.id as number, INITIALIZE);
  expect((await init).loadSession).toBe(true);
  const created = client.newSession({ cwd: "/workspace" });
  await tick();
  p.respond(p.lastWritten()!.id as number, SESSION);
  await created;
  return { p, client };
}

describe("DevinAcpClient", () => {
  test("initialize, session/new and prompt correlate ids and reduce facts", async () => {
    const p = peer();
    const facts: string[] = [];
    const client = new DevinAcpClient({ process: p.handle, onFact: f => facts.push(f.type) });
    const init = client.initialize();
    await tick();
    expect(p.lastWritten()).toMatchObject({ method: "initialize" });
    p.respond(p.lastWritten()!.id as number, INITIALIZE);
    await init;

    const created = client.newSession({ cwd: "/workspace" });
    await tick();
    expect(p.lastWritten()).toMatchObject({ method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
    p.respond(p.lastWritten()!.id as number, SESSION);
    expect((await created).sessionId).toBe("devin_s1");

    const prompted = client.prompt("devin_s1", "summarize");
    await tick();
    expect(p.lastWritten()).toMatchObject({ method: "session/prompt",
      params: { sessionId: "devin_s1", prompt: [{ type: "text", text: "summarize" }] } });
    p.notify("session/update", { sessionId: "devin_s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } });
    await expect(client.prompt("devin_s1", "again")).rejects.toThrow("PROMPT_ACTIVE");
    p.respond(p.lastWritten()!.id as number, { stopReason: "end_turn", usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5 } });
    expect(await prompted).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 9 } });
    expect(facts).toContain("assistantDelta");
    await client.close();
    expect(p.isJoined()).toBe(true);
  });

  test("refuses unknown sessions and unauthenticated lifecycle order", async () => {
    const { client } = await established();
    await expect(client.prompt("forged-session", "x")).rejects.toThrow("SESSION_UNKNOWN");
    await expect(client.setMode("forged-session", "plan")).rejects.toThrow("SESSION_UNKNOWN");
    const p2 = peer();
    const fresh = new DevinAcpClient({ process: p2.handle });
    await expect(fresh.newSession({ cwd: "/workspace" })).rejects.toThrow("NOT_INITIALIZED");
    await fresh.close();
  });

  test("process exit mid-request rejects the pending call and poisons the client", async () => {
    const { p, client } = await established();
    const pending = client.prompt("devin_s1", "work");
    await tick();
    p.exitNow();
    await expect(pending).rejects.toThrow("DEVIN_ACP_PROCESS_EXITED");
    await expect(client.prompt("devin_s1", "more")).rejects.toThrow("DEVIN_ACP_PROCESS_EXITED");
    await client.close();
  });

  test("a malformed frame fails the client closed", async () => {
    const { p, client } = await established();
    const pending = client.prompt("devin_s1", "work");
    await tick();
    p.raw("[1,2,3]\n");
    await expect(pending).rejects.toThrow("DEVIN_ACP_");
    await client.close();
  });

  test("permission requests route to the host callback and write the selected option", async () => {
    const p = peer();
    const seen: string[] = [];
    const client = new DevinAcpClient({ process: p.handle,
      onPermission: request => { seen.push(request.sessionId); return { outcome: "selected", optionId: "allow" }; } });
    const init = client.initialize(); await tick();
    p.respond(p.lastWritten()!.id as number, INITIALIZE); await init;
    const created = client.newSession({ cwd: "/w" }); await tick();
    p.respond(p.lastWritten()!.id as number, SESSION); await created;
    p.request("perm-1", "session/request_permission", { sessionId: "devin_s1",
      toolCall: { toolCallId: "t1", title: "read", kind: "read", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ] });
    await tick(); await tick();
    expect(seen).toEqual(["devin_s1"]);
    expect(p.lastWritten()).toMatchObject({ id: "perm-1", result: { outcome: { outcome: "selected", optionId: "allow" } } });
    await client.close();
  });

  test("without a permission callback the first reject option wins", async () => {
    const { p, client } = await established();
    p.request(55, "session/request_permission", { sessionId: "devin_s1",
      toolCall: { toolCallId: "t9", title: null, kind: null, status: null },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ] });
    await tick(); await tick();
    expect(p.lastWritten()).toMatchObject({ id: 55, result: { outcome: { outcome: "selected", optionId: "deny" } } });
    await client.close();
  });

  test("cancel answers open permission gates then notifies the session", async () => {
    const p = peer();
    const client = new DevinAcpClient({ process: p.handle,
      onPermission: () => new Promise(() => undefined) }); // gate stays open until cancel
    const init = client.initialize(); await tick();
    p.respond(p.lastWritten()!.id as number, INITIALIZE); await init;
    const created = client.newSession({ cwd: "/w" }); await tick();
    p.respond(p.lastWritten()!.id as number, SESSION); await created;
    p.request(77, "session/request_permission", { sessionId: "devin_s1",
      toolCall: { toolCallId: "t1", title: null, kind: null, status: null },
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] });
    await tick();
    await client.cancel("devin_s1");
    const cancel = p.written.find(message => message.method === "session/cancel");
    expect(cancel).toMatchObject({ params: { sessionId: "devin_s1" } });
    expect(p.written.some(message => message.id === 77 && (message.result as any)?.outcome?.outcome === "cancelled")).toBe(true);
    await client.close();
  });

  test("close proves process custody; unproven join fails close", async () => {
    const { p, client } = await established();
    p.setJoinFails(true);
    await expect(client.close()).rejects.toThrow("PROCESS_JOIN_UNPROVEN");
    await expect(client.prompt("devin_s1", "x")).rejects.toThrow();
  });

  test("provider error responses reject with the mapped error", async () => {
    const { p, client } = await established();
    const pending = client.prompt("devin_s1", "work");
    await tick();
    p.failResponse(p.lastWritten()!.id as number, -32602, "bad params");
    await expect(pending).rejects.toThrow("DEVIN_ACP_PROVIDER_ERROR");
    await client.close();
  });
});
