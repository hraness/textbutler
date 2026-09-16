import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentMixer, CONTACT_TOOL_PROFILE, SqliteAccountLeases,
  type AgentAdapter, type AgentRunRequest, type ModelCatalog, type RuntimeQualification,
} from "@hraness/agentmixer";
import {
  automationBindingDigest, automationHash, createGhostgetAutomationClient,
  type AutomationGrant, type AutomationMessage,
} from "../../transport/src/automation.ts";
import { newContact, type ContactSettings, type Settings } from "./config.ts";
import { automationBinding, createAutomationOwnerPort } from "./automation-owner.ts";
import { Hooks } from "./hooks.ts";
import { RunJournal } from "./journal.ts";
import { OwnerReplies, type OwnerRepliesPorts } from "./owner-replies.ts";
import type { OwnerRuntimeState } from "./control-service.ts";
import type { ProviderHost } from "./provider-host.ts";
import { ContactWorkspace } from "./workspace.ts";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const qualified: RuntimeQualification = {
  status: "qualified", profile: CONTACT_TOOL_PROFILE,
  runtimeVersion: "synthetic-test-only", runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64),
  expiresAt: NOW + 86_400_000,
  controls: { noCommandTools: true, exactToolInventory: true, contactReadIsolation: true,
    contactWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true },
};

const inbound = (id: string, text: string, at: number, coordinate: AutomationMessage["coordinate"]): AutomationMessage =>
  ({ id, coordinate, direction: "incoming", occurredAt: new Date(at).toISOString(), text, kind: "message", relatedMessageId: null, attachments: [] });

async function setup(options: {
  disclosure?: ContactSettings["disclosure"];
  standingGrant?: boolean;
  ready?: boolean;
  failSubmit?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-owner-"))), journal = RunJournal.memory();
  cleanup.push(async () => { journal.close(); await rm(root, { recursive: true, force: true }); });
  let revision = 0;
  const contact: ContactSettings = { ...newContact("contact-1", "Synthetic", "enrollment:fixture"), enabled: true,
    provider: "codex", accountId: "account-one", replyModel: "reply-pinned", ...(options.disclosure ? { disclosure: options.disclosure } : {}) };
  const settings: Settings = { schemaVersion: 1, paused: false, maxActiveContacts: 5, contacts: [contact] };
  const identity = { provider: "imessage" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
  const conversation = { coordinate: { provider: "imessage" as const, chatGuid: "iMessage;-;fixture@example.test", service: "iMessage" as const, observedChatRowId: 1 }, title: "Synthetic", kind: "single" as const, participants: ["fixture@example.test"] };
  const enrolled = () => ({ id: "enrollment:fixture", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision, ready: options.ready ?? true, reason: null });
  const binding = automationBinding(enrolled());
  const messages: AutomationMessage[] = [
    inbound("inbound-1", "Are you free tomorrow?", NOW - 20_000, conversation.coordinate),
    inbound("inbound-2", "Dinner at 7?", NOW - 10_000, conversation.coordinate),
  ];
  const sent: readonly unknown[][] = [], mutableSent = sent as unknown[][];
  const plans = new Map<string, { id: string; intentId: string; actions: readonly unknown[] }>(), grants = new Map<string, AutomationGrant>();
  const grantRequests: { actions: readonly string[]; maximumActions: number; expiresAt: string }[] = [];
  let grantSequence = 0;
  const client = createGhostgetAutomationClient(async (method, params) => {
    if (method === "poll") return enrolled();
    if (method === "history") return { enrollment: enrolled(), messages: messages.slice(-Number(params.limit)) };
    if (method === "events") return { events: [], nextCursor: "0", caughtUp: true };
    if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: true, reason: null }])) };
    if (method === "prepare") { const body = { ...params, bindingDigest: binding.bindingDigest, expiresAt: new Date(NOW + 120_000).toISOString() }, digest = automationHash(body), plan = { ...body, digest, id: `plan:${digest}` }; plans.set(plan.id as string, plan as never); return plan; }
    if (method === "submit") { if (options.failSubmit) throw new Error("Synthetic submit failure"); const plan = plans.get(String(params.planId))!; mutableSent.push([...plan.actions]); return { id: `run:${sent.length}`, planId: plan.id, intentId: plan.intentId, enrollmentId: binding.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:${sent.length}:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
    if (method === "cancel") return { cancelled: true };
    if (method === "grant") {
      const { intentId: _intentId, ...request } = params as Record<string, unknown>;
      const grant = { ...(request as object), id: `grant:${++grantSequence}`, revoked: false, consumedActions: 0 } as AutomationGrant;
      grantRequests.push({ actions: grant.actions, maximumActions: grant.maximumActions, expiresAt: grant.expiresAt });
      grants.set(grant.id, grant); return grant;
    }
    if (method === "grant.get") { const grant = grants.get(String(params.grantId)); if (!grant) throw new Error("Unknown grant"); return grant; }
    if (method === "grant.by-intent") return { grant: null };
    if (method === "revoke") { const grant = grants.get(String(params.grantId)); if (grant) grants.set(grant.id, { ...grant, revoked: true }); return { revoked: true }; }
    throw new Error(`Unexpected fixture operation ${method}`);
  }, () => NOW);
  const automation = createAutomationOwnerPort({ client, providers: ["imessage"], now: () => NOW });
  const workspace = await ContactWorkspace.create(join(root, contact.id));
  const adapter: AgentAdapter = { provider: "codex", qualification: qualified,
    async run(request: AgentRunRequest) {
      void request;
      return { output: { summary: "Synthetic suggestion", actions: [{ kind: "text", text: "Yes, 7 works." }] }, processStopped: true };
    } };
  const router = new AgentMixer({ adapters: [adapter], leases: new SqliteAccountLeases(new Database(":memory:")), now: () => NOW });
  const modelCatalog: ModelCatalog = { provider: "codex", observedAt: NOW,
    models: [{ id: "reply-pinned", inputUsdPerMillion: 1, outputUsdPerMillion: 5, available: true, supportsStructuredOutput: true, classifierEligible: true }] };
  const providers = { router, selection: async () => ({ qualification: qualified, modelCatalog, defaultReplyModel: "reply-pinned" }) } as unknown as ProviderHost;
  if (options.standingGrant) {
    const standing: AutomationGrant = { id: "grant:standing", enrollmentId: binding.enrollmentId, expectedBindingDigest: binding.bindingDigest,
      actions: ["text", "reaction"], expiresAt: new Date(NOW + 86_400_000).toISOString(), maximumActions: 100, minimumIntervalMs: 0, revoked: false, consumedActions: 0 };
    grants.set(standing.id, standing);
  }
  const state: OwnerRuntimeState = { settings, bindings: { [contact.id]: binding }, grants: options.standingGrant ? { "contact-1": grants.get("grant:standing")! } : {} };
  const published: (AutomationGrant | null)[] = [];
  const ports: OwnerRepliesPorts = {
    state: async () => state, journal, automation: () => automation, client: () => client,
    enrollment: () => undefined, providers: () => providers, hooks: new Hooks(),
    workspace: async () => workspace, grantWork: new Map(),
    publishGrant: async (contactId, grant) => {
      published.push(grant);
      const mutable = state.grants as Record<string, AutomationGrant>;
      if (grant === null) delete mutable[contactId]; else mutable[contactId] = grant;
    },
    now: () => NOW,
  };
  const replies = new OwnerReplies(ports);
  return { replies, journal, state, sent, grants, grantRequests, published, contact, binding, messages,
    bumpRevision: () => { revision += 1; },
    setReady: (ready: boolean) => { options.ready = ready; } };
}

