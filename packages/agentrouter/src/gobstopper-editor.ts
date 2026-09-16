/**
 * gobstopper preset.command shim: drives gobstopper's `agentic` compaction
 * strategy through agentrouter's bounded task runtime (`runAgentTask`).
 *
 * Contract (gobstopper-cli `run_preset_command`):
 *   stdin  — {"session_id","provider","items":[{line_index,kind,est_tokens,
 *            elidable_bytes,label}],"usage":{context_tokens,...}}
 *   stdout — {"edits": gobstopper Edit[], "context_tokens_after": u64}
 *   stderr — diagnostics only. Nonzero exit marks failure.
 *
 * The transcript is presented to a model as a context-editing task with a
 * fixed capability profile matching gobstopper's `EditorCall` enum
 * (keep/elide/summarize/defer). Calls are recorded by the broker, then lowered
 * to `Edit` objects exactly like `AgenticStrategy::calls_to_plan` does:
 * elide positions map through `items[i].line_index` for elidable items only,
 * summarize injects a digest, keep is advisory, and any defer discards the
 * whole plan. The last `GOBSTOPPER_EDITOR_PROTECT_TAIL` items are never touched.
 *
 * Host configuration (environment, never contact/plugin input):
 *   ANTHROPIC_API_KEY                  — default API-key variable
 *   GOBSTOPPER_EDITOR_KEY_ENV          — override the API-key variable name
 *   GOBSTOPPER_EDITOR_KEY_DIRECTORY    — owner file directory (mode 0700) instead of env
 *   GOBSTOPPER_EDITOR_KEY_NAME         — key file name inside that directory
 *   GOBSTOPPER_EDITOR_ACCOUNT          — account binding id (default "editor-primary")
 *   GOBSTOPPER_EDITOR_MODEL_CATALOG    — path to a fresh ModelCatalog JSON; skips discovery
 *   GOBSTOPPER_EDITOR_PRICES           — path to a ClaudePriceCatalog JSON for discovery
 *   GOBSTOPPER_EDITOR_PROTECT_TAIL     — protected trailing items (default 8)
 *   GOBSTOPPER_EDITOR_BUDGET_USD       — local reservation ceiling (default 0.25, max 5)
 *   GOBSTOPPER_EDITOR_MAX_TOKENS       — response cap per turn (default 2048)
 *
 * `--dry-run` validates stdin and emits an empty plan without provider work.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { VERSION as sdkVersion } from "@anthropic-ai/sdk/version";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { SqliteAccountLeases } from "./accounts.ts";
import { createEnvironmentClaudeApiKeyResolver, createFileClaudeApiKeyResolver } from "./claude-credentials.ts";
import type { ClaudeApiKeyResolver } from "./claude-sdk.ts";
import { discoverClaudeModels, parseClaudePriceCatalog, type ClaudePriceCatalog } from "./claude-api-models.ts";
import { claudeApiClient, CLAUDE_API_SDK_VERSION, type ClaudeApiClient } from "./claude-api-transport.ts";
import { selectClassifierModel, type ModelCatalog } from "./models.ts";
import { createCapabilityBroker, createCapabilityProfile, assertCapabilityProfile,
  type CapabilityBroker, type CapabilityJson, type CapabilityObject, type CapabilityProfile } from "./capabilities.ts";
import { assertAgentTaskAccountLease, runAgentTask,
  type AgentTaskAdapter, type AgentTaskBinding, type AgentTaskCompletion, type AgentTaskExecutionRequest,
  type AgentTaskRoute, type AgentTaskStopEvidence, type AgentTaskStopReason, type TaskRuntimeQualification } from "./task-runtime.ts";
import { boundedText, identifier, safeInteger } from "./validation.ts";

export const GOBSTOPPER_EDITOR_LIMITS = Object.freeze({
  stdinBytes: 256 * 1024, promptBytes: 448 * 1024, items: 4096, calls: 64, toolsPerTurn: 64,
  labelBytes: 512, digestBytes: 8 * 1024, reasonBytes: 1024, catalogBytes: 256 * 1024,
  maxRunMs: 90_000, maxCleanupMs: 10_000, maxOutputBytes: 8 * 1024, maxTurns: 8,
});
/** Identical to gobstopper's `elide::DEFAULT_STUB`; `{bytes}`/`{kind}` expand adapter-side. */
export const DEFAULT_STUB = "[output elided by gobstopper: {bytes} bytes]";
export const EDITOR_PROFILE_ID = "agentrouter.gobstopper-editor.v1";
const ROUTE: AgentTaskRoute = Object.freeze({ id: "claude-api", provider: "claude", authentication: "api" });
const ITEM_KINDS = new Set(["system", "user", "assistant", "tool_call", "tool_result", "reasoning", "meta"]);
const TOOL_NAMES = ["keep", "elide", "summarize", "defer"] as const;

