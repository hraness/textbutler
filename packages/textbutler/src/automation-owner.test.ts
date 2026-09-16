import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { AUTOMATION_ACTIONS, automationBindingDigest, createGhostgetAutomationClient, type AutomationGrant, type AutomationGrantRequest,
  type AutomationEnrollment, type AutomationProvider } from "../../transport/src/automation.ts";
import { createAutomationOwnerPort, parseAutomationBinding, automationBinding } from "./automation-owner.ts";
import { TextbutlerControlService, TEXTBUTLER_CONTROL_PROTOCOL as protocol } from "./control-service.ts";
import { createProviderHost, type ProviderHost } from "./provider-host.ts";
import { parseHostConfig } from "./host-config.ts";
import { parseControlResponse, type ControlResponse } from "../../control/src/index.ts";
import { contactCapabilityIdentity, type ButlerPurpose } from "./contact-capabilities.ts";
import type { ProviderSelection } from "./routed-agent.ts";

const roots: string[] = [], services: TextbutlerControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture(provider: AutomationProvider = "imessage") {
  const now = Date.now(), calls: string[] = [], revoked: string[] = [], grants: AutomationGrant[] = [];
  const identity = { provider, authId: "synthetic", accountIdentity: "a".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "b".repeat(64), sourceGeneration: "synthetic-generation" };
  const coordinate = provider === "imessage" ? { provider, chatGuid: "iMessage;-;synthetic", service: "iMessage" as const, observedChatRowId: 1 } : { provider, conversationJid: "12345@s.whatsapp.net" };
  const conversation = { coordinate, title: "Synthetic person", kind: "single" as const, participants: ["synthetic-person"] };
  const enrollment: AutomationEnrollment = { id: `enrollment:${provider}`, identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 0, ready: true, reason: null };
  let enrolled = false, drift = false, blockGrant: (() => Promise<void>) | undefined, revokeFails = false, loseGrant = false;
  const intents = new Map<string, AutomationGrant>();
  const status = { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(AUTOMATION_ACTIONS.map(kind => [kind, { available: ["text", "attachment", "reaction"].includes(kind), reason: ["text", "attachment", "reaction"].includes(kind) ? null : "Unavailable in fixture" }])) };
  const client = createGhostgetAutomationClient(async (method, params) => {
    calls.push(method);
    if (method === "status" || method === "start") return status;
    if (method === "conversations") return { identity, conversations: [conversation], complete: true };
    if (method === "enrollments") return enrolled ? [enrollment] : [];
    if (method === "enroll") { enrolled = true; return enrollment; }
    if (method === "poll") return drift ? { ...enrollment, identity: { ...identity, sourceGeneration: "replacement" }, bindingDigest: automationBindingDigest({ ...identity, sourceGeneration: "replacement" }, conversation) } : enrollment;
    if (method === "history") return { enrollment, messages: [{ id: "message-1", coordinate, direction: "incoming", occurredAt: new Date(now - 1000).toISOString(), text: "Synthetic memory", kind: "message", relatedMessageId: null, attachments: [] }] };
    if (method === "grant") {
      await blockGrant?.();
      const { intentId, ...request } = params as unknown as AutomationGrantRequest & { intentId: string };
      const grant = { ...request, id: `grant:${grants.length + 1}`, revoked: false, consumedActions: 0 }; grants.push(grant); intents.set(intentId, grant);
      if (loseGrant) throw new Error("Synthetic grant committed but response lost"); return grant;
    }
    if (method === "grant.by-intent") return { grant: intents.get(String(params.intentId)) ?? null };
    if (method === "grant.get") return { ...grants.find(grant => grant.id === params.grantId)! };
    if (method === "revoke") { if (revokeFails) throw new Error("Synthetic unresolved revocation"); revoked.push(String(params.grantId)); const grant = grants.find(grant => grant.id === params.grantId); if (grant) grant.revoked = true; return { revoked: true }; }
    throw new Error(`Unexpected synthetic method ${method}`);
  });
  const port = createAutomationOwnerPort({ client, providers: [provider], now: () => now });
  return { port, calls, grants, revoked, enrollment, candidate: { identity, conversation }, drift: () => { drift = true; },
    loseGrantResponse: () => { loseGrant = true; },
    block: (work: () => Promise<void>) => { blockGrant = work; }, failRevoke: () => { revokeFails = true; }, recoverRevoke: () => { revokeFails = false; } };
}
async function finish(service: TextbutlerControlService, initial: ControlResponse): Promise<ControlResponse> {
  let response = initial;
  for (let count = 0; response.ok && response.kind === "job" && count < 200; count++) { await Bun.sleep(2); response = await service.request({ protocol, command: "owner.job.read", jobId: response.jobId }); }
  if (response.ok && response.kind === "job") throw new Error("Synthetic job did not finish"); return response;
}
async function waitForMessagingState(service: TextbutlerControlService, contactId: string, expected: "recovery-required" | "missing") {
  const deadline = performance.now() + 2000;
  let state;
  do {
    state = (await service.snapshot()).contacts.find(contact => contact.id === contactId)?.messaging?.state;
    if (state === expected) return;
    await Bun.sleep(5);
  } while (performance.now() < deadline);
  expect(state).toBe(expected);
}
function syntheticModels(provider: "claude" | "codex") {
  return { provider, observedAt: Date.now(), models: [{ id: "synthetic-model", available: true, supportsStructuredOutput: true,
    classifierEligible: true, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }] };
}
function managedSelection(purpose: ButlerPurpose): Extract<ProviderSelection, { kind: "managed" }> {
  const route = { id: `synthetic-codex-${purpose}`, provider: "codex" as const, authentication: "subscription" as const };
  return { kind: "managed", route, defaultReplyModel: "synthetic-model", modelCatalog: syntheticModels("codex"),
    qualification: { status: "qualified", route, profile: contactCapabilityIdentity(purpose), runtimeVersion: "synthetic-control-fixture",
      runtimeDigest: "1".repeat(64), evidenceDigest: "2".repeat(64), expiresAt: Date.now() + 600_000,
      controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
        isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } } };
}
async function serviceFixture(f: ReturnType<typeof fixture>, selection?: ProviderHost["selection"]) {
  const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-automation-")); roots.push(dataDir);
  const config = parseHostConfig({ schemaVersion: 1, providerAccounts: [{ id: "synthetic-api", label: "Synthetic API", route: "claude-api", credentialFile: "synthetic-key", replyModel: "synthetic-model",
    prices: { observedAt: Date.now(), models: [{ id: "synthetic-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2, classifierEligible: true }] } },
    { id: "synthetic-managed", label: "Synthetic managed account", route: "codex" }] });
  const service = await TextbutlerControlService.open({ dataDir, automation: f.port, providers: leases => ({ ...createProviderHost({ dataDir, config, leases }),
    selection: selection ?? (async () => ({ qualification: { status: "qualified", profile: "agentmixer.scoped-tools.v1", runtimeVersion: "synthetic-control-fixture", runtimeDigest: "1".repeat(64), evidenceDigest: "2".repeat(64), expiresAt: Date.now() + 60_000,
      controls: { noCommandTools: true, exactToolInventory: true, contactReadIsolation: true, contactWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } },
      defaultReplyModel: "synthetic-model", modelCatalog: syntheticModels("claude") })),
  }) }); services.push(service);
  const listing = await finish(service, await service.request({ protocol, command: "conversations.list" }));
  if (!listing.ok || listing.kind !== "conversations") throw new Error("Missing synthetic conversations");
  const enrolled = await finish(service, await service.request({ protocol, command: "contact.enroll", candidateId: listing.candidates[0]!.id, expectedRevision: 1, initializeHistory: true }));
  if (!enrolled.ok || enrolled.kind !== "enrolled") throw new Error("Missing synthetic enrollment");
  return { service, dataDir, contactId: enrolled.contactId, initial: enrolled.snapshot.contacts[0]!.settings };
}

for (const responseMode of ["smart", "keyword"] as const) {
  test(`${responseMode} activation validates every required purpose before granting messaging access`, async () => {
    const f = fixture(), purposes: ButlerPurpose[] = [];
    const { service, contactId, initial } = await serviceFixture(f, async (contact, purpose) => {
      if (!purpose) throw Error("Readiness requires an explicit purpose");
      expect(contact).toMatchObject({ provider: "codex", accountId: "synthetic-managed", mode: responseMode });
      expect(f.calls).not.toContain("grant"); purposes.push(purpose);
      return managedSelection(purpose);
    });
    const result = await finish(service, await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 2,
      settings: { ...initial, enabled: true, responseMode, provider: "codex", accountId: "synthetic-managed" } }));
    expect(result).toMatchObject({ ok: true, kind: "snapshot" });
    expect(purposes).toEqual(responseMode === "smart" ? ["classify", "respond"] : ["respond"]);
    expect(f.grants).toHaveLength(1); expect((await service.settings()).contacts[0]!.enabled).toBe(true);
  });
}

for (const defect of ["missing-classifier", "stale-classifier", "stale-response", "wrong-classifier-profile", "wrong-response-profile",
  "malformed-runtime-digest", "malformed-evidence-digest", "missing-runtime-version"] as const) {
  test(`smart activation refuses ${defect} before any messaging grant or intent`, async () => {
    const f = fixture(), purposes: ButlerPurpose[] = [];
    const failingPurpose = defect === "stale-response" || defect === "wrong-response-profile" ? "respond" : "classify";
    const { service, contactId, initial } = await serviceFixture(f, async (_, purpose) => {
      if (!purpose) throw Error("Readiness requires an explicit purpose");
      purposes.push(purpose);
      const value = managedSelection(purpose);
      if (purpose !== failingPurpose) return value;
      if (defect === "missing-classifier") return { ...value, modelCatalog: { ...value.modelCatalog,
        models: value.modelCatalog.models.map(model => ({ ...model, classifierEligible: false })) } };
      if (defect === "stale-classifier" || defect === "stale-response") return { ...value,
        modelCatalog: { ...value.modelCatalog, observedAt: Date.now() - 86_400_001 } };
      if (value.qualification.status !== "qualified") throw Error("Expected qualified synthetic fixture");
      if (defect === "wrong-classifier-profile" || defect === "wrong-response-profile") return { ...value,
        qualification: { ...value.qualification, profile: contactCapabilityIdentity(purpose === "classify" ? "respond" : "classify") } };
      if (defect === "malformed-runtime-digest") return { ...value, qualification: { ...value.qualification, runtimeDigest: "invalid" } };
      if (defect === "malformed-evidence-digest") return { ...value, qualification: { ...value.qualification, evidenceDigest: "invalid" } };
      const { runtimeVersion: _omitted, ...qualification } = value.qualification;
      return { ...value, qualification } as unknown as ProviderSelection;
    });
    const result = await finish(service, await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 2,
      settings: { ...initial, enabled: true, responseMode: "smart", provider: "codex", accountId: "synthetic-managed" } }));
    expect(result.ok).toBe(false);
    expect(purposes).toEqual(failingPurpose === "respond" ? ["classify", "respond"] : ["classify"]);
    expect(f.calls).not.toContain("grant"); expect(f.grants).toEqual([]);
    expect(service.runJournal().grantIntents()).toEqual([]); expect(service.runJournal().pendingGrants()).toEqual([]);
    expect((await service.runtimeState()).grants).toEqual({}); expect((await service.settings()).contacts[0]!.enabled).toBe(false);
  });
}

