import { expect, test } from "bun:test";
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import { Database } from "bun:sqlite";
import { SqliteAccountLeases } from "../src/accounts.ts";
import { createCapabilityBroker, type CapabilityBroker } from "../src/capabilities.ts";
import { createEnvironmentClaudeApiKeyResolver } from "../src/claude-credentials.ts";
import type { ClaudeApiClient } from "../src/claude-api-transport.ts";
import type { ModelCatalog } from "../src/models.ts";
import { runAgentTask, type AgentTaskRequest, type AgentTaskResult, type TaskRuntimeQualification } from "../src/task-runtime.ts";
import { buildEditorPrompt, callsToEdits, createEditorCapabilityProfile, createEditorTaskAdapter,
  DEFAULT_STUB, EDITOR_PROFILE_ID, parseEditorTranscript,
  type EditorCall, type EditorTranscript, type EditorTranscriptItem } from "../src/gobstopper-editor.ts";

const hash = (char: string) => char.repeat(64);
const item = (line_index: number, kind: string, est_tokens: number, elidable_bytes: number | null, label = `item-${line_index}`) =>
  ({ line_index, kind, est_tokens, elidable_bytes, label });
const payload = (items: unknown[], context = 0) => JSON.stringify({
  session_id: "session-one", provider: "codex",
  items,
  usage: { context_tokens: context, lifetime_input_tokens: 0, lifetime_cached_tokens: 0, model_context_window: null },
});
const transcript = (items: EditorTranscriptItem[], contextTokens = 0): EditorTranscript =>
  Object.freeze({ sessionId: "session-one", provider: "codex", items: Object.freeze(items),
    contextTokens: contextTokens || items.reduce((sum, entry) => sum + entry.estTokens, 0) });
const editorItem = (lineIndex: number, kind: string, estTokens: number, elidableBytes: number | null, label?: string): EditorTranscriptItem =>
  Object.freeze({ lineIndex, kind, estTokens, elidableBytes, label: label ?? `item-${lineIndex}` });

test("transcript parsing accepts the gobstopper preset payload and tolerates extra keys", () => {
  const parsed = parseEditorTranscript(JSON.parse(payload([
    item(0, "system", 300, null, "preamble"),
    item(3, "tool_result", 5000, 4800, "bash: make test"),
    item(4, "assistant", 120, null, "done"),
  ], 5420)));
  expect(parsed.sessionId).toBe("session-one");
  expect(parsed.items).toHaveLength(3);
  expect(parsed.items[1]).toMatchObject({ lineIndex: 3, kind: "tool_result", estTokens: 5000, elidableBytes: 4800 });
  expect(parsed.contextTokens).toBe(5420);
  const withExtra = JSON.parse(payload([item(0, "user", 10, null)]));
  withExtra.future_field = { nested: true };
  expect(parseEditorTranscript(withExtra).items).toHaveLength(1);
  // Missing usage.context_tokens falls back to the item estimate sum.
  const noUsage = JSON.parse(payload([item(0, "user", 10, null), item(1, "assistant", 20, null)]));
  noUsage.usage.context_tokens = 0;
  expect(parseEditorTranscript(noUsage).contextTokens).toBe(30);
});

test("transcript parsing rejects malformed payloads and unbounded fields", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { delete value.items; },
    (value: Record<string, unknown>) => { value.provider = "other"; },
    (value: Record<string, unknown>) => { value.items = { length: 1 }; },
    (value: Record<string, unknown>) => { (value.items as Record<string, unknown>[])[0]!.kind = "invented"; },
    (value: Record<string, unknown>) => { (value.items as Record<string, unknown>[])[0]!.est_tokens = -1; },
    (value: Record<string, unknown>) => { (value.items as Record<string, unknown>[])[0]!.label = "x".repeat(600); },
    (value: Record<string, unknown>) => { (value.items as Record<string, unknown>[])[0]!.line_index = 1.5; },
  ]) {
    const value = JSON.parse(payload([item(0, "user", 10, null)]));
    mutate(value);
    expect(() => parseEditorTranscript(value)).toThrow();
  }
  expect(() => parseEditorTranscript(JSON.parse(payload(new Array(4097).fill(item(0, "user", 1, null)))))).toThrow();
});

