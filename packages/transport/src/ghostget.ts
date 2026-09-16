import { createHash } from "node:crypto";
import type { ActionIntent, ActionPlan, Capability, Conversation, HistoryMessage, PrepareRequest, SendReceipt, TextbutlerTransport, TransportResult } from "./types";
import { TRANSPORT_PROTOCOL } from "./types";
import { array, canonicalJson, digest, failure, integer, nullableString, object, parseActionIntent, string, success, timestamp } from "./validation";

/** These names map to existing Ghostget CLI commands. No invented daemon RPC. */
export type GhostgetInvocation =
  | { readonly command: "capabilities"; readonly adapterId: "imessage-direct" | "whatsapp-web" }
  | { readonly command: "messaging.routes" | "messaging.resolve" | "messaging.context" | "messaging.preview"; readonly input: Readonly<Record<string, unknown>> }
  | { readonly command: "confirm"; readonly planDigest: string };
/** Invokers return parsed, receipt-verified private artifacts for messaging commands. */
export type GhostgetInvoker = (request: GhostgetInvocation) => Promise<unknown>;
export interface GhostgetTransportOptions { readonly invoke: GhostgetInvoker; readonly authId: string; readonly clock?: () => Date }
const capabilities: readonly Capability[] = ["history", "contacts", "events", "text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience", "autonomous-send"];
const requiredOperations = ["messaging.list", "conversations.read", "messaging.read", "messaging.send"] as const;
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function ref(value: unknown, kind: "wmroute" | "wmcontext"): string {
  const result = string(value, 128);
  if (!new RegExp(`^${kind}_[A-Za-z0-9_-]{22}$`, "u").test(result)) throw new Error("Invalid opaque reference");
  return result;
}
function envelope(value: unknown, format: string, schemaVersion: number): Record<string, unknown> {
  const result = object(value);
  if (result.format !== format || result.schemaVersion !== schemaVersion) throw new Error("Ghostget contract changed");
  return result;
}
function unavailable<T>(): TransportResult<T> { return failure("unavailable", "Ghostget could not complete this operation. Check the installed provider and its permissions."); }
function parseConversation(value: unknown): Conversation {
  const route = envelope(value, "wrench.messaging-route", 2);
  if (route.network !== "imessage") throw new Error("Unexpected messaging network");
  const conversation = object(route.conversation);
  if (!["single", "group", "unknown"].includes(String(conversation.kind))) throw new Error("Unknown conversation kind");
  return { id: ref(route.routeRef, "wmroute"), title: nullableString(conversation.title), kind: conversation.kind as Conversation["kind"], participantCount: integer(conversation.participantCount, 0, 1024), expiresAt: timestamp(route.expiresAt) };
}
function parseMessage(value: unknown): HistoryMessage {
  const message = object(value);
  if (!["incoming", "outgoing", "unknown"].includes(String(message.direction)) || message.untrustedData !== true || typeof message.bodyTruncated !== "boolean") throw new Error("Invalid message");
  return { id: string(message.messageRef, 128), direction: message.direction as HistoryMessage["direction"], time: message.time === null ? null : timestamp(message.time), text: message.body === "" ? "" : nullableString(message.body, 65536), truncated: message.bodyTruncated, untrusted: true };
}