test("owner automation has explicit startup, exact network identity and opt-in context import", async () => {
  for (const provider of ["imessage", "whatsapp"] as const) {
    const f = fixture(provider), signal = new AbortController().signal;
    expect(f.calls).toEqual([]);
    const listed = await f.port.list(signal); expect(f.calls).toEqual(["conversations"]);
    const first = await f.port.enroll(listed[0]!, false, signal);
    expect(first.messages).toEqual([]); expect(f.calls).not.toContain("history"); expect(f.calls).not.toContain("grant"); expect(f.calls).not.toContain("start");
    expect(parseAutomationBinding(first.binding).enrollmentId).toBe(f.enrollment.id);
    expect(() => parseAutomationBinding({ ...first.binding, bindingDigest: "0".repeat(64) })).toThrow();
    const imported = await f.port.enroll(listed[0]!, true, signal);
    expect(imported.messages).toMatchObject([{ author: "contact", text: "Synthetic memory" }]);
    expect(f.calls.filter(method => method === "enroll")).toHaveLength(1);
    await f.port.start(provider, signal); expect(f.calls.at(-1)).toBe("start");
    f.drift(); await expect(f.port.grant(first.binding, "synthetic-intent", signal)).rejects.toThrow("changed"); expect(f.grants).toHaveLength(0);
  }
});

