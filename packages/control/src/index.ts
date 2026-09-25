import { parseActionIntent } from "../../transport/src/validation.ts";
import type { ActionIntent } from "../../transport/src/types.ts";
import type { AutomationProvider, AutomationStatus } from "../../transport/src/automation-contract.ts";
import { parseAutomationFailure, type AutomationFailure } from "../../transport/src/automation-diagnostics.ts";
const MESSAGE_ACTIONS = ["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"] as const;

/** Owner-only desktop control protocol. Messaging authority remains in the daemon. */
export const CONTROL_PROTOCOL = "textbutler.control.v1" as const;
export type CapabilityId = "messages" | "contacts" | "agent" | "attachments" | "reactions" | "stickers" | "links" | "polls" | "mini-apps";
export interface Capability { id: CapabilityId; status: "available" | "setup-required" | "unsupported"; detail: string }
export interface ContactSettings {
  enabled: boolean;
  /** The owner marked this conversation as their own address. */
  selfChat?: boolean;
  responseMode: "smart" | "keyword";
  keyword: string;
  provider: "codex" | "claude" | "devin";
  accountId?: string;
  disclosure: { character: string; begin: string; end: string };
}
/** Owner configuration for one conversation's learned response plan. */
export interface ContactHabitatPlan {
  version: 1;
  guidance: string;
  contextMessages: number;
  maxReplyCharacters: number;
  humor: "off" | "light" | "match";
  webSearch: boolean;
  memeSearch: boolean;
  personality?: { tone: "neutral" | "warm" | "playful" | "direct"; formality: "casual" | "balanced" | "formal" };
}
export interface Contact { id: string; name: string; subtitle: string; settings: ContactSettings;
  messaging?: { provider: "imessage" | "whatsapp" | "beeper"; state: "active" | "missing" | "revocation-pending" | "recovery-required"; detail: string; grantExpiresAt: string | null } }