/** Normalized subset of gobstopper's normalized transcript wire payload. */
export type EditorTranscriptItem = Readonly<{ lineIndex: number; kind: string; estTokens: number; elidableBytes: number | null; label: string }>;
export type EditorTranscript = Readonly<{ sessionId: string; provider: string; items: readonly EditorTranscriptItem[]; contextTokens: number }>;
export type EditorCall =
  | Readonly<{ tool: "keep"; fromItem: number; toItem: number }>
  | Readonly<{ tool: "elide"; items: readonly number[] }>
  | Readonly<{ tool: "summarize"; fromItem: number; toItem: number; digest: string }>
  | Readonly<{ tool: "defer"; reason: string }>;
export type GobstopperEdit =
  | Readonly<{ op: "elide"; line_indexes: readonly number[]; stub_template: string }>
  | Readonly<{ op: "inject_digest"; digest: Readonly<{ goal: string; decisions: readonly string[]; files_touched: readonly string[]; open_tasks: readonly string[]; covers_items: number }> }>
  | Readonly<{ op: "provider_compact"; control: string }>;
export type EditorPlan = Readonly<{ edits: readonly GobstopperEdit[]; contextTokensAfter: number; deferred: string | null }>;

const field = (record: Record<string, unknown>, name: string) => {
  if (!Object.hasOwn(record, name)) throw new Error("TRANSCRIPT_FIELD_MISSING");
  return record[name];
};
function closed(value: unknown, maxKeys = 16): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("TRANSCRIPT_OBJECT_INVALID");
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length > maxKeys || keys.some(key => typeof key !== "string"
    || !Object.getOwnPropertyDescriptor(record, key)?.enumerable
    || !("value" in Object.getOwnPropertyDescriptor(record, key)!))) throw new Error("TRANSCRIPT_OBJECT_INVALID");
  return record;
}

/** Parse the stdin payload from unknown. Extra keys are tolerated: gobstopper's
 * machine surfaces are additive-only, so the shim validates what it consumes. */
export function parseEditorTranscript(value: unknown): EditorTranscript {
  const root = closed(value, 16);
  const sessionId = boundedText(field(root, "session_id"), 512);
  const provider = boundedText(field(root, "provider"), 32);
  if (provider !== "codex" && provider !== "claude_code") throw new Error("TRANSCRIPT_PROVIDER_INVALID");
  const rawItems = field(root, "items");
  if (!Array.isArray(rawItems) || rawItems.length > GOBSTOPPER_EDITOR_LIMITS.items) throw new Error("TRANSCRIPT_ITEMS_INVALID");
  const items = rawItems.map(raw => {
    const item = closed(raw, 8);
    const lineIndex = safeInteger(field(item, "line_index"), 0, Number.MAX_SAFE_INTEGER);
    const kind = boundedText(field(item, "kind"), 32);
    if (!ITEM_KINDS.has(kind)) throw new Error("TRANSCRIPT_ITEM_KIND_INVALID");
    const estTokens = safeInteger(field(item, "est_tokens"), 0, Number.MAX_SAFE_INTEGER);
    const elidable = field(item, "elidable_bytes");
    const elidableBytes = elidable === null ? null : safeInteger(elidable, 0, Number.MAX_SAFE_INTEGER);
    return Object.freeze({ lineIndex, kind, estTokens, elidableBytes, label: boundedText(field(item, "label"), GOBSTOPPER_EDITOR_LIMITS.labelBytes, true) });
  });
  const usage = closed(field(root, "usage"), 8);
  const reported = safeInteger(field(usage, "context_tokens"), 0, Number.MAX_SAFE_INTEGER);
  const contextTokens = reported > 0 ? reported : items.reduce((sum, item) => sum + item.estTokens, 0);
  return Object.freeze({ sessionId, provider, items: Object.freeze(items), contextTokens });
}

/** Bounded stdin reader; invalid UTF-8 and oversize input fail closed. */
async function readStdin(limit: number): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > limit) throw new Error("STDIN_LIMIT_EXCEEDED");
    parts.push(bytes);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}

function itemIndex(value: unknown, itemCount: number): number {
  return safeInteger(value, 0, Math.max(0, itemCount - 1));
}

/** Fixed `EditorCall` tool surface. Handlers only record the call — the broker
 * is the sole effect channel and it performs no filesystem or process work. */
