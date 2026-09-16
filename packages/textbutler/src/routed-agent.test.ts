import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentRouter, CONTACT_TOOL_PROFILE, SqliteAccountLeases, parseClassification,
  type AgentAdapter, type AgentProvider, type AgentRunRequest, type ModelCatalog,
  type RuntimeQualification, type ToolBroker,
} from "../../agentrouter/src/index.ts";
import { newContact, type ContactSettings } from "./config.ts";
import { createRoutedButlerAgent } from "./routed-agent.ts";
import type { AgentRequest } from "./runtime.ts";
import { ContactWorkspace } from "./workspace.ts";
import { Hooks, type HookContext } from "./hooks.ts";

const NOW = 1_000_000;
const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const qualified: RuntimeQualification = {
  status: "qualified", profile: CONTACT_TOOL_PROFILE,
  runtimeVersion: "synthetic-test-only", runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64),
  expiresAt: NOW + 60_000,
  controls: { noCommandTools: true, exactToolInventory: true, contactReadIsolation: true,
    contactWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true },
};
const model = (id: string, cost: number) => ({ id, inputUsdPerMillion: cost,
  outputUsdPerMillion: cost * 5, available: true, supportsStructuredOutput: true, classifierEligible: true });

type AdapterCall = { request: AgentRunRequest; broker: ToolBroker; disable(): void };
async function setup(options: {
  provider?: AgentProvider;
  contact?: Partial<ContactSettings>;
  adapterQualification?: RuntimeQualification;
  selectionQualification?: RuntimeQualification;
  hooks?: Hooks;
  execute?: (call: AdapterCall) => Promise<unknown>;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-routed-test-")));
  roots.push(root);
  const workspace = await ContactWorkspace.create(join(root, "contact-one"));
  const provider = options.provider ?? "codex";
  const contact: ContactSettings = { ...newContact("contact-one", "Synthetic contact", "route-one"),
    enabled: true, provider, accountId: "account-one", replyModel: "reply-pinned", ...options.contact };
  const modelCatalog: ModelCatalog = { provider, observedAt: NOW,
    models: [model("default-expensive", 10), model("reply-pinned", 5), model("classifier-cheap", 0.1),
      { ...model("unavailable-free", 0), available: false }] };
  const db = new Database(":memory:"); databases.push(db);
  const leases = new SqliteAccountLeases(db);
  const calls: AgentRunRequest[] = [];
  const seenBrokers: ToolBroker[] = [];
  let active = true;
  let publicRequests = 0;
  const disable = () => { active = false; };
  const adapter: AgentAdapter = { provider, qualification: options.adapterQualification ?? qualified,
    async run(request, broker) {
      calls.push(request); seenBrokers.push(broker);
      const output = options.execute === undefined
        ? request.purpose === "classify"
          ? { respond: true, confidence: 0.95, reason: "helpful" }
          : { summary: "Synthetic response", actions: [{ kind: "text", text: "Hello from the butler." }] }
        : await options.execute({ request, broker, disable });
      return { output, processStopped: true };
    },
  };
  const router = new AgentRouter({ adapters: [adapter], leases, now: () => NOW });
  const agent = createRoutedButlerAgent({ router, now: () => NOW,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    selection: async () => ({ qualification: options.selectionQualification ?? qualified, modelCatalog, defaultReplyModel: "default-expensive" }),
    getWorkspace: async id => { if (id !== contact.id) throw new Error("Unexpected contact"); return workspace; },
    isActive: (id, revision) => active && id === contact.id && revision === contact.revision,
    web: { fetchPublic: async () => { publicRequests += 1; throw new Error("No web calls expected in synthetic test"); } },
  });
  const request: AgentRequest = { runId: "run-one", contact, signal: new AbortController().signal,
    event: { id: "message-one", contactId: contact.id, routeId: contact.routeId, revision: "revision-one",
      occurredAt: NOW - 10_000, observedAt: NOW - 10_000, author: "contact", kind: "message", text: "Butler, can you help?", historical: false, group: false } };
  return { agent, request, contact, workspace, calls, seenBrokers, leases, disable, publicRequests: () => publicRequests };
}

test("routed classifier chooses the cheapest available model with zero tools", async () => {
  const fixture = await setup({ execute: async ({ request, broker }) => {
    expect(request.purpose).toBe("classify");
    expect(request.model).toBe("classifier-cheap");
    expect(broker.tools).toEqual([]);
    for (const tool of ["files.read", "files.write", "web.fetch", "messages.propose_text", "exec"]) {
      await expect(broker.invoke(tool, {})).rejects.toThrow("TOOL_DENIED");
    }
    return JSON.stringify({ respond: true, confidence: 0.95, reason: "helpful" });
  } });
  expect(parseClassification(await fixture.agent.classify(fixture.request))).toEqual({ respond: true, confidence: 0.95, reason: "helpful" });
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({ runId: "run-one-classify", accountId: "account-one", workspaceId: "contact-one" });
  expect(fixture.publicRequests()).toBe(0);
  expect(fixture.leases.inspect("codex", "account-one")).toBeNull();
});

for (const provider of ["codex", "claude"] as const) {
  test(`routed response preserves the selected ${provider} provider, account and pinned model`, async () => {
    const fixture = await setup({ provider });
    expect(await fixture.agent.qualified(fixture.contact)).toBe(true);
    expect(await fixture.agent.compose(fixture.request)).toEqual({ summary: "Synthetic response", actions: [{ kind: "text", text: "Hello from the butler." }] });
    expect(fixture.calls[0]).toMatchObject({ provider, accountId: "account-one", model: "reply-pinned", purpose: "respond", runId: "run-one-respond" });
    expect(fixture.leases.inspect(provider, "account-one")).toBeNull();
  });
}

test("composition conditionally edits private memory and stages one deduplicated proposal without send authority", async () => {
  const notifications: HookContext[] = [], hooks = new Hooks();
  hooks.register({ id: "observe-memory", version: "1.0.0", hooks: { "memory.updated": async context => { notifications.push(context); throw new Error("Notification failure cannot undo the edit"); } } });
  const fixture = await setup({ hooks, execute: async ({ broker }) => {
    const memory = await broker.invoke("files.read", { path: "MEMORY.md" }) as { text: string; revision: string };
    expect(memory.revision).toMatch(/^[a-f0-9]{64}$/u);
    const nextText = `${memory.text}\nContact prefers tea; source message-one, contact-authored.\n`;
    await broker.invoke("files.write", { path: "MEMORY.md", text: nextText, expectedRevision: memory.revision });
    await expect(broker.invoke("files.write", { path: "MEMORY.md", text: "Overwrite newer notes", expectedRevision: memory.revision })).rejects.toThrow("conflict");
    const proposal = { text: "I can help with that.", idempotencyKey: "draft-one" };
    expect(await broker.invoke("messages.propose_text", proposal)).toEqual({ intentId: "draft-one" });
    expect(await broker.invoke("messages.propose_text", proposal)).toEqual({ intentId: "draft-one" });
    await expect(broker.invoke("messages.propose_text", { ...proposal, text: "A conflicting action" })).rejects.toThrow("Idempotency key");
    await expect(broker.invoke("messages.send", { text: "Bypass staging" })).rejects.toThrow("TOOL_DENIED");
    return { summary: "A proposed response", actions: [] };
  } });
  expect(await fixture.agent.compose(fixture.request)).toEqual({ summary: "A proposed response", actions: [{ kind: "text", text: "I can help with that." }] });
  expect(await fixture.workspace.read("MEMORY.md")).toContain("source message-one, contact-authored");
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ contactId: fixture.contact.id, runId: fixture.request.runId, eventId: "message-one", changedFile: { path: "MEMORY.md" } });
  expect(notifications[0]?.changedFile?.revision).toBe((await fixture.workspace.readVersioned("MEMORY.md")).revision);
  expect(fixture.publicRequests()).toBe(0);
  await expect(fixture.seenBrokers[0]!.invoke("messages.propose_text", { text: "Late action", idempotencyKey: "late" })).rejects.toThrow("RUN_REVOKED");
});