export interface Activity { id: string; at: string; contactId: string | null; title: string; detail: string }
export type ConversationDiscoveryDiagnostic = AutomationFailure & Readonly<{ provider: AutomationProvider }>;
export interface ProviderAccountDiagnostic {
  id: string; label: string; provider: "claude" | "codex" | "devin"; route: "claude-api" | "claude-code" | "codex" | "devin";
  status: "ready" | "setup-required" | "unavailable"; detail: string; defaultReplyModel: string | null; classifierModel: string | null;
  managedAccount?: { state: "unchecked" | "signed-out" | "signing-in" | "signed-in" | "unavailable" | "recovery-required" | "closed"; generation: number; modelCount: number; pendingLoginId: string | null };
}
/** A transient owner response. Never persist this challenge in contact memory or activity. */
export type ProviderLoginChallenge =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string };
/** An enrolled conversation whose tail still awaits an owner answer. */
export interface PendingReplyItem {
  contactId: string; name: string; provider: "imessage" | "whatsapp" | "beeper" | "none"; enabled: boolean;
  pendingCount: number; lastInboundAt: string | null; preview: string | null;
  sendable: boolean; reason: string | null;
}
/** An owner-reviewed suggestion. Sending is always a separate explicit command. */
export interface ReplyDraftView { id: string; contactId: string; name: string; summary: string; preview: string; actionCount: number; expiresAt: string }
export interface ReplyDraftDetail {
  id: string; contactId: string; name: string; provider: "imessage" | "whatsapp" | "beeper"; conversationId: string;
  summary: string; actions: readonly ActionIntent[]; assets: readonly { path: string; sha256: string; bytes: number }[];
  digest: string; expiresAt: string;
}
export interface RepliesView { scannedAt: string | null; pending: readonly PendingReplyItem[]; drafts: readonly ReplyDraftView[] }
export interface OwnerMessage {
  id: string; at: number; author: "owner" | "contact" | "butler" | "self" | "unknown"; text: string | null;
  kind: "message" | "reaction" | "edit" | "delete"; relatedMessageId: string | null; textTruncated: boolean;
  attachments: readonly { name: string | null; mimeType: string | null; sizeBytes: number | null }[];
}
export interface MessageHistoryResult {
  contactId: string; provider: AutomationProvider; ready: boolean; messages: readonly OwnerMessage[];
  bounds: { requested: number; received: number; returned: number; maxTextBytes: 4096; maxJsonBytes: 512000 };
  omissions: { messages: number; textShortened: number }; limitations: readonly string[];
}
export interface MessageSummaryResult {
  contactId: string; summary: string; citations: readonly string[]; sampledMessages: number;
  omittedMessages: number; shortenedMessages: number; limitations: readonly string[];
}
export interface MessageCapabilitiesResult {
  contactId: string; provider: AutomationProvider; ready: boolean; actions: AutomationStatus["actions"];
  threadedReplies: { available: false; reason: string };
}
export interface DesktopSnapshot {
  protocol: typeof CONTROL_PROTOCOL;
  revision: number;
  connection: "connected" | "disconnected" | "demo";
  detail: string;
  settings: { paused: boolean; activeContactLimit: number };
  contacts: Contact[];
  capabilities: Capability[];
  activity: Activity[];
  providerAccounts?: readonly ProviderAccountDiagnostic[];
  automation?: { state: "running" | "paused" | "unavailable"; detail: string };
  messagingProviders?: readonly ("imessage" | "whatsapp" | "beeper")[];
  replies?: RepliesView;
  habitat?: { driver: "gateway" | "local"; model: string; evolutionModel: string | null; debounceMs: number; dailyBudgetMicroUsd: number };
}
export interface ConversationCandidate { id: string; name: string; subtitle: string; eligible: boolean; reason: string }
export type ControlRequest =
  | { protocol: typeof CONTROL_PROTOCOL; command: "conversations.list" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "contact.enroll"; candidateId: string; expectedRevision: number; initializeHistory: boolean }
  | { protocol: typeof CONTROL_PROTOCOL; command: "owner.job.read"; jobId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "snapshot" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "provider.accounts.check"; accountId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "provider.accounts.login.start"; accountId: string; method: "chatgpt" | "chatgptDeviceCode" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "provider.accounts.login.cancel"; accountId: string; loginId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "provider.accounts.logout"; accountId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "messaging.start"; provider: "imessage" | "whatsapp" | "beeper" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "contact.settings.update"; contactId: string; expectedRevision: number; settings: ContactSettings }
  | { protocol: typeof CONTROL_PROTOCOL; command: "habitat.read"; contactId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "habitat.configure"; contactId: string; expectedRevision: number; plan: ContactHabitatPlan }
  | { protocol: typeof CONTROL_PROTOCOL; command: "habitat.rollback"; contactId: string; expectedRevision: number }
  | { protocol: typeof CONTROL_PROTOCOL; command: "habitat.memory.clear"; contactId: string; expectedRevision: number }
  | { protocol: typeof CONTROL_PROTOCOL; command: "contact.memory.read"; contactId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "contact.memory.write"; contactId: string; expectedRevision: string; content: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "global.settings.update"; expectedRevision: number; settings: DesktopSnapshot["settings"] }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.scan" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.suggest"; contactId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "messages.history"; contactId: string; limit: number }
  | { protocol: typeof CONTROL_PROTOCOL; command: "messages.summarize"; contactId: string; limit: number }
  | { protocol: typeof CONTROL_PROTOCOL; command: "messages.capabilities"; contactId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.compose"; contactId: string; summary: string; actions: readonly ActionIntent[] }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.draft.read"; draftId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.send"; draftId: string; expectedDigest: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.send"; contactId: string; text: string; expectedRevision?: number }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.discard"; draftId: string }
  | { protocol: typeof CONTROL_PROTOCOL; command: "replies.reconcile"; contactId: string; resolution?: "sent" | "failed" }
  | { protocol: typeof CONTROL_PROTOCOL; command: "activity.list" };