export function createEditorCapabilityProfile(options: { itemCount: number; calls: EditorCall[] }): CapabilityProfile {
  const count = safeInteger(options.itemCount, 1, GOBSTOPPER_EDITOR_LIMITS.items);
  const calls = options.calls;
  const index = { type: "integer", minimum: 0, maximum: count - 1 };
  const record = (call: EditorCall): CapabilityJson => {
    if (calls.length >= GOBSTOPPER_EDITOR_LIMITS.calls) throw new Error("EDITOR_CALL_LIMIT");
    calls.push(call);
    return { recorded: true };
  };
  const range = (parsed: CapabilityJson): { fromItem: number; toItem: number } => {
    const input = parsed as { from_item: unknown; to_item: unknown };
    return { fromItem: itemIndex(input.from_item, count), toItem: itemIndex(input.to_item, count) };
  };
  const tools = [
    {
      name: "keep", description: "Mark the inclusive item range [from_item, to_item] to preserve verbatim. Advisory; produces no edit.",
      inputSchema: { type: "object", properties: { from_item: index, to_item: index }, required: ["from_item", "to_item"], additionalProperties: false },
      parseInput(input: CapabilityObject): CapabilityJson {
        const from = itemIndex(input.from_item, count), to = itemIndex(input.to_item, count);
        if (from > to) throw new Error("EDITOR_RANGE_INVALID");
        return { from_item: from, to_item: to };
      },
      execute(parsed: CapabilityJson) { const { fromItem, toItem } = range(parsed); return record({ tool: "keep", fromItem, toItem }); },
    },
    {
      name: "elide", description: "Replace the payload of each listed item index with a short stub. Only items with a non-null elidable_bytes take effect.",
      inputSchema: { type: "object", properties: { items: { type: "array", items: index, maxItems: 4096 } }, required: ["items"], additionalProperties: false },
      parseInput(input: CapabilityObject): CapabilityJson {
        if (!Array.isArray(input.items) || input.items.length > GOBSTOPPER_EDITOR_LIMITS.items) throw new Error("EDITOR_ITEMS_INVALID");
        const items = [...new Set(input.items.map(value => itemIndex(value, count)))].sort((a, b) => a - b);
        return { items };
      },
      execute(parsed: CapabilityJson) {
        const input = parsed as { items: unknown };
        if (!Array.isArray(input.items) || input.items.length > GOBSTOPPER_EDITOR_LIMITS.items) throw new Error("EDITOR_ITEMS_INVALID");
        const items = [...new Set(input.items.map(value => itemIndex(value, count)))].sort((a, b) => a - b);
        return record({ tool: "elide", items });
      },
    },
    {
      name: "summarize", description: "Write a structured digest covering items [from_item, to_item]. Injects a digest line; elide the range's elidable items to reclaim its tokens.",
      inputSchema: { type: "object", properties: { from_item: index, to_item: index,
        digest: { type: "string", minLength: 1, maxLength: GOBSTOPPER_EDITOR_LIMITS.digestBytes } },
        required: ["from_item", "to_item", "digest"], additionalProperties: false },
      parseInput(input: CapabilityObject): CapabilityJson {
        const from = itemIndex(input.from_item, count), to = itemIndex(input.to_item, count);
        if (from >= to) throw new Error("EDITOR_RANGE_INVALID");
        return { from_item: from, to_item: to, digest: boundedText(input.digest, GOBSTOPPER_EDITOR_LIMITS.digestBytes) };
      },
      execute(parsed: CapabilityJson) {
        const input = parsed as { digest: unknown };
        const { fromItem, toItem } = range(parsed);
        return record({ tool: "summarize", fromItem, toItem, digest: boundedText(input.digest, GOBSTOPPER_EDITOR_LIMITS.digestBytes) });
      },
    },
    {
      name: "defer", description: "Take no action: compacting now would harm an in-progress derivation. Any defer discards the entire plan.",
      inputSchema: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: GOBSTOPPER_EDITOR_LIMITS.reasonBytes } },
        required: ["reason"], additionalProperties: false },
      parseInput(input: CapabilityObject): CapabilityJson {
        return { reason: boundedText(input.reason, GOBSTOPPER_EDITOR_LIMITS.reasonBytes) };
      },
      execute(parsed: CapabilityJson) {
        return record({ tool: "defer", reason: boundedText((parsed as { reason: unknown }).reason, GOBSTOPPER_EDITOR_LIMITS.reasonBytes) });
      },
    },
  ];
  return createCapabilityProfile({ id: EDITOR_PROFILE_ID, version: 1, tools });
}

/** Lower recorded calls to gobstopper `Edit`s, mirroring `calls_to_plan` with an
 * additional protected-tail bound: positions >= items.length - tail are never
 * elided and summarize ranges may not reach into them. */
export function callsToEdits(transcript: EditorTranscript, calls: readonly EditorCall[], protectTail: number): EditorPlan {
  const count = transcript.items.length;
  const protectedFrom = count - Math.min(count, safeInteger(protectTail, 0, GOBSTOPPER_EDITOR_LIMITS.items));
  const edits: GobstopperEdit[] = [];
  const elided = new Set<number>();
  let after = transcript.contextTokens;
  for (const call of calls) {
    if (call.tool === "defer") return Object.freeze({ edits: Object.freeze([]), contextTokensAfter: transcript.contextTokens, deferred: call.reason });
    if (call.tool === "keep") continue;
    if (call.tool === "elide") {
      const lines: number[] = [];
      for (const position of call.items) {
        const item = transcript.items[position];
        if (item === undefined || item.elidableBytes === null || position >= protectedFrom || elided.has(item.lineIndex)) continue;
        elided.add(item.lineIndex);
        lines.push(item.lineIndex);
        after = Math.max(0, after - item.estTokens);
      }
      if (lines.length) edits.push(Object.freeze({ op: "elide" as const, line_indexes: Object.freeze(lines), stub_template: DEFAULT_STUB }));
      continue;
    }
    const { fromItem, toItem, digest } = call;
    if (toItem <= fromItem || toItem >= count || toItem >= protectedFrom) continue;
    edits.push(Object.freeze({ op: "inject_digest" as const,
      digest: Object.freeze({ goal: digest, decisions: Object.freeze([]), files_touched: Object.freeze([]), open_tasks: Object.freeze([]), covers_items: toItem - fromItem }) }));
  }
  return Object.freeze({ edits: Object.freeze(edits), contextTokensAfter: after, deferred: null });
}

