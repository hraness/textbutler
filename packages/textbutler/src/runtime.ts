import { randomUUID } from "node:crypto";
import { parseActionIntent, type ActionIntent, type TextbutlerTransport } from "../../transport/src/index.ts";
import { parseClassification } from "@hraness/agentmixer";
import { disclose, disclosureMarkers, parseSettings, type ContactSettings, type Settings } from "./config.ts";
import { decideReply, type ConversationState, type MessageEvent } from "./decision.ts";
import { Hooks, type HookContext } from "./hooks.ts";
import { RunJournal, type RunState } from "./journal.ts";
import { DriverFault } from "./fast-driver.ts";

export type ConversationSnapshot = Readonly<{ state: ConversationState; contextId: string; messageIds: readonly string[] }>;
export type AgentRequest = Readonly<{ runId: string; contact: ContactSettings; event: MessageEvent; signal: AbortSignal; capabilities?: readonly string[] }>;
export class NoReplyNeeded extends Error {}
export type SubmittedReply = Readonly<{ runId: string; contact: ContactSettings; event: MessageEvent; actions: readonly ActionIntent[]; messageIds: readonly string[]; at: number }>;
export interface ButlerAgent {
  /** True only after the installed provider's actual tool and file boundary is qualified. */
  qualified(contact: ContactSettings): Promise<boolean>;
  classify(request: AgentRequest): Promise<unknown>;
  compose(request: AgentRequest): Promise<unknown>;
}
export type RuntimePorts = Readonly<{
  settings: () => Settings;
  refresh: (contact: ContactSettings, event: MessageEvent) => Promise<ConversationSnapshot>;
  agent: ButlerAgent;
  transport: TextbutlerTransport;
  journal: RunJournal;
  hooks: Hooks;
  delegatedGrant: (contact: ContactSettings) => Promise<string | null>;
  validateFile: (contact: ContactSettings, path: string) => Promise<void>;
  clock?: () => number;
  onSubmitted?: (reply: SubmittedReply) => void;
}>;
export type ProcessOutcome = Readonly<{ status: "ignored" | "deferred" | "blocked" | "duplicate-or-busy" | RunState; reason: string; runId?: string }>;
/** One run covers intake refresh, qualification, ack, compose and dispatch:
 * the serialized transport lane can queue each invoke for minutes on a loaded
 * host, so the budget bounds the whole run, not any single call. */
const RUN_BUDGET_MS = 600_000;
/** Intake outcomes that indicate pipeline trouble and therefore journal an
 * ignored run as evidence. Ordinary silence (keyword-absent, owner activity,
 * rate limits, cooldowns) stays unjournaled. */
const AUDITED_INTAKE_DROPS = new Set(["stale-event", "superseded", "invalid-event-or-state", "route-mismatch"]);

function composeResult(value: unknown, contact: ContactSettings): readonly ActionIntent[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["summary", "actions"].includes(k)) || typeof input.summary !== "string" || !input.summary.trim() || Buffer.byteLength(input.summary) > 4_096 || !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 8) throw new Error("Invalid response plan");
  const actions = input.actions.map(parseActionIntent);
  const text = actions.filter(a => a.kind === "text");
  const disclosed = actions.map(action => action.kind === "text" ? { ...action, text: disclose(action.text, contact.disclosure) } : action);
  // Standalone cards and reactions cannot carry a prefix. Put an attributed
  // companion first — only when this contact still has visible markers. With
  // disclosure fully cleared the companion would be an unexplained extra text.
  if (disclosureMarkers(contact.disclosure) !== null && (text.length === 0 || actions[0]?.kind !== "text")) disclosed.unshift({ kind: "text", text: disclose(input.summary, contact.disclosure) });
  if (disclosed.length > 8) throw new Error("Disclosure companion must fit within the action limit");
  return disclosed;
}