export type ControlResponse =
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "provider-login"; accountId: string; challenge: ProviderLoginChallenge; snapshot: DesktopSnapshot }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "job"; jobId: string }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "conversations"; candidates: ConversationCandidate[]; detail: string; diagnostics?: readonly ConversationDiscoveryDiagnostic[] }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "enrolled"; snapshot: DesktopSnapshot; contactId: string; historyCount: number; historyOmittedCount: number; historyShortenedCount: number; historyInitialized: boolean }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "snapshot"; snapshot: DesktopSnapshot }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "memory"; contactId: string; revision: string; content: string }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "habitat"; contactId: string; revision: number; ownerRevision?: number; content: string; installationDailyReservedMicroUsd: number }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "replies"; scannedAt: string; checked: number; unreadable: number; pending: readonly PendingReplyItem[]; drafts: readonly ReplyDraftView[] }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "reply-suggestion"; draft: ReplyDraftView | null; pending: PendingReplyItem }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "reply-draft"; draft: ReplyDraftDetail }
  | ({ protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "message-history" } & MessageHistoryResult)
  | ({ protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "message-summary" } & MessageSummaryResult)
  | ({ protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "message-capabilities" } & MessageCapabilitiesResult)
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "reply-sent"; contactId: string; runId: string; state: "submitted" | "failed" | "partial" | "indeterminate" | "cancelled"; detail: string }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "reply-discarded"; discarded: boolean }
  | { protocol: typeof CONTROL_PROTOCOL; ok: true; kind: "reply-reconciled"; contactId: string; runId?: string; resolved: boolean; state?: "submitted" | "failed"; detail: string }
  | { protocol: typeof CONTROL_PROTOCOL; ok: false; code: "disconnected" | "invalid-request" | "conflict" | "capacity" | "unavailable"; message: string };
export interface DesktopControlPort { request(request: ControlRequest): Promise<ControlResponse> }

export const DEFAULT_CONTACT_SETTINGS: ContactSettings = {
  enabled: false, responseMode: "smart", keyword: "butler", provider: "codex",
  disclosure: { character: "🤖", begin: "{", end: "}" },
};
export function disclosurePreview(settings: ContactSettings, text = "Hello, this is my response."): string {
  const { character, begin, end } = settings.disclosure;
  const left = `${character}${begin}`;
  if (!left && !end) return text;
  return `${left ? `${left} ` : ""}${text}${end ? ` ${end}` : ""}`;
}
export function validateContactSettings(settings: ContactSettings): string | null {
  if (settings.selfChat !== undefined && typeof settings.selfChat !== "boolean") return "The self conversation flag must be on or off.";
  if (settings.accountId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(settings.accountId)) return "Choose a configured account.";
  if (typeof settings.enabled !== "boolean" || !["smart", "keyword"].includes(settings.responseMode)
    || !["codex", "claude", "devin"].includes(settings.provider)) return "Choose a supported response mode and agent provider.";
  if (typeof settings.keyword !== "string" || !settings.keyword.trim() || settings.keyword.length > 40
    || /[\p{Cc}\p{Cf}]/u.test(settings.keyword)) return "Use a keyword between 1 and 40 characters without control characters.";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const [name, symbol] of Object.entries(settings.disclosure)) {
    if (typeof symbol !== "string" || symbol.length > 16) return `Use one visible symbol for ${name}, or clear it. Emoji sequences count as one symbol.`;
    if (symbol === "") continue;
    if ([...segmenter.segment(symbol)].length !== 1
      || /[\p{White_Space}\p{Cc}]/u.test(symbol) || /[\u202A-\u202E\u2066-\u2069]/u.test(symbol) || /^[\p{Default_Ignorable_Code_Point}\p{Mark}]+$/u.test(symbol)) {
      return `Use one visible symbol for ${name}, or clear it. Emoji sequences count as one symbol.`;
    }
  }
  return null;
}

