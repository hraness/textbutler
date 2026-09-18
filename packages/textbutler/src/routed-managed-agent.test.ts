import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentMixer } from "@hraness/agentmixer";
import { SqliteAccountLeases } from "@hraness/agentmixer";
import { BROKER_TOOL_NAMES } from "@hraness/agentmixer";
import type { CapabilityBroker } from "@hraness/agentmixer";
import type { AgentTaskAdapter, AgentTaskExecutionRequest, TaskRuntimeQualification } from "@hraness/agentmixer";
import type { ModelCatalog } from "@hraness/agentmixer";
import { contactCapabilityIdentity, type ButlerPurpose } from "./contact-capabilities.ts";
import { createRoutedButlerAgent, type ProviderSelection } from "./routed-agent.ts";
import { ContactWorkspace } from "./workspace.ts";
import { newContact } from "./config.ts";
import type { AgentRequest } from "./runtime.ts";

const NOW = 1_000_000;
const roots: string[] = [], databases: Database[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Execute = (request: AgentTaskExecutionRequest, broker: CapabilityBroker) => Promise<unknown>;
async function setup(execute?: Execute, change?: (value: ProviderSelection, purpose: ButlerPurpose) => ProviderSelection) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-managed-routing-test-"))); roots.push(root);
  const workspace = await ContactWorkspace.create(join(root, "contact-one"));
  const contact = { ...newContact("contact-one", "Synthetic", "conversation-one"), enabled: true, provider: "codex" as const,
    accountId: "account-one", replyModel: "reply-model" };
  const database = new Database(":memory:"); databases.push(database); const leases = new SqliteAccountLeases(database);
  const models: ModelCatalog = { provider: "codex", observedAt: NOW, models: [
    { id: "reply-model", available: true, classifierEligible: true, supportsStructuredOutput: true, inputUsdPerMillion: 4, outputUsdPerMillion: 8 },
    { id: "cheap-model", available: true, classifierEligible: true, supportsStructuredOutput: true, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
  ] };
  const calls: AgentTaskExecutionRequest[] = [], brokers: CapabilityBroker[] = [];
  let active = true, stops = 0, acquisitions = 0;
  const acquire = leases.acquire.bind(leases); leases.acquire = input => { acquisitions++; return acquire(input); };
  const binding = (r: AgentTaskExecutionRequest) => ({ route: r.route, accountId: r.accountId, workspaceId: r.workspaceId, runId: r.runId,
    profile: r.profile, model: r.model, runtime: r.runtime, accountLease: r.accountLease });
  const adapters: AgentTaskAdapter[] = (["classify", "respond"] as const).map(purpose => {
    const route = { id: `test-codex-${purpose}`, provider: "codex" as const, authentication: "subscription" as const };
    const qualification: TaskRuntimeQualification = { status: "qualified", route, profile: contactCapabilityIdentity(purpose), runtimeVersion: "synthetic-only",
      runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), expiresAt: NOW + 600_000,
      controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
        isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } };
    return { route, qualification, runtime: { version: "synthetic-only", digest: "a".repeat(64) },
      async run(request, broker) {
        calls.push(request); brokers.push(broker);
        const output = execute ? await execute(request, broker) : purpose === "classify" ? { respond: true, confidence: 0.9, reason: "helpful" }
          : { summary: "Response", actions: [{ kind: "text", text: "Hello" }] };
        return { ...binding(request), output: JSON.stringify(output), outcome: { status: "completed", code: null },
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null } };
      },
      async stop(request) { stops++; return { ...binding(request), processStopped: true, controllersStopped: true, joined: true,
        stoppedAtUnixMs: NOW, proofDigest: "c".repeat(64) }; },
    };
  });
  const router = new AgentMixer({ adapters: [], taskAdapters: adapters, leases, now: () => NOW });
  const signal = new AbortController();
  const agent = createRoutedButlerAgent({ router, now: () => NOW, getWorkspace: async () => workspace, isActive: () => active,
    runManagedTask: (request, broker) => router.runTask(request, broker),
    selection: async (_, purpose) => {
      const adapter = adapters[purpose === "classify" ? 0 : 1]!;
      const value: ProviderSelection = { kind: "managed", route: adapter.route, qualification: adapter.qualification, modelCatalog: models, defaultReplyModel: "reply-model" };
      return change ? change(value, purpose) : value;
    }, web: { async fetchPublic() { throw Error("Synthetic test forbids network"); } } });
  const request: AgentRequest = { runId: "run-one", contact, signal: signal.signal, event: { id: "message-one", contactId: contact.id, routeId: contact.routeId,
    revision: "one", occurredAt: NOW - 100, observedAt: NOW - 100, author: "contact", kind: "message", text: "Butler help", historical: false, group: false } };
  return { agent, request, contact, workspace, leases, calls, brokers, adapters, signal, disable() { active = false; }, counts: () => ({ stops, acquisitions }) };
}