test("v2 control enrollment stores identity and grants outside contact memory and supports explicit enable/disable", async () => {
  const f = fixture("whatsapp"), { service, dataDir, contactId, initial } = await serviceFixture(f);
  const runtime = await service.runtimeState();
  expect(runtime.settings.contacts[0]).toMatchObject({ enabled: false, routeId: f.enrollment.id });
  expect(runtime.bindings[contactId]).toEqual(automationBinding(f.enrollment)); expect(runtime.grants).toEqual({});
  expect(await readFile(join(dataDir, "contacts", contactId, "MEMORY.md"), "utf8")).not.toContain(f.enrollment.identity.accountSubject);
  const notifications: boolean[] = []; service.onSettingsChanged(settings => notifications.push(settings.contacts[0]!.enabled));
  const enabled = await finish(service, await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 2,
    settings: { ...initial, enabled: true, provider: "claude", accountId: "synthetic-api" } }));
  expect(enabled).toMatchObject({ ok: true, kind: "snapshot" }); expect(f.grants).toHaveLength(1);
  expect(f.grants[0]).toMatchObject({ enrollmentId: f.enrollment.id, expectedBindingDigest: f.enrollment.bindingDigest, maximumActions: 100000 });
  expect(f.grants[0]!.actions).toEqual(["text", "attachment", "reaction"]);
  const selected = (await service.settings()).contacts[0]!;
  expect(await service.delegatedGrant(selected)).toBeNull(); // Global pause remains on.
  await service.request({ protocol, command: "global.settings.update", expectedRevision: 3, settings: { paused: false, activeContactLimit: 5 } });
  expect(await service.delegatedGrant(selected)).toBe(f.grants[0]!.id);
  f.failRevoke();
  expect(await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 4, settings: { ...initial, enabled: false, provider: "claude", accountId: "synthetic-api" } })).toMatchObject({ ok: true });
  expect(await service.delegatedGrant(selected)).toBeNull(); expect(notifications).toContain(false);
  await waitForMessagingState(service, contactId, "recovery-required");
  expect((await service.runtimeState()).grants[contactId]?.id).toBe(f.grants[0]!.id);
  expect((await service.snapshot()).contacts[0]?.messaging?.state).toBe("recovery-required");
  f.recoverRevoke();
  const fresh = await service.snapshot();
  expect(await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: fresh.revision, settings: fresh.contacts[0]!.settings })).toMatchObject({ ok: true });
  await waitForMessagingState(service, contactId, "missing");
  expect((await service.runtimeState()).grants).toEqual({}); expect(f.revoked).toContain(f.grants[0]!.id);
});

