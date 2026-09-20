import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { AgentMixer, CONTACT_TOOL_PROFILE, SqliteAccountLeases, type AgentAdapter, type ModelCatalog, type RuntimeQualification } from "@hraness/agentmixer";
import { automationBindingDigest, automationHash, createGhostgetAutomationClient, type AutomationMessage } from "../../transport/src/automation.ts";
import { automationBinding, createAutomationOwnerPort } from "./automation-owner.ts";
import type { ProviderHost } from "./provider-host.ts";
import { newContact, type Settings } from "./config.ts";
import { TextbutlerControlService, TEXTBUTLER_CONTROL_PROTOCOL as protocol, initializeOwnerState, parseControlRequest } from "./control-service.ts";
import { ContactWorkspace } from "./workspace.ts";
import { RunJournal } from "./journal.ts";
import { createProviderHost } from "./provider-host.ts";
import { parseHostConfig } from "./host-config.ts";
import { parseControlResponse } from "../../control/src/index.ts";

const roots: string[] = [], services: TextbutlerControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(contacts = true) {
  const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-control-")); roots.push(dataDir);
  const initialSettings: Settings = { schemaVersion: 1, paused: true, maxActiveContacts: 1, contacts: contacts ? [newContact("synthetic-a", "Synthetic A", "fixture-route-a"), newContact("synthetic-b", "Synthetic B", "fixture-route-b")] : [] };
  const service = await TextbutlerControlService.open({ dataDir, initialSettings }); services.push(service);
  return { service, dataDir };
}
describe("persistent owner control service", () => {
  test("provider shutdown failure still closes the private journal before custody can be released", async () => {
    const { service, dataDir } = await setup(false); await service.close(); services.splice(services.indexOf(service), 1);
    const reopened = await TextbutlerControlService.open({ dataDir, providers: leases => ({ ...createProviderHost({ dataDir, config: { schemaVersion: 1 }, leases }),
      async close() { throw new Error("Synthetic provider shutdown failure"); } }) });
    const journal = reopened.runJournal();
    await expect(reopened.close()).rejects.toThrow("Synthetic provider shutdown failure");
    expect(() => journal.claim("after-close", "contact", "event", 1)).toThrow();
  });
  test("fresh initialization is paused with no invented contacts or available provider capabilities", async () => {
    const { service } = await setup(false); const snapshot = await service.snapshot();
    expect(snapshot.connection).toBe("connected"); expect(snapshot.contacts).toEqual([]);
    expect(snapshot.settings.paused).toBe(true); expect(snapshot.capabilities.every(capability => capability.status !== "available")).toBe(true);
  });
  test("settings writes are conditional, persist to disk, and remain outside contact memory", async () => {
    const { service, dataDir } = await setup();
    const results = await Promise.all([false, true].map(paused => service.request({ protocol, command: "global.settings.update", expectedRevision: 1, settings: { paused, activeContactLimit: 2 } })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ code: "conflict" });
    const stored = JSON.parse(await readFile(join(dataDir, "state", "settings.json"), "utf8"));
    expect(stored).toMatchObject({ revision: 2, settings: { paused: false, maxActiveContacts: 2 } });
    await initializeOwnerState(dataDir); expect((await service.snapshot()).revision).toBe(2);
  });
  test("capacity and explicit contact identity are enforced on real settings", async () => {
    const { service } = await setup(); const snapshot = await service.snapshot();
    const settings = { ...snapshot.contacts[0]!.settings, enabled: true };
    expect((await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings })).ok).toBe(true);
    expect(await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-b", expectedRevision: 2, settings })).toMatchObject({ ok: false, code: "capacity" });
    expect(await service.request({ protocol, command: "contact.memory.read", contactId: "not-configured" })).toMatchObject({ ok: false, code: "invalid-request" });
  });
  test("memory revisions detect agent changes and do not share the settings revision", async () => {
    const { service, dataDir } = await setup();
    const read = await service.request({ protocol, command: "contact.memory.read", contactId: "synthetic-a" });
    if (!read.ok || read.kind !== "memory") throw new Error("Missing memory");
    expect(read.revision).toMatch(/^[a-f0-9]{64}$/u);
    const workspace = await ContactWorkspace.create(join(dataDir, "contacts", "synthetic-a"));
    await workspace.writeVersioned("MEMORY.md", "Agent changed this synthetic memory", read.revision);
    expect(await service.request({ protocol, command: "contact.memory.write", contactId: "synthetic-a", expectedRevision: read.revision, content: "Stale owner change" })).toMatchObject({ ok: false, code: "conflict" });
    const current = await workspace.readVersioned("MEMORY.md");
    const result = await service.request({ protocol, command: "contact.memory.write", contactId: "synthetic-a", expectedRevision: current.revision, content: "Owner correction" });
    expect(result).toMatchObject({ ok: true, kind: "memory", content: "Owner correction" });
    expect((await service.snapshot()).revision).toBe(1);
  });
  test("unknown fields, direct send commands and traversal never reach a handler", () => {
    for (const request of [{ protocol, command: "snapshot", shell: "whoami" }, { protocol, command: "send" }, { protocol, command: "contact.memory.read", contactId: "../other" }, { protocol, command: "contact.memory.write", contactId: "synthetic-a", expectedRevision: 1, content: "x" }, { protocol, command: "provider.accounts.check", accountId: "account", credential: "private" }, { protocol, command: "provider.accounts.check", accountId: "../other" }]) expect(() => parseControlRequest(request)).toThrow();
  });
  test("account selection is explicit and older settings retain their existing binding", async () => {
    const { service, dataDir } = await setup(); await service.close(); services.splice(services.indexOf(service), 1);
    const config = parseHostConfig({ schemaVersion: 1, providerAccounts: [{ id: "api-owner", label: "API owner", route: "claude-api", credentialFile: "api-owner-key", replyModel: "synthetic-model", prices: { observedAt: 1, models: [{ id: "synthetic-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2, classifierEligible: true }] } }] });
    const reopened = await TextbutlerControlService.open({ dataDir, providers: leases => createProviderHost({ dataDir, config, leases }) }); services.push(reopened);
    const initial = await reopened.snapshot(), { accountId: _accountId, ...oldSettings } = initial.contacts[0]!.settings;
    const legacy = await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings: { ...oldSettings, provider: "claude" } });
    expect(legacy).toMatchObject({ ok: true, kind: "snapshot", snapshot: { contacts: [{ settings: { accountId: "default", provider: "claude" } }, {}] } });
    const selected = await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 2, settings: { ...oldSettings, provider: "claude", accountId: "api-owner" } });
    expect(selected.ok).toBe(true);
    expect(await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 3, settings: { ...oldSettings, provider: "claude" } })).toMatchObject({ ok: true });
    expect((await reopened.settings()).contacts[0]).toMatchObject({ accountId: "api-owner", provider: "claude" });
    expect(await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 4, settings: { ...oldSettings, provider: "codex", accountId: "api-owner" } })).toMatchObject({ ok: false, code: "invalid-request" });
    const snapshot = await reopened.snapshot(); expect(snapshot.revision).toBe(4);
    expect(snapshot.providerAccounts?.some(account => account.id === "api-owner" && account.route === "claude-api")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("api-owner-key");
    expect(snapshot.settings.paused).toBe(true);
  });
  test("provider checks use bounded owner jobs without changing settings or blocking pause", async () => {
    const { service, dataDir } = await setup(); await service.close(); services.splice(services.indexOf(service), 1);
    let finish!: () => void, checked = "";
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const reopened = await TextbutlerControlService.open({ dataDir, providers: leases => ({ ...createProviderHost({ dataDir, config: { schemaVersion: 1 }, leases }),
      async check(accountId, signal) { checked = accountId; await ready; signal.throwIfAborted(); },
    }) }); services.push(reopened);
    const job = await reopened.request({ protocol, command: "provider.accounts.check", accountId: "synthetic-api" });
    if (!job.ok || job.kind !== "job") throw new Error("Expected owner job");
    expect(checked).toBe("synthetic-api");
    expect(await reopened.request({ protocol, command: "provider.accounts.check", accountId: "synthetic-api" })).toMatchObject({ ok: false, code: "capacity" });
    expect(await reopened.request({ protocol, command: "global.settings.update", expectedRevision: 1, settings: { paused: true, activeContactLimit: 1 } })).toMatchObject({ ok: true });
    finish();
    let response = await reopened.request({ protocol, command: "owner.job.read", jobId: job.jobId });
    for (let i = 0; response.ok && response.kind === "job" && i < 5; i++) response = await reopened.request({ protocol, command: "owner.job.read", jobId: job.jobId });
    expect(response).toMatchObject({ ok: true, kind: "snapshot", snapshot: { revision: 2, settings: { paused: true } } });
    expect((await reopened.snapshot()).activity).toEqual([]);
  });
  test("activity projects actual journal runs", async () => {
    const { service, dataDir } = await setup();
    await service.close(); services.splice(services.indexOf(service), 1);
    const journal = await RunJournal.open(join(dataDir, "state", "runs.sqlite"));
    expect(journal.claim("synthetic-run", "synthetic-a", "synthetic-event", 1000)).toBe(true);
    journal.transition("synthetic-run", "running", "ignored", "classifier-silent", 2000); journal.close();
    const reopened = await TextbutlerControlService.open({ dataDir }); services.push(reopened);
    const result = await reopened.request({ protocol, command: "activity.list" });
    expect(result).toMatchObject({ ok: true, kind: "snapshot", snapshot: { activity: [{ id: "synthetic-run", title: "ignored", detail: "classifier-silent" }] } });
  });
  test("unsafe owner settings and linked contact parents fail without exposing or overwriting files", async () => {
    const { service, dataDir } = await setup();
    await chmod(join(dataDir, "state", "settings.json"), 0o644);
    expect(await service.request({ protocol, command: "snapshot" })).toMatchObject({ ok: false, code: "unavailable" });
    await chmod(join(dataDir, "state", "settings.json"), 0o600);
    await rm(join(dataDir, "contacts"), { recursive: true });
    await symlink(join(dataDir, "state"), join(dataDir, "contacts"));
    expect(await service.request({ protocol, command: "contact.memory.read", contactId: "synthetic-a" })).toMatchObject({ ok: false, code: "unavailable" });
    await unlink(join(dataDir, "contacts"));
  });
});

