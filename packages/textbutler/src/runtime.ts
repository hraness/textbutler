import { randomUUID } from "node:crypto";
import { parseActionIntent, type ActionIntent, type TextbutlerTransport } from "../../transport/src/index.ts";
import { parseClassification } from "@hraness/agentmixer";
import { disclose, parseSettings, type ContactSettings, type Settings } from "./config.ts";
import { decideReply, type ConversationState, type MessageEvent } from "./decision.ts";
import { Hooks, type HookContext } from "./hooks.ts";
import { RunJournal, type RunState } from "./journal.ts";

export type ConversationSnapshot = Readonly<{ state: ConversationState; contextId: string; messageIds: readonly string[] }>;
export type AgentRequest = Readonly<{ runId: string; contact: ContactSettings; event: MessageEvent; signal: AbortSignal }>;
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
}>;
export type ProcessOutcome = Readonly<{ status: "ignored" | "deferred" | "blocked" | "duplicate-or-busy" | RunState; reason: string; runId?: string }>;

function composeResult(value: unknown, contact: ContactSettings): readonly ActionIntent[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["summary", "actions"].includes(k)) || typeof input.summary !== "string" || !input.summary.trim() || Buffer.byteLength(input.summary) > 4_096 || !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 8) throw new Error("Invalid response plan");
  const actions = input.actions.map(parseActionIntent);
  const text = actions.filter(a => a.kind === "text");
  const disclosed = actions.map(action => action.kind === "text" ? { ...action, text: disclose(action.text, contact.disclosure) } : action);
  // Standalone cards and reactions cannot carry a prefix. Put an attributed companion first.
  if (text.length === 0 || actions[0]?.kind !== "text") disclosed.unshift({ kind: "text", text: disclose(input.summary, contact.disclosure) });
  if (disclosed.length > 8) throw new Error("Disclosure companion must fit within the action limit");
  return disclosed;
}

export class ButlerRuntime {
  private readonly active = new Map<string, AbortController>();
  private readonly clock: () => number;
  constructor(private readonly ports: RuntimePorts) { this.clock = ports.clock ?? Date.now; }
  cancelContact(id: string): void { this.active.get(id)?.abort(); }
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
    const decision = decideReply(settings, contact, event, snapshot.state, this.clock());
    if (decision.outcome === "ignore") return { status: "ignored", reason: decision.reason };
    if (decision.outcome === "defer") return { status: "deferred", reason: decision.reason };
    const capabilities = await this.ports.transport.capabilities();
    if (!capabilities.ok) return { status: "blocked", reason: capabilities.error.code };
    if (!capabilities.value.capabilities.some(c => c.capability === "autonomous-send" && c.available)) return { status: "blocked", reason: "transport-needs-delegated-send" };
    if (!await this.ports.agent.qualified(contact)) return { status: "blocked", reason: "agent-sandbox-unqualified" };
    const grant = await this.ports.delegatedGrant(contact);
    if (!grant) return { status: "blocked", reason: "contact-grant-required" };
    const runId = randomUUID();
    if (!this.ports.journal.claim(runId, contact.id, event.id, this.clock())) return { status: "duplicate-or-busy", reason: "event-or-contact-already-claimed" };
    const controller = new AbortController();
    this.active.set(contact.id, controller);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const hook: HookContext = { contactId: contact.id, runId, eventId: event.id, signal: controller.signal };
    const request: AgentRequest = { runId, contact, event, signal: controller.signal };
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
      const lastDecision = decideReply(current, currentContact, event, refreshed.state, this.clock());
      if (controller.signal.aborted || !["reply", "classify"].includes(lastDecision.outcome) || refreshed.state.latestRevision !== snapshot.state.latestRevision || refreshed.contextId !== snapshot.contextId) return finish("cancelled", "conversation-changed");
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
      const receipt = await this.ports.transport.submit(plan.value, { mode: "delegated", grantId: grant }, controller.signal);
      if (!receipt.ok) return finish("indeterminate", "dispatch-result-unknown");
      const result = finish(receipt.value.state, receipt.value.state);
      try { await this.ports.hooks.emit("reply.sent", hook); } catch { /* Receipt remains authoritative if a notification hook fails. */ }
      return result;
    } catch {
      const result = finish(state === "dispatching" ? "indeterminate" : controller.signal.aborted ? "cancelled" : "failed", state === "dispatching" ? "dispatch-result-unknown" : "run-failed");
      try { await this.ports.hooks.emit("run.failed", hook); } catch { /* No retry caused by a hook. */ }
      return result;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.active.delete(contact.id);
    }
  }
}
