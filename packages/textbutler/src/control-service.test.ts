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
import { createXcbSubscriptionHost } from "./xcb-host.ts";
import { contactCapabilityIdentity } from "./contact-capabilities.ts";
import { ContactHabitat, DEFAULT_HABITAT_PLAN } from "./contact-habitat.ts";
import { createHabitatAgent } from "./habitat-agent.ts";
import { createFastDriver } from "./fast-driver.ts";

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
  test("qualified XCB accounts survive the provider host and serialized control snapshot", async () => {
    const now = Date.now(), sha256 = "a".repeat(64);
    const accounts = (["claude", "codex"] as const).map(provider => ({ provider, accountId: `synthetic-${provider}`, model: `${provider}/observed` }));
    let generated = 0;
    const native = await createXcbSubscriptionHost({ executable: "/synthetic/xcb", stateHome: "/synthetic/state", sha256, accounts }, {
      now: () => now,
      integration: { version: 1, evidenceDigest: "d".repeat(64), sourceDigest: "e".repeat(64),
        profiles: { classify: contactCapabilityIdentity("classify"), respond: contactCapabilityIdentity("respond") } },
      client: {
        async capabilities() { return { version: 1, supported: true, zeroTools: true, zeroHooks: true, ephemeral: true,
          accounts: accounts.map(account => ({ id: account.accountId, label: "Synthetic", provider: account.provider,
            enabled: true, busy: false, connected: true, runtimeAdmitted: true, available: true, reason: null,
            models: [{ key: account.model, label: "Observed", observedAtMs: now }],
            qualification: { runtimeVersion: "synthetic-v1", runtimeDigest: sha256, evidenceDigest: "b".repeat(64), expiresAt: now + 600_000 } })) }; },
        async generate() { generated++; throw Error("Snapshot must not invoke a model"); },
      },
    });
    const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-control-xcb-")); roots.push(dataDir);
    const service = await TextbutlerControlService.open({ dataDir, providers: leases => createProviderHost({
      dataDir, config: { schemaVersion: 1 }, leases, nativeSubscriptions: native, now: () => now,
    }) }); services.push(service);
    const raw = await service.request({ protocol, command: "snapshot" });
    const response = parseControlResponse(JSON.parse(JSON.stringify(raw)));
    expect(response).toMatchObject({ ok: true, kind: "snapshot", snapshot: { settings: { paused: true }, contacts: [], providerAccounts: [
      { id: "native-codex", provider: "codex", route: "codex", status: "ready", defaultReplyModel: "codex/observed", classifierModel: "codex/observed" },
      { id: "native-claude-code", provider: "claude", route: "claude-code", status: "ready", defaultReplyModel: "claude/observed", classifierModel: "claude/observed" },
      { id: "native-devin", provider: "devin", route: "devin", status: "unavailable", defaultReplyModel: null, classifierModel: null },
    ], capabilities: expect.arrayContaining([{ id: "agent", status: "available", detail: "An AI account is ready. Contact account selection and messaging grants still apply." }]) } });
    expect(response).toEqual(raw); expect(generated).toBe(0);
  });
  test("ready account snapshots still require models, route identity and qualified account state", async () => {
    const { service } = await setup(false), snapshot = await service.snapshot();
    const parse = (account: unknown) => parseControlResponse({ protocol, ok: true, kind: "snapshot", snapshot: { ...snapshot, providerAccounts: [account] } });
    for (const route of ["claude-api", "claude-code", "codex", "devin"] as const) {
      const account = { id: "synthetic-account", label: "Synthetic", provider: route === "codex" ? "codex" : route === "devin" ? "devin" : "claude", route,
        status: "ready", detail: "Synthetic qualification", defaultReplyModel: "reply-model", classifierModel: "classifier-model" };
      expect(parse(account)).toMatchObject({ ok: true, kind: "snapshot" });
      for (const field of ["defaultReplyModel", "classifierModel"] as const) {
        for (const value of [null, "", undefined]) expect(() => parse({ ...account, [field]: value })).toThrow();
      }
      for (const patch of [{ provider: account.provider === "codex" ? "claude" : "codex" }, { route: "unknown" }, { id: "../other" }]) expect(() => parse({ ...account, ...patch })).toThrow();
      const managedAccount = { state: "signed-in", generation: 1, modelCount: 1, pendingLoginId: null };
      expect(() => parse({ ...account, managedAccount })).toThrow("Invalid managed account readiness");
      if (route === "codex") expect(parse({ ...account, status: "unavailable", defaultReplyModel: null, classifierModel: null, managedAccount })).toMatchObject({ ok: true });
    }
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
  test("owner habitat configuration is strict and conditional without changing settings or other contacts", async () => {
    const { service, dataDir } = await setup(), notifications: string[] = [];
    const unsubscribe = service.onHabitatChanged(id => notifications.push(id));
    const before = await readFile(join(dataDir, "state", "settings.json"), "utf8");
    const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "Give one useful example.", personality: { tone: "warm", formality: "casual" }, webSearch: true };
    const request = { protocol, command: "habitat.configure", contactId: "synthetic-a", expectedRevision: 0, plan };
    expect(await service.request({ protocol, command: "habitat.read", contactId: "synthetic-a" })).toMatchObject({ ok: true, kind: "habitat", revision: 0 });
    expect(service.runJournal().habitatState("synthetic-a")).toBeNull();
    const response = await service.request(request);
    expect(response).toMatchObject({ ok: true, kind: "habitat", contactId: "synthetic-a", revision: 1, ownerRevision: 1 });
    expect(parseControlResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    if (!response.ok || response.kind !== "habitat") throw Error("Expected configured habitat");
    expect(JSON.parse(response.content).plan).toEqual(plan);
    expect(notifications).toEqual(["synthetic-a"]);
    expect(await service.request(request)).toMatchObject({ ok: false, code: "conflict" });
    expect(await service.request({ ...request, contactId: "unknown" })).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await readFile(join(dataDir, "state", "settings.json"), "utf8")).toBe(before);
    expect(service.runJournal().habitatState("synthetic-b")).toBeNull();
    expect(notifications).toEqual(["synthetic-a"]);
    unsubscribe();
    expect(await service.request({ ...request, expectedRevision: 1, plan: { ...plan, webSearch: false } })).toMatchObject({ ok: true, revision: 2 });
    expect(notifications).toEqual(["synthetic-a"]);
  });
  test("habitat configure rejects unsupported plan fields and unsafe revisions before mutation", async () => {
    const { service } = await setup();
    const request = { protocol, command: "habitat.configure", contactId: "synthetic-a", expectedRevision: 0, plan: DEFAULT_HABITAT_PLAN };
    for (const plan of [null, [], {}, { ...DEFAULT_HABITAT_PLAN, tools: ["shell"] }, { ...DEFAULT_HABITAT_PLAN, webSearch: "yes" },
      { ...DEFAULT_HABITAT_PLAN, contextMessages: 33 }, { ...DEFAULT_HABITAT_PLAN, guidance: "x".repeat(4097) },
      { ...DEFAULT_HABITAT_PLAN, personality: { tone: "warm", formality: "casual", accountId: "other" } },
      { ...DEFAULT_HABITAT_PLAN, personality: { tone: "intense", formality: "balanced" } }]) {
      expect(await service.request({ ...request, plan })).toMatchObject({ ok: false, code: "invalid-request" });
    }
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
      expect(await service.request({ ...request, expectedRevision })).toMatchObject({ ok: false, code: "invalid-request" });
    }
    expect(() => parseControlRequest({ ...request, plan: { ...DEFAULT_HABITAT_PLAN, get guidance() { throw Error("getter must not run"); } } })).toThrow("JSON data only");
    expect(service.runJournal().habitatState("synthetic-a")).toBeNull();
  });
  test("habitat mutations require pause and notify only after successful mutation", async () => {
    const { service } = await setup(), notifications: string[] = [];
    service.onHabitatChanged(id => notifications.push(id));
    const habitat = new ContactHabitat(service.runJournal(), "synthetic-a"), baseline = habitat.snapshot();
    const promoted = { ...DEFAULT_HABITAT_PLAN, guidance: "A learned concise style." };
    service.runJournal().writeHabitatState("synthetic-a", 0, JSON.stringify({ ...baseline, revision: 1, champion: promoted, ancestors: [DEFAULT_HABITAT_PLAN] }));
    expect(await service.request({ protocol, command: "global.settings.update", expectedRevision: 1, settings: { paused: false, activeContactLimit: 1 } })).toMatchObject({ ok: true });
    for (const command of ["habitat.configure", "habitat.rollback", "habitat.memory.clear"]) {
      expect(await service.request({ protocol, command, contactId: "synthetic-a", expectedRevision: 1, ...(command === "habitat.configure" ? { plan: DEFAULT_HABITAT_PLAN } : {}) })).toMatchObject({ ok: false, code: "conflict" });
    }
    expect(habitat.snapshot().champion).toEqual(promoted); expect(notifications).toEqual([]);
    expect(await service.request({ protocol, command: "global.settings.update", expectedRevision: 2, settings: { paused: true, activeContactLimit: 1 } })).toMatchObject({ ok: true });
    expect(await service.request({ protocol, command: "habitat.rollback", contactId: "synthetic-a", expectedRevision: 0 })).toMatchObject({ ok: false, code: "conflict" });
    expect(await service.request({ protocol, command: "habitat.rollback", contactId: "synthetic-a", expectedRevision: 1 })).toMatchObject({ ok: true, kind: "habitat", revision: 2 });
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN); expect(notifications).toEqual(["synthetic-a"]);
  });
  test("learned memory is inspectable and owner clearing is conditional, isolated and exact", async () => {
    const { service } = await setup(), journal = service.runJournal(), notifications: string[] = [];
    service.onHabitatChanged(id => notifications.push(id));
    const habitat = new ContactHabitat(journal, "synthetic-a"), baseline = habitat.snapshot();
    const memory = [{ id: "preference-1", at: 1, author: "contact", text: "Please keep explanations brief.", sourceDigest: "a".repeat(64), truncated: false }];
    journal.writeHabitatState("synthetic-a", 0, JSON.stringify({ ...baseline, revision: 1, memory }));
    const read = await service.request({ protocol, command: "habitat.read", contactId: "synthetic-a" });
    if (!read.ok || read.kind !== "habitat") throw Error("Expected habitat inspection");
    expect(JSON.parse(read.content)).toMatchObject({ memory, memoryCutoff: null });
    expect(habitat.snapshot().revision).toBe(1);
    const request = { protocol, command: "habitat.memory.clear", contactId: "synthetic-a", expectedRevision: 1 };
    for (const invalid of [{ ...request, expectedRevision: "1" }, { ...request, expectedRevision: -1 }, { ...request, extra: true },
      { ...request, contactId: "unknown" }]) expect(await service.request(invalid)).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await service.request({ ...request, expectedRevision: 0 })).toMatchObject({ ok: false, code: "conflict" });
    expect(notifications).toEqual([]);
    const response = await service.request(request);
    expect(response).toMatchObject({ ok: true, kind: "habitat", revision: 2, ownerRevision: 1 });
    if (!response.ok || response.kind !== "habitat") throw Error("Expected cleared memory");
    expect(JSON.parse(response.content)).toMatchObject({ memory: [], memoryCutoff: expect.any(Number), plan: baseline.champion });
    expect(parseControlResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    expect(journal.habitatState("synthetic-b")).toBeNull();
    expect(await service.request(request)).toMatchObject({ ok: false, code: "conflict" });
    expect(await service.request({ ...request, expectedRevision: 2 })).toMatchObject({ ok: true, revision: 3, ownerRevision: 2 });
    expect(notifications).toEqual(["synthetic-a", "synthetic-a"]);
  });
  test("habitat inspection includes bounded tool evidence without reply bodies and reports omitted entries", async () => {
    const { service } = await setup(), journal = service.runJournal(), habitat = new ContactHabitat(journal, "synthetic-a");
    const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "g".repeat(4096) }, baseline = habitat.snapshot();
    const episodes = Array.from({ length: 9 }, (_, index) => ({ reply: { runId: `run-${index}`, at: index + 1, intent: "Explain",
      trigger: { id: `trigger-${index}`, at: index, author: "contact", kind: "message", text: "private trigger body", relatedMessageId: null },
      context: [], messageIds: [`sent-${index}`], text: "private reply body", planDigest: null,
      memory: [{ id: `remembered-${index}`, at: index, author: "contact", text: "private historical memory", sourceDigest: "a".repeat(64), truncated: false }],
      priorMemory: [{ id: `earlier-tool-memory-${index}`, sourceDigest: "b".repeat(64) }],
      actionKinds: ["text"], tools: [{ kind: "meme-search", query: "public template", result: "r".repeat(4096) }, { kind: "meme-image", query: "template-id", result: "r".repeat(4096) }] },
      followups: [], initialClaimed: false, followupClaimed: false, reflection: null }));
    const evaluations = Array.from({ length: 24 }, (_, index) => ({ key: `evaluation-${index}`, at: index, phase: "initial", status: "retained", reason: "r".repeat(1024), receipts: [],
      evidenceIds: Array.from({ length: 40 }, (_, evidence) => `${evidence}-${"i".repeat(100)}`) }));
    const lineage = Array.from({ length: 16 }, (_, index) => ({ key: `lineage-${index}`, kind: "promotion", from: plan, to: plan, reason: "r".repeat(1024) }));
    journal.writeHabitatState("synthetic-a", 0, JSON.stringify({ ...baseline, revision: 1, champion: plan, episodes, evaluations, lineage }));
    const response = await service.request({ protocol, command: "habitat.read", contactId: "synthetic-a" });
    if (!response.ok || response.kind !== "habitat") throw Error("Expected habitat inspection");
    expect(Buffer.byteLength(response.content)).toBeLessThanOrEqual(262_144);
    expect(parseControlResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    const content = JSON.parse(response.content);
    expect(content.recentEpisodes).toHaveLength(8);
    expect(content.recentEpisodes.at(-1)).toMatchObject({ runId: "run-8", actionKinds: ["text"], tools: episodes[8]!.reply.tools,
      memoryIds: ["remembered-8"], priorMemory: [{ id: "earlier-tool-memory-8", sourceDigest: "b".repeat(64) }] });
    expect(content.omitted.episodes).toBe(1); expect(content.omitted.evaluations).toBeGreaterThan(0);
    expect(response.content).not.toContain("private trigger body"); expect(response.content).not.toContain("private reply body");
    expect(response.content).not.toContain("private historical memory");
    expect(habitat.snapshot().revision).toBe(1); expect(habitat.snapshot().evaluations).toHaveLength(24);
  });
  test("capacity and explicit contact identity are enforced on real settings", async () => {
    const { service } = await setup(); const snapshot = await service.snapshot();
    const settings = { ...snapshot.contacts[0]!.settings, enabled: true };
    expect((await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings })).ok).toBe(true);
    expect(await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-b", expectedRevision: 2, settings })).toMatchObject({ ok: false, code: "capacity" });
    expect(await service.request({ protocol, command: "contact.memory.read", contactId: "not-configured" })).toMatchObject({ ok: false, code: "invalid-request" });
  });
  test("the repo allowlist round-trips through ordinary settings writes", async () => {
    const { service } = await setup();
    const settings = { ...((await service.snapshot()).contacts[0]!.settings), repos: ["https://github.com/hraness/bio"] };
    const updated = await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings });
    expect(updated).toMatchObject({ ok: true, kind: "snapshot", snapshot: { contacts: [{ settings: { repos: ["https://github.com/hraness/bio"] } }, {}] } });
    expect((await service.settings()).contacts[0]?.repos).toEqual(["https://github.com/hraness/bio"]);
    // A later settings write that echoes the snapshot keeps the allowlist.
    const echoed = { ...((await service.snapshot()).contacts[0]!.settings) };
    expect(await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 2, settings: echoed })).toMatchObject({ ok: true });
    expect((await service.settings()).contacts[0]?.repos).toEqual(["https://github.com/hraness/bio"]);
    for (const repos of [["http://github.com/x/y"], ["https://user@example.com/x/y"], ["https://github.com/x", "https://github.com/x"], "https://github.com/x/y"])
      expect(await service.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 3, settings: { ...echoed, repos } })).toMatchObject({ ok: false, code: "invalid-request" });
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
  test("a maximal provider configuration still yields a parseable snapshot", async () => {
    const { service, dataDir } = await setup(false); await service.close(); services.splice(services.indexOf(service), 1);
    const config = parseHostConfig({ schemaVersion: 1, providerAccounts: Array.from({ length: 8 }, (_, index) => ({ id: `configured-${index}`, label: `Configured ${index}`, route: "claude-code" })) });
    const reopened = await TextbutlerControlService.open({ dataDir, providers: leases => createProviderHost({ dataDir, config, leases }) }); services.push(reopened);
    const parsed = parseControlResponse(JSON.parse(JSON.stringify(await reopened.request({ protocol, command: "snapshot" }))));
    if (!parsed.ok || parsed.kind !== "snapshot") throw new Error("Missing snapshot");
    expect(parsed.snapshot.providerAccounts?.map(account => account.id).slice(0, 3)).toEqual(["native-codex", "native-claude-code", "native-devin"]);
    expect(parsed.snapshot.providerAccounts).toHaveLength(11);
  });
  test("the Devin subscription account is selectable only for the Devin provider", async () => {
    const { service, dataDir } = await setup(); await service.close(); services.splice(services.indexOf(service), 1);
    const reopened = await TextbutlerControlService.open({ dataDir, providers: leases => createProviderHost({ dataDir, config: { schemaVersion: 1 }, leases }) }); services.push(reopened);
    const { accountId: _accountId, ...oldSettings } = (await reopened.snapshot()).contacts[0]!.settings;
    expect(await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings: { ...oldSettings, provider: "codex", accountId: "native-devin" } })).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await reopened.request({ protocol, command: "contact.settings.update", contactId: "synthetic-a", expectedRevision: 1, settings: { ...oldSettings, provider: "devin", accountId: "native-devin" } }))
      .toMatchObject({ ok: true, kind: "snapshot", snapshot: { contacts: [{ settings: { accountId: "native-devin", provider: "devin" } }, {}] } });
    expect((await reopened.settings()).contacts[0]).toMatchObject({ accountId: "native-devin", provider: "devin" });
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
  test("settled manual habitat suggestions release their scopes after success, failure and silence", async () => {
    const { service, run, dataDir, sent } = await replySetup();
    const journal = service.runJournal(), workspace = await ContactWorkspace.create(join(dataDir, "contacts", "synthetic-a"));
    let time = Date.now(), calls = 0, mode: "success" | "failure" | "silent" = "success";
    const signals: AbortSignal[] = [];
    const driver = createFastDriver({ kind: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "synthetic" }, { journal, fetch: async () => {
      calls++;
      const value = mode === "failure" ? {} : { respond: mode === "success", confidence: 0.99, reason: mode === "success" ? "requested" : "not_needed",
        summary: "A synthetic suggestion", actions: mode === "success" ? [{ kind: "text", text: "A useful answer." }] : [], tool: null };
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value }) } }] });
    } });
    const habitat = createHabitatAgent({ journal, driver, getWorkspace: async () => workspace, capabilities: async () => ["text"], active: () => true });
    service.setReplyAgent({ ...habitat.agent, async compose(request) { signals.push(request.signal); return habitat.agent.compose(request); } });
    const clock = spyOn(Date, "now").mockImplementation(() => time);
    try {
      for (const outcome of ["success", "failure", "silent"] as const) {
        mode = outcome;
        for (let index = 0; index < 66; index++) {
          // Expire completed owner-job receipts; the habitat's live run cap is
          // independent and must be reclaimed at settlement, not by that TTL.
          time += 600_001;
          const response = await run({ command: "replies.suggest", contactId: "synthetic-a" });
          expect(signals.at(-1)?.aborted).toBe(true);
          if (outcome === "failure") expect(response).toMatchObject({ ok: false, code: "unavailable" });
          else {
            expect(response).toMatchObject({ ok: true, kind: "reply-suggestion" });
            if (!response.ok || response.kind !== "reply-suggestion") throw Error("Expected settled suggestion");
            if (outcome === "silent") expect(response.draft).toBeNull();
            else {
              expect(response.draft).not.toBeNull();
              expect(await run({ command: "replies.discard", draftId: response.draft!.id })).toMatchObject({ ok: true });
            }
          }
        }
      }
      expect(signals).toHaveLength(198); expect(calls).toBe(198); expect(sent).toEqual([]);
    } finally { clock.mockRestore(); await habitat.close(); }
  }, 20_000);
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
