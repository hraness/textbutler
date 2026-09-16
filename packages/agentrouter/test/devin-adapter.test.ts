import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { SqliteAccountLeases } from "../src/accounts.ts";
import { createCapabilityBroker, createCapabilityProfile, type CapabilityTool } from "../src/capabilities.ts";
import { createDevinAcpAdapter } from "../src/devin-adapter.ts";
import { DEVIN_MCP_BRIDGE_SOURCE, startDevinToolRelay } from "../src/devin-mcp.ts";
import type { BoundedProviderProcess, BoundedProviderProcessFactory } from "../src/provider-process.ts";
import { runAgentTask, type AgentTaskRequest } from "../src/task-runtime.ts";

const hash = (char: string) => char.repeat(64);

const documentTool: CapabilityTool = {
  name: "document.read", description: "Read the assigned document.",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  parseInput: input => input, execute: () => ({ body: "retained evidence" }),
};

function relayFixture(tools: CapabilityTool[] = [documentTool]) {
  const profile = createCapabilityProfile({ id: "devin.fixture", version: 1, tools });
  const broker = createCapabilityBroker({ profile, workspaceId: "workspace-one", runId: "run-one", isActive: () => true });
  return { profile, broker };
}

describe("startDevinToolRelay", () => {
  test("serves the exact manifest and invokes broker tools only behind token+path", async () => {
    const { broker } = relayFixture();
    const relay = await startDevinToolRelay({ broker, bridgeExecutable: "/bin/sh" });
    try {
      const env = relay.bridgeEnv();
      const base = env.AGENTROUTER_MCP_RELAY!, token = env.AGENTROUTER_MCP_TOKEN!;
      const manifest = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
      expect(manifest.status).toBe(200);
      expect(await manifest.json()).toEqual({ tools: [{ name: "document.read", description: "Read the assigned document.", inputSchema: documentTool.inputSchema }] });

      const called = await fetch(base, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "document.read", arguments: { value: "doc" } }) });
      expect(called.status).toBe(200);
      expect(await called.json()).toEqual({ output: { body: "retained evidence" } });

      const denied = await fetch(base, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "document.delete", arguments: {} }) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "TOOL_DENIED" });
    } finally { await relay.stop(); }
  });

  test("rejects wrong token, wrong path, wrong method and malformed bodies", async () => {
    const { broker } = relayFixture();
    const relay = await startDevinToolRelay({ broker, bridgeExecutable: "/bin/sh" });
    try {
      const env = relay.bridgeEnv();
      const base = env.AGENTROUTER_MCP_RELAY!, token = env.AGENTROUTER_MCP_TOKEN!;
      const wrongPath = base.replace(/[^/]+$/, "forged");
      for (const response of [
        await fetch(base), // no token
        await fetch(base, { headers: { authorization: "Bearer wrong" } }),
        await fetch(wrongPath, { headers: { authorization: `Bearer ${token}` } }),
        await fetch(base, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }),
        await fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "not json" }),
        await fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: 7 }) }),
      ]) expect(response.status).toBeGreaterThanOrEqual(400);
    } finally { await relay.stop(); }
  });

  test("broker revocation denies subsequent calls", async () => {
    const { broker } = relayFixture();
    const relay = await startDevinToolRelay({ broker, bridgeExecutable: "/bin/sh" });
    try {
      const env = relay.bridgeEnv();
      broker.revoke();
      const response = await fetch(env.AGENTROUTER_MCP_RELAY!, { method: "POST",
        headers: { authorization: `Bearer ${env.AGENTROUTER_MCP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "document.read", arguments: { value: "x" } }) });
      expect(response.status).toBe(403);
    } finally { await relay.stop(); }
  });

  test("the spawned stdio bridge proxies tools/list and tools/call", async () => {
    const { broker } = relayFixture();
    const relay = await startDevinToolRelay({ broker, bridgeExecutable: process.execPath });
    const entry = relay.mcpServerEntry();
    try {
      expect(entry).toMatchObject({ name: "agentrouter", command: process.execPath });
      const env = Object.fromEntries((entry.env as { name: string; value: string }[]).map(pair => [pair.name, pair.value]));
      const bridge = spawn(entry.command as string, [...(entry.args as string[]), ], { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });
      const responses: Record<string, unknown>[] = [];
      let buffer = "";
      bridge.stdout.on("data", chunk => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (line.length > 0) responses.push(JSON.parse(line));
        }
      });
      const send = (message: unknown) => bridge.stdin.write(JSON.stringify(message) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "document.read", arguments: { value: "v" } } });
      send({ jsonrpc: "2.0", id: 4, method: "filesystem/read", params: {} });
      const deadline = Date.now() + 10_000;
      while (responses.length < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      bridge.stdin.end();
      expect(responses).toHaveLength(4);
      const byId = (id: number) => responses.find(message => message.id === id) as any;
      expect(byId(1)).toMatchObject({ result: { serverInfo: { name: "agentrouter" } } });
      expect(byId(2)).toMatchObject({ result: { tools: [{ name: "document.read" }] } });
      expect(JSON.parse(byId(3).result.content[0].text)).toEqual({ body: "retained evidence" });
      expect(byId(4)).toMatchObject({ error: { code: -32601 } });
    } finally { await relay.stop(); }
  });
});

/** A scripted ACP peer that auto-answers the adapter's request sequence. */
function acpPeer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let stopped = false;
  const written: Record<string, any>[] = [];
  let buffer = "";
  const send = (message: unknown) => stdout.write(JSON.stringify(message) + "\n");
  stdin.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      written.push(message);
      if (message.method === "initialize")
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } } } });
      else if (message.method === "session/new")
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "devin_task_session", modes: { currentModeId: "accept-edits" }, configOptions: [] } });
      else if (message.method === "session/set_mode" || message.method === "session/set_config_option")
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      else if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer body" } } } });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } } });
      }
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
    process: process_, isStopped: () => stopped,
    stopAndJoin: async () => { stopped = true; stdout.destroy(); },
  };
  return { handle, written };
}

/** Synthetic-qualified adapter behind the real task runtime; the scripted peer
 * stands in for the provider process — no devin binary is launched. */
function adapterFixture(tools: CapabilityTool[] = []) {
  const peer = acpPeer();
  const profile = createCapabilityProfile({ id: "devin.adapter.fixture", version: 1, tools });
  const broker = createCapabilityBroker({ profile, workspaceId: "workspace-one", runId: "run-one", isActive: () => true });
  const db = new Database(":memory:");
  const leases = new SqliteAccountLeases(db);
  const factory: BoundedProviderProcessFactory = () => peer.handle;
  const route = { id: "devin-subscription", provider: "devin" as const, authentication: "subscription" as const };
  let now = 1_000_000;
  const adapter = createDevinAcpAdapter({
    route, runtime: { version: "synthetic-only", digest: hash("a") },
    qualification: { status: "qualified", route, profile: { id: profile.id, version: profile.version, digest: profile.digest },
      runtimeVersion: "synthetic-only", runtimeDigest: hash("a"), evidenceDigest: hash("b"), expiresAt: now + 3_600_000,
      controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true,
        workspaceWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } },
    executable: "/usr/local/bin/devin", env: { HOME: "/nonexistent", PATH: "/usr/bin" },
    factory, bridgeExecutable: "/bin/sh",
    workspaceCwd: workspaceId => `/workspaces/${workspaceId}`,
    mode: "plan", now: () => now,
  });
  const request: AgentTaskRequest = {
    route, accountId: "account-one", workspaceId: "workspace-one", runId: "run-one",
    profile: { id: profile.id, version: profile.version, digest: profile.digest },
    model: { id: "swe-2-max", reasoningEffort: null, serviceTier: null }, purpose: "research",
    prompt: "Summarize the retained evidence.",
    limits: { maxRunMs: 30_000, maxCleanupMs: 5_000, maxOutputBytes: 4096 },
    signal: new AbortController().signal,
  };
  return { adapter, broker, peer, request, leases, db,
    run: (overrides: Partial<AgentTaskRequest> = {}) =>
      runAgentTask({ adapters: [adapter], leases, now: () => now },
        { ...request, ...overrides }, broker) };
}

describe("createDevinAcpAdapter", () => {
  test("runs one task end-to-end: handshake, session, prompt, join, custody released", async () => {
    const f = adapterFixture();
    try {
      const result = await f.run();
      expect(result.outcome).toEqual({ status: "completed", code: null });
      expect(result.output).toBe("answer body");
      expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
      expect(result.custody).toBe("released");
      expect(result.stop.processStopped).toBe(true);
      expect(result.stop.joined).toBe(true);
      expect(result.stop.proofDigest).toMatch(/^[a-f0-9]{64}$/);
      const methods = f.peer.written.map(message => message.method).filter(Boolean);
      expect(methods).toEqual(["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]);
      const configCall = f.peer.written.find(message => message.method === "session/set_config_option");
      expect(configCall!.params).toMatchObject({ configId: "model", value: "swe-2-max" });
      const newSession = f.peer.written.find(message => message.method === "session/new");
      expect(newSession!.params.mcpServers).toEqual([]);
    } finally { f.db.close(); }
  });

  test("a tool profile publishes exactly one stdio MCP bridge entry", async () => {
    const f = adapterFixture([documentTool]);
    try {
      const result = await f.run();
      expect(result.outcome.status).toBe("completed");
      const newSession = f.peer.written.find(message => message.method === "session/new");
      const servers = newSession!.params.mcpServers as Record<string, unknown>[];
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ name: "agentrouter", command: "/bin/sh" });
      expect(servers[0]!.args).toEqual(["-e", DEVIN_MCP_BRIDGE_SOURCE]);
    } finally { f.db.close(); }
  });
});