test("desktop capabilities retain provider limits for rich links and polls", async () => {
  const f = fixture("imessage"), { service } = await serviceFixture(f);
  await f.port.start("imessage", new AbortController().signal);
  const response = parseControlResponse(await service.request({ protocol, command: "snapshot" }));
  if (!response.ok || response.kind !== "snapshot") throw new Error("Missing capability snapshot");
  expect(response.snapshot.capabilities.find(value => value.id === "attachments")?.status).toBe("available");
  for (const id of ["links", "polls"] as const) expect(response.snapshot.capabilities.find(value => value.id === id)).toMatchObject({ status: "unsupported", detail: "iMessage: Unavailable in fixture" });
  const observed = f.port.observedCapabilities()[0]!;
  observed.status.actions["app-clip"].reason = "a".repeat(1024);
  observed.status.actions.experience.reason = "b".repeat(1024);
  f.port.observedCapabilities = () => [observed, { ...structuredClone(observed), status: { ...structuredClone(observed.status), identity: { ...observed.status.identity, provider: "whatsapp" } } }];
  const long = parseControlResponse(await service.request({ protocol, command: "snapshot" }));
  if (!long.ok || long.kind !== "snapshot") throw new Error("Missing bounded capability snapshot");
  expect(long.snapshot.capabilities.find(value => value.id === "mini-apps")?.detail).toEndWith("… Details shortened.");
});

test("a grant issued during a concurrent global pause is revoked and cannot activate the contact", async () => {
  const f = fixture(), { service, initial, contactId } = await serviceFixture(f);
  let unblock!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), wait = new Promise<void>(resolve => { unblock = resolve; });
  f.block(async () => { began(); await wait; });
  const job = await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 2, settings: { ...initial, enabled: true, provider: "claude", accountId: "synthetic-api" } });
  await started;
  expect(await service.request({ protocol, command: "global.settings.update", expectedRevision: 2, settings: { paused: true, activeContactLimit: 5 } })).toMatchObject({ ok: true });
  unblock(); expect(await finish(service, job)).toMatchObject({ ok: false, code: "conflict" });
  expect(f.revoked).toEqual(["grant:1"]); expect((await service.runtimeState()).grants).toEqual({}); expect((await service.settings()).contacts[0]?.enabled).toBe(false);
});