export function disconnectedSnapshot(detail = "The Textbutler daemon is not connected."): DesktopSnapshot {
  return {
    protocol: CONTROL_PROTOCOL, revision: 0, connection: "disconnected", detail,
    settings: { paused: true, activeContactLimit: 5 }, contacts: [], activity: [],
    capabilities: [
      { id: "messages", status: "setup-required", detail: "Connect the daemon to negotiate Ghostget Messages access." },
      { id: "contacts", status: "setup-required", detail: "Contacts appear after Ghostget grants scoped access." },
      { id: "agent", status: "setup-required", detail: "A qualified Claude, Codex, or Devin account is required." },
      { id: "attachments", status: "setup-required", detail: "File sending must be reported by the connected provider." },
      { id: "reactions", status: "setup-required", detail: "Available only when the transport supports reactions." },
      { id: "stickers", status: "unsupported", detail: "No qualified sticker transport is connected." },
      { id: "links", status: "setup-required", detail: "Connect messaging to check rich link support." },
      { id: "polls", status: "setup-required", detail: "Connect messaging to check native poll support." },
      { id: "mini-apps", status: "unsupported", detail: "No qualified iMessage app transport is connected." },
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control response.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4_096): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid text in control response.");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid memory revision digest.");
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid number in control response.");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid flag in control response.");
  return value;
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new Error("Unknown control response value.");
  return value as T;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("Control response exceeds its list limit.");
  return value;
}
function pendingReplyItem(value: unknown): PendingReplyItem {
  const row = record(value);
  return { contactId: text(row.contactId, 256), name: text(row.name, 256), provider: oneOf(row.provider, ["imessage", "whatsapp", "beeper", "none"]),
    enabled: bool(row.enabled), pendingCount: integer(row.pendingCount, 0, 20),
    lastInboundAt: row.lastInboundAt === null ? null : text(row.lastInboundAt, 64),
    preview: row.preview === null ? null : text(row.preview, 512), sendable: bool(row.sendable),
    reason: row.reason === null ? null : text(row.reason, 512) };
}
function replyDraftView(value: unknown): ReplyDraftView {
  const row = record(value);
  return { id: text(row.id, 120), contactId: text(row.contactId, 256), name: text(row.name, 256), summary: text(row.summary, 512),
    preview: text(row.preview, 512), actionCount: integer(row.actionCount, 0, 8), expiresAt: text(row.expiresAt, 64) };
}
function replyDraftDetail(value: unknown): ReplyDraftDetail {
  const row = record(value), actions = list(row.actions, 8).map(parseActionIntent);
  if (!actions.length) throw new Error("A reply draft needs actions.");
  return { id: text(row.id, 120), contactId: text(row.contactId, 80), name: text(row.name, 256),
    provider: oneOf(row.provider, ["imessage", "whatsapp", "beeper"]), conversationId: text(row.conversationId, 512),
    summary: text(row.summary, 4096), actions,
    assets: list(row.assets, 8).map(value => { const asset = record(value); return { path: text(asset.path, 1024), sha256: digest(asset.sha256), bytes: integer(asset.bytes, 1, 16 * 1024 * 1024) }; }),
    digest: digest(row.digest), expiresAt: text(row.expiresAt, 64) };
}
function messageText(value: unknown, max: number): string {
  const result = text(value, max);
  if (new TextEncoder().encode(result).length > max || result.includes("\0")) throw Error("Message response text exceeds its byte bound.");
  return result;
}
function ownerMessage(value: unknown): OwnerMessage {
  const row = record(value);
  const nullable = (value: unknown, max: number) => value === null ? null : messageText(value, max);
  return { id: messageText(row.id, 512), at: integer(row.at), author: oneOf(row.author, ["owner", "contact", "butler", "self", "unknown"]),
    text: nullable(row.text, 4096), kind: oneOf(row.kind, ["message", "reaction", "edit", "delete"]), relatedMessageId: nullable(row.relatedMessageId, 512), textTruncated: bool(row.textTruncated),
    attachments: list(row.attachments, 20).map(value => { const attachment = record(value); return { name: nullable(attachment.name, 512), mimeType: nullable(attachment.mimeType, 256), sizeBytes: attachment.sizeBytes === null ? null : integer(attachment.sizeBytes, 0, 1024 ** 3) }; }) };
}
function repliesView(value: unknown): RepliesView {
  const row = record(value);
  return { scannedAt: row.scannedAt === null ? null : text(row.scannedAt, 64),
    pending: list(row.pending, 200).map(pendingReplyItem), drafts: list(row.drafts, 64).map(replyDraftView) };
}
function settings(value: unknown): ContactSettings {
  const row = record(value); const symbols = record(row.disclosure);
  const result: ContactSettings = {
    enabled: bool(row.enabled), responseMode: oneOf(row.responseMode, ["smart", "keyword"]),
    keyword: text(row.keyword, 40), provider: oneOf(row.provider, ["codex", "claude", "devin"]),
    ...(row.accountId === undefined ? {} : { accountId: text(row.accountId, 80) }),
    ...(row.selfChat === undefined ? {} : { selfChat: bool(row.selfChat) }),
    disclosure: { character: text(symbols.character, 16), begin: text(symbols.begin, 16), end: text(symbols.end, 16) },
  };
  const error = validateContactSettings(result); if (error) throw new Error(error);
  return result;
}
export function parseControlResponse(value: unknown): ControlResponse {
  const row = record(value);
  if (row.protocol !== CONTROL_PROTOCOL) throw new Error("The daemon uses an incompatible control protocol.");
  if (row.ok === false) return { protocol: CONTROL_PROTOCOL, ok: false,
    code: oneOf(row.code, ["disconnected", "invalid-request", "conflict", "capacity", "unavailable"]), message: text(row.message) };
  if (row.ok !== true) throw new Error("Invalid control response outcome.");
  if (row.kind === "provider-login") {
    const response = parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: row.snapshot });
    const accountId = text(row.accountId, 80);
    if (!response.ok || response.kind !== "snapshot" || !response.snapshot.providerAccounts?.some(account => account.id === accountId && account.route === "codex" && account.managedAccount)) throw new Error("Invalid managed account login response.");
    const challenge = parseProviderLoginChallenge(row.challenge);
    const native = response.snapshot.providerAccounts.find(account => account.id === accountId)!.managedAccount!;
    if (native.state !== "signing-in" || native.pendingLoginId !== challenge.loginId) throw new Error("Stale managed account login response.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "provider-login", accountId, challenge, snapshot: response.snapshot };
  }
  if (row.kind === "job") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "job", jobId: text(row.jobId, 80) };
  if (row.kind === "conversations") {
    const candidates = list(row.candidates, 200).map(value => { const item = record(value); return { id: text(item.id, 80), name: text(item.name, 200), subtitle: text(item.subtitle, 512), eligible: bool(item.eligible), reason: text(item.reason, 512) }; });
    if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new Error("Duplicate conversation candidate.");
    const diagnostics = row.diagnostics === undefined ? undefined : list(row.diagnostics, 3).map(value => {
      const item = record(value);
      if (Object.keys(item).sort().join(",") !== (Object.hasOwn(item, "native") ? "code,native,provider,stage" : "code,provider,stage")) throw new Error("Unexpected discovery diagnostic fields.");
      return { provider: oneOf(item.provider, ["imessage", "whatsapp", "beeper"]), ...parseAutomationFailure({ stage: item.stage, code: item.code,
        ...(Object.hasOwn(item, "native") ? { native: item.native } : {}) }) };
    });
    if (diagnostics && new Set(diagnostics.map(item => item.provider)).size !== diagnostics.length) throw new Error("Duplicate discovery diagnostic provider.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "conversations", candidates, detail: text(row.detail), ...(diagnostics === undefined ? {} : { diagnostics }) };
  }
  if (row.kind === "enrolled") {
    const response = parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: row.snapshot });
    if (!response.ok || response.kind !== "snapshot") throw new Error("Invalid enrollment snapshot.");
    const contactId = text(row.contactId, 80);
    if (!response.snapshot.contacts.some(contact => contact.id === contactId && !contact.settings.enabled)) throw new Error("Enrollment must create a disabled contact.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "enrolled", snapshot: response.snapshot, contactId, historyCount: integer(row.historyCount, 0, 200), historyOmittedCount: integer(row.historyOmittedCount, 0, 200), historyShortenedCount: integer(row.historyShortenedCount, 0, 200), historyInitialized: bool(row.historyInitialized) };
  }
  if (row.kind === "memory") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "memory", contactId: text(row.contactId, 256), revision: digest(row.revision), content: text(row.content, 65_536) };
  if (row.kind === "habitat") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "habitat", contactId: text(row.contactId, 80), revision: integer(row.revision, 0),
    ...(row.ownerRevision === undefined ? {} : { ownerRevision: integer(row.ownerRevision, 0) }),
    content: text(row.content, 262_144), installationDailyReservedMicroUsd: integer(row.installationDailyReservedMicroUsd, 0) };
  if (row.kind === "replies") {
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "replies", scannedAt: text(row.scannedAt, 64), checked: integer(row.checked, 0, 10_000),
      unreadable: integer(row.unreadable, 0, 10_000), pending: list(row.pending, 200).map(pendingReplyItem), drafts: list(row.drafts, 64).map(replyDraftView) };
  }
  if (row.kind === "reply-suggestion") {
    const draft = row.draft === null ? null : replyDraftView(row.draft), pending = pendingReplyItem(row.pending);
    if (draft !== null && (draft.contactId !== pending.contactId || !pending.sendable && pending.reason === null)) throw new Error("Inconsistent reply suggestion.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-suggestion", draft, pending };
  }
  if (row.kind === "reply-draft") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-draft", draft: replyDraftDetail(row.draft) };
  if (row.kind === "message-history") {
    const messages = list(row.messages, 200).map(ownerMessage), bounds = record(row.bounds), omissions = record(row.omissions);
    const requested = integer(bounds.requested, 1, 200), received = integer(bounds.received, 0, requested), returned = integer(bounds.returned, 0, received);
    const omitted = integer(omissions.messages, 0, received), textShortened = integer(omissions.textShortened, 0, received);
    if (new Set(messages.map(message => message.id)).size !== messages.length || messages.some(message => !message.id)
      || returned !== messages.length || returned + omitted !== received || bounds.maxTextBytes !== 4096 || bounds.maxJsonBytes !== 512000
      || new TextEncoder().encode(JSON.stringify(messages)).length > 512000) throw Error("Inconsistent bounded message history.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "message-history", contactId: messageText(row.contactId, 80), provider: oneOf(row.provider, ["imessage", "whatsapp", "beeper"]), ready: bool(row.ready), messages,
      bounds: { requested, received, returned, maxTextBytes: 4096, maxJsonBytes: 512000 }, omissions: { messages: omitted, textShortened }, limitations: list(row.limitations, 8).map(value => messageText(value, 512)) };
  }
  if (row.kind === "message-summary") {
    const citations = list(row.citations, 32).map(value => messageText(value, 512));
    const sampledMessages = integer(row.sampledMessages, 1, 200), omittedMessages = integer(row.omittedMessages, 0, 200), shortenedMessages = integer(row.shortenedMessages, 0, 200), summary = messageText(row.summary, 8192);
    if (new Set(citations).size !== citations.length || citations.some(id => !id) || citations.length > sampledMessages
      || sampledMessages + omittedMessages > 200 || shortenedMessages > sampledMessages + omittedMessages || !summary.trim()) throw Error("Invalid summary citations or sample bounds.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "message-summary", contactId: messageText(row.contactId, 80), summary, citations,
      sampledMessages, omittedMessages, shortenedMessages,
      limitations: list(row.limitations, 8).map(value => messageText(value, 512)) };
  }
  if (row.kind === "message-capabilities") {
    const actions = record(row.actions), threaded = record(row.threadedReplies);
    if (Object.keys(actions).sort().join(",") !== [...MESSAGE_ACTIONS].sort().join(",") || threaded.available !== false) throw Error("Unsupported message capabilities.");
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "message-capabilities", contactId: messageText(row.contactId, 80), provider: oneOf(row.provider, ["imessage", "whatsapp", "beeper"]), ready: bool(row.ready),
      actions: Object.fromEntries(MESSAGE_ACTIONS.map(kind => { const action = record(actions[kind]); return [kind, { available: bool(action.available), reason: action.reason === null ? null : messageText(action.reason, 1024) }]; })) as AutomationStatus["actions"],
      threadedReplies: { available: false, reason: messageText(threaded.reason, 512) } };
  }
  if (row.kind === "reply-sent") {
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-sent", contactId: text(row.contactId, 256), runId: text(row.runId, 120),
      state: oneOf(row.state, ["submitted", "failed", "partial", "indeterminate", "cancelled"]), detail: text(row.detail, 512) };
  }
  if (row.kind === "reply-discarded") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-discarded", discarded: bool(row.discarded) };
  if (row.kind === "reply-reconciled") {
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-reconciled", contactId: text(row.contactId, 256), resolved: bool(row.resolved), detail: text(row.detail, 512),
      ...(row.runId === undefined ? {} : { runId: text(row.runId, 120) }),
      ...(row.state === undefined ? {} : { state: oneOf(row.state, ["submitted", "failed"]) }) };
  }
  if (row.kind !== "snapshot") throw new Error("Unknown control response kind.");
  const source = record(row.snapshot); const global = record(source.settings);
  if (source.protocol !== CONTROL_PROTOCOL) throw new Error("Incompatible snapshot protocol.");
  const snapshot: DesktopSnapshot = {
    protocol: CONTROL_PROTOCOL, revision: integer(source.revision), connection: oneOf(source.connection, ["connected", "disconnected", "demo"]),
    detail: text(source.detail), settings: { paused: bool(global.paused), activeContactLimit: integer(global.activeContactLimit, 1, 50) },
    contacts: list(source.contacts, 1_000).map(value => { const row = record(value); return { id: text(row.id, 256), name: text(row.name, 256), subtitle: text(row.subtitle, 512), settings: settings(row.settings),
      ...(row.messaging === undefined ? {} : { messaging: { provider: oneOf(record(row.messaging).provider, ["imessage", "whatsapp", "beeper"]), state: oneOf(record(row.messaging).state, ["active", "missing", "revocation-pending", "recovery-required"]), detail: text(record(row.messaging).detail, 512), grantExpiresAt: record(row.messaging).grantExpiresAt === null ? null : text(record(row.messaging).grantExpiresAt, 32) } }) }; }),
    capabilities: list(source.capabilities, 9).map(value => { const row = record(value); return { id: oneOf(row.id, ["messages", "contacts", "agent", "attachments", "reactions", "stickers", "links", "polls", "mini-apps"]), status: oneOf(row.status, ["available", "setup-required", "unsupported"]), detail: text(row.detail) }; }),
    activity: list(source.activity, 200).map(value => { const row = record(value); return { id: text(row.id, 256), at: text(row.at, 64), contactId: row.contactId === null ? null : text(row.contactId, 256), title: text(row.title, 256), detail: text(row.detail) }; }),
    // Three native subscription accounts plus at most eight configured accounts.
    ...(source.providerAccounts === undefined ? {} : { providerAccounts: list(source.providerAccounts, 11).map(value => {
      const account = record(value);
      return { id: text(account.id, 80), label: text(account.label, 100), provider: oneOf(account.provider, ["claude", "codex", "devin"]),
        route: oneOf(account.route, ["claude-api", "claude-code", "codex", "devin"]), status: oneOf(account.status, ["ready", "setup-required", "unavailable"]),
        detail: text(account.detail, 512), defaultReplyModel: account.defaultReplyModel === null ? null : text(account.defaultReplyModel, 160),
        classifierModel: account.classifierModel === null ? null : text(account.classifierModel, 160),
        ...(account.managedAccount === undefined ? {} : { managedAccount: {
          state: oneOf(record(account.managedAccount).state, ["unchecked", "signed-out", "signing-in", "signed-in", "unavailable", "recovery-required", "closed"]),
          generation: integer(record(account.managedAccount).generation, 0), modelCount: integer(record(account.managedAccount).modelCount, 0, 5000),
          pendingLoginId: record(account.managedAccount).pendingLoginId === null ? null : text(record(account.managedAccount).pendingLoginId, 160),
        } }) };
    }) }),
    ...(source.automation === undefined ? {} : { automation: { state: oneOf(record(source.automation).state, ["running", "paused", "unavailable"]), detail: text(record(source.automation).detail, 512) } }),
    ...(source.messagingProviders === undefined ? {} : { messagingProviders: list(source.messagingProviders, 3).map(value => oneOf(value, ["imessage", "whatsapp", "beeper"])) }),
    ...(source.replies === undefined ? {} : { replies: repliesView(source.replies) }),
    ...(source.habitat === undefined ? {} : { habitat: { driver: oneOf(record(source.habitat).driver, ["gateway", "local"]), model: text(record(source.habitat).model, 160),
      evolutionModel: record(source.habitat).evolutionModel === null ? null : text(record(source.habitat).evolutionModel, 160),
      debounceMs: integer(record(source.habitat).debounceMs, 1000, 8000), dailyBudgetMicroUsd: integer(record(source.habitat).dailyBudgetMicroUsd, 0, 10_000_000) } }),
  };
  if (new Set(snapshot.contacts.map(contact => contact.id)).size !== snapshot.contacts.length
    || new Set(snapshot.capabilities.map(capability => capability.id)).size !== snapshot.capabilities.length
    || snapshot.providerAccounts && new Set(snapshot.providerAccounts.map(account => account.id)).size !== snapshot.providerAccounts.length) throw new Error("Duplicate identity in control response.");
  for (const account of snapshot.providerAccounts ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(account.id) || account.provider !== (account.route === "codex" ? "codex" : account.route === "devin" ? "devin" : "claude")) throw new Error("Invalid provider account identity.");
    // Qualified native subscription hosts use the same diagnostic contract.
    // Readiness is admitted by the host; the wire still requires both models.
    if (account.status === "ready" && (!account.classifierModel || !account.defaultReplyModel)) throw new Error("Invalid provider readiness.");
    if (account.managedAccount && (account.route !== "codex" || account.status === "ready" || account.managedAccount.state !== "signed-in" && account.managedAccount.modelCount !== 0)) throw new Error("Invalid managed account readiness.");
    if (account.managedAccount?.pendingLoginId != null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(account.managedAccount.pendingLoginId)) throw new Error("Invalid managed login identity.");
  }
  return { protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot };
}