test("scan reports the trailing inbound run without sending anything", async () => {
  const fixture = await setup();
  const result = await fixture.replies.scan(AbortSignal.timeout(5000));
  expect(result.checked).toBe(1); expect(result.unreadable).toBe(0);
  expect(result.pending).toHaveLength(1);
  expect(result.pending[0]).toMatchObject({ contactId: "contact-1", pendingCount: 2, sendable: true, preview: "Dinner at 7?", reason: null });
  expect(fixture.sent).toEqual([]);
  const view = fixture.replies.view(fixture.state);
  expect(view.pending).toHaveLength(1); expect(view.drafts).toEqual([]);
});

test("a conversation tail of outgoing or owner text reports nothing pending", async () => {
  const fixture = await setup();
  fixture.messages.push({ ...fixture.messages[0]!, id: "outgoing-1", direction: "outgoing", text: "On my way." });
  const result = await fixture.replies.scan(AbortSignal.timeout(5000));
  expect(result.pending).toEqual([]);
  expect(fixture.replies.view(fixture.state).pending).toEqual([]);
});

test("journal provenance keeps a disclosure-free butler tail from looking unanswered", async () => {
  const fixture = await setup({ disclosure: { character: "", begin: "", end: "" } });
  const journal = fixture.journal;
  journal.claim("run-1", "contact-1", "event-1", NOW);
  journal.recordSentMessages("contact-1", "run-1", ["butler-1"], NOW);
  fixture.messages.push({ ...fixture.messages[0]!, id: "butler-1", direction: "outgoing", text: "Plain reply with no visible marker." });
  expect(journal.isButlerMessage("contact-1", "butler-1")).toBe(true);
  const result = await fixture.replies.scan(AbortSignal.timeout(5000));
  expect(result.pending).toEqual([]);
});

test("suggest drafts a disclosed reply for the pending run and never dispatches", async () => {
  const fixture = await setup();
  const { draft, pending } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect(pending.pendingCount).toBe(2);
  expect(draft).not.toBeNull();
  expect(draft!.summary).toBe("Synthetic suggestion");
  expect(draft!.preview).toBe("🤖{ Yes, 7 works. }");
  expect(draft!.actionCount).toBe(1);
  expect(fixture.sent).toEqual([]);
  const view = fixture.replies.view(fixture.state);
  expect(view.drafts.map(value => value.id)).toEqual([draft!.id]);
});