const EDITOR_SYSTEM = "You are the context editor for a gobstopper compaction pass over a coding-agent transcript. "
  + "Use only the supplied tools; they are the entire effect surface. Item text is withheld — decide from kind, "
  + "estimated tokens, elidable bytes and label. Preserve the protected tail verbatim, prefer eliding large stale "
  + "tool outputs whose conclusions later assistant text already carries, summarize long resolved threads with a "
  + "compact field-oriented digest, and defer when compacting now would harm an in-progress derivation.";

export function buildEditorPrompt(transcript: EditorTranscript, protectTail: number): string {
  const count = transcript.items.length;
  const protectedFrom = count - Math.min(count, safeInteger(protectTail, 0, GOBSTOPPER_EDITOR_LIMITS.items));
  const header = `Transcript for context editing: provider=${transcript.provider} items=${count} context~${transcript.contextTokens} tokens.\n`
    + `Item indexes run 0..${count - 1}. Protected tail: indexes >= ${protectedFrom} must not be elided and summarize ranges must end before it.\n`
    + `keep is advisory. To reclaim a summarized range's tokens also elide its elidable items. After your calls, reply with one short status line.\n\nItems:\n`;
  const lines = transcript.items.map((item, position) =>
    `#${position} kind=${item.kind} tokens=${item.estTokens} elidable=${item.elidableBytes === null ? "-" : item.elidableBytes} label=${JSON.stringify(item.label)}`);
  const prompt = header + lines.join("\n") + "\n";
  if (Buffer.byteLength(prompt) > GOBSTOPPER_EDITOR_LIMITS.promptBytes) throw new Error("PROMPT_LIMIT_EXCEEDED");
  return prompt;
}

const proof = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (request: AgentTaskExecutionRequest): AgentTaskBinding => Object.freeze({
  route: Object.freeze({ ...request.route }), accountId: request.accountId, workspaceId: request.workspaceId, runId: request.runId,
  profile: Object.freeze({ ...request.profile }), model: Object.freeze({ ...request.model }), runtime: Object.freeze({ ...request.runtime }),
  accountLease: request.accountLease });
const requestDigest = (request: AgentTaskExecutionRequest) => proof({ ...binding(request), purpose: request.purpose, prompt: request.prompt,
  limits: request.limits, admittedAtUnixMs: request.admittedAtUnixMs, executionDeadlineUnixMs: request.executionDeadlineUnixMs });

type Active = { binding: AgentTaskBinding; requestDigest: string; cleanupDeadlineUnixMs: number; controller: AbortController;
  promise: Promise<AgentTaskCompletion>; started: boolean; stopping?: Promise<AgentTaskStopEvidence> };

export type EditorTaskAdapterOptions = Readonly<{
  route: AgentTaskRoute;
  runtime: Readonly<{ version: string; digest: string }>;
  /** Host-attested qualification for this exact route, profile and runtime. */
  qualification: TaskRuntimeQualification;
  credentials: ClaudeApiKeyResolver;
  modelCatalog: (accountId: string) => Promise<ModelCatalog>;
  instructions: Readonly<{ system: string }>;
  now(): number;
  maxTurns?: number;
  maxOutputTokens?: number;
  /** Conservative local reservation at supplied prices; not a provider billing cap. */
  budgetUsd?: number;
  /** Internal fixture seam; production wiring uses the pinned transport. */
  clientFor?: (key: string, signal: AbortSignal) => ClaudeApiClient;
}>;

/**
 * Minimal Messages-API task adapter for application capability profiles. It is
 * the no-process counterpart of `apiAdapter`: the same fixed Anthropic
 * transport, the same bounded tool loop, but the tool inventory comes from the
 * `CapabilityBroker` profile instead of the contact tool set. No filesystem,
 * shell or configuration access exists on this path. Failures return a typed
 * failed completion so account custody is released cleanly.
 */