test("calls lower to gobstopper edits: elide maps positions to line_indexes, summarize injects a digest", () => {
  const t = transcript([
    editorItem(0, "system", 300, null),
    editorItem(5, "tool_result", 4000, 3900),
    editorItem(9, "tool_result", 3000, 2900),
    editorItem(12, "assistant", 200, null),
    editorItem(17, "tool_result", 2500, 2400),
    editorItem(21, "assistant", 150, null),
  ]);
  const calls: EditorCall[] = [
    { tool: "keep", fromItem: 4, toItem: 5 },
    { tool: "elide", items: [1, 2, 0, 5] }, // 0 not elidable; 5 inside protected tail
    { tool: "summarize", fromItem: 0, toItem: 3, digest: "resolved setup thread" },
    { tool: "summarize", fromItem: 3, toItem: 5, digest: "reaches into tail" },
  ];
  const plan = callsToEdits(t, calls, 2);
  expect(plan.deferred).toBeNull();
  expect(plan.edits).toEqual([
    { op: "elide", line_indexes: [5, 9], stub_template: DEFAULT_STUB },
    { op: "inject_digest", digest: { goal: "resolved setup thread", decisions: [], files_touched: [], open_tasks: [], covers_items: 3 } },
  ]);
  expect(plan.contextTokensAfter).toBe(t.contextTokens - 7000);
});

test("any defer discards the whole plan; out-of-range and reversed calls are ignored", () => {
  const t = transcript([editorItem(0, "tool_result", 100, 90), editorItem(4, "user", 10, null)]);
  const defer = callsToEdits(t, [
    { tool: "elide", items: [0] },
    { tool: "defer", reason: "derivation in progress" },
  ], 0);
  expect(defer.edits).toEqual([]);
  expect(defer.deferred).toBe("derivation in progress");
  const dropped = callsToEdits(t, [
    { tool: "elide", items: [] },
    { tool: "summarize", fromItem: 1, toItem: 1, digest: "empty" },
    { tool: "summarize", fromItem: 0, toItem: 2, digest: "past end" },
  ], 0);
  expect(dropped.edits).toEqual([]);
});

test("capability profile exposes exactly the EditorCall tool surface", () => {
  const calls: EditorCall[] = [];
  const profile = createEditorCapabilityProfile({ itemCount: 4, calls });
  expect(profile.id).toBe(EDITOR_PROFILE_ID);
  expect(profile.tools.map(tool => tool.name)).toEqual(["keep", "elide", "summarize", "defer"]);
  for (const tool of profile.tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
});

const key = ["sk", "ant", "api03", "synthetic", "fixture", "credential"].join("-");
const catalog: ModelCatalog = { provider: "claude", observedAt: 1_000_000, models: [{ id: "synthetic-model", available: true,
  supportsStructuredOutput: true, classifierEligible: true, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }] };
const toolCall = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (value: string) => ({ type: "text", text: value });
const response = (content: unknown[], stop = "end_turn") => ({ id: "msg_fixture", type: "message", role: "assistant",
  model: "synthetic-model", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } });

async function fixture(itemCount: number, responses: unknown[]) {
  const db = new Database(":memory:");
  const leases = new SqliteAccountLeases(db);
  const calls: EditorCall[] = [];
  const profile = createEditorCapabilityProfile({ itemCount, calls });
  const identity = { id: profile.id, version: profile.version, digest: profile.digest };
  const route = { id: "claude-api", provider: "claude" as const, authentication: "api" as const };
  const qualification: TaskRuntimeQualification = { status: "qualified", route, profile: identity,
    runtimeVersion: "synthetic-editor", runtimeDigest: hash("a"), evidenceDigest: hash("b"), expiresAt: 1_100_000,
    controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
      isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } };
  let index = 0;
  const seen: unknown[] = [];
  const client = { messages: { create: async (value: MessageCreateParams) => { seen.push(structuredClone(value)); return responses[index++]; } } };
  const adapter = createEditorTaskAdapter({ route, runtime: { version: "synthetic-editor", digest: hash("a") }, qualification,
    credentials: createEnvironmentClaudeApiKeyResolver({ "editor-primary": "SYNTHETIC_KEY" }, () => key),
    modelCatalog: async () => catalog, instructions: { system: "synthetic system" }, now: () => 1_000_000,
    clientFor: () => client as unknown as ClaudeApiClient });
  const controller = new AbortController();
  const broker: CapabilityBroker = createCapabilityBroker({ profile, workspaceId: "workspace-one", runId: "run-one",
    isActive: () => true, signal: controller.signal });
  const request: AgentTaskRequest = { route, accountId: "editor-primary", workspaceId: "workspace-one", runId: "run-one",
    profile: identity, model: { id: "synthetic-model", reasoningEffort: null, serviceTier: null },
    purpose: "gobstopper-context-edit", prompt: "Synthetic transcript table",
    limits: { maxRunMs: 10_000, maxCleanupMs: 1_000, maxOutputBytes: 8 * 1024 }, signal: controller.signal };
  const run = async (): Promise<AgentTaskResult> => await runAgentTask({ adapters: [adapter], leases, now: () => 1_000_000 }, request, broker);
  return { db, calls, run, seen };
}

test("runAgentTask drives broker-recorded editor calls through a completed run", async () => {
  const f = await fixture(8, [
    response([toolCall("t1", "elide", { items: [1, 2] }), toolCall("t2", "summarize", { from_item: 0, to_item: 2, digest: "setup" })], "tool_use"),
    response([text("2 edits recorded")]),
  ]);
  try {
    const result = await f.run();
    expect(result.outcome.status).toBe("completed");
    expect(result.output).toBe("2 edits recorded");
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 6, totalTokens: 20, costUsd: null });
    expect(result.custody).toBe("released");
    expect(f.calls).toEqual([
      { tool: "elide", items: [1, 2] },
      { tool: "summarize", fromItem: 0, toItem: 2, digest: "setup" },
    ]);
    const params = f.seen[0] as MessageCreateParams;
    expect((params.tools ?? []).map(tool => (tool as { name?: string }).name)).toEqual(["keep", "elide", "summarize", "defer"]);
  } finally { f.db.close(); }
});

test("invalid tool inputs are denied to the model and never recorded", async () => {
  const f = await fixture(4, [
    response([toolCall("t1", "elide", { items: [99] }), toolCall("t2", "shell", { command: "rm -rf /" }),
      toolCall("t3", "summarize", { from_item: 2, to_item: 1, digest: "reversed" })], "tool_use"),
    response([toolCall("t4", "defer", { reason: "not now" })], "tool_use"),
    response([text("deferred")]),
  ]);
  try {
    const result = await f.run();
    expect(result.outcome.status).toBe("completed");
    expect(f.calls).toEqual([{ tool: "defer", reason: "not now" }]);
    const second = f.seen[1] as MessageCreateParams;
    const results = (second.messages as { content: { type: string; is_error?: boolean }[] }[]).at(-1)!.content;
    expect(results.every(block => block.type === "tool_result" && block.is_error === true)).toBe(true);
  } finally { f.db.close(); }
});

test("a failed provider exchange returns a typed failure with released custody", async () => {
  const f = await fixture(4, [{ type: "not-a-message" }]);
  try {
    const result = await f.run();
    expect(result.outcome).toEqual({ status: "failed", code: "EDITOR_RUN_FAILED" });
    expect(result.output).toBeNull();
    expect(result.custody).toBe("released");
  } finally { f.db.close(); }
});

test("prompt renders bounded numbered items with the protected tail marked", () => {
  const t = transcript([editorItem(0, "system", 10, null, "a"), editorItem(1, "tool_result", 20, 18, "b")], 30);
  const prompt = buildEditorPrompt(t, 1);
  expect(prompt).toContain("items=2");
  expect(prompt).toContain("indexes >= 1");
  expect(prompt).toContain("#0 kind=system tokens=10 elidable=- label=\"a\"");
  expect(prompt).toContain("#1 kind=tool_result tokens=20 elidable=18 label=\"b\"");
});
