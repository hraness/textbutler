import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createPrivateFileOnce, publishPrivateFile } from "@hraness/local-custody/atomic-publish";
import { ensurePrivateDirectory, readPrivateFile } from "@hraness/local-custody/private-paths";
import type { ControlRequest, ControlResponse, DesktopSnapshot } from "../../control/src/index.ts";
import { configureContact, newContact, DEFAULT_ACTIVE_LIMIT, parseSettings, type ContactSettings, type Settings } from "./config.ts";
import { ContactWorkspace } from "./workspace.ts";
import { RunJournal } from "./journal.ts";
import { OwnerReadRecoveryError, assertSameConversation, bindingDigest, boundedHistory, parseConversationBinding, type ConversationBinding, type ObservedConversation, type OwnerConversationReadPort } from "./enrollment.ts";
import type { ProviderHost } from "./provider-host.ts";
import type { AccountLeaseStore } from "../../agentrouter/src/accounts.ts";
import { selectButlerModel } from "./routed-agent.ts";
import { parseAutomationBinding, type AutomationBinding, type AutomationCandidate, type OwnerAutomationPort } from "./automation-owner.ts";
import { automationBindingDigest, parseAutomationGrant, type AutomationGrant } from "../../transport/src/automation.ts";

export const TEXTBUTLER_CONTROL_PROTOCOL = "textbutler.control.v1" as const;
const MAX_SETTINGS_BYTES = 524_288;
const MAX_CONTACTS = 200;
const CONTACT_KEYS = ["id", "label", "routeId", "enabled", "mode", "keyword", "provider", "accountId", "replyModel", "classifierModel", "disclosure", "revision", "pausedUntil", "humanCooldownMs", "debounceMs", "maxRepliesPerHour"];
type FailureCode = "invalid-request" | "conflict" | "capacity" | "unavailable";
class ControlFailure extends Error { constructor(readonly code: FailureCode, message: string) { super(message); } }
function fail(code: FailureCode, message: string): never { throw new ControlFailure(code, message); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid-request", "Expected a plain control object.");
  if (Reflect.ownKeys(value).length !== Object.keys(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !("value" in descriptor))) fail("invalid-request", "Control objects must contain JSON data only.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail("invalid-request", "Unsupported or missing control fields.");
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("invalid-request", "Invalid bounded control number.");
  return value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("invalid-request", "Invalid bounded control text.");
  return value;
}
function contactId(value: unknown): string { const id = text(value, 80); if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) fail("invalid-request", "Invalid contact identifier."); return id; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail("invalid-request", "Invalid control flag."); return value; }
function parseUiSettings(value: unknown) {
  const settings = record(value); exact(settings, ["enabled", "responseMode", "keyword", "provider", "disclosure", ...(settings.accountId === undefined ? [] : ["accountId"])]);
  const disclosure = record(settings.disclosure); exact(disclosure, ["character", "begin", "end"]);
  if (settings.responseMode !== "smart" && settings.responseMode !== "keyword" || settings.provider !== "codex" && settings.provider !== "claude") fail("invalid-request", "Unknown reply mode or provider.");
  const keyword = text(settings.keyword, 160);
  if (keyword.length > 40) fail("invalid-request", "The trigger keyword is limited to 40 characters.");
  return { enabled: bool(settings.enabled), responseMode: settings.responseMode as "smart" | "keyword", keyword, provider: settings.provider as "codex" | "claude",
    ...(settings.accountId === undefined ? {} : { accountId: contactId(settings.accountId) }),
    disclosure: { character: text(disclosure.character, 64), begin: text(disclosure.begin, 64), end: text(disclosure.end, 64) } };
}
/** This is an owner control channel. Requests cannot create message sends or change routes. */
export function parseControlRequest(value: unknown): ControlRequest {
  const item = record(value);
  if (item.protocol !== TEXTBUTLER_CONTROL_PROTOCOL) fail("invalid-request", "Unsupported control protocol.");
  if (item.command === "snapshot" || item.command === "activity.list" || item.command === "conversations.list") {
    exact(item, ["protocol", "command"]); return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command };
  }
  if (item.command === "owner.job.read") {
    exact(item, ["protocol", "command", "jobId"]); return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, jobId: contactId(item.jobId) };
  }
  if (item.command === "provider.accounts.check" || item.command === "provider.accounts.logout") {
    exact(item, ["protocol", "command", "accountId"]);
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, accountId: contactId(item.accountId) };
  }
  if (item.command === "provider.accounts.login.start") {
    exact(item, ["protocol", "command", "accountId", "method"]);
    if (item.method !== "chatgpt" && item.method !== "chatgptDeviceCode") fail("invalid-request", "Choose a supported Codex sign-in method.");
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, accountId: contactId(item.accountId), method: item.method };
  }
  if (item.command === "provider.accounts.login.cancel") {
    exact(item, ["protocol", "command", "accountId", "loginId"]);
    const loginId = text(item.loginId, 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(loginId)) fail("invalid-request", "Invalid provider sign-in identity.");
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, accountId: contactId(item.accountId), loginId };
  }
  if (item.command === "messaging.start") {
    exact(item, ["protocol", "command", "provider"]);
    if (item.provider !== "imessage" && item.provider !== "whatsapp") fail("invalid-request", "Choose a configured messaging provider.");
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, provider: item.provider };
  }
  if (item.command === "contact.enroll") {
    exact(item, ["protocol", "command", "candidateId", "expectedRevision", "initializeHistory"]);
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, candidateId: contactId(item.candidateId), expectedRevision: integer(item.expectedRevision, 1), initializeHistory: bool(item.initializeHistory) };
  }
  if (item.command === "contact.memory.read") {
    exact(item, ["protocol", "command", "contactId"]); return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, contactId: contactId(item.contactId) };
  }
  if (item.command === "contact.memory.write") {
    exact(item, ["protocol", "command", "contactId", "expectedRevision", "content"]);
    const revision = text(item.expectedRevision, 64);
    if (!/^[a-f0-9]{64}$/u.test(revision) || typeof item.content !== "string" || Buffer.byteLength(item.content) > 65_536 || item.content.includes("\0")) fail("invalid-request", "Memory needs a SHA-256 revision and at most 65,536 bytes.");
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, contactId: contactId(item.contactId), expectedRevision: revision, content: item.content };
  }
  if (item.command === "contact.settings.update") {
    exact(item, ["protocol", "command", "contactId", "expectedRevision", "settings"]);
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, contactId: contactId(item.contactId), expectedRevision: integer(item.expectedRevision, 1), settings: parseUiSettings(item.settings) };
  }
  if (item.command === "global.settings.update") {
    exact(item, ["protocol", "command", "expectedRevision", "settings"]);
    const settings = record(item.settings); exact(settings, ["paused", "activeContactLimit"]);
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: item.command, expectedRevision: integer(item.expectedRevision, 1), settings: { paused: bool(settings.paused), activeContactLimit: integer(settings.activeContactLimit, 1, 50) } };
  }
  return fail("invalid-request", "Unknown owner control command.");
}

