import { expect, test } from "bun:test";
import { advanceNativeCodexProtocol, assertNativeCodexConfiguration, createNativeCodexProtocol, extractNativeCodexCatalog,
  nativeCodexConfiguration, transformNativeCodexCatalog, NATIVE_CODEX_CANDIDATE, NATIVE_CODEX_MODELS,
  type NativeCodexState } from "./native-codex.ts";

const CWD = "/private/synthetic/workspace", HOME = "/private/synthetic/codex-home";
const CATALOG = "/private/synthetic/codex-home/model-catalog.json", MODEL = NATIVE_CODEX_MODELS[0];
const THREAD = "thread-synthetic", TURN = "turn-synthetic", ITEM = "item-synthetic";
const FINAL = '{"kind":"final","output":"Synthetic reply"}';

const row = (slug: string) => ({ slug, display_name: "Synthetic", supported_reasoning_levels: ["low", "high"],
  shell_type: "default", visibility: "public", priority: 1, supported_in_api: true, support_verbosity: false,
  truncation_policy: "none", experimental_supported_tools: ["shell"], tool_mode: "agentic" });

test("the catalog keeps only the reviewed model and forces its safe fields", () => {
  const catalog = transformNativeCodexCatalog({ models: [row(MODEL), row(NATIVE_CODEX_MODELS[1])] }, MODEL);
  expect(catalog).toMatchObject({ model: MODEL, status: "unqualified" });
  expect(catalog.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const models = JSON.parse(catalog.json).models;
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({ slug: MODEL, tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null,
    experimental_supported_tools: [], supports_search_tool: false, supports_experimental_context: false,
    multi_agent_version: "disabled", node_repl_disabled: true });
  expect(transformNativeCodexCatalog({ models: [row(MODEL)] }, MODEL).sha256).toBe(catalog.sha256);
});
test("an unreviewed model, duplicate slug or incomplete row never becomes a catalog", () => {
  expect(() => transformNativeCodexCatalog({ models: [row("gpt-6-unreviewed")] }, "gpt-6-unreviewed")).toThrow();
  expect(() => transformNativeCodexCatalog({ models: [row("gpt-6-unreviewed")] }, MODEL)).toThrow();
  expect(() => transformNativeCodexCatalog({ models: [row(MODEL), row(MODEL)] }, MODEL)).toThrow();
  const { truncation_policy, ...incomplete } = row(MODEL);
  expect(() => transformNativeCodexCatalog({ models: [incomplete] }, MODEL)).toThrow();
  expect(() => transformNativeCodexCatalog({ models: [] }, MODEL)).toThrow();
});
test("extraction refuses any executable whose bytes are not the admitted build", () => {
  expect(() => extractNativeCodexCatalog(new TextEncoder().encode(`{\n  "models":[]}`), MODEL)).toThrow();
  expect(() => extractNativeCodexCatalog(new Uint8Array(), MODEL)).toThrow();
  expect(NATIVE_CODEX_CANDIDATE.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(NATIVE_CODEX_CANDIDATE.status).toBe("unqualified");
});

/** The asserted account features are exactly the ones the generated
 * configuration disables, read back from its own `[features]` section. */
function featureNames(): readonly string[] {
  const lines = nativeCodexConfiguration(CATALOG).split("\n"), start = lines.indexOf("[features]") + 1;
  expect(start).toBeGreaterThan(0);
  const end = lines.findIndex((line, index) => index >= start && line.startsWith("["));
  return lines.slice(start, end).map(line => {
    expect(line).toMatch(/^[a-z0-9_]+ = false$/u);
    return line.split(" ")[0]!;
  });
}
function configuration(changes: Record<string, unknown> = {}, features: Record<string, unknown> = {}) {
  const names = featureNames();
  return { config: { model_provider: "openai", forced_login_method: "chatgpt", cli_auth_credentials_store: "file",
    mcp_oauth_credentials_store: "file", approval_policy: "never", sandbox_mode: "read-only", web_search: "disabled",
    project_doc_max_bytes: 0, check_for_update_on_startup: false, allow_login_shell: false, notify: [], mcp_servers: {},
    plugins: {}, model_providers: {}, model_catalog_json: CATALOG, chatgpt_base_url: "https://chatgpt.com/backend-api/",
    shell_environment_policy: { inherit: "none" }, analytics: { enabled: false }, feedback: { enabled: false },
    history: { persistence: "none" }, skills: { include_instructions: false, bundled: { enabled: false } },
    orchestrator: { skills: { enabled: false } },
    apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
    features: { ...Object.fromEntries(names.map(name => [name, false])), ...features },
    ...changes } };
}
test("the generated configuration closes every inherited surface it asserts", () => {
  const text = nativeCodexConfiguration(CATALOG);
  expect(text).toContain(`model_catalog_json = ${JSON.stringify(CATALOG)}`);
  expect(text).toContain('sandbox_mode = "read-only"');
  expect(text).toContain('inherit = "none"');
  expect(text).toContain("shell_tool = false");
  expect(() => nativeCodexConfiguration("codex-home/model-catalog.json")).toThrow();
  expect(() => assertNativeCodexConfiguration(configuration(), CATALOG)).not.toThrow();
});
test("a changed control, inherited instruction or extra app fails configuration admission", () => {
  for (const changes of [{ sandbox_mode: "workspace-write" }, { approval_policy: "on-request" }, { web_search: "enabled" },
    { forced_login_method: "apikey" }, { mcp_servers: { synthetic: {} } }, { plugins: { synthetic: {} } },
    { instructions: "Inherited" }, { openai_base_url: "https://example.invalid" }, { allow_login_shell: true },
    { shell_environment_policy: { inherit: "all" } }, { analytics: { enabled: true } }, { history: { persistence: "save-all" } },
    { apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false }, synthetic: {} } },
    { model_catalog_json: "/private/synthetic/other.json" }])
    expect(() => assertNativeCodexConfiguration(configuration(changes), CATALOG)).toThrow();
  expect(() => assertNativeCodexConfiguration(configuration({}, { shell_tool: true }), CATALOG)).toThrow();
  expect(() => assertNativeCodexConfiguration(configuration(), "/private/synthetic/other.json")).toThrow();
});

