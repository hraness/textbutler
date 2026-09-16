import { randomBytes } from "node:crypto";
import { createLoopbackServer, type LoopbackServer } from "./loopback-server.ts";
import type { CapabilityBroker, CapabilityProfile } from "./capabilities.ts";
import { boundedText } from "./validation.ts";

/**
 * Host-side tool relay for the Devin ACP adapter. Devin's MCP support is
 * stdio-only (the agent advertises `mcpCapabilities: {http:false, sse:false}`),
 * so profile tools reach the agent through a spawned bridge process that
 * proxies this closed loopback surface:
 *
 *   GET  {base}  -> { tools: [{name,description,inputSchema}] }
 *   POST {base}  -> { name, arguments } => { output } | { error }
 *
 * The random path plus bearer token are the relay's whole admission surface;
 * the broker still applies the profile, input and capability limits.
 */

const MAX_BODY = 256 * 1024;
const MAX_MANIFEST = 256 * 1024;

export type DevinToolRelay = Readonly<{
  /** Closed loopback origin carrying the relay token; only the bridge sees it. */
  bridgeEnv(): Readonly<Record<string, string>>;
  mcpServerEntry(): Readonly<Record<string, unknown>>;
  stop(): Promise<void>;
}>;

export type DevinToolRelayOptions = Readonly<{
  broker: CapabilityBroker;
  /** Runtime executable that runs DEVIN_MCP_BRIDGE_SOURCE, e.g. an exact
   * host-pinned `bun`/`node` path. Required when the profile has tools. */
  bridgeExecutable: string;
  signal?: AbortSignal;
}>;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const failure = (status: number): Response => jsonResponse({ error: "RELAY_DENIED" }, status);

function manifest(profile: CapabilityProfile): unknown {
  return { tools: profile.tools.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: tool.inputSchema })) };
}

export function startDevinToolRelay(options: DevinToolRelayOptions): Promise<DevinToolRelay> {
  const { broker } = options;
  const executable = boundedText(options.bridgeExecutable, 1024);
  if (!executable.startsWith("/") || executable.includes("\0") || executable.includes(".."))
    throw new Error("DEVIN_BRIDGE_EXECUTABLE_INVALID");
  const token = randomBytes(24).toString("hex");
  const path = `/devin-mcp/${randomBytes(24).toString("hex")}`;
  const manifestBody = JSON.stringify(manifest(broker.profile));
  if (Buffer.byteLength(manifestBody) > MAX_MANIFEST) throw new Error("DEVIN_TOOL_MANIFEST_BOUND");
  return createLoopbackServer({
    hostname: "127.0.0.1", idleTimeoutMs: 30_000, maxRequestBodyBytes: MAX_BODY,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== path || request.headers.get("authorization") !== `Bearer ${token}`) return failure(404);
      if (request.method === "GET") return new Response(manifestBody, { headers: { "content-type": "application/json" } });
      if (request.method !== "POST") return failure(405);
      let body: unknown;
      try { body = await request.json(); }
      catch { return failure(400); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return failure(400);
      const call = body as Record<string, unknown>;
      if (typeof call.name !== "string" || !Object.hasOwn(call, "arguments")) return failure(400);
      try {
        const output = await broker.invoke(call.name, call.arguments);
        return jsonResponse({ output });
      } catch {
        return jsonResponse({ error: "TOOL_DENIED" }, 403);
      }
    },
    error: () => failure(500),
  }).then((server: LoopbackServer) => Object.freeze({
    bridgeEnv(): Readonly<Record<string, string>> {
      return Object.freeze({
        AGENTROUTER_MCP_RELAY: `http://127.0.0.1:${server.port}${path}`,
        AGENTROUTER_MCP_TOKEN: token,
      });
    },
    /** Stdio MCP server entry for ACP session/new. The bridge executable and
     * its inline source are host-pinned artifacts; env carries only the relay
     * origin and its capability token. */
    mcpServerEntry(): Readonly<Record<string, unknown>> {
      const env = this.bridgeEnv();
      return Object.freeze({
        name: "agentrouter",
        command: executable,
        args: ["-e", DEVIN_MCP_BRIDGE_SOURCE],
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
      });
    },
    stop: () => server.stop(),
  }));
}

/** Self-contained MCP-over-stdio server that proxies `tools/list`/`tools/call`
 * to the host relay. Spawned as `executable -e <this source>` by the Devin ACP
 * agent; uses only the runtime's own stdio/fetch surface. */
export const DEVIN_MCP_BRIDGE_SOURCE: string = `
const relay = process.env.AGENTROUTER_MCP_RELAY;
const token = process.env.AGENTROUTER_MCP_TOKEN;
const bound = 262144;
let input = Buffer.alloc(0);
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
async function fetchRelay(body) {
  const response = await fetch(relay, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (text.length > bound) throw new Error("relay response exceeded bound");
  return JSON.parse(text);
}
async function handle(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return;
  const id = message.id;
  if (id === undefined || id === null) return;
  const method = message.method;
  if (method === "initialize") {
    result(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "agentrouter", version: "1" } });
    return;
  }
  if (method === "ping") { result(id, {}); return; }
  if (method === "tools/list") {
    try { const manifest = await fetchRelay(); result(id, { tools: manifest.tools }); }
    catch { fail(id, -32603, "manifest unavailable"); }
    return;
  }
  if (method === "tools/call") {
    const params = message.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)
      || typeof params.name !== "string") { fail(id, -32602, "invalid params"); return; }
    try {
      const response = await fetchRelay({ name: params.name, arguments: params.arguments ?? {} });
      if (response.error) { result(id, { content: [{ type: "text", text: "TOOL_DENIED" }], isError: true }); return; }
      result(id, { content: [{ type: "text", text: JSON.stringify(response.output) }], isError: false });
    } catch { fail(id, -32603, "relay call failed"); }
    return;
  }
  fail(id, -32601, "unsupported method");
}
if (!relay || !token) process.exit(2);
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.byteLength > bound) process.exit(2);
  let index;
  while ((index = input.indexOf(10)) >= 0) {
    const line = input.subarray(0, index);
    input = input.subarray(index + 1);
    if (line.byteLength === 0) continue;
    let message;
    try { message = JSON.parse(line.toString("utf8")); } catch { continue; }
    handle(message).catch(() => {});
  }
});
process.stdin.on("end", () => process.exit(0));
`;