test("managed classifier uses the cheapest model, an empty profile and one runtime-owned lease", async () => {
  const f = await setup(async (request, broker) => {
    expect(request.model).toEqual({ id: "cheap-model", reasoningEffort: null, serviceTier: null });
    expect(broker.profile.tools).toEqual([]);
    await expect(broker.invoke("files.read", { path: "MEMORY.md" })).rejects.toThrow("DENIED");
    return { respond: true, confidence: 0.9, reason: "helpful" };
  });
  expect(await f.agent.qualified(f.contact)).toBe(true);
  expect(JSON.parse(await f.agent.classify(f.request) as string).respond).toBe(true);
  expect(f.calls[0]).toMatchObject({ accountId: "account-one", workspaceId: "contact-one", runId: "run-one-classify", profile: contactCapabilityIdentity("classify") });
  expect(f.counts()).toEqual({ stops: 1, acquisitions: 1 }); expect(f.leases.inspect("codex", "account-one")).toBeNull();
});

test("managed reply reuses conditional contact files and deduplicated proposed actions", async () => {
  const f = await setup(async (request, broker) => {
    expect(request.model.id).toBe("reply-model"); expect(broker.profile.tools.map(tool => tool.name)).toEqual([...BROKER_TOOL_NAMES]);
    const file = await broker.invoke("files.read", { path: "MEMORY.md" }) as { text: string; revision: string };
    await broker.invoke("files.write", { path: "MEMORY.md", text: file.text + "\nTea preference; message-one.\n", expectedRevision: file.revision });
    await expect(broker.invoke("files.write", { path: "MEMORY.md", text: "stale", expectedRevision: file.revision })).rejects.toThrow("FAILED");
    const proposal = { text: "Tea sounds good", idempotencyKey: "proposal-one" };
    await broker.invoke("messages.propose_text", proposal); await broker.invoke("messages.propose_text", proposal);
    return { summary: "Tea reply", actions: [] };
  });
  expect(await f.agent.compose(f.request)).toEqual({ summary: "Tea reply", actions: [{ kind: "text", text: "Tea sounds good" }] });
  expect(await f.workspace.read("MEMORY.md")).toContain("message-one"); expect(f.counts().acquisitions).toBe(1);
  await expect(f.brokers[0]!.invoke("files.read", { path: "MEMORY.md" })).rejects.toThrow("REVOKED");
});

test("managed capabilities refuse extra recipients, shell, path traversal and private web URLs before effects", async () => {
  const f = await setup(async (_, broker) => {
    for (const [name, input] of [
      ["messages.propose_text", { text: "hello", idempotencyKey: "one", recipient: "another-contact" }],
      ["files.read", { path: "../owner-settings.json" }], ["web.fetch", { url: "https://127.0.0.1", maxBytes: 10 }], ["exec", { command: "pwd" }],
    ] as const) await expect(broker.invoke(name, input)).rejects.toThrow();
    return { summary: "Safe", actions: [{ kind: "text", text: "Hello" }] };
  });
  await f.agent.compose(f.request); expect(f.counts()).toEqual({ stops: 1, acquisitions: 1 });
});

for (const defect of ["unqualified", "api-substitution", "wrong-profile", "expired", "missing-control", "stale-models"] as const) {
  test(`managed route refuses ${defect} before task or lease admission`, async () => {
    const f = await setup(undefined, (value, purpose) => {
      if (value.kind !== "managed" || value.qualification.status !== "qualified") throw Error("fixture");
      if (defect === "unqualified") return { ...value, qualification: { status: "unqualified", reason: "fixture" } };
      if (defect === "api-substitution") return { ...value, route: { ...value.route, authentication: "api" as const } };
      if (defect === "wrong-profile") return { ...value, qualification: { ...value.qualification, profile: contactCapabilityIdentity(purpose === "classify" ? "respond" : "classify") } };
      if (defect === "expired") return { ...value, qualification: { ...value.qualification, expiresAt: NOW + 1 } };
      if (defect === "stale-models") return { ...value, modelCatalog: { ...value.modelCatalog, observedAt: NOW - 86_400_001 } };
      return { ...value, qualification: { ...value.qualification, controls: { ...value.qualification.controls, noCommandTools: false } } } as unknown as ProviderSelection;
    });
    expect(await f.agent.qualified(f.contact)).toBe(false); await expect(f.agent.compose(f.request)).rejects.toThrow();
    expect(f.counts()).toEqual({ stops: 0, acquisitions: 0 });
  });
}