/** Only known HTTPS sign-in destinations may reach the owner interface. */
export function parseProviderLoginChallenge(value: unknown): ProviderLoginChallenge {
  const row = record(value), loginId = text(row.loginId, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(loginId)) throw new Error("Invalid provider login identity.");
  const signInUrl = (value: unknown, device: boolean): string => {
    const raw = text(value, 8192);
    if (!raw.startsWith("https://") || /[\u0000-\u0020\u007f\\]/u.test(raw)) throw new Error("Invalid provider sign-in destination.");
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("Invalid provider sign-in destination."); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !(device ? url.origin === "https://auth.openai.com" && url.pathname === "/codex/device" && !url.search
        : ["https://auth.openai.com", "https://chatgpt.com"].includes(url.origin))) throw new Error("Invalid provider sign-in destination.");
    return raw;
  };
  if (row.type === "chatgpt" && Object.keys(row).sort().join(",") === "authUrl,loginId,type") return { type: "chatgpt", loginId, authUrl: signInUrl(row.authUrl, false) };
  if (row.type === "chatgptDeviceCode" && Object.keys(row).sort().join(",") === "loginId,type,userCode,verificationUrl") {
    const userCode = text(row.userCode, 64);
    if (!/^[A-Za-z0-9-]+$/u.test(userCode)) throw new Error("Invalid provider device code.");
    return { type: "chatgptDeviceCode", loginId, verificationUrl: signInUrl(row.verificationUrl, true), userCode };
  }
  throw new Error("Unsupported managed login challenge.");
}
