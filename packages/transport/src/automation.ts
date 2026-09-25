import { createHash } from "node:crypto";
import { AUTOMATION_ACTIONS, automationBoolean, automationHash, automationId, automationProvider, automationRecord, parseAutomationConversation, parseAutomationCoordinate, parseAutomationEnrollment, parseAutomationGrant, parseAutomationIdentity, parseAutomationMessage, parseAutomationRun, parseAutomationStatus, type AutomationAction, type AutomationCoordinate, type AutomationEnrollment, type AutomationEvent, type AutomationGrantRequest, type AutomationPlan, type AutomationProvider } from "./automation-contract";
import { array, canonicalJson, digest, failure, integer, parseActionIntent, string, success, timestamp } from "./validation";
import { TRANSPORT_PROTOCOL, type ActionPlan, type HistoryMessage, type TextbutlerTransport } from "./types";
import { AutomationOperationError } from "./automation-diagnostics.ts";
export * from "./automation-contract";
export * from "./automation-diagnostics.ts";

/** Only the trusted daemon owns this port. It is never an agent tool. */
export type GhostgetAutomationInvoker = (method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>;
export function createGhostgetAutomationClient(invoke: GhostgetAutomationInvoker, now: () => number = Date.now) {
  const known = new Map<string, AutomationEnrollment>();
  const remember = (value: unknown): AutomationEnrollment => { const result = parseAutomationEnrollment(value); known.set(result.id, result); return result; };
  return {
    async start(provider: AutomationProvider, signal?: AbortSignal) { return parseAutomationStatus(await invoke("start", { provider: automationProvider(provider) }, signal)); },
    async status(provider: AutomationProvider, signal?: AbortSignal) {
      const result = parseAutomationStatus(await invoke("status", { provider: automationProvider(provider) }, signal));
      if (result.identity.provider !== provider) throw new Error("Provider status changed network"); return result;
    },
    async conversations(provider: AutomationProvider, limit = 200, signal?: AbortSignal) {
      const value = await invoke("conversations", { provider: automationProvider(provider), limit: integer(limit, 1, 200) }, signal);
      try {
        const r = automationRecord(value, ["identity", "conversations", "complete"]);
        const identity = parseAutomationIdentity(r.identity), conversations = array(r.conversations, limit).map(parseAutomationConversation);
        if (identity.provider !== provider || conversations.some(item => item.coordinate.provider !== provider)) throw new Error("Discovery changed network");
        return { identity, conversations, complete: automationBoolean(r.complete) };
      } catch { throw new AutomationOperationError("response-schema"); }
    },
    async enroll(provider: AutomationProvider, coordinate: AutomationCoordinate, signal?: AbortSignal) {
      const selected = parseAutomationCoordinate(coordinate);
      if (selected.provider !== provider) throw new Error("Enrollment network mismatch");
      const result = remember(await invoke("enroll", { provider, coordinate: selected }, signal));
      if (automationHash(result.conversation.coordinate) !== automationHash(selected)) throw new Error("Enrollment target changed"); return result;
    },
    async enrollments(signal?: AbortSignal) { return array(await invoke("enrollments", {}, signal), 1000).map(remember); },
    async grant(request: AutomationGrantRequest, intentId: string, signal?: AbortSignal) {
      const result = parseAutomationGrant(await invoke("grant", { ...request, intentId: automationId(intentId) }, signal));
      const { id: _id, revoked, consumedActions, ...bound } = result;
      if (revoked || consumedActions !== 0 || automationHash({ ...request, actions: [...request.actions].sort() }) !== automationHash({ ...bound, actions: [...bound.actions].sort() })) throw new Error("Grant changed owner authorization"); return result;
    },
    async revoke(grantId: string, signal?: AbortSignal) { const r = automationRecord(await invoke("revoke", { grantId: automationId(grantId) }, signal), ["revoked"]); if (r.revoked !== true) throw new Error("Grant revocation is uncertain"); },
    async grantStatus(grantId: string, signal?: AbortSignal) { const result = parseAutomationGrant(await invoke("grant.get", { grantId: automationId(grantId) }, signal)); if (result.id !== grantId) throw new Error("Grant status changed identity"); return result; },
    async grantByIntent(intentId: string, signal?: AbortSignal) { const result = automationRecord(await invoke("grant.by-intent", { intentId: automationId(intentId) }, signal), ["grant"]); return result.grant === null ? null : parseAutomationGrant(result.grant); },
    async poll(enrollmentId: string, signal?: AbortSignal) { const result = remember(await invoke("poll", { enrollmentId: automationId(enrollmentId) }, signal)); if (result.id !== enrollmentId) throw new Error("Poll changed enrollment"); return result; },
    /** One provider-sync for the whole selection: the host shares a session
     * across enrollments and answers one entry per id — a lane already running
     * reports its current row instead of re-polling. */
    async pollSet(enrollmentIds: readonly string[], signal?: AbortSignal) {
      const ids = array(enrollmentIds, 50).map(automationId);
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Invalid poll selection");
      const r = automationRecord(await invoke("pollSet", { enrollmentIds: ids }, signal), ["results"]);
      const results = new Map<string, { enrollment: AutomationEnrollment | null; error: string | null }>();
      for (const entry of array(r.results, ids.length)) {
        // Envelope faults — a missing/extra key, a duplicate or escaped id —
        // break the whole response and stay fatal. A fault inside one
        // attributed entry degrades to that enrollment's error result, the
        // same blast radius a per-contact poll failure had.
        const item = automationRecord(entry, ["enrollmentId", "enrollment", "error"]);
        const id = automationId(item.enrollmentId);
        if (results.has(id) || !ids.includes(id)) throw new Error("Poll result escaped its selection");
        try {
          const enrollment = item.enrollment === null ? null : parseAutomationEnrollment(item.enrollment);
          if (enrollment !== null && enrollment.id !== id) throw new Error("Poll changed enrollment");
          const error = item.error === null ? null : string(item.error, 1024);
          if (enrollment === null && error === null) throw new Error("Poll result is empty");
          if (enrollment !== null) known.set(id, enrollment);
          results.set(id, { enrollment, error });
        } catch { results.set(id, { enrollment: null, error: "Poll result could not be verified." }); }
      }
      if (results.size !== ids.length) throw new Error("Poll set missed an enrollment");
      return results;
    },
    async history(enrollmentId: string, limit = 200, signal?: AbortSignal) {
      const r = automationRecord(await invoke("history", { enrollmentId: automationId(enrollmentId), limit: integer(limit, 1, 200) }, signal), ["enrollment", "messages"]);
      const enrollment = remember(r.enrollment), messages = array(r.messages, limit).map(parseAutomationMessage);
      if (enrollment.id !== enrollmentId || messages.some(message => automationHash(message.coordinate) !== automationHash(enrollment.conversation.coordinate))) throw new Error("History changed enrollment");
      return { enrollment, messages };
    },
    async events(request: { enrollmentIds: readonly string[]; cursor: string | null; limit?: number }, signal?: AbortSignal) {
      const ids = array(request.enrollmentIds, 100).map(automationId), limit = integer(request.limit ?? 200, 1, 500);
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Invalid event selection");
      const r = automationRecord(await invoke("events", { enrollmentIds: ids, cursor: request.cursor === null ? null : string(request.cursor, 4096), limit }, signal), ["events", "nextCursor", "caughtUp"]);
      let previous = 0;
      const events: AutomationEvent[] = array(r.events, limit).map(value => {
        const event = automationRecord(value, ["sequence", "enrollmentId", "revision", "message"]), enrollmentId = automationId(event.enrollmentId);
        const sequence = integer(event.sequence, previous + 1, Number.MAX_SAFE_INTEGER); previous = sequence;
        if (!ids.includes(enrollmentId)) throw new Error("Event escaped selection");
        const message = parseAutomationMessage(event.message), enrollment = known.get(enrollmentId);
        if (enrollment && automationHash(enrollment.conversation.coordinate) !== automationHash(message.coordinate)) throw new Error("Event changed conversation");
        return { sequence, enrollmentId, revision: integer(event.revision, 1, Number.MAX_SAFE_INTEGER), message };
      });
      return { events, nextCursor: string(r.nextCursor, 4096), caughtUp: automationBoolean(r.caughtUp) };
    },
    async asset(asset: Readonly<{ bytes: Uint8Array; sha256: string }>, signal?: AbortSignal) {
      if (!(asset.bytes instanceof Uint8Array) || asset.bytes.length < 1 || asset.bytes.length > 16 * 1024 * 1024) throw new Error("Attachment exceeds its byte bound");
      const bytes = Buffer.from(asset.bytes), sha256 = digest(asset.sha256);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Attachment snapshot changed");
      const r = automationRecord(await invoke("asset", { bytesBase64: bytes.toString("base64"), sha256 }, signal), ["assetId", "bytes", "sha256", "expiresAt"]);
      const expiresAt = timestamp(r.expiresAt);
      if (r.bytes !== bytes.length || r.sha256 !== sha256 || Date.parse(expiresAt) <= now()) throw new Error("Attachment admission changed");
      return { assetId: automationId(r.assetId), bytes: bytes.length, sha256, expiresAt };
    },
    async prepare(request: { enrollmentId: string; expectedRevision: number; intentId: string; actions: readonly AutomationAction[] }, signal?: AbortSignal): Promise<AutomationPlan> {
      const r = automationRecord(await invoke("prepare", { ...request }, signal), ["id", "digest", "enrollmentId", "expectedRevision", "intentId", "actions", "bindingDigest", "expiresAt"]);
      const expiresAt = timestamp(r.expiresAt), bindingDigest = digest(r.bindingDigest), enrollment = known.get(request.enrollmentId);
      const bound = { ...request, bindingDigest, expiresAt }, planDigest = digest(r.digest);
      if (!enrollment || enrollment.bindingDigest !== bindingDigest || r.enrollmentId !== request.enrollmentId || r.expectedRevision !== request.expectedRevision || r.intentId !== request.intentId || canonicalJson(r.actions) !== canonicalJson(request.actions)
        || Date.parse(expiresAt) <= now() || Date.parse(expiresAt) > now() + 125000 || r.id !== `plan:${planDigest}` || automationHash(bound) !== planDigest) throw new Error("Prepared actions changed their context or content");
      return Object.freeze({ ...bound, actions: structuredClone(request.actions), id: r.id, digest: planDigest });
    },
    async submit(planId: string, grantId: string, signal?: AbortSignal) {
      signal?.throwIfAborted(); planId = automationId(planId); grantId = automationId(grantId);
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => { cancellation ??= invoke("cancel", { planId }); void cancellation.catch(() => undefined); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        // Keep custody of the original result after cancellation. The priority
        // control request stops subsequent actions; it does not prove non-send.
        const result = parseAutomationRun(await invoke("submit", { planId, grantId }, signal));
        if (cancellation) { const c = automationRecord(await cancellation, ["cancelled"]); automationBoolean(c.cancelled); }
        if (result.planId !== planId) throw new Error("Run changed its plan"); return result;
      } finally { signal?.removeEventListener("abort", cancel); }
    },
    async run(runId: string, signal?: AbortSignal) { const result = parseAutomationRun(await invoke("run", { runId: automationId(runId) }, signal)); if (result.id !== runId) throw new Error("Run identity changed"); return result; },
  };
}
export type GhostgetAutomationClient = ReturnType<typeof createGhostgetAutomationClient>;
export const automationContextId = (enrollment: AutomationEnrollment): string => `context:${automationHash({ bindingDigest: enrollment.bindingDigest, revision: enrollment.revision })}`;
const historyMessage = (message: { id: string; direction: "incoming" | "outgoing" | "unknown"; occurredAt: string; text: string | null }): HistoryMessage => ({ id: message.id, direction: message.direction, time: message.occurredAt, text: message.text, truncated: false, untrusted: true });

/** One immutable Ghostget enrollment per port, never a model-selected recipient. */
export function createGhostgetAutomationTransport(options: { client: GhostgetAutomationClient; enrollmentId: string; admitAsset(path: string): Promise<Readonly<{ bytes: Uint8Array; sha256: string }>>; now?: () => number }): TextbutlerTransport {
  const client = options.client, enrollmentId = automationId(options.enrollmentId), now = options.now ?? Date.now;
  const plans = new Map<string, { public: ActionPlan; upstream: AutomationPlan; consumed: boolean }>();
  const unavailable = () => failure("unavailable", "Ghostget automation is unavailable or needs owner setup.");
  const scope = (id: string) => { if (id !== enrollmentId) throw new Error("Conversation escaped its contact binding"); };
  const prune = () => { for (const [id, value] of plans) if (Date.parse(value.upstream.expiresAt) <= now()) plans.delete(id); };
  return {
    async capabilities() {
      try {
        const { enrollment } = await client.history(enrollmentId, 1), status = await client.status(enrollment.identity.provider);
        if (automationHash(status.identity) !== automationHash(enrollment.identity)) return unavailable();
        return success({ protocol: TRANSPORT_PROTOCOL, provider: `ghostget-${enrollment.identity.provider}`, capabilities: [
          { capability: "history", available: true, reason: null }, { capability: "contacts", available: false, reason: "Choose an exact Ghostget conversation." },
          { capability: "events", ...status.events }, { capability: "autonomous-send", available: enrollment.ready && status.connected && status.events.available && status.actions.text.available, reason: enrollment.ready ? null : enrollment.reason },
          ...AUTOMATION_ACTIONS.map(capability => ({ capability, ...status.actions[capability] })),
        ] });
      } catch { return unavailable(); }
    },
    async conversations() { try { const { enrollment } = await client.history(enrollmentId, 1); return success([{ id: enrollmentId, title: enrollment.conversation.title, kind: "single", participantCount: enrollment.conversation.participants.length, expiresAt: new Date(now() + 120000).toISOString() }]); } catch { return unavailable(); } },
    async contacts() { return failure("unsupported", "Contacts are selected through the owner enrollment panel.", "contacts"); },
    async history(request) {
      try {
        scope(request.conversationId); if (request.cursor !== undefined) return failure("unsupported", "Automation context uses a bounded current snapshot.", "history");
        await client.poll(enrollmentId); const { enrollment, messages } = await client.history(enrollmentId, request.limit ?? 200);
        return success({ conversationId: enrollmentId, contextId: enrollment.ready ? automationContextId(enrollment) : null, revision: String(enrollment.revision), expiresAt: new Date(now() + 120000).toISOString(), messages: messages.map(historyMessage), complete: enrollment.ready, nextCursor: null });
      } catch { return unavailable(); }
    },
    async events(request) {
      try { if (request.conversationIds.length !== 1) throw new Error("One contact required"); scope(request.conversationIds[0]!); const page = await client.events({ enrollmentIds: [enrollmentId], cursor: request.cursor, ...(request.limit === undefined ? {} : { limit: request.limit }) });
        return success({ ...page, events: page.events.map(event => ({ id: `event:${event.sequence}`, conversationId: enrollmentId, kind: event.message.kind === "reaction" ? "reaction.changed" : event.message.kind !== "message" ? "message.changed" : event.message.direction === "outgoing" ? "message.sent" : "message.received", message: historyMessage(event.message), occurredAt: event.message.occurredAt })) });
      } catch { return unavailable(); }
    },
    async prepare(request) {
      try {
        scope(request.conversationId); prune(); if (plans.size >= 256) return failure("unavailable", "Too many pending plans.");
        const actions = array(request.actions, 8).map(parseActionIntent); if (!actions.length) throw new Error("No actions");
        const { enrollment } = await client.history(enrollmentId, 1);
        if (!enrollment.ready || request.contextId !== automationContextId(enrollment)) return failure("stale-context", "Conversation changed before preparation.");
        const admitted: AutomationAction[] = [];
        for (const action of actions) {
          if (action.kind === "attachment" || action.kind === "sticker") {
            const asset = await client.asset(await options.admitAsset(action.file));
            admitted.push(action.kind === "attachment" ? { kind: "attachment", assetId: asset.assetId, name: action.name, mimeType: action.mimeType } : { kind: "sticker", assetId: asset.assetId, messageId: action.messageId });
          } else if (action.kind === "reaction") admitted.push({ kind: "reaction", messageId: action.messageId, emoji: action.emoji, remove: action.action === "remove" });
          else if (action.kind === "experience") {
            if (Object.values(action.parameters).some(value => typeof value !== "string")) throw new Error("Experience parameters must be strings");
            admitted.push({ ...action, parameters: action.parameters as Record<string, string> });
          } else admitted.push(action);
        }
        const upstream = await client.prepare({ enrollmentId, expectedRevision: enrollment.revision, intentId: automationId(request.intentId), actions: admitted });
        const plan: ActionPlan = Object.freeze({ protocol: TRANSPORT_PROTOCOL, id: upstream.id, intentId: upstream.intentId, conversationId: enrollmentId, contextId: request.contextId, digest: upstream.digest, expiresAt: upstream.expiresAt, actions: structuredClone(actions) });
        plans.set(plan.id, { public: plan, upstream, consumed: false }); return success(plan);
      } catch { return failure("contract-mismatch", "Ghostget could not bind the requested actions and attachment bytes."); }
    },
    async submit(plan, authorization, signal) {
      prune(); const known = plans.get(plan.id);
      if (!known || known.consumed || automationHash(plan) !== automationHash(known.public) || authorization.mode !== "delegated") return failure("authorization-required", "An exact unconsumed contact grant and plan are required.");
      known.consumed = true;
      try {
        const result = await client.submit(known.upstream.id, authorization.grantId, signal);
        if (result.enrollmentId !== enrollmentId || result.intentId !== plan.intentId || result.totalActions !== plan.actions.length) throw new Error("Run scope changed");
        return success({ planId: plan.id, runId: result.id, state: result.state === "accepted" ? "submitted" : result.state === "started" ? "indeterminate" : result.state, submittedCount: result.accepted.length, totalCount: result.totalActions, acceptedMessageIds: result.accepted.map(part => part.messageId), recordedAt: new Date(now()).toISOString(), delivery: "unknown", retryable: false });
      } catch { return failure("indeterminate", "Ghostget send outcome is uncertain. Reconcile the recorded intent before another send."); }
    },
  };
}