export function createEditorTaskAdapter(options: EditorTaskAdapterOptions): AgentTaskAdapter {
  if (sdkVersion !== CLAUDE_API_SDK_VERSION) throw new Error("CLAUDE_API_SDK_VERSION_MISMATCH");
  if (options.route.provider !== "claude" || options.route.authentication !== "api") throw new Error("EDITOR_ROUTE_INVALID");
  const route = Object.freeze({ id: identifier(options.route.id), provider: "claude" as const, authentication: "api" as const });
  const runtime = Object.freeze({ version: boundedText(options.runtime.version, 160), digest: boundedText(options.runtime.digest, 64) });
  if (!/^[a-f0-9]{64}$/u.test(runtime.digest)) throw new Error("EDITOR_RUNTIME_INVALID");
  const qualification = options.qualification;
  const system = boundedText(options.instructions.system, 64 * 1024);
  const now = options.now.bind(options);
  const maxTurns = safeInteger(options.maxTurns ?? GOBSTOPPER_EDITOR_LIMITS.maxTurns, 1, 16);
  const maxOutputTokens = safeInteger(options.maxOutputTokens ?? 2048, 128, 8192);
  const budget = options.budgetUsd ?? 0.25;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 5) throw new Error("EDITOR_LIMIT_INVALID");
  const clientFor = options.clientFor ?? claudeApiClient;
  let active: Active | null = null;
  const slots = new WeakMap<AbortSignal, Active>();

  const adapter: AgentTaskAdapter = {
    route, runtime, qualification,
    async run(input, broker: CapabilityBroker): Promise<AgentTaskCompletion> {
      if (qualification.status !== "qualified") throw new Error("EDITOR_ADAPTER_UNQUALIFIED");
      const qualified = qualification;
      assertAgentTaskAccountLease(input);
      if (slots.has(input.signal)) throw new Error("EDITOR_REQUEST_ALREADY_ADMITTED");
      const request: AgentTaskExecutionRequest = input;
      const busy = active !== null;
      const controller = new AbortController();
      const slot: Active = { binding: binding(request), requestDigest: requestDigest(request), cleanupDeadlineUnixMs: request.cleanupDeadlineUnixMs,
        controller, promise: Promise.resolve().then(execute), started: false };
      slots.set(request.signal, slot);
      if (!busy) active = slot;
      async function execute(): Promise<AgentTaskCompletion> {
        try {
          if (busy) throw new Error("EDITOR_TASK_ALREADY_RUNNING");
          if (JSON.stringify(route) !== JSON.stringify(request.route) || JSON.stringify(qualified.route) !== JSON.stringify(route)
            || JSON.stringify(qualified.profile) !== JSON.stringify(request.profile)
            || qualified.runtimeVersion !== runtime.version || qualified.runtimeDigest !== runtime.digest
            || request.runtime.runtimeVersion !== runtime.version || request.runtime.runtimeDigest !== runtime.digest
            || request.runtime.evidenceDigest !== qualified.evidenceDigest
            || request.runtime.qualificationExpiresAt !== qualified.expiresAt
            || qualified.expiresAt < request.cleanupDeadlineUnixMs
            || ["noCommandTools", "exactToolInventory", "workspaceReadIsolation", "workspaceWriteIsolation",
              "isolatedConfiguration", "authOutsideWorkspace", "hostBrokerOnly"].some(key =>
              (qualified.controls as unknown as Record<string, unknown>)[key] !== true)) throw new Error("EDITOR_QUALIFICATION_MISMATCH");
          assertCapabilityProfile(broker.profile, request.profile);
          if (broker.runId !== request.runId || broker.workspaceId !== request.workspaceId) throw new Error("EDITOR_BROKER_MISMATCH");
          broker.assertActive();
          const signal = AbortSignal.any([request.signal, controller.signal]);
          signal.throwIfAborted();
          const catalog = await options.modelCatalog(request.accountId);
          const model = catalog.models.find(entry => entry.id === request.model.id && entry.available && entry.supportsStructuredOutput);
          if (catalog.provider !== "claude" || !model || model.inputUsdPerMillion <= 0 || model.outputUsdPerMillion <= 0
            || catalog.models.length > 256) throw new Error("EDITOR_MODEL_UNAVAILABLE");
          slot.started = true;
          return await options.credentials.withApiKey(request.accountId, signal, async key => {
            const client = clientFor(key, signal);
            const tools: Tool[] = broker.profile.tools.map(descriptor => ({ name: descriptor.name, description: descriptor.description,
              input_schema: descriptor.inputSchema as unknown as Tool["input_schema"] }));
            const names = new Set(broker.profile.tools.map(descriptor => descriptor.name));
            const messages: MessageParam[] = [{ role: "user", content: request.prompt }];
            const ids = new Set<string>();
            let reservation = 0, inputTokens = 0, outputTokens = 0, usageSeen = false;
            for (let turn = 0; turn < maxTurns; turn++) {
              signal.throwIfAborted();
              const params = { model: request.model.id, max_tokens: maxOutputTokens, system, messages, tools, stream: false as const };
              const size = Buffer.byteLength(JSON.stringify(params));
              if (size > 1024 * 1024) throw new Error("EDITOR_INPUT_LIMIT");
              reservation += ((size + 8192) * model.inputUsdPerMillion + params.max_tokens * model.outputUsdPerMillion) / 1_000_000;
              if (reservation > budget) throw new Error("EDITOR_BUDGET_EXHAUSTED");
              const response = await client.messages.create(params, { signal });
              signal.throwIfAborted();
              if (response.type !== "message" || response.role !== "assistant" || response.model !== request.model.id
                || !Array.isArray(response.content) || response.content.length > 64) throw new Error("EDITOR_RESPONSE_INVALID");
              const usage = response.usage as unknown;
              if (usage && typeof usage === "object" && !Array.isArray(usage)) {
                const u = usage as Record<string, unknown>;
                if (typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
                  usageSeen = true;
                  inputTokens += safeInteger(u.input_tokens, 0, Number.MAX_SAFE_INTEGER);
                  outputTokens += safeInteger(u.output_tokens, 0, Number.MAX_SAFE_INTEGER);
                }
              }
              const blocks: NonNullable<Exclude<MessageParam["content"], string>> = [];
              const calls: { id: string; name: string; input: unknown }[] = [];
              let text = "";
              for (const block of response.content) {
                if (block.type === "text") { text += boundedText(block.text, 512 * 1024, true); blocks.push({ type: "text", text: block.text }); }
                else if (block.type === "tool_use") {
                  const id = identifier(block.id), name = boundedText(block.name, 160);
                  if (ids.has(id) || ids.size >= GOBSTOPPER_EDITOR_LIMITS.toolsPerTurn) throw new Error("EDITOR_TOOL_ID_INVALID");
                  ids.add(id);
                  calls.push({ id, name, input: block.input });
                  blocks.push({ type: "tool_use", id, name, input: block.input });
                } else throw new Error("EDITOR_UNEXPECTED_CAPABILITY");
              }
              boundedText(text, 512 * 1024, true);
              if (!calls.length) {
                if (response.stop_reason !== "end_turn") throw new Error("EDITOR_RESULT_INCOMPLETE");
                signal.throwIfAborted();
                const output = Buffer.byteLength(text) > request.limits.maxOutputBytes
                  ? new TextDecoder().decode(Buffer.from(text).subarray(0, request.limits.maxOutputBytes)) : text;
                return Object.freeze({ ...slot.binding, output: output.length ? output : null,
                  usage: Object.freeze({ inputTokens: usageSeen ? inputTokens : null, outputTokens: usageSeen ? outputTokens : null,
                    totalTokens: usageSeen ? inputTokens + outputTokens : null, costUsd: null }),
                  outcome: Object.freeze({ status: "completed" as const, code: null }) });
              }
              if (response.stop_reason !== "tool_use") throw new Error("EDITOR_TOOL_PHASE_INVALID");
              messages.push({ role: "assistant", content: blocks });
              const results: NonNullable<Exclude<MessageParam["content"], string>> = [];
              for (const call of calls) {
                signal.throwIfAborted();
                try {
                  if (!names.has(call.name)) throw new Error("TOOL_DENIED");
                  const output = await broker.invoke(call.name, call.input);
                  signal.throwIfAborted();
                  results.push({ type: "tool_result", tool_use_id: call.id, content: boundedText(JSON.stringify(output), 512 * 1024) });
                } catch {
                  signal.throwIfAborted();
                  results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "TOOL_REQUEST_DENIED" });
                }
              }
              messages.push({ role: "user", content: results });
            }
            throw new Error("EDITOR_TURN_LIMIT");
          });
        } catch {
          return Object.freeze({ ...slot.binding, output: null,
            usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }),
            outcome: Object.freeze({ status: "failed" as const, code: busy ? "EDITOR_TASK_ALREADY_RUNNING" : "EDITOR_RUN_FAILED" }) });
        }
      }
      return slot.promise;
    },
    async stop(request, _reason: AgentTaskStopReason): Promise<AgentTaskStopEvidence> {
      const originalSignal = Object.getOwnPropertyDescriptor(request, "signal");
      if (!originalSignal || !("value" in originalSignal)) throw new Error("EDITOR_STOP_BINDING_MISMATCH");
      const slot = slots.get(originalSignal.value as AbortSignal);
      if (!slot) throw new Error("EDITOR_TASK_NOT_RUNNING");
      try { assertAgentTaskAccountLease(request, "stop"); }
      catch { throw new Error("EDITOR_STOP_BINDING_MISMATCH"); }
      if (requestDigest(request) !== slot.requestDigest || !Number.isSafeInteger(request.cleanupDeadlineUnixMs)
        || request.cleanupDeadlineUnixMs < request.admittedAtUnixMs || request.cleanupDeadlineUnixMs > slot.cleanupDeadlineUnixMs)
        throw new Error("EDITOR_STOP_BINDING_MISMATCH");
      return slot.stopping ??= Promise.resolve().then(async () => {
        slot.controller.abort();
        await slot.promise;
        const evidence = Object.freeze({ ...slot.binding, processStopped: true as const, controllersStopped: true as const, joined: true as const,
          stoppedAtUnixMs: safeInteger(now(), request.admittedAtUnixMs, Number.MAX_SAFE_INTEGER),
          proofDigest: proof({ requestDigest: slot.requestDigest, custody: { started: slot.started } }) });
        if (active === slot) active = null;
        return evidence;
      });
    },
  };
  return Object.freeze(adapter);
}

