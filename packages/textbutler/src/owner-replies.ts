import { randomUUID } from "node:crypto";
import { automationContextId, automationHash, createGhostgetAutomationTransport, type AutomationEnrollment, type AutomationGrant, type AutomationMessage, type GhostgetAutomationClient } from "../../transport/src/automation.ts";
import { parseActionIntent, type ActionIntent } from "../../transport/src/index.ts";
import { type ContactSettings, type Disclosure } from "./config.ts";
import { assertAutomationBinding, type AutomationBinding, type OwnerAutomationPort } from "./automation-owner.ts";
import { messageAuthor, pendingCluster } from "./attribution.ts";
import { boundedHistory, type OwnerConversationReadPort } from "./enrollment.ts";
import type { RunJournal } from "./journal.ts";
import type { Hooks, HookContext } from "./hooks.ts";
import type { ProviderHost } from "./provider-host.ts";
import type { ContactWorkspace } from "./workspace.ts";
import { ControlFailure, type OwnerBinding, type OwnerRuntimeState } from "./control-service.ts";
import { createRoutedButlerAgent } from "./routed-agent.ts";
import type { AgentRequest, ButlerAgent } from "./runtime.ts";
import type { MessageEvent } from "./decision.ts";
import { discloseReplyActions } from "./reply-actions.ts";
import type { ReplyDraftDetail } from "../../control/src/index.ts";

export interface PendingReplyItem {
  readonly contactId: string;
  readonly name: string;
  readonly provider: "imessage" | "whatsapp" | "beeper" | "none";
  readonly enabled: boolean;
  readonly pendingCount: number;
  readonly lastInboundAt: string | null;
  readonly preview: string | null;
  readonly sendable: boolean;
  readonly reason: string | null;
}
export interface ReplyDraftView {
  readonly id: string;
  readonly contactId: string;
  readonly name: string;
  readonly summary: string;
  readonly preview: string;
  readonly actionCount: number;
  readonly expiresAt: string;
}
export interface ReplyScanResult {
  readonly scannedAt: string;
  readonly checked: number;
  readonly unreadable: number;
  readonly pending: readonly PendingReplyItem[];
}
export interface ReplySendResult {
  readonly contactId: string;
  readonly runId: string;
  readonly state: "submitted" | "failed" | "partial" | "indeterminate" | "cancelled";
  readonly detail: string;
}

interface ReplyDraft {
  readonly id: string;
  readonly contactId: string;
  readonly summary: string;
  readonly actions: readonly ActionIntent[];
  readonly disclosure: Disclosure;
  readonly contextId: string;
  readonly eventId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly contactRevision: number;
  readonly bindingDigest: string;
  readonly review: ReplyDraftDetail;
}
export interface PendingObservation { readonly count: number; readonly lastAt: number; readonly preview: string | null; readonly ready: boolean }

const DRAFT_TTL_MS = 15 * 60_000;
const DRAFT_LIMIT = 64;
const HISTORY_LIMIT = 100;
const PREVIEW_LIMIT = 480;

function fail(code: "invalid-request" | "conflict" | "capacity" | "unavailable", message: string): never {
  throw new ControlFailure(code, message);
}

/** Trusted ports an owner-initiated reply session needs. The agent never sees
 * this surface; every send still passes through the same grant, plan, journal
 * and disclosure discipline as an automatic reply. */
export interface OwnerRepliesPorts {
  readonly state: () => Promise<OwnerRuntimeState>;
  readonly journal: RunJournal;
  readonly automation: () => OwnerAutomationPort | undefined;
  readonly client: () => GhostgetAutomationClient | undefined;
  readonly enrollment: () => OwnerConversationReadPort | undefined;
  readonly providers: () => ProviderHost | undefined;
  readonly hooks: Hooks;
  readonly workspace: (contactId: string) => Promise<ContactWorkspace>;
  readonly grantWork: Map<string, Promise<unknown>>;
  readonly publishGrant: (contactId: string, grant: AutomationGrant | null) => Promise<void>;
  readonly now: () => number;
}

