/** Provider-neutral broker contract. Agents receive contact-bound tools, never this port. */
export const TRANSPORT_PROTOCOL = "textbutler.transport/1" as const;
export type Capability = "history" | "contacts" | "events" | "text" | "attachment" | "reaction" | "sticker" | "link" | "poll" | "app-clip" | "experience" | "autonomous-send";
export interface CapabilityStatus { readonly capability: Capability; readonly available: boolean; readonly reason: string | null }
export interface TransportCapabilities { readonly protocol: typeof TRANSPORT_PROTOCOL; readonly provider: string; readonly capabilities: readonly CapabilityStatus[] }
export type TransportErrorCode = "unsupported" | "invalid-input" | "contract-mismatch" | "unavailable" | "stale-context" | "authorization-required" | "indeterminate";
export type TransportResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: TransportErrorCode; readonly message: string; readonly capability?: Capability; readonly retryable: false } };
export interface Conversation { readonly id: string; readonly title: string | null; readonly kind: "single" | "group" | "unknown"; readonly participantCount: number; readonly expiresAt: string }
export interface Contact { readonly id: string; readonly name: string; readonly handles: readonly string[] }
export interface HistoryMessage { readonly id: string; readonly direction: "incoming" | "outgoing" | "unknown"; readonly time: string | null; readonly text: string | null; readonly truncated: boolean; readonly untrusted: true }
export interface HistoryPage { readonly conversationId: string; readonly contextId: string | null; readonly revision: string | null; readonly expiresAt: string | null; readonly messages: readonly HistoryMessage[]; readonly complete: boolean; readonly nextCursor: string | null }
export interface MessageEvent { readonly id: string; readonly conversationId: string; readonly kind: "message.received" | "message.sent" | "message.changed" | "reaction.changed"; readonly message: HistoryMessage; readonly occurredAt: string }
export interface EventPage { readonly events: readonly MessageEvent[]; readonly nextCursor: string; readonly caughtUp: boolean }
export type ActionIntent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "attachment"; readonly file: string; readonly mimeType: string; readonly name: string }
  | { readonly kind: "reaction"; readonly messageId: string; readonly emoji: string; readonly action: "add" | "remove" }
  | { readonly kind: "sticker"; readonly file: string; readonly messageId: string | null }
  | { readonly kind: "link"; readonly url: string }
  | { readonly kind: "poll"; readonly question: string; readonly options: readonly string[]; readonly maximumSelections: number | null }
  | { readonly kind: "app-clip"; readonly url: string }
  | { readonly kind: "experience"; readonly experienceId: string; readonly parameters: Readonly<Record<string, unknown>> };
export interface PrepareRequest { readonly intentId: string; readonly conversationId: string; readonly contextId: string; readonly actions: readonly ActionIntent[] }
export interface ActionPlan { readonly protocol: typeof TRANSPORT_PROTOCOL; readonly id: string; readonly intentId: string; readonly conversationId: string; readonly contextId: string; readonly digest: string; readonly expiresAt: string; readonly actions: readonly ActionIntent[] }
export type SendAuthorization = { readonly mode: "owner-confirmed"; readonly planDigest: string } | { readonly mode: "delegated"; readonly grantId: string };
export interface SendReceipt { readonly planId: string; readonly runId: string; readonly state: "submitted" | "failed" | "partial" | "indeterminate"; readonly submittedCount: number; readonly totalCount: number; readonly acceptedMessageIds: readonly (string | null)[] | null; readonly recordedAt: string; readonly delivery: "unknown"; readonly retryable: false }
export interface TextbutlerTransport {
  capabilities(): Promise<TransportResult<TransportCapabilities>>;
  conversations(): Promise<TransportResult<readonly Conversation[]>>;
  contacts(): Promise<TransportResult<readonly Contact[]>>;
  history(request: { readonly conversationId: string; readonly cursor?: string; readonly limit?: number }): Promise<TransportResult<HistoryPage>>;
  events(request: { readonly conversationIds: readonly string[]; readonly cursor: string | null; readonly limit?: number }): Promise<TransportResult<EventPage>>;
  prepare(request: PrepareRequest): Promise<TransportResult<ActionPlan>>;
  submit(plan: ActionPlan, authorization: SendAuthorization, signal?: AbortSignal): Promise<TransportResult<SendReceipt>>;
}