const diag = (message: string) => process.stderr.write(`gobstopper-editor: ${message}\n`);
const envText = (name: string, max = 1024) => {
  const value = process.env[name];
  return value === undefined ? undefined : boundedText(value, max);
};

function editorCredentials(accountId: string): ClaudeApiKeyResolver {
  const directory = envText("GOBSTOPPER_EDITOR_KEY_DIRECTORY", 4096);
  if (directory !== undefined) {
    const name = envText("GOBSTOPPER_EDITOR_KEY_NAME", 160) ?? "api-key";
    return createFileClaudeApiKeyResolver({ directory, bindings: { [accountId]: name } });
  }
  const variable = envText("GOBSTOPPER_EDITOR_KEY_ENV", 160) ?? "ANTHROPIC_API_KEY";
  return createEnvironmentClaudeApiKeyResolver({ [accountId]: variable });
}

/** Host-supplied price floor rows for the live Models discovery path. Public
 * Anthropic list prices; override with GOBSTOPPER_EDITOR_PRICES when the
 * account exposes different ids or prices. */
const DEFAULT_PRICE_ROWS: ClaudePriceCatalog["models"] = Object.freeze([
  Object.freeze({ id: "claude-haiku-4-5", inputUsdPerMillion: 1, outputUsdPerMillion: 5, classifierEligible: true }),
  Object.freeze({ id: "claude-haiku-4-5-20251001", inputUsdPerMillion: 1, outputUsdPerMillion: 5, classifierEligible: true }),
  Object.freeze({ id: "claude-sonnet-4-5", inputUsdPerMillion: 3, outputUsdPerMillion: 15, classifierEligible: true }),
  Object.freeze({ id: "claude-sonnet-4-5-20250929", inputUsdPerMillion: 3, outputUsdPerMillion: 15, classifierEligible: true }),
  Object.freeze({ id: "claude-sonnet-4-6", inputUsdPerMillion: 3, outputUsdPerMillion: 15, classifierEligible: true }),
  Object.freeze({ id: "claude-opus-4-5", inputUsdPerMillion: 5, outputUsdPerMillion: 25, classifierEligible: false }),
  Object.freeze({ id: "claude-opus-4-5-20251101", inputUsdPerMillion: 5, outputUsdPerMillion: 25, classifierEligible: false }),
]);