const input = { cwd: CWD, accountHome: HOME, catalogPath: CATALOG, model: MODEL, prompt: "Synthetic task",
  outputSchema: { type: "object", additionalProperties: false } };
function ready(): NativeCodexState {
  let state = createNativeCodexProtocol(input).state;
  state = advanceNativeCodexProtocol(state, { method: "remoteControl/status/changed", params: { status: "disabled" } }).state;
  state = advanceNativeCodexProtocol(state, { id: 1, result: { userAgent: "codex/synthetic", codexHome: HOME } }).state;
  state = advanceNativeCodexProtocol(state, { id: 2, result: { requiresOpenaiAuth: true, account: { type: "chatgpt" } } }).state;
  state = advanceNativeCodexProtocol(state, { id: 3, result: configuration() }).state;
  state = advanceNativeCodexProtocol(state, { id: 4, result: { model: MODEL, modelProvider: "openai", cwd: CWD,
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, serviceTier: null,
    instructionSources: [], thread: { id: THREAD, ephemeral: true, turns: [], cwd: CWD, modelProvider: "openai", model: MODEL,
      path: null, cliVersion: NATIVE_CODEX_CANDIDATE.version } } }).state;
  return advanceNativeCodexProtocol(state, { id: 5, result: { turn: { id: TURN, status: "inProgress", items: [] } } }).state;
}
const notify = (method: string, params: Record<string, unknown>) => ({ jsonrpc: "2.0", method, params: { threadId: THREAD, ...params } });