/** Ghostget remains responsible for provider identity, permission and at-most-once dispatch. */
export function createGhostgetTransport(options: GhostgetTransportOptions): TextbutlerTransport {
  const authId = string(options.authId, 128);
  const clock = options.clock ?? (() => new Date());
  const plans = new Map<string, { readonly plan: ActionPlan; readonly intentHash: string; consumed: boolean }>();
  const contexts = new Map<string, { readonly conversationId: string; readonly expiresAt: string }>();
  const resolvedRoutes = new Map<string, Conversation>();
  const prune = (): void => {
    for (const [id, entry] of contexts) if (Date.parse(entry.expiresAt) <= clock().getTime()) contexts.delete(id);
    for (const [id, entry] of plans) if (Date.parse(entry.plan.expiresAt) <= clock().getTime()) plans.delete(id);
    for (const [id, entry] of resolvedRoutes) if (Date.parse(entry.expiresAt) <= clock().getTime()) resolvedRoutes.delete(id);
  };
  async function installed(): Promise<Set<string>> {
    const result = object(await options.invoke({ command: "capabilities", adapterId: "imessage-direct" }));
    if (result.ok !== true) return new Set();
    const adapters = array(result.adapters, 128).map(object).filter(adapter => adapter.id === "imessage-direct");
    if (adapters.length !== 1) return new Set();
    const adapter = adapters[0]!;
    if (adapter.surfaceId !== "imessage") return new Set();
    const operations = new Set<string>();
    for (const raw of array(adapter.operations, 256)) {
      const operation = object(raw);
      if (operation.transport === "local-cli" && operation.surface === "imessage" && operation.localCliContractVersion === 1 && operation.state === "observed" && operation.id === operation.localCliAction && requiredOperations.includes(operation.id as typeof requiredOperations[number])) operations.add(String(operation.id));
    }
    return operations;
  }
  async function readReady(): Promise<boolean> { const operations = await installed(); return requiredOperations.slice(0, 3).every(operation => operations.has(operation)); }
  return {
    async capabilities() {
      try {
        const operations = await installed();
        const read = requiredOperations.slice(0, 3).every(operation => operations.has(operation));
        return success({ protocol: TRANSPORT_PROTOCOL, provider: "ghostget-imessage", capabilities: capabilities.map(capability => {
          const available = capability === "history" ? read : capability === "text" && read && operations.has("messaging.send");
          const reason = available ? null : capability === "autonomous-send" ? "Ghostget has no negotiated contact-scoped delegation grant; exact owner confirmation is required." : capability === "events" ? "The installed iMessage contract has bounded reads, with no durable event cursor or subscription." : capability === "contacts" ? "Ghostget has no native Contacts directory operation in this contract." : `The installed Ghostget contract does not provide ${capability}.`;
          return { capability, available, reason };
        }) });
      } catch { return unavailable(); }
    },
    async conversations() {
      try {
        if (!await readReady()) return failure("unsupported", "The reviewed iMessage read contract is not installed.", "history");
        const value = envelope(await options.invoke({ command: "messaging.routes", input: { schemaVersion: 1, format: "wrench.messaging-routes-request", source: { adapterId: "imessage-direct", authId, listInput: { limit: 200 } } } }), "wrench.messaging-routes", 2);
        return success(array(value.routes, 1000).map(parseConversation));
      } catch { return unavailable(); }
    },
    async contacts() { return failure("unsupported", "Native Contacts discovery requires a separately negotiated Ghostget Contacts provider.", "contacts"); },
    async events() { return failure("unsupported", "Ghostget does not expose a durable iMessage event cursor. Bounded history is not an event stream.", "events"); },
    async history(request) {
      let conversationId: string, limit: number;
      try { conversationId = ref(request.conversationId, "wmroute"); limit = integer(request.limit ?? 100, 1, 200); if (request.cursor !== undefined) return failure("unsupported", "The installed history contract has no pagination cursor.", "history"); } catch { return failure("invalid-input", "Invalid bounded conversation history request."); }
      try {
        if (!await readReady()) return failure("unsupported", "The reviewed iMessage read contract is not installed.", "history");
        prune();
        const route = resolvedRoutes.get(conversationId) ?? parseConversation(await options.invoke({ command: "messaging.resolve", input: { schemaVersion: 2, format: "wrench.messaging-route-resolve-request", routeRef: conversationId } }));
        if (Date.parse(route.expiresAt) <= clock().getTime()) return failure("stale-context", "The exact conversation reference has expired.");
        if (resolvedRoutes.size >= 256 && !resolvedRoutes.has(route.id)) return failure("unavailable", "Too many live conversation routes.");
        resolvedRoutes.set(route.id, route);
        // Ghostget deliberately mints a NEW reference when resolving a list candidate.
        conversationId = route.id;
        const value = envelope(await options.invoke({ command: "messaging.context", input: { schemaVersion: 1, format: "wrench.messaging-context-request", routeRef: conversationId, limit } }), "wrench.messaging-context", 1);
        if (value.network !== "imessage" || typeof value.truncated !== "boolean") throw new Error("Invalid context");
        const binding = value.binding === null ? null : envelope(value.binding, "wrench.messaging-context-binding", 2);
        if (binding !== null && binding.routeRef !== conversationId) throw new Error("Cross-conversation context");
        const contextId = binding === null ? null : ref(binding.contextRef, "wmcontext");
        const expiresAt = binding === null ? null : timestamp(binding.expiresAt);
        if (expiresAt !== null && Date.parse(expiresAt) <= clock().getTime()) return failure("stale-context", "The message context has expired.");
        prune();
        if (contextId !== null && expiresAt !== null) { if (contexts.size >= 256) return failure("unavailable", "Too many live message contexts."); contexts.set(contextId, { conversationId, expiresAt }); }
        return success({ conversationId, contextId, revision: binding === null ? null : digest(binding.exactDataRevision), expiresAt, messages: array(value.messages, 200).map(parseMessage), complete: value.truncated === false && object(value.completeness).kind === "complete", nextCursor: null });
      } catch { return failure("contract-mismatch", "Ghostget did not return the expected exact iMessage context."); }
    },
    async prepare(request: PrepareRequest) {
      let actions: readonly ActionIntent[], intentId: string, conversationId: string, contextId: string;
      try { actions = array(request.actions, 8).map(parseActionIntent); if (actions.length === 0) throw new Error("Empty turn"); intentId = string(request.intentId, 128); conversationId = ref(request.conversationId, "wmroute"); contextId = ref(request.contextId, "wmcontext"); } catch { return failure("invalid-input", "Invalid bounded message action plan."); }
      const unsupported = actions.find(action => action.kind !== "text");
      if (unsupported !== undefined) return failure("unsupported", `Ghostget does not support ${unsupported.kind} in its installed iMessage contract.`, unsupported.kind);
      prune();
      const context = contexts.get(contextId);
      if (context === undefined || context.conversationId !== conversationId) return failure("stale-context", "Read fresh exact conversation context before preparing a turn.");
      if (plans.size >= 256) return failure("unavailable", "Too many live action plans.");
      const intentHash = hash({ intentId, conversationId, contextId, actions });
      const parts = actions.map((action, index) => ({ partId: `part-${index + 1}`, text: (action as Extract<ActionIntent, { kind: "text" }>).text, replyRef: null }));
      try {
        if (!(await installed()).has("messaging.send")) return failure("unsupported", "The reviewed iMessage send contract is not installed.", "text");
        const preview = envelope(await options.invoke({ command: "messaging.preview", input: { schemaVersion: 1, format: "wrench.messaging-turn", clientIntentSha256: intentHash, routeRef: conversationId, contextRef: contextId, parts } }), "wrench.messaging-preview", 1);
        if (preview.status !== "confirmation-required" || preview.risk !== "R3" || preview.routeRef !== conversationId || preview.contextRef !== contextId || preview.clientIntentSha256 !== intentHash || integer(preview.partCount, 1, 8) !== parts.length || hash(array(preview.bubbles, 8)) !== hash(parts) || object(preview.recipient).network !== "imessage") throw new Error("Changed preview");
        const planDigest = digest(preview.planDigest), expiresAt = timestamp(preview.expiresAt);
        if (Date.parse(expiresAt) <= clock().getTime()) return failure("stale-context", "The action preview expired.");
        const plan: ActionPlan = Object.freeze({ protocol: TRANSPORT_PROTOCOL, id: planDigest, intentId, conversationId, contextId, digest: planDigest, expiresAt, actions: Object.freeze(actions.map(action => Object.freeze(action))) });
        const prior = plans.get(plan.id);
        if (prior?.consumed === true) return failure("authorization-required", "This exact action plan has already been submitted.");
        plans.set(plan.id, { plan, intentHash, consumed: false });
        return success(plan);
      } catch { return failure("contract-mismatch", "Ghostget did not return the exact requested message preview."); }
    },
    async submit(plan, authorization) {
      if (authorization.mode === "delegated") return failure("unsupported", "Ghostget has no negotiated contact-scoped automation grant. Enablement alone cannot authorize dispatch.", "autonomous-send");
      prune();
      const known = plans.get(plan.id);
      if (known === undefined || known.consumed || hash(known.plan) !== hash(plan) || authorization.mode !== "owner-confirmed" || authorization.planDigest !== known.plan.digest) return failure("authorization-required", "An unconsumed exact owner-confirmed action plan is required.");
      // Consume before invoking. An exception after spawn is not evidence of non-delivery.
      known.consumed = true;
      try {
        const value = envelope(await options.invoke({ command: "confirm", planDigest: known.plan.digest }), "wrench.messaging-run", 1);
        if (value.planDigest !== plan.digest || value.routeRef !== plan.conversationId || value.contextRef !== plan.contextId || value.clientIntentSha256 !== known.intentHash || !["submitted", "failed", "partial", "indeterminate"].includes(String(value.state))) throw new Error("Changed run identity");
        const totalCount = integer(value.partCount, 1, 8), submittedCount = integer(value.provenPartCount, 0, totalCount);
        if (totalCount !== plan.actions.length || value.state === "submitted" && submittedCount !== totalCount || value.state === "partial" && (submittedCount === 0 || submittedCount === totalCount)) throw new Error("Invalid run count");
        return success({ planId: plan.id, runId: string(value.runId, 128), state: value.state as SendReceipt["state"], submittedCount, totalCount, acceptedMessageIds: null, recordedAt: timestamp(value.recordedAt), delivery: "unknown", retryable: false });
      } catch { return failure("indeterminate", "The send outcome is unknown. Reconcile its Ghostget journal; do not retry this action."); }
    },
  };
}