async function loadModelCatalog(options: { credentials: ClaudeApiKeyResolver; accountId: string; now(): number; signal: AbortSignal }): Promise<ModelCatalog> {
  const catalogPath = envText("GOBSTOPPER_EDITOR_MODEL_CATALOG", 4096);
  if (catalogPath !== undefined) {
    const bytes = await readFile(catalogPath);
    if (bytes.byteLength > GOBSTOPPER_EDITOR_LIMITS.catalogBytes) throw new Error("CATALOG_LIMIT_EXCEEDED");
    const catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    selectClassifierModel(catalog, options.now());
    return catalog as ModelCatalog;
  }
  const pricesPath = envText("GOBSTOPPER_EDITOR_PRICES", 4096);
  let priceInput: unknown = { observedAt: options.now(), models: DEFAULT_PRICE_ROWS };
  if (pricesPath !== undefined) {
    const bytes = await readFile(pricesPath);
    if (bytes.byteLength > GOBSTOPPER_EDITOR_LIMITS.catalogBytes) throw new Error("CATALOG_LIMIT_EXCEEDED");
    priceInput = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // A bare rows array or a rows-only object is stamped at load time; a full
    // ClaudePriceCatalog keeps its own observedAt and 30-day freshness check.
    if (Array.isArray(priceInput)) priceInput = { observedAt: options.now(), models: priceInput };
    else if (typeof priceInput === "object" && priceInput !== null && !Object.hasOwn(priceInput, "observedAt"))
      priceInput = { observedAt: options.now(), ...(priceInput as Record<string, unknown>) };
  }
  const priceCatalog = parseClaudePriceCatalog(priceInput, options.now());
  return await discoverClaudeModels({ credentials: options.credentials, accountId: options.accountId, priceCatalog, signal: options.signal, now: options.now });
}

const USAGE = `usage: bun gobstopper-editor.ts [--dry-run]
  Reads a gobstopper normalized transcript JSON on stdin and writes
  {"edits": [...], "context_tokens_after": n} on stdout for preset.command.`;