test("owner disable during a managed task rejects late tools and eventual output", async () => {
  const f = await setup(async (_, broker) => { f.disable();
    await expect(broker.invoke("messages.propose_text", { text: "late", idempotencyKey: "late" })).rejects.toThrow("REVOKED");
    return { summary: "Late", actions: [{ kind: "text", text: "late" }] };
  });
  await expect(f.agent.compose(f.request)).rejects.toThrow("Contact run revoked");
  expect(f.leases.inspect("codex", "account-one")).toBeNull();
});

test("managed rich final actions preserve host transport validation and one proposal channel", async () => {
  const f = await setup(async (_, broker) => {
    await broker.invoke("messages.propose_text", { text: "staged", idempotencyKey: "one" });
    return { summary: "Duplicate", actions: [{ kind: "poll", question: "Tea?", options: ["Yes", "No"], maximumSelections: null }] };
  });
  await expect(f.agent.compose(f.request)).rejects.toThrow("one proposal channel"); expect(f.counts().stops).toBe(1);
});

test("managed broker cleanup joins an admitted file handler before the runtime releases its account", async () => {
  let finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const f = await setup(async (_, broker) => {
    void broker.invoke("files.read", { path: "MEMORY.md" }).catch(() => {});
    await started;
    return { summary: "Finished model", actions: [{ kind: "text", text: "Hello" }] };
  });
  const read = f.workspace.readVersioned.bind(f.workspace);
  f.workspace.readVersioned = async path => { entered(); await held; return read(path); };
  let settled = false;
  const result = f.agent.compose(f.request).finally(() => { settled = true; });
  try {
    await started; await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false); expect(f.leases.inspect("codex", "account-one")?.owner).toBe("run-one-respond");
  } finally { finish(); }
  await result; expect(f.leases.inspect("codex", "account-one")).toBeNull();
});

test("managed final poll proposals retain their full shape for host capability checks", async () => {
  const action = { kind: "poll", question: "Which day?", options: ["Saturday", "Sunday"], maximumSelections: null };
  const f = await setup(async () => ({ summary: "Poll proposal", actions: [action] }));
  expect(await f.agent.compose(f.request)).toEqual({ summary: "Poll proposal", actions: [action] });
  expect(f.counts().acquisitions).toBe(1);
});

test("owner disable while a memory write waits prevents publication and removes its stage", async () => {
  let finish!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; }), staged = new Promise<void>(resolve => { entered = resolve; });
  const f = await setup(async (_, broker) => {
    const file = await broker.invoke("files.read", { path: "MEMORY.md" }) as { revision: string };
    let failure: unknown;
    try { await broker.invoke("files.write", { path: "MEMORY.md", text: "Must not commit", expectedRevision: file.revision }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("REVOKED");
    return { summary: "Late", actions: [{ kind: "text", text: "Late" }] };
  });
  const before = await f.workspace.read("MEMORY.md"), read = f.workspace.readVersioned.bind(f.workspace); let reads = 0;
  f.workspace.readVersioned = async path => {
    const result = await read(path);
    if (path === "MEMORY.md" && ++reads === 3) { entered(); await held; }
    return result;
  };
  const result = f.agent.compose(f.request); void result.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([staged, result.then(() => { throw Error("Unexpected early task completion"); }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error(`Stage not reached after ${reads} reads`)), 1000); })]);
    expect(await readdir(join(f.workspace.root, ".staging"))).toHaveLength(1); f.disable();
  } finally { clearTimeout(timeout); finish(); }
  await expect(result).rejects.toThrow("Contact run revoked");
  expect(await f.workspace.read("MEMORY.md")).toBe(before); expect(await readdir(join(f.workspace.root, ".staging"))).toEqual([]);
  expect(f.leases.inspect("codex", "account-one")).toBeNull();
});