export class ButlerRuntime {
  private readonly active = new Map<string, AbortController>();
  private readonly dispatching = new Set<string>();
  private readonly clock: () => number;
  constructor(private readonly ports: RuntimePorts) { this.clock = ports.clock ?? Date.now; }
  /** A new event cancels only pre-dispatch work. Once send intent is recorded the
   * transport's atomic context check arbitrate the send; aborting mid-dispatch
   * would only manufacture an indeterminate outcome. */
  cancelContact(id: string): void { if (!this.dispatching.has(id)) this.active.get(id)?.abort(); }
  pause(): void { for (const controller of this.active.values()) controller.abort(); }
  private async refresh(contact: ContactSettings, event: MessageEvent): Promise<ConversationSnapshot> {
    const snapshot = await this.ports.refresh(contact, event);
    return { ...snapshot, state: { ...snapshot.state, repliesInLastHour: Math.max(snapshot.state.repliesInLastHour, this.ports.journal.repliesSince(contact.id, this.clock() - 3_600_000)) } };
  }

  async process(event: MessageEvent): Promise<ProcessOutcome> {
    const settings = parseSettings(this.ports.settings());
    const contact = settings.contacts.find(c => c.id === event.contactId);
    if (!contact) return { status: "ignored", reason: "unknown-contact" };
    if (this.ports.journal.hasUncertainSend(contact.id)) return { status: "blocked", reason: "reconcile-previous-send" };
    const snapshot = await this.refresh(contact, event);
    const admittedAt = this.clock();
    const decision = decideReply(settings, contact, event, snapshot.state, admittedAt);
    if (decision.outcome === "ignore") {
      // Drops that indicate pipeline trouble are evidence, not noise: journal
      // them under a namespaced event id so the outcome stays visible without
      // colliding with the event's real claim or replaying on re-drain.
      if (AUDITED_INTAKE_DROPS.has(decision.reason)) {
        const dropId = randomUUID();
        if (this.ports.journal.claim(dropId, contact.id, `drop:${event.id}`, this.clock())) this.ports.journal.transition(dropId, "running", "ignored", `intake:${decision.reason}`, this.clock());
      }
      return { status: "ignored", reason: decision.reason };
    }
    if (decision.outcome === "defer") return { status: "deferred", reason: decision.reason };
    // The capability and qualification gates are independent reads; fetching
    // them together keeps a transport status session off the serial run path.
    // Deferring qualification behind Promise.resolve keeps a synchronous port
    // throw from detaching the capabilities read.
    const [capabilities, qualified] = await Promise.all([
      this.ports.transport.capabilities(), Promise.resolve().then(() => this.ports.agent.qualified(contact)),
    ]);
    if (!capabilities.ok) return { status: "blocked", reason: capabilities.error.code };
    if (!capabilities.value.capabilities.some(c => c.capability === "autonomous-send" && c.available)) return { status: "blocked", reason: "transport-needs-delegated-send" };
    if (!qualified) return { status: "blocked", reason: "agent-sandbox-unqualified" };
    const grant = await this.ports.delegatedGrant(contact);
    if (!grant) return { status: "blocked", reason: "contact-grant-required" };
    const runId = randomUUID();
    if (!this.ports.journal.claim(runId, contact.id, event.id, this.clock())) return { status: "duplicate-or-busy", reason: "event-or-contact-already-claimed" };
    const controller = new AbortController();
    this.active.set(contact.id, controller);
    const timeout = setTimeout(() => controller.abort(), RUN_BUDGET_MS);
    const hook: HookContext = { contactId: contact.id, runId, eventId: event.id, signal: controller.signal };
    const request: AgentRequest = { runId, contact, event, signal: controller.signal, capabilities: capabilities.value.capabilities.filter(value => value.available).map(value => value.capability) };
    let state: RunState = "running";
    const finish = (next: RunState, reason: string): ProcessOutcome => {
      this.ports.journal.transition(runId, state, next, reason, this.clock());
      state = next;
      return { status: next, reason, runId };
    };
    try {
      if ((await this.ports.hooks.emit("message.received", hook)).veto || (await this.ports.hooks.emit("reply.decide", hook)).veto) return finish("ignored", "extension-veto");
      if (decision.outcome === "classify") {
        const classification = parseClassification(await this.ports.agent.classify(request));
        if (!classification.respond || classification.confidence < 0.85) return finish("ignored", "classifier-silent");
      }
      if (controller.signal.aborted) return finish("cancelled", "cancelled");
      // A disclosure-wrapped ack is the fastest possible read receipt: it lands
      // while composition still runs and its echo attributes to the butler, not
      // the owner. It is awaited so it precedes the reply in the serialized
      // lane and holds the dispatching guard like the reply does — aborting it
      // mid-dispatch would only manufacture an indeterminate. A dispatch whose
      // outcome is unknown wedges the run honestly instead of leaving an
      // unresolved upstream run for the next reply to trip on.
      const ackIds = new Set<string>();
      const ack = await this.ports.transport.prepare({ intentId: `${runId}:ack`, conversationId: contact.routeId, contextId: snapshot.contextId,
        actions: [{ kind: "text", text: disclose("…", contact.disclosure) }] });
      if (ack.ok) {
        this.dispatching.add(contact.id);
        const ackReceipt = await this.ports.transport.submit(ack.value, { mode: "delegated", grantId: grant }, controller.signal).catch(() => null);
        this.dispatching.delete(contact.id);
        // An ack that provably never dispatched is skipped, not wedged: the
        // reply itself still proceeds. Only unknown ack outcomes block.
        if (ackReceipt === null || (!ackReceipt.ok && ackReceipt.error.code !== "dispatch-failed") || (ackReceipt.ok && (ackReceipt.value.state === "indeterminate" || ackReceipt.value.state === "partial"))) return finish("indeterminate", "ack-dispatch-unknown");
        if (ackReceipt.ok && ackReceipt.value.state === "submitted" && ackReceipt.value.acceptedMessageIds) {
          this.ports.journal.recordSentMessages(contact.id, `${runId}:ack`, ackReceipt.value.acceptedMessageIds, this.clock());
          for (const id of ackReceipt.value.acceptedMessageIds) if (id !== null) ackIds.add(id);
        }
      }
      const acked = ackIds.size > 0;
      if ((await this.ports.hooks.emit("reply.compose", hook)).veto) return finish("ignored", "extension-veto");
      const actions = composeResult(await this.ports.agent.compose(request), contact);
      for (const action of actions) {
        if (!capabilities.value.capabilities.some(c => c.capability === action.kind && c.available)) return finish("failed", `unsupported-${action.kind}`);
        if (action.kind === "attachment" || action.kind === "sticker") await this.ports.validateFile(contact, action.file);
        if ((action.kind === "reaction" || action.kind === "sticker") && action.messageId !== null && !snapshot.messageIds.includes(action.messageId)) return finish("failed", "foreign-message-target");
      }
      if ((await this.ports.hooks.emit("reply.before-send", hook)).veto) return finish("ignored", "extension-veto");
      const current = parseSettings(this.ports.settings());
      const currentContact = current.contacts.find(c => c.id === contact.id);
      if (!currentContact || currentContact.revision !== contact.revision || currentContact.routeId !== contact.routeId) return finish("cancelled", "settings-changed");
      const refreshed = await this.refresh(currentContact, event);
      // An acked run moved the revision itself, so supersession is judged from
      // the refreshed baseline — genuinely new messages are caught below by
      // comparing message ids instead.
      const lastDecision = decideReply(current, currentContact, acked ? { ...event, revision: refreshed.state.latestRevision } : event, refreshed.state, this.clock(), admittedAt);
      // A pinned run already absorbed a continuous stream to its cap: newer
      // contact messages queue behind it instead of restarting it forever.
      // Pause, settings, owner activity and stale context still cancel it.
      const stillReply = ["reply", "classify"].includes(lastDecision.outcome) || (event.pinned === true && lastDecision.reason === "superseded");
      // Once an ack is journaled, revision drift is expected — our own echo
      // bumps it. The cancel condition then relaxes to "a new message id
      // arrived that isn't this run's ack", which still catches contact or
      // owner messages — including owner sends journaled separately — while
      // ignoring the ack's own echo (and any reaction or edit, which adds no
      // message id). Without an ack, drift remains the strict scalar
      // revision/context comparison.
      const changed = event.pinned !== true && (acked
        ? refreshed.messageIds.some(id => !snapshot.messageIds.includes(id) && !ackIds.has(id))
        : refreshed.state.latestRevision !== snapshot.state.latestRevision || refreshed.contextId !== snapshot.contextId);
      if (controller.signal.aborted || !stillReply || changed) return finish("cancelled", "conversation-changed");
      const plan = await this.ports.transport.prepare({ intentId: runId, conversationId: contact.routeId, contextId: refreshed.contextId, actions });
      if (!plan.ok) return finish("failed", plan.error.code);
      if (controller.signal.aborted) return finish("cancelled", "cancelled");
      // Recheck mutable permission after preparation. The transport must atomically bind
      // the delegated grant, context revision, action digest and ordered execution.
      const finalSettings = parseSettings(this.ports.settings());
      const finalContact = finalSettings.contacts.find(c => c.id === contact.id);
      if (!finalContact || finalSettings.paused || !finalContact.enabled || finalContact.revision !== contact.revision || await this.ports.delegatedGrant(finalContact) !== grant) return finish("cancelled", "grant-changed");
      const dispatchSettings = parseSettings(this.ports.settings());
      if (controller.signal.aborted || dispatchSettings.paused || !dispatchSettings.contacts.some(c => c.id === contact.id && c.enabled && c.revision === contact.revision && c.pausedUntil <= this.clock())) return finish("cancelled", "cancelled-at-dispatch");
      this.ports.journal.transition(runId, "running", "dispatching", "intent-recorded", this.clock(), plan.value.digest);
      state = "dispatching";
      this.dispatching.add(contact.id);
      const receipt = await this.ports.transport.submit(plan.value, { mode: "delegated", grantId: grant }, controller.signal);
      // A proven non-send fails the run cleanly instead of blocking the
      // contact; only an outcome the provider cannot arbitrate stays uncertain.
      if (!receipt.ok) return finish(receipt.error.code === "dispatch-failed" ? "failed" : "indeterminate", receipt.error.code === "dispatch-failed" ? "dispatch-failed" : "dispatch-result-unknown");
      if (receipt.value.acceptedMessageIds) this.ports.journal.recordSentMessages(contact.id, receipt.value.runId, receipt.value.acceptedMessageIds, this.clock());
      const result = finish(receipt.value.state, receipt.value.state);
      if (receipt.value.state === "submitted") {
        try { this.ports.onSubmitted?.({ runId, contact, event, actions, at: this.clock(), messageIds: (receipt.value.acceptedMessageIds ?? []).filter((id): id is string => id !== null) }); } catch {}
      }
      try { await this.ports.hooks.emit("reply.sent", hook); } catch { /* Receipt remains authoritative if a notification hook fails. */ }
      return result;
    } catch (error) {
      if (state === "running" && error instanceof NoReplyNeeded) return finish("ignored", "agent-silent");
      const failureClass = error instanceof DriverFault ? `run-failed:driver-${error.kind}`
        : error instanceof Error && error.message.startsWith("Hook timed out") ? "run-failed:hook" : "run-failed";
      const result = finish(state === "dispatching" ? "indeterminate" : controller.signal.aborted ? "cancelled" : "failed",
        state === "dispatching" ? "dispatch-result-unknown" : failureClass);
      try { await this.ports.hooks.emit("run.failed", hook); } catch { /* No retry caused by a hook. */ }
      return result;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.active.delete(contact.id);
      this.dispatching.delete(contact.id);
    }
  }
}