function preview(text: string | null): string | null {
  if (text === null) return null;
  const value = text.replaceAll("\0", "").trim();
  return Buffer.byteLength(value) > PREVIEW_LIMIT ? `${new TextDecoder().decode(Buffer.from(value).subarray(0, PREVIEW_LIMIT - 8))}…` : value;
}
/** What the owner reviews is what the send carries: disclosed text plus the
 * count of any rich actions that follow it. */
function draftPreview(draft: ReplyDraft): string {
  const actions = draft.review.actions;
  const text = actions.find(action => action.kind === "text");
  const lead = text?.kind === "text" ? text.text : draft.summary;
  const extras = actions.length - (text ? 1 : 0);
  const value = extras > 0 ? `${lead} (+${extras} more action${extras === 1 ? "" : "s"})` : lead;
  return preview(value) ?? "";
}

/** Owner-initiated triage, suggestion and explicit send. Distinct from the
 * autonomous reply loop: nothing here dispatches until an explicit send
 * command binds a draft or literal text to a fresh plan and live grant. */
export class OwnerReplies {
  private readonly drafts = new Map<string, ReplyDraft>();
  private readonly observations = new Map<string, PendingObservation>();
  private scannedAt: number | null = null;
  private agent: ButlerAgent | undefined;
  constructor(private readonly ports: OwnerRepliesPorts) {}

  /** The reply loop reports the cluster it already observed; scans replace it. */
  notePending(contactId: string, value: PendingObservation | null): void {
    if (value === null) this.observations.delete(contactId);
    else this.observations.set(contactId, value);
  }