describe("owner reply triage through the control surface", () => {
  async function replySetup(options: { afterGrant?: () => Promise<void>; afterRevoke?: () => Promise<void>; failRevoke?: boolean; enabled?: boolean } = {}) {
    const REPLY_NOW = Date.now();
    const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-replies-")); roots.push(dataDir);
    const contact = { ...newContact("synthetic-a", "Synthetic A", "enrollment:fixture"), enabled: options.enabled ?? true };
    await initializeOwnerState(dataDir, { schemaVersion: 1, paused: true, maxActiveContacts: 1, contacts: [contact] });
    const identity = { provider: "imessage" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
    const conversation = { coordinate: { provider: "imessage" as const, chatGuid: "iMessage;-;fixture@example.test", service: "iMessage" as const, observedChatRowId: 1 }, title: "Synthetic", kind: "single" as const, participants: ["fixture@example.test"] };
    const enrolled = () => ({ id: "enrollment:fixture", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 0, ready: true, reason: null });
    const binding = automationBinding(enrolled());
    const messages: AutomationMessage[] = [{ id: "inbound-1", coordinate: conversation.coordinate, direction: "incoming", occurredAt: new Date(REPLY_NOW - 10_000).toISOString(), text: "Can you pick up dinner?", kind: "message", relatedMessageId: null, attachments: [] }];
    const sent: readonly unknown[][] = [], mutableSent = sent as unknown[][], plans = new Map<string, { id: string; intentId: string; actions: readonly unknown[] }>();
    const grantStore = new Map<string, Record<string, unknown>>(); let grantSequence = 0;
    const client = createGhostgetAutomationClient(async (method, params) => {
      if (method === "poll") return enrolled();
      if (method === "history") return { enrollment: enrolled(), messages: messages.slice(-Number(params.limit)) };
      if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: true, reason: null }])) };
      if (method === "prepare") { const body = { ...params, bindingDigest: binding.bindingDigest, expiresAt: new Date(REPLY_NOW + 120_000).toISOString() }, digest = automationHash(body), plan = { ...body, digest, id: `plan:${digest}` }; plans.set(plan.id as string, plan as never); return plan; }
      if (method === "submit") { const plan = plans.get(String(params.planId))!; mutableSent.push([...plan.actions]); return { id: "run:1", planId: plan.id, intentId: plan.intentId, enrollmentId: binding.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:1:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
      if (method === "cancel") return { cancelled: true };
      if (method === "grant") { const { intentId: _intentId, ...request } = params as Record<string, unknown>; const grant = { ...request, id: `grant:${++grantSequence}`, revoked: false, consumedActions: 0 }; grantStore.set(grant.id as string, grant); await options.afterGrant?.(); return grant; }
      if (method === "grant.get") { const grant = grantStore.get(String(params.grantId)); if (!grant) throw new Error("Unknown grant"); return grant; }
      if (method === "grant.by-intent") return { grant: null };
      if (method === "revoke") { if (options.failRevoke) throw new Error("Synthetic revocation unavailable"); const grant = grantStore.get(String(params.grantId)); if (grant) grantStore.set(grant.id as string, { ...grant, revoked: true }); await options.afterRevoke?.(); return { revoked: true }; }
      throw new Error(`Unexpected fixture operation ${method}`);
    }, () => REPLY_NOW);
    const qualification: RuntimeQualification = { status: "qualified", profile: CONTACT_TOOL_PROFILE, runtimeVersion: "synthetic-test-only",
      runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), expiresAt: Date.now() + 86_400_000,
      controls: { noCommandTools: true, exactToolInventory: true, contactReadIsolation: true, contactWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } };
    const modelCatalog: ModelCatalog = { provider: "codex", observedAt: Date.now(),
      models: [{ id: "reply-pinned", inputUsdPerMillion: 1, outputUsdPerMillion: 5, available: true, supportsStructuredOutput: true, classifierEligible: true }] };
    const adapter: AgentAdapter = { provider: "codex", qualification, async run() { return { output: { summary: "Suggestion", actions: [{ kind: "text", text: "On it." }] }, processStopped: true }; } };
    const db = new Database(":memory:");
    const providers = { router: new AgentMixer({ adapters: [adapter], leases: new SqliteAccountLeases(db), now: () => REPLY_NOW }),
      accounts: () => [{ id: "account-one", status: "ready", route: "codex-cli", detail: null }],
      check: async () => { throw new Error("not used"); }, startLogin: async () => { throw new Error("not used"); },
      cancelLogin: async () => { throw new Error("not used"); }, logout: async () => { throw new Error("not used"); },
      runManagedTask: async () => { throw new Error("not used"); },
      selection: async () => ({ qualification, modelCatalog, defaultReplyModel: "reply-pinned" }),
      validateAccountChange: () => {}, close: async () => { db.close(); } } as unknown as ProviderHost;
    // Persist the messaging binding so the reopened service sees an exact enrollment.
    const settingsPath = join(dataDir, "state", "settings.json");
    const state = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, `${JSON.stringify({ ...state, bindings: { "synthetic-a": binding } }, null, 2)}\n`, { mode: 0o600 });
    const service = await TextbutlerControlService.open({ dataDir, providers: () => providers,
      automation: createAutomationOwnerPort({ client, providers: ["imessage"], now: () => REPLY_NOW }), client });
    services.push(service);
    const run = async (request: Record<string, unknown>) => {
      let response = await service.request({ protocol, ...request });
      for (let i = 0; response.ok && response.kind === "job" && i < 400; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        response = await service.request({ protocol, command: "owner.job.read", jobId: response.jobId });
      }
      return response;
    };
    return { service, sent, db, run, dataDir, grantStore };
  }
  test("history, capabilities and explicit rich drafts use bounded owner jobs without dispatch", async () => {
    const { run, sent } = await replySetup();
    const history = await run({ command: "messages.history", contactId: "synthetic-a", limit: 20 });
    expect(history).toMatchObject({ ok: true, kind: "message-history", contactId: "synthetic-a", messages: [{ id: "inbound-1", author: "contact", text: "Can you pick up dinner?" }] });
    expect(parseControlResponse(JSON.parse(JSON.stringify(history)))).toEqual(history);
    const capabilities = await run({ command: "messages.capabilities", contactId: "synthetic-a" });
    expect(capabilities).toMatchObject({ ok: true, kind: "message-capabilities", ready: true, threadedReplies: { available: false } });
    expect(parseControlResponse(JSON.parse(JSON.stringify(capabilities)))).toEqual(capabilities);
    const composed = await run({ command: "replies.compose", contactId: "synthetic-a", summary: "Acknowledge dinner", actions: [{ kind: "reaction", messageId: "inbound-1", emoji: "👍", action: "add" }] });
    expect(composed).toMatchObject({ ok: true, kind: "reply-draft", draft: { actions: [{ kind: "text", text: "🤖{ Acknowledge dinner }" }, { kind: "reaction", messageId: "inbound-1", emoji: "👍", action: "add" }] } });
    expect(parseControlResponse(JSON.parse(JSON.stringify(composed)))).toEqual(composed);
    expect(sent).toEqual([]);
    expect(await run({ command: "messages.summarize", contactId: "synthetic-a", limit: 20 })).toMatchObject({ ok: false, code: "unavailable" });
  });
  test("message command parsing rejects unbounded history and arbitrary actions or paths", () => {
    for (const limit of [0, 201, 1.5, "20", undefined]) expect(() => parseControlRequest({ protocol, command: "messages.history", contactId: "synthetic-a", limit })).toThrow();
    for (const command of ["messages.history", "messages.summarize"]) expect(parseControlRequest({ protocol, command, contactId: "synthetic-a", limit: 200 })).toMatchObject({ command, limit: 200 });
    for (const command of ["messages.history", "messages.summarize", "messages.capabilities"]) expect(() => parseControlRequest({ protocol, command, contactId: "../other", limit: 20 })).toThrow();
    for (const actions of [[], Array.from({ length: 8 }, () => ({ kind: "text", text: "Hi" })), [{ kind: "shell", command: "whoami" }],
      [{ kind: "text", text: "Hi", replyTo: "inbound-1" }], [{ kind: "attachment", file: "/private/owner-file", mimeType: "text/plain", name: "file" }]])
      expect(() => parseControlRequest({ protocol, command: "replies.compose", contactId: "synthetic-a", summary: "Review", actions })).toThrow();
    expect(parseControlRequest({ protocol, command: "replies.compose", contactId: "synthetic-a", summary: "Review", actions: [{ kind: "text", text: "Hi" }] })).toMatchObject({ command: "replies.compose" });
    expect(() => parseControlRequest({ protocol, command: "messages.capabilities", contactId: "synthetic-a", force: true })).toThrow();
  });
  test("scan, suggest, send and discard stay behind owner commands", async () => {
    const { service, sent, run } = await replySetup();
    const scan = await run({ command: "replies.scan" });
    expect(scan).toMatchObject({ ok: true, kind: "replies", checked: 1, unreadable: 0,
      pending: [{ contactId: "synthetic-a", pendingCount: 1, sendable: true, preview: "Can you pick up dinner?" }] });
    const suggest = await run({ command: "replies.suggest", contactId: "synthetic-a" });
    expect(suggest).toMatchObject({ ok: true, kind: "reply-suggestion", draft: { contactId: "synthetic-a", preview: "🤖{ On it. }" } });
    expect(sent).toEqual([]);
    if (!suggest.ok || suggest.kind !== "reply-suggestion") throw new Error("Missing suggestion");
    expect(await run({ command: "replies.send", draftId: suggest.draft!.id })).toMatchObject({ ok: false, code: "invalid-request" });
    const reviewed = await run({ command: "replies.draft.read", draftId: suggest.draft!.id });
    if (!reviewed.ok || reviewed.kind !== "reply-draft") throw new Error("Missing complete draft");
    expect(reviewed.draft.actions).toEqual([{ kind: "text", text: "🤖{ On it. }" }]);
    expect(parseControlResponse(JSON.parse(JSON.stringify(reviewed)))).toEqual(reviewed);
    expect(() => parseControlResponse({ ...reviewed, draft: { ...reviewed.draft, digest: "wrong" } })).toThrow();
    expect(() => parseControlResponse({ ...reviewed, draft: { ...reviewed.draft, actions: [{ kind: "shell", command: "no" }] } })).toThrow();
    const sentReply = await run({ command: "replies.send", draftId: suggest.draft!.id, expectedDigest: reviewed.draft.digest });
    expect(sentReply).toMatchObject({ ok: true, kind: "reply-sent", state: "submitted" });
    expect(sent).toEqual([[{ kind: "text", text: "🤖{ On it. }" }]]);
    const snapshot = await service.snapshot();
    expect(snapshot.replies?.drafts).toEqual([]);
    const literal = await run({ command: "replies.send", contactId: "synthetic-a", text: "Direct answer" });
    expect(literal).toMatchObject({ ok: true, kind: "reply-sent", state: "submitted" });
    expect(sent[1]).toEqual([{ kind: "text", text: "🤖{ Direct answer }" }]);
    expect(await run({ command: "replies.discard", draftId: "draft:missing" })).toMatchObject({ ok: true, kind: "reply-discarded", discarded: false });
  });
  test("reply commands fail closed without messaging automation and never invent sends", async () => {
    const { service } = await setup();
    for (const request of [
      { protocol, command: "replies.scan" },
      { protocol, command: "replies.suggest", contactId: "synthetic-a" },
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "Hi" },
      { protocol, command: "replies.send", draftId: "draft:none", expectedDigest: "a".repeat(64) },
      { protocol, command: "replies.draft.read", draftId: "draft:none" },
      { protocol, command: "replies.discard", draftId: "draft:none" },
    ]) expect(await service.request(request as never)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await service.snapshot()).replies).toBeUndefined();
  });
  test("reply request parsing rejects empty text, mixed send forms and extra fields", () => {
    for (const request of [
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "" },
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "hi", draftId: "draft:1" },
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "hi", extra: 1 },
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "hi", expectedRevision: 0 },
      { protocol, command: "replies.send", contactId: "synthetic-a", text: "hi", expectedRevision: undefined },
      { protocol, command: "replies.send", draftId: "draft:1" },
      { protocol, command: "replies.send", draftId: "draft:1", expectedDigest: "bad" },
      { protocol, command: "replies.suggest" },
      { protocol, command: "replies.suggest", contactId: "../bad" },
      { protocol, command: "replies.scan", contactId: "synthetic-a" },
      { protocol, command: "replies.discard" },
    ]) expect(() => parseControlRequest(request)).toThrow();
    expect(parseControlRequest({ protocol, command: "replies.send", contactId: "synthetic-a", text: "hi" })).toMatchObject({ command: "replies.send" });
    expect(parseControlRequest({ protocol, command: "replies.send", contactId: "synthetic-a", text: "hi", expectedRevision: 4 })).toMatchObject({ command: "replies.send", expectedRevision: 4 });
    expect(parseControlRequest({ protocol, command: "replies.send", draftId: "draft:1", expectedDigest: "a".repeat(64) })).toMatchObject({ command: "replies.send", draftId: "draft:1" });
    expect(parseControlRequest({ protocol, command: "replies.draft.read", draftId: "draft:1" })).toMatchObject({ command: "replies.draft.read", draftId: "draft:1" });
  });
  test("literal replies bound to an old preview are rejected before an owner send job", async () => {
    const { service, sent, run } = await replySetup();
    const previous = await service.snapshot();
    const changed = await service.request({ protocol, command: "global.settings.update", expectedRevision: previous.revision,
      settings: { ...previous.settings, paused: !previous.settings.paused } });
    expect(changed.ok).toBe(true);
    const stale = await service.request({ protocol, command: "replies.send", contactId: "synthetic-a", text: "Reviewed reply", expectedRevision: previous.revision });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect(sent).toEqual([]);
    const current = await service.snapshot();
    expect(await run({ command: "replies.send", contactId: "synthetic-a", text: "Reviewed reply", expectedRevision: current.revision })).toMatchObject({ ok: true, kind: "reply-sent", state: "submitted" });
    expect(sent).toEqual([[{ kind: "text", text: "🤖{ Reviewed reply }" }]]);
  });
  test("shutdown cannot acknowledge an unpublished grant or erase uncertain revocation", async () => {
    let arrived!: () => void, release!: () => void;
    const grantArrived = new Promise<void>(resolve => { arrived = resolve; });
    const grantResponse = new Promise<void>(resolve => { release = resolve; });
    const fixture = await replySetup({ failRevoke: true, afterGrant: async () => { arrived(); await grantResponse; } });
    const admitted = await fixture.service.request({ protocol, command: "replies.send", contactId: "synthetic-a", text: "Shutdown must retain custody" });
    expect(admitted).toMatchObject({ ok: true, kind: "job" });
    await grantArrived;
    const closing = fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);
    release();
    await closing.catch(() => undefined);
    expect(fixture.sent).toEqual([]);
    expect(fixture.grantStore.get("grant:1")?.revoked).toBe(false);
    const settings = JSON.parse(await readFile(join(fixture.dataDir, "state", "settings.json"), "utf8"));
    expect(settings.grants).toEqual({});
    const recovered = await RunJournal.open(join(fixture.dataDir, "state", "runs.sqlite"));
    try {
      expect(recovered.pendingGrants()).toMatchObject([{ contactId: "synthetic-a", grant: { id: "grant:1" } }]);
      expect(recovered.grantIntents()).toEqual([]);
    } finally { recovered.close(); }
  });
  test("a job deadline during grant cleanup cannot erase a submitted send receipt", async () => {
    let deadline: (() => void) | undefined, cleanupObserved = false;
    const fixture = await replySetup({ enabled: false, afterRevoke: async () => {
      cleanupObserved = true;
      expect(fixture.sent).toHaveLength(1);
      expect(deadline).toBeDefined();
      deadline!();
    } });
    const originalSetTimeout = globalThis.setTimeout;
    const interceptedTimeout = new Proxy(originalSetTimeout, { apply(target, thisArg, timerArgs) {
      const [handler, timeout, ...args] = timerArgs;
      if (timeout === 120_000 && typeof handler === "function") deadline = () => Reflect.apply(handler, undefined, args);
      return Reflect.apply(target, thisArg, timerArgs);
    } });
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(interceptedTimeout);
    try {
      const result = await fixture.run({ command: "replies.send", contactId: "synthetic-a", text: "Already accepted" });
      expect(cleanupObserved).toBe(true);
      expect(result).toMatchObject({ ok: true, kind: "reply-sent", state: "submitted" });
      expect(fixture.sent).toEqual([[{ kind: "text", text: "🤖{ Already accepted }" }]]);
      expect(fixture.service.runJournal().recent("synthetic-a", 1)).toMatchObject([{ state: "submitted" }]);
      expect(fixture.grantStore.get("grant:1")?.revoked).toBe(true);
    } finally { timer.mockRestore(); }
  });
  test("owner settings can explicitly clear disclosure markers", async () => {
    const { service } = await setup();
    const snapshot = await service.snapshot(), contact = snapshot.contacts[0]!;
    const response = await service.request({ protocol, command: "contact.settings.update", contactId: contact.id, expectedRevision: snapshot.revision,
      settings: { ...contact.settings, disclosure: { character: "", begin: "", end: "" } } });
    expect(response).toMatchObject({ ok: true, kind: "snapshot", snapshot: { contacts: [{ settings: { disclosure: { character: "", begin: "", end: "" } } }, {}] } });
  });
});
