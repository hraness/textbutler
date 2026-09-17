import { array, canonicalJson, digest, exact, integer, object, string, timestamp } from "./validation";
import { createHash } from "node:crypto";

/** Versioned public Ghostget wire contract. No provider internals or credentials. */
export const AUTOMATION_PROTOCOL = "ghostget.messaging-automation/1" as const;
export const AUTOMATION_ACTIONS = ["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"] as const;
export type AutomationProvider = "imessage" | "whatsapp" | "beeper";
export type AutomationCoordinate = { provider: "imessage"; chatGuid: string; service: "iMessage"; observedChatRowId: number } | { provider: "whatsapp"; conversationJid: string } | { provider: "beeper"; accountId: string; conversationId: string };
export interface AutomationIdentity { provider: AutomationProvider; authId: string; accountIdentity: string; accountSubject: string; implementationIdentity: string; sourceGeneration: string }
export interface AutomationConversation { coordinate: AutomationCoordinate; title: string | null; kind: "single"; participants: readonly string[] }
export interface AutomationEnrollment { id: string; identity: AutomationIdentity; conversation: AutomationConversation; bindingDigest: string; revision: number; ready: boolean; reason: string | null }
export interface AutomationMessage { id: string; coordinate: AutomationCoordinate; direction: "incoming" | "outgoing" | "unknown"; occurredAt: string; text: string | null; kind: "message" | "reaction" | "edit" | "delete"; relatedMessageId: string | null; attachments: readonly { name: string | null; mimeType: string | null; sizeBytes: number | null }[] }
export interface AutomationGrantRequest { enrollmentId: string; expectedBindingDigest: string; actions: readonly typeof AUTOMATION_ACTIONS[number][]; expiresAt: string; maximumActions: number; minimumIntervalMs: number }
export interface AutomationGrant extends AutomationGrantRequest { id: string; revoked: boolean; consumedActions: number }
export type AutomationAction =
  | { kind: "text"; text: string }
  | { kind: "attachment"; assetId: string; name: string; mimeType: string }
  | { kind: "reaction"; messageId: string; emoji: string; remove: boolean }
  | { kind: "sticker"; assetId: string; messageId: string | null }
  | { kind: "link" | "app-clip"; url: string }
  | { kind: "poll"; question: string; options: readonly string[]; maximumSelections: number | null }
  | { kind: "experience"; experienceId: string; parameters: Readonly<Record<string, string>> };