test("spent grants renew from live provider status and pending authority survives failed cleanup plus restart", async () => {
  const f = fixture(), { service, initial, contactId, dataDir } = await serviceFixture(f);
  const request = { protocol, command: "contact.settings.update", contactId, expectedRevision: 2, settings: { ...initial, enabled: true, provider: "claude", accountId: "synthetic-api" } };
  expect(await finish(service, await service.request(request))).toMatchObject({ ok: true });
  await service.request({ protocol, command: "global.settings.update", expectedRevision: 3, settings: { paused: false, activeContactLimit: 5 } });
  const selected = (await service.settings()).contacts[0]!;
  f.grants[0]!.consumedActions = 99999;
  expect(await service.delegatedGrant(selected)).toBe("grant:2");
  expect(f.revoked).toContain("grant:1"); expect(service.runJournal().pendingGrants()).toEqual([]);
  expect((await service.snapshot()).capabilities.find(value => value.id === "attachments")?.status).toBe("available");
  expect((await service.snapshot()).capabilities.find(value => value.id === "stickers")?.status).toBe("unsupported");
  let unblock!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), waiting = new Promise<void>(resolve => { unblock = resolve; });
  f.block(async () => { began(); await waiting; });
  const fresh = await service.snapshot();
  const job = await service.request({ ...request, expectedRevision: fresh.revision }); await started;
  await service.request({ protocol, command: "global.settings.update", expectedRevision: fresh.revision, settings: { paused: true, activeContactLimit: 5 } });
  f.failRevoke(); unblock();
  expect(await finish(service, job)).toMatchObject({ ok: false, code: "conflict" });
  expect(service.runJournal().pendingGrants()).toMatchObject([{ contactId, grant: { id: "grant:3" } }]);
  expect((await service.runtimeState()).grants[contactId]?.id).toBe("grant:2");
  await service.close(); services.splice(services.indexOf(service), 1);
  const restarted = await TextbutlerControlService.open({ dataDir, automation: f.port }); services.push(restarted);
  await restarted.recoverInactiveGrants();
  expect(restarted.runJournal().pendingGrants()).toHaveLength(1);
  expect(await restarted.delegatedGrant(selected)).toBeNull();
  f.recoverRevoke(); await restarted.recoverInactiveGrants();
  expect(restarted.runJournal().pendingGrants()).toEqual([]); expect(f.revoked).toContain("grant:3");
});

test("lost grant creation replies recover by durable intent lookup without issuing another grant", async () => {
  const f = fixture(), { service, initial, contactId, dataDir } = await serviceFixture(f);
  f.loseGrantResponse();
  const result = await finish(service, await service.request({ protocol, command: "contact.settings.update", contactId, expectedRevision: 2,
    settings: { ...initial, enabled: true, provider: "claude", accountId: "synthetic-api" } }));
  expect(result.ok).toBe(false); expect(f.grants).toHaveLength(1);
  expect(service.runJournal().grantIntents()).toMatchObject([{ contactId, enrollmentId: f.enrollment.id, bindingDigest: f.enrollment.bindingDigest }]);
  expect(service.runJournal().pendingGrants()).toEqual([]);
  await service.close(); services.splice(services.indexOf(service), 1);
  const restarted = await TextbutlerControlService.open({ dataDir, automation: f.port }); services.push(restarted);
  expect((await restarted.snapshot()).contacts[0]?.messaging?.state).toBe("recovery-required");
  f.failRevoke(); await restarted.recoverInactiveGrants();
  expect(restarted.runJournal().grantIntents()).toEqual([]);
  expect(restarted.runJournal().pendingGrants()).toMatchObject([{ contactId, grant: { id: "grant:1" } }]);
  expect(f.calls.filter(method => method === "grant")).toHaveLength(1);
  f.recoverRevoke(); await restarted.recoverInactiveGrants();
  expect(restarted.runJournal().pendingGrants()).toEqual([]); expect(f.revoked).toEqual(["grant:1"]);
  expect(f.calls.filter(method => method === "grant")).toHaveLength(1);
  const absentIntent = { id: "synthetic-never-reached-provider", contactId, enrollmentId: f.enrollment.id, bindingDigest: f.enrollment.bindingDigest };
  restarted.runJournal().recordGrantIntent(absentIntent);
  expect(() => restarted.runJournal().recordGrantIntent({ ...absentIntent, bindingDigest: "0".repeat(64) })).toThrow("changed");
  await restarted.recoverInactiveGrants(); expect(restarted.runJournal().grantIntents()).toEqual([]);
  expect(f.calls.filter(method => method === "grant")).toHaveLength(1);
});