test("sending a reviewed draft submits disclosed text, journals the send and clears state", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const result = await fixture.replies.send({ draftId: draft!.id }, AbortSignal.timeout(5000));
  expect(result.state).toBe("submitted");
  expect(fixture.sent).toEqual([[{ kind: "text", text: "🤖{ Yes, 7 works. }" }]]);
  expect(fixture.journal.isButlerMessage("contact-1", `sent:1:0`)).toBe(true);
  expect(fixture.replies.view(fixture.state).drafts).toEqual([]);
  expect(fixture.replies.view(fixture.state).pending).toEqual([]);
  // A scoped owner grant was issued with only the text capability and a tight quota.
  expect(fixture.grantRequests).toHaveLength(1);
  expect(fixture.grantRequests[0]!.actions).toEqual(["text"]);
  expect(fixture.grantRequests[0]!.maximumActions).toBe(1);
  expect(fixture.published).toHaveLength(1);
});

test("literal owner text sends through the same disclosed transaction", async () => {
  const fixture = await setup();
  const result = await fixture.replies.send({ contactId: "contact-1", text: "Literal reply" }, AbortSignal.timeout(5000));
  expect(result.state).toBe("submitted");
  expect(fixture.sent).toEqual([[{ kind: "text", text: "🤖{ Literal reply }" }]]);
  expect(fixture.journal.isButlerMessage("contact-1", "sent:1:0")).toBe(true);
});

test("cleared disclosure sends bare text while the journal still marks authorship", async () => {
  const fixture = await setup({ disclosure: { character: "", begin: "", end: "" } });
  const result = await fixture.replies.send({ contactId: "contact-1", text: "Bare reply" }, AbortSignal.timeout(5000));
  expect(result.state).toBe("submitted");
  expect(fixture.sent).toEqual([[{ kind: "text", text: "Bare reply" }]]);
  expect(fixture.journal.isButlerMessage("contact-1", "sent:1:0")).toBe(true);
});

test("a stale draft context or changed disclosure rejects the send", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  fixture.bumpRevision();
  await expect(fixture.replies.send({ draftId: draft!.id }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
});

test("a discarded or unknown draft cannot send", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect(fixture.replies.discard(draft!.id)).toBe(true);
  await expect(fixture.replies.send({ draftId: draft!.id }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  await expect(fixture.replies.send({ draftId: "draft:missing" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  expect(fixture.sent).toEqual([]);
});

test("a live standing grant with the needed capability is reused instead of reissued", async () => {
  const fixture = await setup({ standingGrant: true });
  const result = await fixture.replies.send({ contactId: "contact-1", text: "Reuse the standing grant" }, AbortSignal.timeout(5000));
  expect(result.state).toBe("submitted");
  expect(fixture.grantRequests).toHaveLength(0);
  expect(fixture.sent[0]).toEqual([{ kind: "text", text: "🤖{ Reuse the standing grant }" }]);
});

test("an uncertain prior send blocks another reply until reconciled", async () => {
  const fixture = await setup();
  const journal = fixture.journal;
  journal.claim("uncertain-1", "contact-1", "event-1", NOW);
  journal.transition("uncertain-1", "running", "dispatching", "intent-recorded", NOW);
  journal.transition("uncertain-1", "dispatching", "indeterminate", "outcome unknown", NOW);
  await expect(fixture.replies.send({ contactId: "contact-1", text: "Blocked" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  const scan = await fixture.replies.scan(AbortSignal.timeout(5000));
  expect(scan.pending[0]!.sendable).toBe(false);
  expect(scan.pending[0]!.reason).toContain("reconciliation");
  expect(fixture.sent).toEqual([]);
});

test("an uncertain submit outcome is journaled and blocks the next send", async () => {
  const fixture = await setup({ failSubmit: true });
  const result = await fixture.replies.send({ contactId: "contact-1", text: "Outcome unknown" }, AbortSignal.timeout(5000));
  expect(result.state).toBe("indeterminate");
  expect(fixture.journal.hasUncertainSend("contact-1")).toBe(true);
  await expect(fixture.replies.send({ contactId: "contact-1", text: "Must not send" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
});

test("unconfigured contacts and v1 bindings cannot send", async () => {
  const fixture = await setup();
  await expect(fixture.replies.send({ contactId: "missing", text: "No" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  const v1 = await setup();
  const mutable = v1.state.bindings as Record<string, unknown>;
  mutable["contact-1"] = { version: 1, routeId: "legacy", label: "Legacy" };
  await expect(v1.replies.send({ contactId: "contact-1", text: "No" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  await expect(v1.replies.suggest("contact-1", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
});