export interface AutomationPlan { id: string; digest: string; enrollmentId: string; expectedRevision: number; intentId: string; actions: readonly AutomationAction[]; bindingDigest: string; expiresAt: string }
export interface AutomationRun { id: string; planId: string; intentId: string; enrollmentId: string; state: "started" | "accepted" | "failed" | "partial" | "indeterminate"; accepted: readonly { messageId: string | null; providerReceiptId: string | null }[]; totalActions: number; reason: string | null; retryable: false }
export interface AutomationEvent { sequence: number; enrollmentId: string; revision: number; message: AutomationMessage }
export interface AutomationStatus { identity: AutomationIdentity; connected: boolean; events: { available: boolean; reason: string | null }; actions: Record<typeof AUTOMATION_ACTIONS[number], { available: boolean; reason: string | null }> }
export const automationHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Display titles can change without changing the account or recipient. */
export const automationBindingDigest = (identity: AutomationIdentity, conversation: AutomationConversation): string => automationHash({ identity, conversation: { ...conversation, title: null } });
export function automationRecord(value: unknown, keys: readonly string[]): Record<string, unknown> { const r = object(value); exact(r, keys); return r; }
export function automationId(value: unknown): string { const result = string(value, 256); if (!/^[A-Za-z0-9._:-]+$/u.test(result)) throw new Error("Invalid automation ID"); return result; }
export function automationProvider(value: unknown): AutomationProvider { if (value !== "imessage" && value !== "whatsapp" && value !== "beeper") throw new Error("Unknown messaging network"); return value; }
export function automationBoolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Expected automation flag"); return value; }
const nullable = (value: unknown, maximum = 1024): string | null => value === null ? null : string(value, maximum);
export function parseAutomationCoordinate(value: unknown): AutomationCoordinate {
  const r = object(value), provider = automationProvider(r.provider);
  if (provider === "imessage") {
    exact(r, ["provider", "chatGuid", "service", "observedChatRowId"]);
    const chatGuid = string(r.chatGuid, 1024);
    if (r.service !== "iMessage" || !chatGuid.startsWith("iMessage;")) throw new Error("Invalid iMessage coordinate");
    return { provider, chatGuid, service: "iMessage", observedChatRowId: integer(r.observedChatRowId, 1, Number.MAX_SAFE_INTEGER) };
  }
  if (provider === "beeper") {
    exact(r, ["provider", "accountId", "conversationId"]);
    return { provider, accountId: string(r.accountId, 512), conversationId: string(r.conversationId, 2048) };
  }
  exact(r, ["provider", "conversationJid"]);
  const conversationJid = string(r.conversationJid, 256);
  if (!/^(?:[1-9][0-9]{4,14}@s\.whatsapp\.net|[1-9][0-9]{4,19}@lid)$/u.test(conversationJid)) throw new Error("Invalid individual WhatsApp coordinate");
  return { provider, conversationJid };
}
export function parseAutomationIdentity(value: unknown): AutomationIdentity {
  const r = automationRecord(value, ["provider", "authId", "accountIdentity", "accountSubject", "implementationIdentity", "sourceGeneration"]);
  return { provider: automationProvider(r.provider), authId: automationId(r.authId), accountIdentity: digest(r.accountIdentity), accountSubject: string(r.accountSubject, 512), implementationIdentity: digest(r.implementationIdentity), sourceGeneration: string(r.sourceGeneration, 256) };
}
export function parseAutomationConversation(value: unknown): AutomationConversation {
  const r = automationRecord(value, ["coordinate", "title", "kind", "participants"]), participants = array(r.participants, 2).map(value => string(value, 512));
  if (r.kind !== "single" || participants.length < 1 || new Set(participants).size !== participants.length) throw new Error("Exact individual conversation required");
  return { coordinate: parseAutomationCoordinate(r.coordinate), title: nullable(r.title, 512), kind: "single", participants: participants.sort() };
}
export function parseAutomationEnrollment(value: unknown): AutomationEnrollment {
  const r = automationRecord(value, ["id", "identity", "conversation", "bindingDigest", "revision", "ready", "reason"]);
  const identity = parseAutomationIdentity(r.identity), conversation = parseAutomationConversation(r.conversation), bindingDigest = digest(r.bindingDigest);
  if (identity.provider !== conversation.coordinate.provider || automationBindingDigest(identity, conversation) !== bindingDigest) throw new Error("Changed enrollment binding");
  return { id: automationId(r.id), identity, conversation, bindingDigest, revision: integer(r.revision, 0, Number.MAX_SAFE_INTEGER), ready: automationBoolean(r.ready), reason: nullable(r.reason) };
}
export function parseAutomationMessage(value: unknown): AutomationMessage {
  const r = automationRecord(value, ["id", "coordinate", "direction", "occurredAt", "text", "kind", "relatedMessageId", "attachments"]);
  if (!["incoming", "outgoing", "unknown"].includes(String(r.direction)) || !["message", "reaction", "edit", "delete"].includes(String(r.kind))) throw new Error("Invalid automation message kind");
  const attachments = array(r.attachments, 20).map(value => { const a = automationRecord(value, ["name", "mimeType", "sizeBytes"]); return { name: nullable(a.name, 512), mimeType: nullable(a.mimeType, 256), sizeBytes: a.sizeBytes === null ? null : integer(a.sizeBytes, 0, 1024 ** 3) }; });
  return { id: automationId(r.id), coordinate: parseAutomationCoordinate(r.coordinate), direction: r.direction as AutomationMessage["direction"], occurredAt: timestamp(r.occurredAt), text: r.text === "" ? "" : nullable(r.text, 65536), kind: r.kind as AutomationMessage["kind"], relatedMessageId: r.relatedMessageId === null ? null : automationId(r.relatedMessageId), attachments };
}
export function parseAutomationGrant(value: unknown): AutomationGrant {
  const r = automationRecord(value, ["id", "enrollmentId", "expectedBindingDigest", "actions", "expiresAt", "maximumActions", "minimumIntervalMs", "revoked", "consumedActions"]);
  const actions = array(r.actions, 8).map(value => { if (!AUTOMATION_ACTIONS.includes(value as typeof AUTOMATION_ACTIONS[number])) throw new Error("Invalid grant action"); return value as typeof AUTOMATION_ACTIONS[number]; });
  if (!actions.length || new Set(actions).size !== actions.length) throw new Error("Invalid grant actions");
  const maximumActions = integer(r.maximumActions, 1, 100000);
  return { id: automationId(r.id), enrollmentId: automationId(r.enrollmentId), expectedBindingDigest: digest(r.expectedBindingDigest), actions, expiresAt: timestamp(r.expiresAt), maximumActions, minimumIntervalMs: integer(r.minimumIntervalMs, 0, 86400000), revoked: automationBoolean(r.revoked), consumedActions: integer(r.consumedActions, 0, maximumActions) };
}
export function parseAutomationStatus(value: unknown): AutomationStatus {
  const r = automationRecord(value, ["identity", "connected", "events", "actions"]), actions = automationRecord(r.actions, AUTOMATION_ACTIONS);
  const capability = (value: unknown) => { const c = automationRecord(value, ["available", "reason"]); return { available: automationBoolean(c.available), reason: nullable(c.reason) }; };
  return { identity: parseAutomationIdentity(r.identity), connected: automationBoolean(r.connected), events: capability(r.events), actions: Object.fromEntries(AUTOMATION_ACTIONS.map(kind => [kind, capability(actions[kind])])) as AutomationStatus["actions"] };
}
export function parseAutomationRun(value: unknown): AutomationRun {
  const r = automationRecord(value, ["id", "planId", "intentId", "enrollmentId", "state", "accepted", "totalActions", "reason", "retryable"]);
  const totalActions = integer(r.totalActions, 1, 8), accepted = array(r.accepted, totalActions).map(value => { const a = automationRecord(value, ["messageId", "providerReceiptId"]); return { messageId: a.messageId === null ? null : automationId(a.messageId), providerReceiptId: a.providerReceiptId === null ? null : automationId(a.providerReceiptId) }; });
  if (!["started", "accepted", "failed", "partial", "indeterminate"].includes(String(r.state)) || r.retryable !== false || r.state === "accepted" && accepted.length !== totalActions || r.state === "failed" && accepted.length !== 0) throw new Error("Invalid automation run state");
  return { id: automationId(r.id), planId: automationId(r.planId), intentId: automationId(r.intentId), enrollmentId: automationId(r.enrollmentId), state: r.state as AutomationRun["state"], accepted, totalActions, reason: nullable(r.reason), retryable: false };
}
