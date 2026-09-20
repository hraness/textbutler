import { expect, test } from "bun:test";
import { buildNativeClaudePlan, parseNativeClaudeStream, CLAUDE_NATIVE_BUILD, CLAUDE_NATIVE_LIMITS,
  CLAUDE_NATIVE_SYSTEM_PROMPT, type NativeClaudeExpected } from "./native-claude.ts";

const MODEL = "claude-opus-5", CWD = "/private/synthetic/workspace";
const RUNTIME = { executable: "/private/synthetic/claude", version: CLAUDE_NATIVE_BUILD.version, sha256: CLAUDE_NATIVE_BUILD.sha256 };
const AUTH = { home: "/private/synthetic/account", configDir: "/private/synthetic/account/.claude", tmpdir: "/private/synthetic/scratch" };
const plan = (changes: Record<string, unknown> = {}) =>
  buildNativeClaudePlan({ runtime: { ...RUNTIME }, model: MODEL, cwd: CWD, auth: { ...AUTH }, prompt: "Synthetic task", ...changes });
const binding: NativeClaudeExpected = { version: CLAUDE_NATIVE_BUILD.version, sha256: CLAUDE_NATIVE_BUILD.sha256, model: MODEL, cwd: CWD };

const SESSION = "1d0f9b6a-3c41-4f8e-b2a7-5c6d7e8f9a0b";
const identifiers = ["2e1a0c7b-4d52-4a9f-8b3c-6d7e8f9a0b1c", "3f2b1d8c-5e63-4baf-9c4d-7e8f9a0b1c2d", "4a3c2e9d-6f74-4cbf-ad5e-8f9a0b1c2d3e"];
const usage = { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" };
const FINAL = '{"kind":"final","output":"Synthetic reply"}';
function stream(changes: Readonly<{ init?: object; assistant?: object; result?: object; text?: string }> = {}): string {
  const text = changes.text ?? FINAL;
  const init = { type: "system", subtype: "init", uuid: identifiers[0], session_id: SESSION, cwd: CWD, model: MODEL,
    claude_code_version: CLAUDE_NATIVE_BUILD.version, permissionMode: "dontAsk", apiKeySource: "none", tools: [], mcp_servers: [],
    slash_commands: [], skills: [], plugins: [], output_style: "default", ...changes.init };
  const assistant = { type: "assistant", uuid: identifiers[1], session_id: SESSION, parent_tool_use_id: null,
    message: { id: "msg_synthetic", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null, usage }, ...changes.assistant };
  const result = { type: "result", subtype: "success", uuid: identifiers[2], session_id: SESSION, duration_ms: 120,
    duration_api_ms: 100, is_error: false, num_turns: 1, result: text, stop_reason: "end_turn", total_cost_usd: 0,
    usage, permission_denials: [], modelUsage: { [MODEL]: { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 8192 } }, ...changes.result };
  return [init, assistant, result].map(frame => JSON.stringify(frame)).join("\n") + "\n";
}

test("the plan pins the verified build and never inherits ambient configuration", () => {
  const built = plan();
  expect(built.expected).toEqual(binding);
  expect(built.env).toEqual({ HOME: AUTH.home, TMPDIR: AUTH.tmpdir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
    DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: AUTH.configDir });
  expect(built.environmentContract.inheritAmbient).toBe(false);
  expect(built.stdin).toBe("Synthetic task");
  for (const argument of ["--safe-mode", "--restricted", "--disallowedTools", "*", "--strict-mcp-config", "--permission-mode",
    "dontAsk", "--no-session-persistence", "--disable-slash-commands", "--no-chrome"]) expect(built.args).toContain(argument);
  expect(built.args).toContain(CLAUDE_NATIVE_SYSTEM_PROMPT);
  expect(built.args).not.toContain("--bare");
  expect(built.args[built.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
});
test("the plan rejects an unverified build, model, path or extra option", () => {
  for (const changes of [{ runtime: { ...RUNTIME, version: "2.1.273" } }, { runtime: { ...RUNTIME, sha256: "f".repeat(64) } },
    { runtime: { ...RUNTIME, executable: "claude" } }, { model: "gpt-6-astra" }, { model: "claude-opus-5; rm -rf /" },
    { cwd: "relative/workspace" }, { auth: { ...AUTH, home: "/private/synthetic/account/../account" } },
    { auth: { ...AUTH, extra: "/private/synthetic" } }, { extra: "ignored" }]) expect(() => plan(changes)).toThrow();
});
test("prompt bytes are bounded before a process is described", () => {
  expect(plan({ prompt: "x".repeat(CLAUDE_NATIVE_LIMITS.promptBytes) }).stdin).toHaveLength(CLAUDE_NATIVE_LIMITS.promptBytes);
  for (const prompt of ["", "x".repeat(CLAUDE_NATIVE_LIMITS.promptBytes + 1), "task\u0000"]) expect(() => plan({ prompt })).toThrow();
});

test("a complete subscription stream yields one validated proposal", () => {
  const parsed = parseNativeClaudeStream(stream(), binding, 0);
  expect(parsed).toEqual({ sessionId: SESSION, model: MODEL, value: { kind: "final", output: "Synthetic reply" } });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(parseNativeClaudeStream(new TextEncoder().encode(stream()), binding, 0).value).toEqual(parsed.value);
});
test("a non-zero exit, foreign binding or oversized stream is never a result", () => {
  expect(() => parseNativeClaudeStream(stream(), binding, 1)).toThrow();
  expect(() => parseNativeClaudeStream(stream(), { ...binding, model: "claude-sonnet-5" }, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream(), { ...binding, cwd: "/private/other" }, 0)).toThrow();
  expect(() => parseNativeClaudeStream("x".repeat(CLAUDE_NATIVE_LIMITS.streamBytes + 1), binding, 0)).toThrow();
});
test("an API key, inherited tooling or changed build fails the whole stream", () => {
  for (const init of [{ apiKeySource: "ANTHROPIC_API_KEY" }, { permissionMode: "acceptEdits" }, { tools: ["Bash"] },
    { mcp_servers: [{ name: "synthetic" }] }, { skills: ["synthetic"] }, { plugins: ["synthetic"] }, { agents: ["synthetic"] },
    { claude_code_version: "2.1.273" }, { output_style: "Explanatory" }, { fast_mode_state: "on" },
    { extra_field: true }]) expect(() => parseNativeClaudeStream(stream({ init }), binding, 0)).toThrow();
});
test("a tool call, foreign model or unreconciled result text is rejected", () => {
  for (const assistant of [{ message: { id: "msg_synthetic", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "tool_use", name: "Bash", input: {} }], stop_reason: "tool_use", stop_sequence: null, usage } },
    { parent_tool_use_id: "toolu_synthetic" }]) expect(() => parseNativeClaudeStream(stream({ assistant }), binding, 0)).toThrow();
  for (const result of [{ is_error: true }, { subtype: "error_during_execution" }, { num_turns: 2 },
    { result: '{"kind":"final","output":"Swapped"}' }, { permission_denials: [{ tool_name: "Bash" }] },
    { modelUsage: { [MODEL]: { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 1, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 8192 } } },
    { duration_ms: -1 }]) expect(() => parseNativeClaudeStream(stream({ result }), binding, 0)).toThrow();
});
test("replayed frames, mixed sessions and duplicate JSON keys never reach the host", () => {
  expect(() => parseNativeClaudeStream(stream() + stream().split("\n")[2] + "\n", binding, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream({ assistant: { uuid: identifiers[0] } }), binding, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream({ assistant: { session_id: identifiers[2] } }), binding, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream({ text: '{"kind":"final","kind":"tool"}' }), binding, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream({ text: '"a bare string"' }), binding, 0)).toThrow();
  expect(() => parseNativeClaudeStream(stream().split("\n").slice(0, 2).join("\n"), binding, 0)).toThrow();
});
