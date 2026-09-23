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
import { NoReplyNeeded } from "./runtime.ts";
import type { OwnerRuntimeState } from "./control-service.ts";
import type { ProviderHost } from "./provider-host.ts";
import { ContactWorkspace } from "./workspace.ts";
import type { ActionIntent } from "../../transport/src/index.ts";

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
  failRevoke?: boolean;
  failGrant?: boolean;
  actions?: readonly ActionIntent[];
  enabled?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-owner-"))), journal = RunJournal.memory();
  cleanup.push(async () => { journal.close(); await rm(root, { recursive: true, force: true }); });
  let revision = 0;
  const contact: ContactSettings = { ...newContact("contact-1", "Synthetic", "enrollment:fixture"), enabled: options.enabled ?? true,
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
    if (method === "submit") { if (options.failSubmit) throw new Error("Synthetic submit failure"); const plan = plans.get(String(params.planId))!, grant = grants.get(String(params.grantId))!;
      if (grant.revoked || grant.maximumActions - grant.consumedActions < plan.actions.length) throw new Error("Synthetic grant exhausted");
      mutableSent.push([...plan.actions]); return { id: `run:${sent.length}`, planId: plan.id, intentId: plan.intentId, enrollmentId: binding.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:${sent.length}:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
    if (method === "cancel") return { cancelled: true };
    if (method === "grant") {
      const { intentId: _intentId, ...request } = params as Record<string, unknown>;
      const grant = { ...(request as object), id: `grant:${++grantSequence}`, revoked: false, consumedActions: 0 } as AutomationGrant;
      grantRequests.push({ actions: grant.actions, maximumActions: grant.maximumActions, expiresAt: grant.expiresAt });
      grants.set(grant.id, grant); if (options.failGrant) throw new Error("Synthetic lost grant response"); return grant;
    }
    if (method === "grant.get") { const grant = grants.get(String(params.grantId)); if (!grant) throw new Error("Unknown grant"); return grant; }
    if (method === "grant.by-intent") return { grant: null };
    if (method === "revoke") { if (options.failRevoke) throw new Error("Synthetic revoke failure"); const grant = grants.get(String(params.grantId)); if (grant) grants.set(grant.id, { ...grant, revoked: true }); return { revoked: true }; }
    throw new Error(`Unexpected fixture operation ${method}`);
  }, () => NOW);
  const automation = createAutomationOwnerPort({ client, providers: ["imessage"], now: () => NOW });
  const workspace = await ContactWorkspace.create(join(root, contact.id));
  const adapter: AgentAdapter = { provider: "codex", qualification: qualified,
    async run(request: AgentRunRequest) {
      void request;
      return { output: { summary: "Synthetic suggestion", actions: options.actions ?? [{ kind: "text", text: "Yes, 7 works." }] }, processStopped: true };
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
  const state: OwnerRuntimeState = { revision: 1, settings, bindings: { [contact.id]: binding }, grants: options.standingGrant ? { "contact-1": grants.get("grant:standing")! } : {} };
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
  return { replies, journal, state, sent, grants, grantRequests, published, contact, binding, messages, workspace, ports,
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

test("a silent agent suggestion returns no draft instead of a generic failure", async () => {
  const fixture = await setup();
  fixture.replies.useAgent({ qualified: async () => true, classify: async () => ({ outcome: "reply" }),
    compose: async () => { throw new NoReplyNeeded(); } });
  const { draft, pending } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect(draft).toBeNull();
  expect(pending.pendingCount).toBe(2);
  expect(fixture.replies.view(fixture.state).drafts).toEqual([]);
});

test("sending a reviewed draft submits disclosed text, journals the send and clears state", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const result = await fixture.replies.send({ draftId: draft!.id, expectedDigest: (await fixture.replies.readDraft(draft!.id)).digest }, AbortSignal.timeout(5000));
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
  const reviewed = await fixture.replies.readDraft(draft!.id);
  fixture.bumpRevision();
  await expect(fixture.replies.send({ draftId: draft!.id, expectedDigest: reviewed.digest }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
});

test("a discarded or unknown draft cannot send", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect(fixture.replies.discard(draft!.id)).toBe(true);
  await expect(fixture.replies.send({ draftId: draft!.id, expectedDigest: "a".repeat(64) }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  await expect(fixture.replies.send({ draftId: "draft:missing", expectedDigest: "a".repeat(64) }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
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

test("scoped quota counts every action, including repeated text kinds", async () => {
  const fixture = await setup({ actions: [{ kind: "text", text: "First" }, { kind: "text", text: "Second" }] });
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const review = await fixture.replies.readDraft(draft!.id);
  const result = await fixture.replies.send({ draftId: draft!.id, expectedDigest: review.digest }, AbortSignal.timeout(5000));
  expect(result.state).toBe("submitted");
  expect(fixture.grantRequests[0]).toMatchObject({ actions: ["text"], maximumActions: 2 });
  expect(fixture.sent[0]).toEqual([...review.actions]);
});

test("a standing grant needs enough quota for the complete action batch", async () => {
  const fixture = await setup({ standingGrant: true, actions: [{ kind: "text", text: "First" }, { kind: "text", text: "Second" }] });
  fixture.grants.set("grant:standing", { ...fixture.grants.get("grant:standing")!, maximumActions: 1 });
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const review = await fixture.replies.readDraft(draft!.id);
  expect((await fixture.replies.send({ draftId: draft!.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).state).toBe("submitted");
  expect(fixture.grants.get("grant:standing")!.revoked).toBe(true);
  expect(fixture.grantRequests[0]!.maximumActions).toBe(2);
});

test.each([
  [{ kind: "link", url: "https://example.test" }],
  [{ kind: "reaction", messageId: "inbound-2", emoji: "👍", action: "add" }, { kind: "text", text: "See you" }],
] satisfies ActionIntent[][])("rich-leading drafts review and send the same disclosure companion", async (...actions) => {
  const fixture = await setup({ actions });
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const review = await fixture.replies.readDraft(draft!.id);
  expect(review.actions[0]).toEqual({ kind: "text", text: "🤖{ Synthetic suggestion }" });
  expect(draft!.actionCount).toBe(actions.length + 1);
  expect((await fixture.replies.send({ draftId: draft!.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).state).toBe("submitted");
  expect(fixture.sent[0]).toEqual(review.actions.map(action => action.kind === "reaction"
    ? { kind: "reaction", messageId: action.messageId, emoji: action.emoji, remove: action.action === "remove" } : action));
  expect(fixture.grantRequests[0]!.maximumActions).toBe(review.actions.length);
});

test("cleared disclosure does not invent a companion for rich-only drafts", async () => {
  const fixture = await setup({ disclosure: { character: "", begin: "", end: "" }, actions: [{ kind: "link", url: "https://example.test" }] });
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect((await fixture.replies.readDraft(draft!.id)).actions).toEqual([{ kind: "link", url: "https://example.test" }]);
  expect(draft!.actionCount).toBe(1);
});

test("full review exposes every byte and action, and an incorrect digest cannot send", async () => {
  const long = `${"A".repeat(1_000)} final important words`;
  const fixture = await setup({ actions: [{ kind: "text", text: long }, { kind: "text", text: "Second message" }] });
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  expect(draft!.preview).not.toContain("final important words");
  const review = await fixture.replies.readDraft(draft!.id);
  expect(review.actions).toEqual([{ kind: "text", text: `🤖{ ${long} }` }, { kind: "text", text: "🤖{ Second message }" }]);
  expect(review).toMatchObject({ contactId: "contact-1", name: "Synthetic", provider: "imessage", conversationId: fixture.binding.enrollmentId });
  await expect(fixture.replies.send({ draftId: draft!.id, expectedDigest: "a".repeat(64) }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
  expect(fixture.grantRequests).toEqual([]);
});

test("changing an attachment after review cannot change the submitted bytes", async () => {
  const fixture = await setup({ enabled: false, actions: [{ kind: "attachment", file: "outbox/note.txt", mimeType: "text/plain", name: "note.txt" }] });
  await fixture.workspace.write("outbox/note.txt", "Reviewed bytes");
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const review = await fixture.replies.readDraft(draft!.id);
  expect(review.assets).toHaveLength(1);
  expect(review.assets[0]).toMatchObject({ path: "outbox/note.txt", bytes: 14 });
  await fixture.workspace.write("outbox/note.txt", "Changed bytes");
  await expect(fixture.replies.send({ draftId: draft!.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(fixture.sent).toEqual([]);
  expect(fixture.journal.hasUncertainSend("contact-1")).toBe(false);
  expect(fixture.grants.get("grant:1")!.revoked).toBe(true);
});

test("suggest refreshes all recent attributed context for disabled owner-review contacts", async () => {
  const fixture = await setup({ enabled: false });
  await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000));
  const history = JSON.parse(await fixture.workspace.read("history/recent.json"));
  expect(history.messages.map((message: { text: string }) => message.text)).toEqual(["Are you free tomorrow?", "Dinner at 7?"]);
  expect(history.messages.every((message: { author: string }) => message.author === "contact")).toBe(true);
});

test("suggest refuses an incomplete current conversation", async () => {
  const fixture = await setup({ ready: false });
  await expect(fixture.replies.suggest("contact-1", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(fixture.replies.view(fixture.state).drafts).toEqual([]);
});

test("uncertain grant creation blocks another grant and send until reconciliation", async () => {
  const fixture = await setup({ failGrant: true });
  await expect(fixture.replies.send({ contactId: "contact-1", text: "First" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(fixture.journal.grantIntents()).toHaveLength(1);
  await expect(fixture.replies.send({ contactId: "contact-1", text: "Retry" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.grantRequests).toHaveLength(1);
  expect(fixture.sent).toEqual([]);
});

test("uncertain revocation retains the previous grant without creating a replacement", async () => {
  const fixture = await setup({ standingGrant: true, failRevoke: true });
  fixture.grants.set("grant:standing", { ...fixture.grants.get("grant:standing")!, consumedActions: 100 });
  await expect(fixture.replies.send({ contactId: "contact-1", text: "First" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(fixture.state.grants["contact-1"]?.id).toBe("grant:standing");
  expect(fixture.grantRequests).toEqual([]);
  expect(fixture.sent).toEqual([]);
});

test("in-progress grant recovery cannot be overwritten by an owner send", async () => {
  const fixture = await setup();
  const work = Promise.resolve(); fixture.ports.grantWork.set("contact-1", work);
  await expect(fixture.replies.send({ contactId: "contact-1", text: "No" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.ports.grantWork.get("contact-1")).toBe(work);
  expect(fixture.grantRequests).toEqual([]);
});

test("a returned grant awaiting recovery blocks a new owner grant", async () => {
  const fixture = await setup({ standingGrant: true });
  fixture.journal.recordPendingGrant("contact-1", fixture.grants.get("grant:standing")!);
  await expect(fixture.replies.send({ contactId: "contact-1", text: "No" }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect((await fixture.replies.scan(AbortSignal.timeout(5000))).pending[0]).toMatchObject({ sendable: false, reason: "A previous messaging grant needs reconciliation." });
  expect(fixture.sent).toEqual([]);
});

test("contact settings changing during preparation cancel the reviewed send", async () => {
  const fixture = await setup();
  const { draft } = await fixture.replies.suggest("contact-1", AbortSignal.timeout(5000)), review = await fixture.replies.readDraft(draft!.id);
  fixture.ports.hooks.register({ id: "owner-settings-change", version: "1.0.0", hooks: { "reply.before-send": async () => {
    (fixture.state as { settings: Settings }).settings = { ...fixture.state.settings,
      contacts: [{ ...fixture.contact, revision: fixture.contact.revision + 1, disclosure: { character: "", begin: "", end: "" } }] };
  } } });
  await expect(fixture.replies.send({ draftId: draft!.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
  expect(fixture.journal.hasUncertainSend("contact-1")).toBe(false);
});

test("a literal reply reviewed against an older owner snapshot never starts sending", async () => {
  const fixture = await setup();
  (fixture.state as { revision: number }).revision = 2;
  await expect(fixture.replies.send({ contactId: "contact-1", text: "Reviewed reply", expectedRevision: 1 }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
  expect(fixture.grantRequests).toEqual([]);
  expect(fixture.journal.recent("contact-1")).toEqual([]);
});

test("a current literal reply snapshot uses the same trimmed disclosure as review", async () => {
  const fixture = await setup();
  expect((await fixture.replies.send({ contactId: "contact-1", text: "  Reviewed reply\n", expectedRevision: 1 }, AbortSignal.timeout(5000))).state).toBe("submitted");
  expect(fixture.sent).toEqual([[{ kind: "text", text: "🤖{ Reviewed reply }" }]]);
});

test("a literal review cannot use an injected state with no revision", async () => {
  const fixture = await setup();
  delete (fixture.state as { revision?: number }).revision;
  await expect(fixture.replies.send({ contactId: "contact-1", text: "Reviewed reply", expectedRevision: 1 }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect(fixture.sent).toEqual([]);
});

test("explicit composition creates a fully disclosed draft for a disabled contact without inference or sending", async () => {
  const f = await setup({ enabled: false });
  const providers = f.ports.providers()!; providers.selection = async () => { throw Error("Explicit composition must not run inference"); };
  const review = await f.replies.compose("contact-1", "React to dinner", [{ kind: "reaction", messageId: "inbound-2", emoji: "👍", action: "add" }], AbortSignal.timeout(5000));
  expect(review.actions).toEqual([{ kind: "text", text: "🤖{ React to dinner }" }, { kind: "reaction", messageId: "inbound-2", emoji: "👍", action: "add" }]);
  expect(await f.replies.readDraft(review.id)).toEqual(review);
  expect(f.sent).toEqual([]); expect(f.grantRequests).toEqual([]);
  await expect(f.replies.send({ draftId: review.id, expectedDigest: "0".repeat(64) }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
  expect((await f.replies.send({ draftId: review.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).state).toBe("submitted");
  expect(f.sent[0]).toEqual([{ kind: "text", text: "🤖{ React to dinner }" }, { kind: "reaction", messageId: "inbound-2", emoji: "👍", remove: false }]);
});

test("composition validates targets against this conversation and refuses unsupported threading fields", async () => {
  const f = await setup();
  for (const action of [{ kind: "reaction", messageId: "other-conversation", emoji: "👍", action: "add" },
    { kind: "sticker", file: "outbox/sticker.png", messageId: "other-conversation" }, { kind: "text", text: "Hello", replyTo: "inbound-1" }]) {
    await expect(f.replies.compose("contact-1", "Review", [action as ActionIntent], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  }
  expect(f.replies.view(f.state).drafts).toEqual([]); expect(f.grantRequests).toEqual([]); expect(f.sent).toEqual([]);
});

test("composition requires each current capability including the added disclosure text", async () => {
  for (const unavailable of ["reaction", "text"]) {
    const f = await setup(), client = f.ports.client()!, original = client.status;
    client.status = async (...args) => { const status = await original(...args); return { ...status, actions: { ...status.actions, [unavailable]: { available: false, reason: "Synthetic unavailable" } } }; };
    await expect(f.replies.compose("contact-1", "Review", [{ kind: "reaction", messageId: "inbound-1", emoji: "👍", action: "add" }], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
    expect(f.replies.view(f.state).drafts).toEqual([]); expect(f.sent).toEqual([]);
  }
});

test("composition rejects account or context drift before it stores any draft", async () => {
  for (const kind of ["account", "context"]) {
    const f = await setup(), client = f.ports.client()!;
    if (kind === "account") { const original = client.status; client.status = async (...args) => { const status = await original(...args); return { ...status, identity: { ...status.identity, accountSubject: "other" } }; }; }
    else { const original = client.poll; client.poll = async (...args) => { const enrollment = await original(...args); return { ...enrollment, revision: enrollment.revision + 1 }; }; }
    await expect(f.replies.compose("contact-1", "Review", [{ kind: "text", text: "Hello" }], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "conflict" });
    expect(f.replies.view(f.state).drafts).toEqual([]); expect(f.grantRequests).toEqual([]);
  }
});

test("composition binds imported contact assets by bytes and digest before owner review", async () => {
  const f = await setup(); await f.workspace.write("outbox/owner-note.txt", "Synthetic owner media");
  const review = await f.replies.compose("contact-1", "A note", [{ kind: "attachment", file: "outbox/owner-note.txt", name: "owner-note.txt", mimeType: "text/plain" }], AbortSignal.timeout(5000));
  expect(review.assets).toEqual([{ path: "outbox/owner-note.txt", bytes: 21, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
  expect(f.grantRequests).toEqual([]); expect(f.sent).toEqual([]);
  await f.workspace.write("outbox/owner-note.txt", "Different bytes");
  await expect(f.replies.send({ draftId: review.id, expectedDigest: review.digest }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(f.sent).toEqual([]);
});

test("composition rejects missing contacts, incomplete catchup, excess actions and invalid summaries", async () => {
  const f = await setup();
  await expect(f.replies.compose("other", "Review", [{ kind: "text", text: "Hello" }], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  for (const summary of ["", " ", "x".repeat(4097), "bad\0summary"]) await expect(f.replies.compose("contact-1", summary, [{ kind: "text", text: "Hello" }], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  await expect(f.replies.compose("contact-1", "Review", Array.from({ length: 8 }, () => ({ kind: "text" as const, text: "Hello" })), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  f.setReady(false);
  await expect(f.replies.compose("contact-1", "Review", [{ kind: "text", text: "Hello" }], AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable" });
  expect(f.replies.view(f.state).drafts).toEqual([]); expect(f.sent).toEqual([]);
});

test("reconcile resolves an uncertain send by observing the butler reply in history", async () => {
  const fixture = await setup();
  const journal = fixture.journal;
  journal.claim("uncertain-1", "contact-1", "event-1", NOW);
  journal.transition("uncertain-1", "running", "dispatching", "intent-recorded", NOW);
  journal.transition("uncertain-1", "dispatching", "indeterminate", "outcome unknown", NOW);
  // The reply actually landed: history carries the disclosed outgoing message
  // inside the dispatch window, unjournaled because the receipt was lost.
  fixture.messages.push({ ...fixture.messages[0]!, id: "landed-1", direction: "outgoing", text: "🤖{ Yes, 7 works. }", occurredAt: new Date(NOW + 60_000).toISOString() });
  const result = await fixture.replies.reconcile("contact-1", undefined, AbortSignal.timeout(5000));
  expect(result).toMatchObject({ contactId: "contact-1", runId: "uncertain-1", resolved: true, state: "submitted" });
  expect(journal.hasUncertainSend("contact-1")).toBe(false);
  // The observed message gains journal provenance for later history attribution.
  expect(journal.isButlerMessage("contact-1", "landed-1")).toBe(true);
  expect(journal.recent("contact-1")[0]?.reason).toContain("observed in conversation history");
});

test("reconcile without evidence leaves the run uncertain and reports it", async () => {
  const fixture = await setup();
  const journal = fixture.journal;
  journal.claim("uncertain-1", "contact-1", "event-1", NOW);
  journal.transition("uncertain-1", "running", "dispatching", "intent-recorded", NOW);
  journal.transition("uncertain-1", "dispatching", "indeterminate", "outcome unknown", NOW);
  const result = await fixture.replies.reconcile("contact-1", undefined, AbortSignal.timeout(5000));
  expect(result).toMatchObject({ contactId: "contact-1", runId: "uncertain-1", resolved: false });
  expect(result.detail).toContain("--failed");
  expect(journal.hasUncertainSend("contact-1")).toBe(true);
});

test("owner attestation reconciles and unblocks the next send", async () => {
  const fixture = await setup({ standingGrant: true });
  const journal = fixture.journal;
  journal.claim("uncertain-1", "contact-1", "event-1", NOW);
  journal.transition("uncertain-1", "running", "dispatching", "intent-recorded", NOW);
  journal.transition("uncertain-1", "dispatching", "indeterminate", "outcome unknown", NOW);
  expect((await fixture.replies.reconcile("contact-1", "failed", AbortSignal.timeout(5000)))).toMatchObject({ resolved: true, state: "failed" });
  expect(journal.hasUncertainSend("contact-1")).toBe(false);
  const sent = await fixture.replies.send({ contactId: "contact-1", text: "Sendable again" }, AbortSignal.timeout(5000));
  expect(sent.state).toBe("submitted");
  expect(fixture.sent).toEqual([[{ kind: "text", text: "🤖{ Sendable again }" }]]);
});

test("reconcile refuses unconfigured contacts and reports clean contacts", async () => {
  const fixture = await setup();
  await expect(fixture.replies.reconcile("missing", "sent", AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "invalid-request" });
  expect((await fixture.replies.reconcile("contact-1", "sent", AbortSignal.timeout(5000)))).toMatchObject({ resolved: true, detail: "No send is awaiting reconciliation." });
});