test("the startup sequence demands a subscription account and a closed configuration", () => {
  const start = createNativeCodexProtocol(input);
  expect(start.state.phase).toBe("initialize");
  expect(start.outbound).toEqual([{ id: 1, method: "initialize", params: { capabilities: { experimentalApi: false,
    requestAttestation: false }, clientInfo: { name: "textbutler", version: "1" } } }]);
  const state = ready();
  expect(state).toMatchObject({ phase: "running", threadId: THREAD, turnId: TURN, remoteDisabled: true, pendingId: null });
  const turn = advanceNativeCodexProtocol(state, notify("item/started", { turnId: TURN, item: { id: ITEM, type: "agentMessage" } })).state;
  const completed = advanceNativeCodexProtocol(turn, notify("item/completed", { turnId: TURN, item: { id: ITEM, type: "agentMessage", text: FINAL } })).state;
  const done = advanceNativeCodexProtocol(completed, notify("turn/completed", { turn: { id: TURN, status: "completed", items: [] } }));
  expect(done.state.phase).toBe("complete");
  expect(done.output).toEqual({ kind: "final", output: "Synthetic reply" });
  expect(() => advanceNativeCodexProtocol(done.state, notify("thread/tokenUsage/updated", {}))).toThrow();
});
test("the turn cannot start before remote control, the account and the configuration are proven", () => {
  const start = createNativeCodexProtocol(input).state;
  const initialized = advanceNativeCodexProtocol(start, { id: 1, result: { userAgent: "codex/synthetic", codexHome: HOME } }).state;
  expect(() => advanceNativeCodexProtocol(initialized, { id: 2, result: { requiresOpenaiAuth: false, account: { type: "apikey" } } })).toThrow();
  const account = advanceNativeCodexProtocol(initialized, { id: 2, result: { requiresOpenaiAuth: true, account: { type: "chatgpt" } } }).state;
  expect(() => advanceNativeCodexProtocol(account, { id: 3, result: configuration() })).toThrow();
  expect(() => advanceNativeCodexProtocol(start, { id: 1, result: { userAgent: "codex/synthetic", codexHome: "/private/other" } })).toThrow();
  expect(() => createNativeCodexProtocol({ ...input, model: "gpt-6-unreviewed" })).toThrow();
  expect(() => createNativeCodexProtocol({ ...input, accountHome: `${CWD}/home` })).toThrow();
  expect(() => createNativeCodexProtocol({ ...input, cwd: "workspace" })).toThrow();
});
test("a server request, unknown notification or native tool item is denied", () => {
  const state = ready();
  for (const frame of [{ id: 9, method: "applyPatch/approve", params: {} }, notify("item/exec/begin", { turnId: TURN, item: { id: ITEM } }),
    notify("item/started", { turnId: TURN, item: { id: ITEM, type: "commandExecution" } }),
    notify("item/started", { turnId: "turn-other", item: { id: ITEM, type: "agentMessage" } }),
    { jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-other", turnId: TURN, item: { id: ITEM, type: "agentMessage" } } },
    { method: "remoteControl/status/changed", params: { status: "connected" } },
    { method: "account/updated", params: { authMode: "apikey" } },
    { id: 5, error: { code: -32000, message: "denied" } }]) expect(() => advanceNativeCodexProtocol(state, frame)).toThrow();
});
test("a replayed, unfinished or non-final item never completes the turn", () => {
  const state = ready();
  const started = advanceNativeCodexProtocol(state, notify("item/started", { turnId: TURN, item: { id: ITEM, type: "agentMessage" } })).state;
  expect(() => advanceNativeCodexProtocol(started, notify("turn/completed", { turn: { id: TURN, status: "completed", items: [] } }))).toThrow();
  const completed = advanceNativeCodexProtocol(started, notify("item/completed", { turnId: TURN, item: { id: ITEM, type: "agentMessage", text: FINAL } })).state;
  expect(() => advanceNativeCodexProtocol(completed, notify("item/completed", { turnId: TURN, item: { id: ITEM, type: "agentMessage", text: FINAL } }))).toThrow();
  expect(() => advanceNativeCodexProtocol(completed, notify("turn/completed", { turn: { id: TURN, status: "failed", items: [] } }))).toThrow();
  expect(() => advanceNativeCodexProtocol(completed, notify("turn/completed", { turn: { id: "turn-other", status: "completed", items: [] } }))).toThrow();
  expect(() => advanceNativeCodexProtocol(completed, notify("turn/completed", { turn: { id: TURN, status: "completed",
    items: [{ id: ITEM, type: "agentMessage", text: '{"kind":"final","output":"Swapped"}' }] } }))).toThrow();
  const prose = advanceNativeCodexProtocol(started, notify("item/completed", { turnId: TURN, item: { id: ITEM, type: "agentMessage", text: "not json" } })).state;
  expect(() => advanceNativeCodexProtocol(prose, notify("turn/completed", { turn: { id: TURN, status: "completed", items: [] } }))).toThrow();
  expect(() => advanceNativeCodexProtocol({ ...state }, notify("thread/tokenUsage/updated", {}))).toThrow();
});