export async function main(argv: readonly string[]): Promise<number> {
  const flags = new Set(argv);
  if (flags.has("--help") || flags.has("-h")) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (argv.some(arg => arg !== "--dry-run")) { diag("unknown argument"); return 2; }
  const dryRun = flags.has("--dry-run");
  const protectTail = (() => {
    const raw = envText("GOBSTOPPER_EDITOR_PROTECT_TAIL", 16);
    return raw === undefined ? 8 : safeInteger(Number(raw), 0, GOBSTOPPER_EDITOR_LIMITS.items);
  })();
  const transcript = parseEditorTranscript(JSON.parse(await readStdin(GOBSTOPPER_EDITOR_LIMITS.stdinBytes)));
  if (transcript.items.length === 0) {
    process.stdout.write(`${JSON.stringify({ edits: [], context_tokens_after: transcript.contextTokens })}\n`);
    return 0;
  }
  const prompt = buildEditorPrompt(transcript, protectTail);
  if (dryRun) {
    diag(`dry-run: ${transcript.items.length} items parsed; provider call skipped`);
    process.stdout.write(`${JSON.stringify({ edits: [], context_tokens_after: transcript.contextTokens })}\n`);
    return 0;
  }
  const controller = new AbortController();
  const now = () => Date.now();
  const accountId = identifier(envText("GOBSTOPPER_EDITOR_ACCOUNT", 160) ?? "editor-primary");
  const credentials = editorCredentials(accountId);
  const catalog = await loadModelCatalog({ credentials, accountId, now, signal: controller.signal });
  const selected = selectClassifierModel(catalog, now());
  const workspaceId = "gobstopper-editor";
  const runId = `run-${randomUUID()}`;
  const calls: EditorCall[] = [];
  const profile = createEditorCapabilityProfile({ itemCount: transcript.items.length, calls });
  const broker = createCapabilityBroker({ profile, workspaceId, runId, isActive: () => !controller.signal.aborted, signal: controller.signal });
  const db = new Database(":memory:");
  try {
    const leases = new SqliteAccountLeases(db);
    const runtimeVersion = `gobstopper-editor/1;claude-api/2023-06-01;anthropic-sdk/${CLAUDE_API_SDK_VERSION}`;
    const runtimeDigest = proof({ runtime: runtimeVersion, tools: TOOL_NAMES });
    const qualification: TaskRuntimeQualification = Object.freeze({ status: "qualified", route: ROUTE,
      profile: { id: profile.id, version: profile.version, digest: profile.digest },
      runtimeVersion, runtimeDigest, evidenceDigest: proof(`enforced-editor-tool-loop-v1:${runtimeDigest}`),
      expiresAt: safeInteger(now(), 0, Number.MAX_SAFE_INTEGER - 86_400_000) + 86_400_000,
      controls: Object.freeze({ noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true,
        workspaceWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true }) });
    const adapter = createEditorTaskAdapter({ route: ROUTE, runtime: { version: runtimeVersion, digest: runtimeDigest }, qualification,
      credentials, modelCatalog: async () => catalog, instructions: { system: EDITOR_SYSTEM }, now,
      budgetUsd: (() => { const raw = envText("GOBSTOPPER_EDITOR_BUDGET_USD", 16); return raw === undefined ? 0.25 : Number(raw); })(),
      maxOutputTokens: (() => { const raw = envText("GOBSTOPPER_EDITOR_MAX_TOKENS", 16); return raw === undefined ? 2048 : safeInteger(Number(raw), 128, 8192); })() });
    const result = await runAgentTask({ adapters: [adapter], leases, now }, {
      route: ROUTE, accountId, workspaceId, runId,
      profile: { id: profile.id, version: profile.version, digest: profile.digest },
      model: { id: selected.id, reasoningEffort: null, serviceTier: null },
      purpose: "gobstopper-context-edit", prompt,
      limits: { maxRunMs: GOBSTOPPER_EDITOR_LIMITS.maxRunMs, maxCleanupMs: GOBSTOPPER_EDITOR_LIMITS.maxCleanupMs,
        maxOutputBytes: GOBSTOPPER_EDITOR_LIMITS.maxOutputBytes },
      signal: controller.signal }, broker);
    if (result.outcome.status !== "completed") {
      diag(`editor task failed: ${result.outcome.status} ${result.outcome.code ?? ""}`.trimEnd());
      return 1;
    }
    const plan = callsToEdits(transcript, calls, protectTail);
    if (plan.deferred !== null) diag(`editor deferred: ${plan.deferred.slice(0, 160)}`);
    else diag(`editor emitted ${plan.edits.length} edit(s) from ${calls.length} call(s)`);
    process.stdout.write(`${JSON.stringify({ edits: plan.edits, context_tokens_after: plan.contextTokensAfter })}\n`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    error => {
      const message = error instanceof Error ? error.message : "";
      const code = /^[A-Z][A-Z0-9_]{2,63}$/u.test(message) ? message : "EDITOR_INPUT_INVALID";
      diag(`failed: ${code}`);
      process.exitCode = error instanceof SyntaxError || /^(TRANSCRIPT|STDIN|PROMPT|INVALID|UNKNOWN)_/u.test(code) ? 2 : 1;
    });
}