test("composition rejects simultaneous staged actions and a final action channel", async () => {
  const fixture = await setup({ execute: async ({ broker }) => {
    await broker.invoke("messages.propose_text", { text: "Staged reply", idempotencyKey: "draft-one" });
    return { summary: "Duplicate reply", actions: [{ kind: "text", text: "Staged reply" }] };
  } });
  await expect(fixture.agent.compose(fixture.request)).rejects.toThrow("one proposal channel");
  expect(fixture.leases.inspect("codex", "account-one")).toBeNull();
});

test("owner disable revokes file and messaging tools and discards the eventual response", async () => {
  const fixture = await setup({ execute: async ({ broker, disable }) => {
    const original = await broker.invoke("files.read", { path: "MEMORY.md" }) as { revision: string };
    disable();
    await expect(broker.invoke("files.write", { path: "MEMORY.md", text: "Too late", expectedRevision: original.revision })).rejects.toThrow("RUN_REVOKED");
    await expect(broker.invoke("messages.propose_text", { text: "Too late", idempotencyKey: "late" })).rejects.toThrow("RUN_REVOKED");
    return { summary: "Delayed completion", actions: [{ kind: "text", text: "Do not dispatch this." }] };
  } });
  const before = await fixture.workspace.read("MEMORY.md");
  await expect(fixture.agent.compose(fixture.request)).rejects.toThrow("Contact run revoked");
  expect(await fixture.workspace.read("MEMORY.md")).toBe(before);
  expect(fixture.leases.inspect("codex", "account-one")).toBeNull();
});

test("owner disable during context preparation prevents provider admission", async () => {
  const fixture = await setup();
  const list = fixture.workspace.list.bind(fixture.workspace);
  fixture.workspace.list = async () => {
    const inventory = await list();
    fixture.disable();
    return inventory;
  };
  await expect(fixture.agent.compose(fixture.request)).rejects.toThrow("Contact run revoked");
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.leases.inspect("codex", "account-one")).toBeNull();
});

test("unqualified router adapters cannot execute despite optimistic selection metadata", async () => {
  const fixture = await setup({ adapterQualification: { status: "unqualified", reason: "Synthetic missing isolation evidence" } });
  await expect(fixture.agent.classify(fixture.request)).rejects.toThrow("PROVIDER_UNQUALIFIED");
  await expect(fixture.agent.compose(fixture.request)).rejects.toThrow("PROVIDER_UNQUALIFIED");
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.leases.inspect("codex", "account-one")).toBeNull();
});

test("missing qualification and unavailable explicit models never fall back", async () => {
  const unqualified = await setup({ selectionQualification: { status: "unqualified", reason: "Synthetic missing evidence" } });
  expect(await unqualified.agent.qualified(unqualified.contact)).toBe(false);
  await expect(unqualified.agent.compose(unqualified.request)).rejects.toThrow("PROVIDER_UNQUALIFIED");
  expect(unqualified.calls).toHaveLength(0);
  const pinned = await setup({ contact: { replyModel: "unavailable-free" } });
  expect(await pinned.agent.qualified(pinned.contact)).toBe(false);
  await expect(pinned.agent.compose(pinned.request)).rejects.toThrow("unavailable");
  expect(pinned.calls).toHaveLength(0);
});