  private pruneDrafts(): void {
    const at = this.ports.now();
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= at) this.drafts.delete(id);
  }

  private pendingGrantRecovery(contactId: string): boolean {
    return this.ports.journal.grantIntents().some(intent => intent.contactId === contactId)
      || this.ports.journal.pendingGrants().some(pending => pending.contactId === contactId);
  }

  private item(contact: ContactSettings, binding: OwnerBinding | null, observation: PendingObservation | null, reason: string | null): PendingReplyItem {
    const journal = this.ports.journal;
    const recovery = this.pendingGrantRecovery(contact.id);
    const sendable = observation !== null && observation.ready && reason === null && !recovery && binding?.version === 2
      && this.ports.automation() !== undefined && this.ports.client() !== undefined && !journal.hasUncertainSend(contact.id);
    return {
      contactId: contact.id, name: contact.label, provider: binding?.version === 2 ? binding.identity.provider : binding?.version === 1 ? "imessage" : "none",
      enabled: contact.enabled, pendingCount: observation?.count ?? 0,
      lastInboundAt: observation === null ? null : new Date(observation.lastAt).toISOString(),
      preview: preview(observation?.preview ?? null), sendable,
      reason: reason ?? (recovery ? "A previous messaging grant needs reconciliation." : observation === null ? null : !observation.ready ? "Messaging catchup is incomplete." : binding?.version !== 2 ? "This selection cannot send; re-enroll it through messaging." : journal.hasUncertainSend(contact.id) ? "A previous send needs reconciliation." : null),
    };
  }

  view(state: OwnerRuntimeState): { scannedAt: string | null; pending: readonly PendingReplyItem[]; drafts: readonly ReplyDraftView[] } {
    this.pruneDrafts();
    const pending: PendingReplyItem[] = [];
    for (const [contactId, observation] of this.observations) {
      const contact = state.settings.contacts.find(value => value.id === contactId);
      if (!contact) { this.observations.delete(contactId); continue; }
      pending.push(this.item(contact, state.bindings[contactId] ?? null, observation, null));
    }
    pending.sort((a, b) => (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? ""));
    const names = new Map(state.settings.contacts.map(contact => [contact.id, contact.label]));
    const drafts = [...this.drafts.values()].map(draft => ({
      id: draft.id, contactId: draft.contactId, name: names.get(draft.contactId) ?? draft.contactId,
      summary: draft.summary.slice(0, 512),
      preview: draftPreview(draft),
      actionCount: draft.review.actions.length, expiresAt: new Date(draft.expiresAt).toISOString(),
    } satisfies ReplyDraftView));
    return { scannedAt: this.scannedAt === null ? null : new Date(this.scannedAt).toISOString(), pending, drafts };
  }

  /** Bounded read-only pass over every configured conversation. */
  async scan(signal: AbortSignal): Promise<ReplyScanResult> {
    const state = await this.ports.state();
    const automation = this.ports.automation(), client = this.ports.client(), enrollment = this.ports.enrollment();
    const pending: PendingReplyItem[] = [];
    let unreadable = 0;
    for (const contact of state.settings.contacts) {
      signal.throwIfAborted();
      const binding = state.bindings[contact.id];
      if (binding === undefined) continue;
      if (binding.version === 2) {
        if (!automation || !client) { unreadable++; continue; }
        try {
          const page = await client.history(binding.enrollmentId, HISTORY_LIMIT, signal);
          assertAutomationBinding(binding, page.enrollment);
          const cluster = pendingCluster(page.messages, contact, this.ports.journal);
          this.notePending(contact.id, cluster === null ? null : { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: page.enrollment.ready });
          if (cluster !== null) pending.push(this.item(contact, binding, { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: page.enrollment.ready }, null));
        } catch { this.notePending(contact.id, null); unreadable++; }
      } else if (enrollment) {
        try {
          const page = await enrollment.read(binding, true, signal);
          const messages = page.messages;
          let count = 0, lastAt: number | null = null, lastText: string | null = null;
          for (let index = messages.length - 1; index >= 0 && count < 20; index -= 1) {
            const message = messages[index]!;
            if (message.author !== "contact") break;
            count++; lastAt ??= message.at; lastText ??= message.text;
          }
          this.notePending(contact.id, count === 0 ? null : { count, lastAt: lastAt!, preview: lastText, ready: true });
          if (count > 0) pending.push(this.item(contact, binding, { count, lastAt: lastAt!, preview: lastText, ready: true }, "This Messages selection is read-only; re-enroll it through messaging to reply."));
        } catch { this.notePending(contact.id, null); unreadable++; }
      }
    }
    this.scannedAt = this.ports.now();
    pending.sort((a, b) => (b.lastInboundAt ?? "").localeCompare(a.lastInboundAt ?? ""));
    return { scannedAt: new Date(this.scannedAt).toISOString(), checked: state.settings.contacts.filter(contact => state.bindings[contact.id] !== undefined).length, unreadable, pending };
  }

  private replyAgent(providers: ProviderHost): ButlerAgent {
    return this.agent ??= createRoutedButlerAgent({
      router: providers.router, selection: (contact, purpose) => providers.selection(contact, purpose),
      runManagedTask: (request, broker) => providers.runManagedTask(request, broker),
      getWorkspace: this.ports.workspace, hooks: this.ports.hooks, now: this.ports.now,
      // Owner-initiated drafts are not gated by autonomous enablement or pause.
      isActive: () => true,
    });
  }

  /** Drafts a reply for the conversation's unanswered inbound run. Never sends. */
  async suggest(contactId: string, signal: AbortSignal): Promise<{ draft: ReplyDraftView | null; pending: PendingReplyItem }> {
    const state = await this.ports.state();
    const contact = state.settings.contacts.find(value => value.id === contactId);
    if (!contact) fail("invalid-request", "This contact is not configured by the owner.");
    const binding = state.bindings[contact.id];
    if (binding?.version !== 2) fail("unavailable", "Only an exact messaging enrollment can draft replies. Re-enroll this contact through messaging.");
    const automation = this.ports.automation(), client = this.ports.client(), providers = this.ports.providers();
    if (!automation || !client) fail("unavailable", "Messaging automation is not configured.");
    if (!providers) fail("unavailable", "Select a qualified agent account before requesting suggestions.");
    const { enrollment, messages } = await client.history(binding.enrollmentId, HISTORY_LIMIT, signal);
    assertAutomationBinding(binding, enrollment);
    const cluster = pendingCluster(messages, contact, this.ports.journal);
    this.notePending(contact.id, cluster === null ? null : { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: enrollment.ready });
    const item = this.item(contact, binding, cluster === null ? null : { count: cluster.count, lastAt: cluster.latestAt, preview: cluster.preview, ready: enrollment.ready }, null);
    if (cluster === null) return { draft: null, pending: item };
    if (!enrollment.ready) fail("unavailable", "Messaging catchup is incomplete. Wait for a current conversation before requesting a suggestion.");
    const history = boundedHistory(messages.filter(message => message.kind === "message" && message.direction !== "unknown")
      .map(message => ({ id: message.id, text: message.text ?? "", at: Date.parse(message.occurredAt),
        author: messageAuthor(message, contact, this.ports.journal) as "owner" | "contact" | "butler" })));
    signal.throwIfAborted();
    await (await this.ports.workspace(contact.id)).write("history/recent.json", JSON.stringify({ schemaVersion: 1, purpose: "context-only-never-trigger", messages: history }));
    const agent = this.replyAgent(providers);
    if (!await agent.qualified(contact)) fail("unavailable", "The selected agent account is not qualified. Check it under providers.");
    const latest = messages.find(message => message.id === cluster.latestId)!;
    const event: MessageEvent = { id: latest.id, contactId: contact.id, routeId: binding.enrollmentId, revision: String(enrollment.revision),
      occurredAt: Date.parse(latest.occurredAt), observedAt: this.ports.now(), author: "contact", kind: "message", text: latest.text ?? "", historical: false, group: false };
    const request: AgentRequest = { runId: `suggest:${randomUUID()}`, contact, event, signal };
    const value = await agent.compose(request);
    const summary = typeof (value as { summary?: unknown })?.summary === "string" ? (value as { summary: string }).summary : "";
    const actions = (value as { actions?: unknown })?.actions;
    if (!summary.trim() || Buffer.byteLength(summary) > 4_096 || !Array.isArray(actions) || actions.length < 1 || actions.length > 7) throw new Error("Invalid agent suggestion");
    const intents = actions.map(action => parseActionIntent(action));
    if (intents.some(intent => intent === null)) throw new Error("Invalid agent suggestion");
    const review = await this.storeDraft(contact, binding, enrollment, messages, intents, summary, latest.id, signal);
    const draft = this.drafts.get(review.id)!;
    return { draft: { id: draft.id, contactId: contact.id, name: contact.label, summary: summary.slice(0, 512),
      preview: draftPreview(draft), actionCount: review.actions.length,
      expiresAt: new Date(draft.expiresAt).toISOString() }, pending: item };
  }

  /** Explicit rich composition stores an owner-reviewable draft. It never
   * acquires a send grant or dispatches until a separate digest-bound send. */
  async compose(contactId: string, summary: string, actions: readonly ActionIntent[], signal: AbortSignal): Promise<ReplyDraftDetail> {
    if (typeof summary !== "string" || !summary.trim() || summary.includes("\0") || Buffer.byteLength(summary) > 4096 || !Array.isArray(actions) || actions.length < 1 || actions.length > 7)
      fail("invalid-request", "Composition needs a bounded summary and 1-7 supported actions.");
    let intents: ActionIntent[];
    try { intents = actions.map(action => parseActionIntent(action)); } catch { fail("invalid-request", "Composition contains an unsupported action or field."); }
    signal.throwIfAborted();
    const state = await this.ports.state(), contact = state.settings.contacts.find(value => value.id === contactId), binding = state.bindings[contactId];
    if (!contact) fail("invalid-request", "This contact is not configured by the owner.");
    if (binding?.version !== 2) fail("unavailable", "Only an exact messaging enrollment can compose replies.");
    const client = this.ports.client();
    if (!client || !this.ports.automation()) fail("unavailable", "Messaging automation is not configured.");
    const { enrollment, messages } = await client.history(binding.enrollmentId, 200, signal); assertAutomationBinding(binding, enrollment);
    return this.storeDraft(contact, binding, enrollment, messages, intents, summary, `owner:compose:${randomUUID()}`, signal);
  }

  private async storeDraft(contact: ContactSettings, binding: AutomationBinding, enrollment: AutomationEnrollment, messages: readonly AutomationMessage[],
    intents: readonly ActionIntent[], summary: string, eventId: string, signal: AbortSignal): Promise<ReplyDraftDetail> {
    if (!enrollment.ready) fail("unavailable", "Messaging catchup is incomplete. Wait for a current conversation before composing.");
    const disclosed = discloseReplyActions(intents, summary, contact.disclosure);
    const client = this.ports.client(); if (!client) fail("unavailable", "Messaging automation is not configured.");
    const status = await client.status(binding.identity.provider, signal);
    if (automationHash(status.identity) !== automationHash(binding.identity)) fail("conflict", "The messaging account changed during composition.");
    if (!status.connected || !status.events.available || disclosed.some(action => !status.actions[action.kind].available))
      fail("unavailable", "The current messaging connection does not support every composed action, including disclosure.");
    const known = new Set(messages.filter(message => message.kind === "message").map(message => message.id));
    for (const action of disclosed) if ((action.kind === "reaction" || action.kind === "sticker") && action.messageId !== null && !known.has(action.messageId))
      fail("invalid-request", "A composed action targets a message outside this conversation's current history.");
    const assets: ReplyDraftDetail["assets"][number][] = [];
    const workspace = await this.ports.workspace(contact.id);
    for (const action of disclosed) {
      signal.throwIfAborted();
      if ((action.kind === "attachment" || action.kind === "sticker") && !assets.some(asset => asset.path === action.file)) {
        const admitted = await workspace.admitAsset(action.file);
        assets.push({ path: action.file, sha256: admitted.sha256, bytes: admitted.bytes.length });
      }
    }
    signal.throwIfAborted();
    const current = await this.ports.state(), currentContact = current.settings.contacts.find(value => value.id === contact.id), currentBinding = current.bindings[contact.id];
    if (!currentContact || currentContact.revision !== contact.revision || currentBinding?.version !== 2
      || currentBinding.bindingDigest !== binding.bindingDigest || currentBinding.enrollmentId !== binding.enrollmentId)
      fail("conflict", "The contact or messaging recipient changed during composition.");
    const fresh = await client.poll(binding.enrollmentId, signal); assertAutomationBinding(binding, fresh);
    if (!fresh.ready || automationContextId(fresh) !== automationContextId(enrollment)) fail("conflict", "The conversation changed during composition. Read it again.");
    signal.throwIfAborted();
    this.pruneDrafts();
    for (const [id, existing] of this.drafts) if (existing.contactId === contact.id) this.drafts.delete(id);
    if (this.drafts.size >= DRAFT_LIMIT) fail("capacity", "Too many open reply drafts. Discard one before suggesting again.");
    const id = `draft:${randomUUID()}`, createdAt = this.ports.now(), expiresAt = createdAt + DRAFT_TTL_MS;
    const detail = { id, contactId: contact.id, name: contact.label, provider: binding.identity.provider,
      conversationId: binding.enrollmentId, summary, actions: disclosed, assets, expiresAt: new Date(expiresAt).toISOString() };
    const contextId = automationContextId(enrollment);
    const review: ReplyDraftDetail = { ...detail, digest: automationHash({ draft: detail, bindingDigest: binding.bindingDigest, contextId, contactRevision: contact.revision }) };
    const draft: ReplyDraft = { id, contactId: contact.id, summary, actions: Object.freeze(structuredClone(intents)),
      disclosure: contact.disclosure, contextId, eventId, createdAt, expiresAt,
      contactRevision: contact.revision, bindingDigest: binding.bindingDigest, review };
    this.drafts.set(draft.id, draft);
    return structuredClone(review);
  }

  discard(draftId: string): boolean { return this.drafts.delete(draftId); }

  /** The bounded preview never authorizes a send. Return the complete ordered
   * batch and its recipient/content digest for explicit owner review. */
  async readDraft(draftId: string): Promise<ReplyDraftDetail> {
    this.pruneDrafts();
    const draft = this.drafts.get(draftId);
    if (!draft) fail("invalid-request", "This suggestion expired. Ask for a fresh one.");
    const state = await this.ports.state(), contact = state.settings.contacts.find(value => value.id === draft.contactId);
    const binding = state.bindings[draft.contactId];
    if (!contact || contact.revision !== draft.contactRevision || binding?.version !== 2 || binding.bindingDigest !== draft.bindingDigest)
      fail("conflict", "This contact changed since the suggestion. Request a fresh one.");
    return structuredClone(draft.review);
  }

  /** Explicit owner send: binds the exact draft or literal text to a fresh
   * plan, a live recipient grant and the journaled send transaction. */
  async send(input: { draftId: string; expectedDigest: string } | { contactId: string; text: string; expectedRevision?: number }, signal: AbortSignal): Promise<ReplySendResult> {
    const state = await this.ports.state();
    if ("contactId" in input && input.expectedRevision !== undefined && input.expectedRevision !== state.revision)
      fail("conflict", "Settings changed since the reply preview. Review the reply again before sending.");
    let contact: ContactSettings, actions: readonly ActionIntent[], draft: ReplyDraft | undefined, eventId: string;
    if ("draftId" in input) {
      this.pruneDrafts();
      draft = this.drafts.get(input.draftId);
      if (!draft) fail("invalid-request", "This suggestion expired. Ask for a fresh one.");
      if (input.expectedDigest !== draft.review.digest) fail("conflict", "Review the complete draft and use its exact digest before sending.");
      const selected = state.settings.contacts.find(value => value.id === draft!.contactId);
      if (!selected) fail("invalid-request", "This contact is not configured by the owner.");
      if (selected.revision !== draft.contactRevision) fail("conflict", "This contact changed since the suggestion. Request a fresh one.");
      if (selected.disclosure.character !== draft.disclosure.character || selected.disclosure.begin !== draft.disclosure.begin || selected.disclosure.end !== draft.disclosure.end)
        fail("conflict", "Disclosure settings changed since the suggestion. Request a fresh one.");
      contact = selected; actions = draft.actions; eventId = `owner:${draft.id}:${randomUUID()}`;
    } else {
      const selected = state.settings.contacts.find(value => value.id === input.contactId);
      if (!selected) fail("invalid-request", "This contact is not configured by the owner.");
      const parsed = parseActionIntent({ kind: "text", text: input.text });
      if (parsed === null) fail("invalid-request", "The reply text is not a supported messaging action.");
      contact = selected; actions = [parsed]; eventId = `owner:text:${randomUUID()}`;
    }
    const binding = state.bindings[contact.id];
    if (binding?.version !== 2) fail("unavailable", "This contact has no messaging enrollment that can send. Re-enroll it through messaging.");
    if (draft && (draft.bindingDigest !== binding.bindingDigest || draft.review.conversationId !== binding.enrollmentId))
      fail("conflict", "The messaging recipient changed since this suggestion. Request a fresh one.");
    const automation = this.ports.automation(), client = this.ports.client();
    if (!automation || !client) fail("unavailable", "Messaging automation is not configured.");
    if (this.ports.journal.hasUncertainSend(contact.id)) fail("conflict", "A previous send needs reconciliation before another reply.");
    if (this.ports.grantWork.has(contact.id)) fail("conflict", "This conversation's messaging grant is changing. Wait for it to settle.");
    if (this.pendingGrantRecovery(contact.id))
      fail("conflict", "A previous messaging grant needs reconciliation before another reply.");
    const enrollment = await client.poll(binding.enrollmentId, signal); assertAutomationBinding(binding, enrollment);
    if (!enrollment.ready) fail("unavailable", "Messaging catchup is incomplete. The reply stays queued until the conversation is current.");
    const contextId = automationContextId(enrollment);
    if (draft && draft.contextId !== contextId) fail("conflict", "The conversation changed since this suggestion. Request a fresh one.");
    const disclosed = draft?.review.actions ?? discloseReplyActions(actions, "", contact.disclosure);
    const kinds = [...new Set(disclosed.map(action => action.kind))];
    if (disclosed.some(action => (action.kind === "reaction" || action.kind === "sticker") && action.messageId !== null)) {
      const page = await client.history(binding.enrollmentId, 200, signal); assertAutomationBinding(binding, page.enrollment);
      const known = new Set(page.messages.filter(message => message.kind === "message").map(message => message.id));
      for (const action of disclosed) {
        if ((action.kind === "reaction" || action.kind === "sticker") && action.messageId !== null && !known.has(action.messageId)) fail("conflict", "The suggested action targets a message that is no longer in this conversation.");
      }
    }
    const runId = randomUUID();
    signal.throwIfAborted();
    if (this.ports.grantWork.has(contact.id)) fail("conflict", "This conversation's messaging grant is changing. Wait for it to settle.");
    if (this.pendingGrantRecovery(contact.id)) fail("conflict", "A previous messaging grant needs reconciliation before another reply.");
    if (!this.ports.journal.claim(runId, contact.id, eventId, this.ports.now())) fail("conflict", "This conversation already has a reply in progress.");
    const journal = this.ports.journal, now = this.ports.now;
    let phase: "running" | "dispatching" = "running";
    const hook: HookContext = { contactId: contact.id, runId, eventId, signal };
    let ephemeral: AutomationGrant | null = null;
    const finish = (next: "cancelled" | "failed" | "submitted" | "partial" | "indeterminate", detail: string): ReplySendResult => {
      journal.transition(runId, phase, next, detail.slice(0, 400), now());
      return { contactId: contact.id, runId, state: next, detail };
    };
    // The work registration covers the whole dispatch so delegated renewal and
    // disable-revocation stay blocked until the send settles and the scoped
    // grant is released.
    const work = (async (): Promise<ReplySendResult> => {
      try {
        if ((await this.ports.hooks.emit("reply.before-send", hook)).veto) return finish("cancelled", "extension-veto");
        const transport = createGhostgetAutomationTransport({ client, enrollmentId: binding.enrollmentId,
          admitAsset: async path => {
            const asset = await (await this.ports.workspace(contact.id)).admitAsset(path);
            const reviewed = draft?.review.assets.find(value => value.path === path);
            if (!reviewed || reviewed.sha256 !== asset.sha256 || reviewed.bytes !== asset.bytes.length) throw new Error("The reviewed attachment changed");
            return asset;
          }, now });
        const grant = await this.sendGrant(automation, contact, binding, kinds, disclosed.length, signal);
        ephemeral = grant.ephemeral;
        const plan = await transport.prepare({ intentId: runId, conversationId: binding.enrollmentId, contextId, actions: disclosed });
        if (!plan.ok) { if (plan.error.code === "stale-context") fail("conflict", "The conversation changed. Request a fresh suggestion."); fail("unavailable", "The messaging plan could not be prepared."); }
        const latest = await this.ports.state(), currentContact = latest.settings.contacts.find(value => value.id === contact.id);
        const currentBinding = latest.bindings[contact.id];
        if (!currentContact || currentContact.revision !== contact.revision || currentBinding?.version !== 2 || currentBinding.bindingDigest !== binding.bindingDigest)
          fail("conflict", "The contact changed while preparing this reply. Review it again before sending.");
        signal.throwIfAborted();
        journal.transition(runId, "running", "dispatching", "intent-recorded", now(), plan.value.digest);
        phase = "dispatching";
        const receipt = await transport.submit(plan.value, { mode: "delegated", grantId: grant.grantId }, signal);
        if (!receipt.ok) return finish("indeterminate", "The send outcome is unknown. Reconcile the journaled intent before another reply.");
        if (receipt.value.acceptedMessageIds) journal.recordSentMessages(contact.id, receipt.value.runId, receipt.value.acceptedMessageIds, now());
        const result = finish(receipt.value.state, receipt.value.state === "submitted" ? "Reply sent." : receipt.value.state === "failed" ? "The provider rejected this reply." : "The send needs reconciliation.");
        if (result.state === "submitted") {
          if (draft) this.drafts.delete(draft.id);
          this.notePending(contact.id, null);
          try { await this.ports.hooks.emit("reply.sent", hook); } catch { /* The receipt stays authoritative. */ }
        }
        return result;
      } catch (error) {
        if (phase === "dispatching") {
          try { journal.transition(runId, "dispatching", "indeterminate", "send-outcome-unknown", now()); } catch { /* Restart recovery reconciles a still-open dispatch. */ }
          return { contactId: contact.id, runId, state: "indeterminate", detail: "The send outcome is unknown. Reconcile the journaled intent before another reply." };
        }
        try { journal.transition(runId, "running", signal.aborted ? "cancelled" : "failed", signal.aborted ? "cancelled" : "run-failed", now()); } catch { /* Claim may already have settled. */ }
        if (error instanceof ControlFailure) throw error;
        fail("unavailable", "The reply could not be sent. Inspect messaging setup and retry.");
      } finally {
        await this.releaseGrant(contact, ephemeral);
      }
    })();
    this.ports.grantWork.set(contact.id, work.then(() => undefined, () => undefined));
    try { return await work; } finally { this.ports.grantWork.delete(contact.id); }
  }

  /** Reuse a live standing grant or issue a tightly scoped owner-send grant.
   * The caller's work registration keeps recovery from revoking mid-dispatch. */
  private async sendGrant(automation: OwnerAutomationPort, contact: ContactSettings, binding: AutomationBinding, kinds: readonly ActionIntent["kind"][], actionCount: number, signal: AbortSignal): Promise<{ grantId: string; ephemeral: AutomationGrant | null }> {
    const state = await this.ports.state();
    const existing = state.grants[contact.id];
    if (existing) {
      const live = await automation.grantStatus(binding, existing.id, signal);
      if (!live.revoked && Date.parse(live.expiresAt) > this.ports.now() + 60_000 && live.maximumActions - live.consumedActions >= actionCount
        && kinds.every(kind => live.actions.includes(kind))) return { grantId: live.id, ephemeral: null };
      // Replace the stale standing grant so the scoped grant is the only
      // published authority for this conversation.
      await automation.revoke(existing.id, AbortSignal.timeout(60_000));
    }
    const intentId = randomUUID();
    this.ports.journal.recordGrantIntent({ id: intentId, contactId: contact.id, enrollmentId: binding.enrollmentId, bindingDigest: binding.bindingDigest });
    const created = await automation.grantScoped(binding, { enrollmentId: binding.enrollmentId, expectedBindingDigest: binding.bindingDigest,
      actions: kinds, expiresAt: new Date(this.ports.now() + 600_000).toISOString(), maximumActions: actionCount, minimumIntervalMs: 0 }, intentId, signal);
    this.ports.journal.recordPendingGrant(contact.id, created, intentId);
    try {
      await this.ports.publishGrant(contact.id, created);
      this.ports.journal.clearPendingGrant(created.id);
      return { grantId: created.id, ephemeral: created };
    } catch (error) {
      try { await automation.revoke(created.id, AbortSignal.timeout(60_000)); this.ports.journal.clearPendingGrant(created.id); }
      catch { /* The durable pending grant keeps revocation honest through recovery. */ }
      throw error;
    }
  }

  /** An owner-send grant survives only while its contact stays enabled. */
  private async releaseGrant(contact: ContactSettings, ephemeral: AutomationGrant | null): Promise<void> {
    if (ephemeral === null || !this.ports.automation()) return;
    try {
      const state = await this.ports.state();
      const selected = state.settings.contacts.find(value => value.id === contact.id);
      if (selected?.enabled) return; // published standing grant; delegated renewal owns it now
      await this.ports.automation()!.revoke(ephemeral.id, AbortSignal.timeout(60_000));
      await this.ports.publishGrant(contact.id, null);
    } catch { /* The published grant remains visible until recovery revokes it. */ }
  }
}