/** Creates only the last component; symlinked or non-private existing roots fail closed. */
export { ensurePrivateDirectory };
async function privateText(path: string): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateFile(path, MAX_SETTINGS_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message === "Private file exceeds its size bound.") throw new Error("Owner settings exceeds size bound");
    if (error instanceof Error && error.message === "Unsafe private file.") throw new Error("Unsafe owner settings file");
    throw error;
  }
}
export type OwnerBinding = ConversationBinding | AutomationBinding;
export type OwnerRuntimeState = Readonly<{ settings: Settings; bindings: Readonly<Record<string, OwnerBinding>>; grants: Readonly<Record<string, AutomationGrant>> }>;
type OwnerState = OwnerRuntimeState & Readonly<{ schemaVersion: 1; revision: number }>;
const ownerBindingDigest = (binding: OwnerBinding): string => binding.version === 1 ? bindingDigest(binding) : binding.bindingDigest;
const ownerBindingRoute = (binding: OwnerBinding, contactId: string): string => binding.version === 1 ? `local-binding:${contactId}` : binding.enrollmentId;
function parseOwnerBinding(value: unknown): OwnerBinding { return record(value).version === 2 ? parseAutomationBinding(value) : parseConversationBinding(value); }
function parseOwnerState(value: unknown): OwnerState {
  const item = record(value); exact(item, ["schemaVersion", "revision", "settings", ...(Object.hasOwn(item, "bindings") ? ["bindings"] : []), ...(Object.hasOwn(item, "grants") ? ["grants"] : [])]);
  if (item.schemaVersion !== 1) throw new Error("Unsupported owner state version");
  const settings = record(item.settings); exact(settings, ["schemaVersion", "paused", "maxActiveContacts", "contacts"]);
  if (!Array.isArray(settings.contacts) || settings.contacts.length > MAX_CONTACTS) throw new Error("Too many configured contacts");
  for (const contact of settings.contacts) { const entry = record(contact); exact(entry, CONTACT_KEYS); exact(record(entry.disclosure), ["character", "begin", "end"]); }
  const parsed = parseSettings(settings);
  const bindings: Record<string, OwnerBinding> = {};
  for (const [id, value] of Object.entries(item.bindings === undefined ? {} : record(item.bindings))) {
    contactId(id);
    const binding = parseOwnerBinding(value);
    if (!parsed.contacts.some(contact => contact.id === id && contact.routeId === ownerBindingRoute(binding, id))) throw new Error("Conversation binding has no matching contact");
    bindings[id] = binding;
    if (binding.version === 1 && binding.participants.length !== 1) throw new Error("Group bindings are unsupported");
  }
  if (new Set(Object.values(bindings).map(ownerBindingDigest)).size !== Object.keys(bindings).length) throw new Error("Repeated owner conversation binding");
  const grants: Record<string, AutomationGrant> = {};
  for (const [id, value] of Object.entries(item.grants === undefined ? {} : record(item.grants))) {
    const binding = bindings[id], grant = parseAutomationGrant(value);
    if (!binding || binding.version !== 2 || grant.enrollmentId !== binding.enrollmentId || grant.expectedBindingDigest !== binding.bindingDigest || grant.revoked) throw new Error("Grant has no matching owner binding");
    grants[id] = grant;
  }
  return { schemaVersion: 1, revision: integer(item.revision, 1), settings: parsed, bindings, grants };
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function initializeOwnerState(dataDir: string, initialSettings?: Settings): Promise<{ dataDir: string; settingsPath: string }> {
  const root = await ensurePrivateDirectory(dataDir);
  const state = await ensurePrivateDirectory(join(root, "state"));
  await ensurePrivateDirectory(join(root, "contacts"));
  const settingsPath = join(state, "settings.json");
  const initial = parseOwnerState({ schemaVersion: 1, revision: 1, settings: initialSettings ?? { schemaVersion: 1, paused: true, maxActiveContacts: DEFAULT_ACTIVE_LIMIT, contacts: [] } });
  await createPrivateFileOnce(state, "settings.json", `${JSON.stringify(initial, null, 2)}\n`);
  parseOwnerState(JSON.parse(await privateText(settingsPath)));
  return { dataDir: root, settingsPath };
}

export class TextbutlerControlService {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private candidates = new Map<string, { conversation: ObservedConversation; expires: number }>();
  private automationCandidates = new Map<string, { candidate: AutomationCandidate; expires: number }>();
  private readonly settingsListeners = new Set<(settings: Settings) => void>();
  private readonly grantWork = new Map<string, Promise<unknown>>();
  private readonly grantFailures = new Set<string>();
  private readonly grantChanging = new Set<string>();
  private grantRecovery: Promise<void> | undefined;
  private runtimeStatus: { state: "running" | "paused" | "unavailable"; detail: string } = { state: "unavailable", detail: "Automatic replies need a configured messaging connection, scoped contact grant and admitted agent account." };
  private jobs = new Map<string, { result?: ControlResponse; expires: number }>();
  private activeJob: { controller: AbortController; promise: Promise<void> } | undefined;
  private constructor(readonly dataDir: string, private readonly settingsPath: string, private readonly journal: RunJournal, private readonly enrollment?: OwnerConversationReadPort, readonly providers?: ProviderHost, readonly automation?: OwnerAutomationPort) {}
  static async open(options: { dataDir: string; initialSettings?: Settings; recoverRuns?: boolean; enrollment?: OwnerConversationReadPort; providers?: (leases: AccountLeaseStore) => ProviderHost; automation?: OwnerAutomationPort }): Promise<TextbutlerControlService> {
    const state = await initializeOwnerState(options.dataDir, options.initialSettings);
    const journal = await RunJournal.open(join(state.dataDir, "state", "runs.sqlite"));
    try {
      if (options.recoverRuns === true) journal.recover(Date.now());
      return new TextbutlerControlService(state.dataDir, state.settingsPath, journal, options.enrollment, options.providers?.(journal.accountLeases()), options.automation);
    } catch (error) { journal.close(); throw error; }
  }
  private async current(): Promise<{ state: OwnerState; bytes: string }> {
    await ensurePrivateDirectory(this.dataDir);
    await ensurePrivateDirectory(dirname(this.settingsPath));
    const bytes = await privateText(this.settingsPath);
    return { state: parseOwnerState(JSON.parse(bytes)), bytes };
  }
  async settings(): Promise<Settings> { return (await this.current()).state.settings; }
  async runtimeState(): Promise<OwnerRuntimeState> { const { settings, bindings, grants } = (await this.current()).state; return { settings, bindings, grants }; }
  runJournal(): RunJournal { return this.journal; }
  setRuntimeStatus(status: { state: "running" | "paused" | "unavailable"; detail: string }): void {
    if (!["running", "paused", "unavailable"].includes(status.state) || typeof status.detail !== "string" || status.detail.length > 512) throw new Error("Invalid runtime diagnostic");
    this.runtimeStatus = { ...status };
  }
  onSettingsChanged(listener: (settings: Settings) => void): () => void { this.settingsListeners.add(listener); return () => this.settingsListeners.delete(listener); }
  private notifySettings(settings: Settings): void { for (const listener of this.settingsListeners) { try { listener(settings); } catch { /* Owner state is authoritative; observers cannot roll it back. */ } } }
  private pendingGrant(contactId: string): boolean {
    return this.journal.pendingGrants().some(value => value.contactId === contactId) || this.journal.grantIntents().some(value => value.contactId === contactId);
  }
  /** Standing contact enablement may renew a bounded grant; it never changes the recipient. */
  async delegatedGrant(contact: ContactSettings): Promise<string | null> {
    if (this.closed || !this.automation || this.grantRecovery || this.grantWork.has(contact.id) || this.grantChanging.has(contact.id)
      || this.pendingGrant(contact.id)) return null;
    const state = (await this.current()).state, selected = state.settings.contacts.find(value => value.id === contact.id);
    const binding = state.bindings[contact.id], prior = state.grants[contact.id];
    if (this.closed || state.settings.paused || !selected?.enabled || selected.revision !== contact.revision || binding?.version !== 2) return null;
    if (prior) {
      try {
        const live = await this.automation.grantStatus(binding, prior.id, AbortSignal.timeout(60_000));
        const current = (await this.current()).state;
        if (this.closed || this.grantRecovery || current.settings.paused || this.grantWork.has(contact.id) || this.grantChanging.has(contact.id)
          || current.grants[contact.id]?.id !== live.id || this.pendingGrant(contact.id)
          || !current.settings.contacts.some(value => value.id === contact.id && value.enabled && value.revision === contact.revision)) return null;
        if (!live.revoked && Date.parse(live.expiresAt) > Date.now() + 60_000 && live.maximumActions - live.consumedActions >= 8) { this.grantFailures.delete(contact.id); return live.id; }
      } catch { this.grantFailures.add(contact.id); return null; }
    }
    if (this.grantRecovery || this.grantWork.has(contact.id) || this.grantChanging.has(contact.id) || this.pendingGrant(contact.id)) return null;
    const work = (async () => {
      let created: AutomationGrant | undefined;
      try {
        if (prior) await this.automation!.revoke(prior.id);
        const signal = AbortSignal.timeout(60_000);
        const before = (await this.current()).state;
        if (this.closed || before.settings.paused || !before.settings.contacts.some(value => value.id === contact.id && value.enabled && value.revision === contact.revision)) return null;
        const intentId = randomUUID();
        this.journal.recordGrantIntent({ id: intentId, contactId: contact.id, enrollmentId: binding.enrollmentId, bindingDigest: binding.bindingDigest });
        created = await this.automation!.grant(binding, intentId, signal);
        this.journal.recordPendingGrant(contact.id, created, intentId);
        return await this.serial(async () => {
          const latest = await this.current();
          if (this.closed || latest.state.settings.paused || !latest.state.settings.contacts.some(value => value.id === contact.id && value.enabled && value.revision === contact.revision)
            || ownerBindingDigest(latest.state.bindings[contact.id]!) !== binding.bindingDigest) throw new Error("Contact changed during grant renewal");
          await this.publish(latest, latest.state.settings, latest.state.bindings, { ...latest.state.grants, [contact.id]: created! });
          this.journal.clearPendingGrant(created!.id);
          this.grantFailures.delete(contact.id); return created!.id;
        });
      } catch {
        this.grantFailures.add(contact.id);
        if (created) {
          try { await this.automation!.revoke(created.id, AbortSignal.timeout(60_000)); this.journal.clearPendingGrant(created.id); }
          catch { /* Retain the private pending grant for explicit recovery. */ }
        }
        return null;
      }
    })();
    this.grantWork.set(contact.id, work);
    try { return await work; } finally { this.grantWork.delete(contact.id); }
  }
  private revokeDisabled(contactId: string, grant: AutomationGrant): void {
    if (!this.automation || this.grantWork.has(contactId)) return;
    const work = (async () => {
      try {
        const pending = this.journal.pendingGrants().filter(value => value.contactId === contactId).map(value => value.grant);
        for (const item of [grant, ...pending.filter(value => value.id !== grant.id)]) {
          await this.automation!.revoke(item.id, AbortSignal.timeout(60_000)); this.journal.clearPendingGrant(item.id);
        }
        this.grantFailures.delete(contactId);
        await this.serial(async () => {
          const current = await this.current();
          if (current.state.grants[contactId]?.id !== grant.id || current.state.settings.contacts.some(contact => contact.id === contactId && contact.enabled)) return;
          const grants = { ...current.state.grants }; delete grants[contactId];
          await this.publish(current, current.state.settings, current.state.bindings, grants); this.grantFailures.delete(contactId);
        });
      } catch { this.grantFailures.add(contactId); }
    })();
    this.grantWork.set(contactId, work); void work.finally(() => this.grantWork.delete(contactId));
  }
  /** After daemon custody is established, retry only idempotent revocation of retained disabled grants. */
  async recoverInactiveGrants(): Promise<void> {
    if (!this.automation || this.closed) return;
    if (this.grantRecovery) return this.grantRecovery;
    const work = (async () => {
    await Promise.allSettled([...this.grantWork.values()]);
    const state = (await this.current()).state;
    for (const intent of this.journal.grantIntents()) {
      try {
        const grant = await this.automation!.grantByIntent(intent.id, AbortSignal.timeout(60_000));
        if (grant === null) { this.journal.clearGrantIntent(intent.id); this.grantFailures.delete(intent.contactId); }
        else this.journal.recordPendingGrant(intent.contactId, grant, intent.id);
      } catch { this.grantFailures.add(intent.contactId); }
    }
    for (const { contactId, grant } of this.journal.pendingGrants()) {
      if (state.grants[contactId]?.id === grant.id && state.settings.contacts.some(contact => contact.id === contactId && contact.enabled)) {
        this.journal.clearPendingGrant(grant.id); continue;
      }
      try { await this.automation!.revoke(grant.id, AbortSignal.timeout(60_000)); this.journal.clearPendingGrant(grant.id); this.grantFailures.delete(contactId); }
      catch { this.grantFailures.add(contactId); }
    }
    for (const [id, grant] of Object.entries(state.grants)) {
      if (!state.settings.contacts.some(contact => contact.id === id && contact.enabled)) this.revokeDisabled(id, grant);
    }
    await Promise.allSettled([...this.grantWork.values()]);
    })();
    this.grantRecovery = work;
    try { await work; } finally { this.grantRecovery = undefined; }
  }
  private async publish(current: { state: OwnerState; bytes: string }, settings: Settings, bindings = current.state.bindings, grants = current.state.grants): Promise<void> {
    if (current.state.revision >= Number.MAX_SAFE_INTEGER) fail("unavailable", "Settings revision capacity is exhausted.");
    const bytes = `${JSON.stringify(parseOwnerState({ schemaVersion: 1, revision: current.state.revision + 1, settings, bindings, grants }), null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_SETTINGS_BYTES) fail("capacity", "Settings exceed the private storage limit.");
    await publishPrivateFile(dirname(this.settingsPath), "settings.json", bytes, {
      beforeCommit: async () => {
        if (hash(await privateText(this.settingsPath)) !== hash(current.bytes)) fail("conflict", "Settings changed. Reload before saving.");
      },
    });
    this.notifySettings(settings);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(work); this.queue = result; return result;
  }
  private error(error: unknown): ControlResponse {
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: false, code: error instanceof ControlFailure ? error.code : "unavailable", message: error instanceof ControlFailure || error instanceof OwnerReadRecoveryError ? error.message : "The private control operation could not complete. Reload before retrying a change." };
  }
  private startJob(work: (signal: AbortSignal) => Promise<ControlResponse>): ControlResponse {
    if (this.activeJob) fail("capacity", "An owner setup or history job is already in progress. Wait for it to finish.");
    for (const [id, job] of this.jobs) if (job.expires < Date.now()) this.jobs.delete(id);
    if (this.jobs.size >= 16) fail("capacity", "Too many recent owner jobs. Try again in a few minutes.");
    const jobId = randomUUID(), controller = new AbortController();
    const job: { result?: ControlResponse; expires: number } = { expires: Date.now() + 600_000 }; this.jobs.set(jobId, job);
    const timer = setTimeout(() => controller.abort(), 120_000);
    const promise = Promise.resolve().then(() => work(controller.signal)).then(result => { job.result = result; }, error => { job.result = this.error(error); }).finally(() => { clearTimeout(timer); this.activeJob = undefined; });
    this.activeJob = { controller, promise };
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "job", jobId };
  }
  async snapshot(): Promise<DesktopSnapshot> {
    const { state } = await this.current();
    const observed = this.automation?.observedCapabilities().filter(value => value.observedAt <= Date.now() && value.observedAt > Date.now() - 60_000) ?? [];
    const richCapability = (id: "attachments" | "reactions" | "stickers" | "links" | "polls" | "mini-apps", actions: readonly ("attachment" | "reaction" | "sticker" | "link" | "poll" | "app-clip" | "experience")[]) => {
      const supported = observed.filter(value => value.status.connected && actions.some(action => value.status.actions[action].available));
      const unavailable = observed.map(value => {
        const reasons = [...new Set(actions.map(action => value.status.actions[action].reason).filter((reason): reason is string => typeof reason === "string" && reason.length > 0))];
        return `${value.status.identity.provider === "imessage" ? "iMessage" : "WhatsApp"}: ${reasons.join(" ") || "This feature is unavailable on the checked connection."}`;
      });
      const combined = unavailable.join(" ");
      const unavailableDetail = combined.length <= 4096 ? combined : `${combined.slice(0, 4000).replace(/[\uD800-\uDBFF]$/u, "")}… Details shortened.`;
      return { id, status: supported.length ? "available" as const : observed.length ? "unsupported" as const : "setup-required" as const,
        detail: supported.length ? `Last confirmed by ${supported.map(value => value.status.identity.provider === "imessage" ? "iMessage" : "WhatsApp").join(" and ")}. The selected contact's grant and current provider capability are checked before sending.`
          : observed.length ? unavailableDetail : "Connect messaging to check this feature's availability." };
    };
    const activity = state.settings.contacts.flatMap(contact => this.journal.recent(contact.id, 50)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200).map(run => ({ id: run.id, at: new Date(run.updatedAt).toISOString(), contactId: run.contactId, title: run.state, detail: run.reason }));
    return {
      protocol: TEXTBUTLER_CONTROL_PROTOCOL, revision: state.revision, connection: "connected",
      detail: this.runtimeStatus.detail,
      automation: { ...this.runtimeStatus },
      ...(this.automation ? { messagingProviders: this.automation.providers() } : {}),
      settings: { paused: state.settings.paused, activeContactLimit: state.settings.maxActiveContacts },
      contacts: state.settings.contacts.map(contact => { const binding = state.bindings[contact.id], grant = state.grants[contact.id], recovering = this.grantFailures.has(contact.id) || this.pendingGrant(contact.id); return { id: contact.id, name: contact.label,
        subtitle: binding?.version === 2 ? `${binding.identity.provider === "imessage" ? "iMessage" : "WhatsApp"} · ${contact.enabled && grant && Date.parse(grant.expiresAt) > Date.now() && !recovering ? "Contact grant active" : "Butler off or grant unavailable"}` : binding ? "Selected Messages conversation · sending unavailable" : "Owner-configured workspace · sending unavailable",
        ...(binding?.version !== 2 ? {} : { messaging: { provider: binding.identity.provider,
          state: this.grantWork.has(contact.id) ? "revocation-pending" as const : recovering || !contact.enabled && grant ? "recovery-required" as const : contact.enabled && grant && Date.parse(grant.expiresAt) > Date.now() ? "active" as const : "missing" as const,
          detail: this.grantWork.has(contact.id) ? "The messaging grant is changing. New dispatches wait until it settles."
            : recovering || !contact.enabled && grant ? "The previous grant needs revocation recovery. New replies remain blocked; check the messaging connection and save the disabled contact again."
            : contact.enabled && grant ? "A bounded conversation grant renews while this contact remains enabled. Pausing or disabling stops new replies."
            : "Enabling this contact delegates supported actions to its exact conversation using a renewable bounded grant.",
          grantExpiresAt: grant?.expiresAt ?? null } }),
        settings: { enabled: contact.enabled, responseMode: contact.mode, keyword: contact.keyword, provider: contact.provider, accountId: contact.accountId, disclosure: { ...contact.disclosure } } }; }),
      ...(this.providers ? { providerAccounts: this.providers.accounts() } : {}),
      capabilities: [
        { id: "messages", status: this.runtimeStatus.state === "unavailable" ? "setup-required" : "available", detail: this.automation ? this.runtimeStatus.detail : this.enrollment ? "Owner conversation selection is configured. Message subscriptions and autonomous sending remain unavailable." : "Configure the owner-installed Ghostget CLI to select messaging conversations." },
        { id: "contacts", status: "unsupported", detail: "The current Ghostget contract has no native Contacts directory. No contacts are imported automatically." },
        { id: "agent", status: this.providers?.accounts().some(account => account.status === "ready") ? "available" : "setup-required", detail: this.providers?.accounts().some(account => account.status === "ready") ? "An explicitly selected Claude API account is ready. Contact selection and messaging grants still apply." : "Choose and check an explicit account. Claude API and native coding-agent routes are separate." },
        richCapability("attachments", ["attachment"]), richCapability("reactions", ["reaction"]),
        richCapability("stickers", ["sticker"]), richCapability("links", ["link"]),
        richCapability("polls", ["poll"]), richCapability("mini-apps", ["app-clip", "experience"]),
      ], activity,
    };
  }
  private enrollAutomation(request: Extract<ControlRequest, { command: "contact.enroll" }>): ControlResponse {
    const candidate = this.automationCandidates.get(request.candidateId);
    if (!this.automation || !candidate || candidate.expires < Date.now()) fail("conflict", "Messaging selection expired. Refresh conversations.");
    return this.startJob(async signal => {
      const before = await this.current();
      if (before.state.revision !== request.expectedRevision) fail("conflict", "Settings changed. Reload before adding a contact.");
      if (before.state.settings.contacts.length >= MAX_CONTACTS) fail("capacity", "The configured contact limit has been reached.");
      const observed = await this.automation!.enroll(candidate.candidate, request.initializeHistory, signal); signal.throwIfAborted();
      const binding = parseAutomationBinding(observed.binding);
      if (binding.bindingDigest !== automationBindingDigest(candidate.candidate.identity, candidate.candidate.conversation)) throw new Error("Messaging enrollment changed its target");
      const messages = request.initializeHistory ? boundedHistory(observed.messages) : [];
      const historyOmittedCount = request.initializeHistory ? observed.messages.length - messages.length : 0;
      const historyShortenedCount = request.initializeHistory ? messages.filter(message => observed.messages.find(original => original.id === message.id || `sha256:${hash(original.id)}` === message.id)?.text !== message.text).length : 0;
      return this.serial(async () => {
        signal.throwIfAborted(); const latest = await this.current();
        if (latest.state.revision !== request.expectedRevision) fail("conflict", "Settings changed. Reload before adding a contact.");
        if (Object.values(latest.state.bindings).some(value => ownerBindingDigest(value) === binding.bindingDigest)) fail("conflict", "This messaging conversation has already been added.");
        const id = randomUUID(), workspace = await ContactWorkspace.create(join(this.dataDir, "contacts", id));
        if (request.initializeHistory) {
          const historyFile = await workspace.initializeHistory(messages);
          await workspace.writeVersioned("history/bootstrap-summary.json", JSON.stringify({ schemaVersion: 1, purpose: "context-only-never-trigger", historyFile,
            requestedLimit: 200, receivedMessages: observed.messages.length, retainedMessages: messages.length, omittedMessages: historyOmittedCount,
            shortenedMessages: historyShortenedCount, attachmentsImported: false }, null, 2), null);
        }
        signal.throwIfAborted();
        const label = candidate.candidate.conversation.title ?? candidate.candidate.conversation.participants.join(", ");
        const settings = parseSettings({ ...latest.state.settings, contacts: [...latest.state.settings.contacts, newContact(id, label.slice(0, 200), binding.enrollmentId)] });
        await this.publish(latest, settings, { ...latest.state.bindings, [id]: binding }); this.automationCandidates.delete(request.candidateId);
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "enrolled", snapshot: await this.snapshot(), contactId: id,
          historyInitialized: request.initializeHistory, historyCount: messages.length, historyOmittedCount, historyShortenedCount };
      });
    });
  }
  private enableAutomation(request: Extract<ControlRequest, { command: "contact.settings.update" }>, current: { state: OwnerState; bytes: string }): ControlResponse {
    if (!this.automation || !this.providers) fail("unavailable", "Connect messaging and explicitly select a ready agent account before enabling the butler.");
    if (this.pendingGrant(request.contactId)) fail("unavailable", "A previous grant still needs revocation recovery. Keep this contact disabled and check the messaging connection.");
    if (this.grantRecovery || this.grantWork.has(request.contactId)) fail("capacity", "This contact's messaging grant is still changing. Refresh before enabling it.");
    const binding = current.state.bindings[request.contactId] as AutomationBinding;
    let updated: Settings;
    try { updated = configureContact(current.state.settings, request.contactId, { enabled: true, mode: request.settings.responseMode,
      keyword: request.settings.keyword, provider: request.settings.provider, ...(request.settings.accountId === undefined ? {} : { accountId: request.settings.accountId }), disclosure: request.settings.disclosure }); }
    catch { fail("capacity", "Check contact settings and the active contact limit."); }
    const contact = updated.contacts.find(contact => contact.id === request.contactId)!;
    const response = this.startJob(async signal => {
      let created: AutomationGrant | undefined;
      try {
        for (const purpose of contact.mode === "smart" ? ["classify", "respond"] as const : ["respond"] as const) {
          selectButlerModel(await this.providers!.selection(contact, purpose), contact, purpose, Date.now(), true);
          signal.throwIfAborted();
        }
        const prior = current.state.grants[contact.id]; if (prior) await this.automation!.revoke(prior.id, signal);
        const intentId = randomUUID();
        this.journal.recordGrantIntent({ id: intentId, contactId: contact.id, enrollmentId: binding.enrollmentId, bindingDigest: binding.bindingDigest });
        created = await this.automation!.grant(binding, intentId, signal);
        this.journal.recordPendingGrant(contact.id, created, intentId); signal.throwIfAborted();
        return await this.serial(async () => {
          const latest = await this.current(); signal.throwIfAborted();
          if (this.closed || latest.state.revision !== request.expectedRevision) fail("conflict", "Settings changed while the grant was prepared. Refresh and retry.");
          await this.publish(latest, updated, latest.state.bindings, { ...latest.state.grants, [contact.id]: created! });
          this.journal.clearPendingGrant(created!.id); this.grantFailures.delete(contact.id);
          return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() };
        });
      } catch (error) {
        this.grantFailures.add(contact.id);
        if (created) {
          try { await this.automation!.revoke(created.id, AbortSignal.timeout(60_000)); this.journal.clearPendingGrant(created.id); }
          catch { /* The durable pending grant remains until revocation is proven. */ }
        }
        throw error;
      } finally { this.grantChanging.delete(contact.id); }
    });
    this.grantChanging.add(contact.id); return response;
  }
  private async execute(request: ControlRequest): Promise<ControlResponse> {
    if (this.closed) fail("unavailable", "The control service is closing.");
    const current = await this.current();
    if (request.command === "snapshot" || request.command === "activity.list") return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() };
    if (request.command === "owner.job.read") {
      const job = this.jobs.get(request.jobId);
      if (!job || job.expires < Date.now()) fail("invalid-request", "This owner job has expired. Reload before retrying.");
      return job.result ?? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "job", jobId: request.jobId };
    }
    if (request.command === "provider.accounts.check") {
      if (!this.providers) fail("unavailable", "Provider accounts are not configured.");
      return this.startJob(async signal => { await this.providers!.check(request.accountId, signal); signal.throwIfAborted();
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() }; });
    }
    if (request.command === "provider.accounts.login.start") {
      if (!this.providers) fail("unavailable", "Provider accounts are not configured.");
      return this.startJob(async signal => {
        const challenge = await this.providers!.startLogin(request.accountId, request.method, signal); signal.throwIfAborted();
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "provider-login", accountId: request.accountId, challenge, snapshot: await this.snapshot() };
      });
    }
    if (request.command === "provider.accounts.login.cancel" || request.command === "provider.accounts.logout") {
      if (!this.providers) fail("unavailable", "Provider accounts are not configured.");
      return this.startJob(async signal => {
        if (request.command === "provider.accounts.login.cancel") await this.providers!.cancelLogin(request.accountId, request.loginId, signal);
        else await this.providers!.logout(request.accountId, signal);
        signal.throwIfAborted();
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() };
      });
    }
    if (request.command === "messaging.start") {
      if (!this.automation) fail("unavailable", "Messaging automation is not configured.");
      return this.startJob(async signal => { await this.automation!.start(request.provider, signal); signal.throwIfAborted(); await this.recoverInactiveGrants();
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() }; });
    }
    if (request.command === "conversations.list") {
      if (this.automation) return this.startJob(async signal => {
        const candidates = await this.automation!.list(signal); signal.throwIfAborted();
        if (candidates.length > 200) throw new Error("Too many messaging conversations");
        const current = await this.current(); this.automationCandidates.clear();
        const rows = candidates.map(candidate => {
          const duplicate = Object.values(current.state.bindings).some(binding => binding.version === 2 && binding.bindingDigest === automationBindingDigest(candidate.identity, candidate.conversation));
          const id = randomUUID(); this.automationCandidates.set(id, { candidate, expires: Date.now() + 300_000 });
          return { id, name: candidate.conversation.title ?? candidate.conversation.participants.join(", "),
            subtitle: `${candidate.identity.provider === "imessage" ? "iMessage" : "WhatsApp"} · ${candidate.conversation.participants.join(", ")}`.slice(0, 512),
            eligible: !duplicate, reason: duplicate ? "Already added" : "Ready to add" };
        });
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "conversations", candidates: rows, detail: "Choose an exact one-to-one iMessage or WhatsApp conversation. Adding a contact keeps its butler disabled." };
      });
      if (!this.enrollment) fail("unavailable", "Messages selection is not configured. Set up the owner-installed Ghostget CLI in Textbutler's host configuration, then restart the daemon.");
      return this.startJob(async signal => {
        const conversations = await this.enrollment!.list(signal); signal.throwIfAborted();
        if (conversations.length > 200) throw new Error("Too many conversations");
        this.candidates.clear();
        const latest = await this.current();
        const candidates = conversations.map(conversation => {
          const binding = parseConversationBinding(conversation.binding);
          const enrolled = Object.values(latest.state.bindings).some(value => value.version === 1 && value.authId === binding.authId && value.chatGuid === binding.chatGuid);
          const eligible = conversation.kind === "single" && binding.participants.length === 1 && !enrolled;
          const id = randomUUID(); this.candidates.set(id, { conversation: { ...conversation, binding }, expires: Date.now() + 300_000 });
          return { id, name: conversation.title.slice(0, 200), subtitle: binding.participants.join(", ").slice(0, 512), eligible, reason: enrolled ? "Already added" : !eligible ? "Only one-to-one conversations with a verified participant are supported" : "Ready to add" };
        });
        return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "conversations", candidates, detail: "Up to 200 recent Messages conversations. Selection expires after five minutes. Contacts directory access is not available." };
      });
    }
    if (request.command === "contact.enroll") {
      if (this.automationCandidates.has(request.candidateId)) return this.enrollAutomation(request);
      if (!this.enrollment) fail("unavailable", "Messages selection is not configured.");
      if (request.expectedRevision !== current.state.revision) fail("conflict", "Settings changed. Reload before adding a contact.");
      const candidate = this.candidates.get(request.candidateId);
      if (!candidate || candidate.expires < Date.now()) fail("conflict", "The conversation selection expired. Refresh conversations.");
      assertSameConversation(candidate.conversation.binding, candidate.conversation);
      return this.startJob(async signal => {
        const observed = await this.enrollment!.read(candidate.conversation.binding, request.initializeHistory, signal);
        signal.throwIfAborted(); assertSameConversation(candidate.conversation.binding, observed.conversation);
        const messages = request.initializeHistory ? boundedHistory(observed.messages) : [];
        const historyOmittedCount = request.initializeHistory ? observed.messages.length - messages.length : 0;
        const historyShortenedCount = request.initializeHistory ? messages.filter(message => observed.messages.find(original => original.id === message.id || `sha256:${hash(original.id)}` === message.id)?.text !== message.text).length : 0;
        return this.serial(async () => {
          signal.throwIfAborted();
          const latest = await this.current();
          if (latest.state.revision !== request.expectedRevision) fail("conflict", "Settings changed. Reload before adding a contact.");
          if (latest.state.settings.contacts.length >= MAX_CONTACTS) fail("capacity", "The configured contact limit has been reached.");
          const binding = parseConversationBinding(candidate.conversation.binding);
          if (Object.values(latest.state.bindings).some(value => value.version === 1 && value.authId === binding.authId && value.chatGuid === binding.chatGuid)) fail("conflict", "This Messages conversation has already been added.");
          const id = randomUUID();
          const workspace = await ContactWorkspace.create(join(this.dataDir, "contacts", id));
          if (request.initializeHistory) {
            const historyFile = await workspace.initializeHistory(messages);
            await workspace.writeVersioned("history/bootstrap-summary.json", JSON.stringify({ schemaVersion: 1, purpose: "context-only-never-trigger", historyFile, requestedLimit: 200, receivedMessages: observed.messages.length, retainedMessages: messages.length, omittedMessages: historyOmittedCount, shortenedMessages: historyShortenedCount, attachmentsImported: false, historicalAutomation: "Only the default visible butler wrapper is identified; other historical automation may be present. Do not derive owner style rules automatically." }, null, 2), null);
          }
          signal.throwIfAborted();
          const settings = parseSettings({ ...latest.state.settings, contacts: [...latest.state.settings.contacts, newContact(id, candidate.conversation.title, `local-binding:${id}`)] });
          await this.publish(latest, settings, { ...latest.state.bindings, [id]: binding });
          this.candidates.delete(request.candidateId);
          return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "enrolled", snapshot: await this.snapshot(), contactId: id, historyInitialized: request.initializeHistory, historyCount: messages.length, historyOmittedCount, historyShortenedCount };
        });
      });
    }
    const contact = "contactId" in request ? current.state.settings.contacts.find(contact => contact.id === request.contactId) : undefined;
    if ("contactId" in request && contact === undefined) fail("invalid-request", "This contact is not configured by the owner.");
    if (request.command === "contact.memory.read" || request.command === "contact.memory.write") {
      await ensurePrivateDirectory(join(this.dataDir, "contacts"));
      const workspace = await ContactWorkspace.create(join(this.dataDir, "contacts", request.contactId));
      if (request.command === "contact.memory.write") {
        const memory = await workspace.readVersioned("MEMORY.md");
        if (memory.revision !== request.expectedRevision) fail("conflict", "Memory changed. Reload before saving.");
        try { await workspace.writeVersioned("MEMORY.md", request.content, request.expectedRevision); } catch (error) { if (error instanceof Error && error.message === "Contact file revision conflict") fail("conflict", "Memory changed. Reload before saving."); throw error; }
      }
      const memory = await workspace.readVersioned("MEMORY.md");
      if (Buffer.byteLength(memory.text) > 65_536) fail("capacity", "Memory exceeds the control editor's 65,536-byte limit.");
      return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "memory", contactId: request.contactId, revision: memory.revision, content: memory.text };
    }
    if (request.expectedRevision !== current.state.revision) fail("conflict", "Settings changed. Reload before saving.");
    if (request.command === "contact.settings.update") {
      if (request.settings.accountId !== undefined && !this.providers && request.settings.accountId !== contact!.accountId) fail("invalid-request", "Provider accounts are not configured.");
      try { this.providers?.validateAccountChange(contact!, request.settings); }
      catch { fail("invalid-request", "Choose a configured account explicitly. Claude API is billed separately from coding-agent subscriptions."); }
    }
    if (request.command === "contact.settings.update" && request.settings.enabled && current.state.bindings[request.contactId]?.version === 2) return this.enableAutomation(request, current);
    if (request.command === "contact.settings.update" && request.settings.enabled && current.state.bindings[request.contactId]?.version === 1) {
      if (!this.enrollment) fail("unavailable", "Reconnect the configured Ghostget account before enabling this contact.");
      const binding = current.state.bindings[request.contactId] as ConversationBinding;
      return this.startJob(async signal => {
        const observed = await this.enrollment!.read(binding, false, signal);
        signal.throwIfAborted(); assertSameConversation(binding, observed.conversation);
        return this.serial(async () => {
          signal.throwIfAborted(); const latest = await this.current();
          if (latest.state.revision !== request.expectedRevision) fail("conflict", "Settings changed. Reload before saving.");
          if (!contact!.enabled && latest.state.settings.contacts.filter(item => item.enabled).length >= latest.state.settings.maxActiveContacts) fail("capacity", "The active contact limit has been reached.");
          const updated = configureContact(latest.state.settings, request.contactId, { enabled: request.settings.enabled, mode: request.settings.responseMode, keyword: request.settings.keyword, provider: request.settings.provider, ...(request.settings.accountId === undefined ? {} : { accountId: request.settings.accountId }), disclosure: request.settings.disclosure });
          await this.publish(latest, updated);
          return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() };
        });
      });
    }
    let updated: Settings;
    if (request.command === "global.settings.update") {
      if (current.state.settings.contacts.filter(contact => contact.enabled).length > request.settings.activeContactLimit) fail("capacity", "Disable contacts before reducing the active limit.");
      updated = parseSettings({ ...current.state.settings, paused: request.settings.paused, maxActiveContacts: request.settings.activeContactLimit });
    } else {
      if (request.settings.enabled && !contact!.enabled && current.state.settings.contacts.filter(contact => contact.enabled).length >= current.state.settings.maxActiveContacts) fail("capacity", "The active contact limit has been reached.");
      try { updated = configureContact(current.state.settings, request.contactId, { enabled: request.settings.enabled, mode: request.settings.responseMode, keyword: request.settings.keyword, provider: request.settings.provider, ...(request.settings.accountId === undefined ? {} : { accountId: request.settings.accountId }), disclosure: request.settings.disclosure }); } catch { fail("invalid-request", "Invalid contact settings."); }
    }
    await this.publish(current, updated);
    if (request.command === "contact.settings.update" && !request.settings.enabled) {
      const grant = current.state.grants[request.contactId] ?? this.journal.pendingGrants().find(value => value.contactId === request.contactId)?.grant;
      if (grant) this.revokeDisabled(request.contactId, grant);
    }
    return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: await this.snapshot() };
  }
  request(value: unknown): Promise<ControlResponse> {
    const result = this.serial(async (): Promise<ControlResponse> => {
      try { return await this.execute(parseControlRequest(value)); }
      catch (error) { return this.error(error); }
    });
    this.queue = result;
    return result;
  }
  async close(): Promise<void> {
    this.closed = true; this.activeJob?.controller.abort();
    const settled = await Promise.allSettled([this.activeJob?.promise, this.grantRecovery, ...this.grantWork.values()]);
    let failure = settled.find((value): value is PromiseRejectedResult => value.status === "rejected");
    try { await this.queue; } catch (reason) { failure ??= { status: "rejected", reason }; }
    try { await this.providers?.close(); } catch (reason) { failure ??= { status: "rejected", reason }; }
    try { this.journal.close(); } catch (reason) { failure ??= { status: "rejected", reason }; }
    if (failure) throw failure.reason;
  }
}
