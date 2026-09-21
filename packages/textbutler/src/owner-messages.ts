import type { MessageCapabilitiesResult, MessageHistoryResult, MessageSummaryResult, OwnerMessage } from "../../control/src/index.ts";
import { AUTOMATION_ACTIONS, automationHash, type GhostgetAutomationClient } from "../../transport/src/automation.ts";
import { assertAutomationBinding } from "./automation-owner.ts";
import { messageAuthor } from "./attribution.ts";
import type { ContactSettings } from "./config.ts";
import { ControlFailure, type OwnerBinding, type OwnerRuntimeState } from "./control-service.ts";
import { assertSameConversation, type OwnerConversationReadPort } from "./enrollment.ts";
import type { RunJournal } from "./journal.ts";
import { summarizeMessages, type SummaryMessage } from "./message-summary.ts";
import type { ProviderHost } from "./provider-host.ts";

const HISTORY_BYTES = 512000, SUMMARY_BYTES = 96000;
const THREADING_REASON = "The connected messaging contract does not support threaded replies. Text replies are separate messages.";
const LIMITATIONS = ["This is a bounded recent sample, not the complete conversation.", "Attachments contain metadata only; their contents have not been read."];
function fail(code: "invalid-request" | "conflict" | "unavailable", message: string): never { throw new ControlFailure(code, message); }
function limit_(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 200) fail("invalid-request", "History limit must be between 1 and 200."); return value; }
function retainNewest<T>(values: readonly T[], maximumBytes: number): T[] {
  const sizes = values.map(value => Buffer.byteLength(JSON.stringify(value)) + 1);
  let size = sizes.reduce((total, value) => total + value, 1), first = 0;
  while (size > maximumBytes && first < values.length) size -= sizes[first++]!;
  return values.slice(first);
}
function normalizeText(value: string | null): { text: string | null; textTruncated: boolean } {
  if (value === null) return { text: null, textTruncated: false };
  const clean = value.replaceAll("\0", "");
  const text = Buffer.byteLength(clean) <= 4096 ? clean : new TextDecoder().decode(Buffer.from(clean).subarray(0, 4096)).replace(/\uFFFD$/u, "");
  return { text, textTruncated: text !== value };
}
export interface OwnerMessagesPorts {
  state(): Promise<OwnerRuntimeState>;
  client(): GhostgetAutomationClient | undefined;
  enrollment(): OwnerConversationReadPort | undefined;
  providers(): Pick<ProviderHost, "selection" | "runManagedTask"> | undefined;
  journal: RunJournal;
  now(): number;
  summarize?: typeof summarizeMessages;
}

/** Owner-only reads and ephemeral analysis. No grants, provider mutations,
 * conversation files, or messaging actions are exposed to the summary model. */
export class OwnerMessages {
  constructor(private readonly ports: OwnerMessagesPorts) {}
  private async selected(contactId: string): Promise<{ contact: ContactSettings; binding: OwnerBinding }> {
    const state = await this.ports.state(), contact = state.settings.contacts.find(value => value.id === contactId), binding = state.bindings[contactId];
    if (!contact) fail("invalid-request", "This contact is not configured by the owner.");
    if (!binding) fail("unavailable", "This contact has no bound conversation.");
    return { contact, binding };
  }
  private async unchanged(contact: ContactSettings, binding: OwnerBinding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const current = await this.selected(contact.id);
    if (current.contact.revision !== contact.revision || automationHash(current.binding) !== automationHash(binding))
      fail("conflict", "The contact or messaging identity changed during this request. Read it again.");
    signal.throwIfAborted();
  }
  private async read(contact: ContactSettings, binding: OwnerBinding, limit: number, signal: AbortSignal): Promise<MessageHistoryResult> {
    limit_(limit); signal.throwIfAborted();
    let messages: OwnerMessage[], ready = true;
    if (binding.version === 2) {
      const client = this.ports.client(); if (!client) fail("unavailable", "Messaging automation is not configured.");
      const page = await client.history(binding.enrollmentId, limit, signal); assertAutomationBinding(binding, page.enrollment);
      ready = page.enrollment.ready;
      messages = page.messages.map(message => ({ id: message.id, at: Date.parse(message.occurredAt), author: messageAuthor(message, contact, this.ports.journal),
        ...normalizeText(message.text), kind: message.kind, relatedMessageId: message.relatedMessageId, attachments: structuredClone(message.attachments) }));
    } else {
      const enrollment = this.ports.enrollment(); if (!enrollment) fail("unavailable", "Read-only Messages access is not configured.");
      const page = await enrollment.read(binding, true, signal); assertSameConversation(binding, page.conversation);
      if (page.messages.length > 200) fail("unavailable", "The conversation reader exceeded its history limit.");
      messages = page.messages.slice(-limit).map(message => ({ id: message.id, at: message.at, author: message.author, ...normalizeText(message.text), kind: "message", relatedMessageId: null, attachments: [] }));
    }
    if (messages.length > limit || new Set(messages.map(message => message.id)).size !== messages.length
      || messages.some(message => !message.id || Buffer.byteLength(message.id) > 512 || !Number.isSafeInteger(message.at) || message.at < 0))
      fail("unavailable", "The conversation returned invalid or duplicate history identities.");
    messages.sort((a, b) => a.at - b.at);
    const bounded = retainNewest(messages, HISTORY_BYTES);
    await this.unchanged(contact, binding, signal);
    return { contactId: contact.id, provider: binding.version === 2 ? binding.identity.provider : "imessage", ready, messages: bounded,
      bounds: { requested: limit, received: messages.length, returned: bounded.length, maxTextBytes: 4096, maxJsonBytes: HISTORY_BYTES },
      omissions: { messages: messages.length - bounded.length, textShortened: messages.filter(message => message.textTruncated).length },
      limitations: [...LIMITATIONS, ...(binding.version === 1 ? ["This legacy read-only selection does not expose attachment or reaction metadata."] : []),
        ...(!ready ? ["Messaging catchup is incomplete; more recent messages may be missing."] : [])] };
  }
  async history(contactId: string, limit: number, signal: AbortSignal): Promise<MessageHistoryResult> {
    const { contact, binding } = await this.selected(contactId); return this.read(contact, binding, limit, signal);
  }
  async summarize(contactId: string, limit: number, signal: AbortSignal): Promise<MessageSummaryResult> {
    const { contact, binding } = await this.selected(contactId), providers = this.ports.providers();
    if (!providers) fail("unavailable", "Select a qualified agent account before requesting a summary.");
    const history = await this.read(contact, binding, limit, signal);
    const eligible: SummaryMessage[] = history.messages.filter(message => message.kind === "message" && message.text !== null && message.author !== "self")
      .map(message => ({ id: message.id, at: message.at, author: message.author as SummaryMessage["author"], text: message.text! }));
    const messages = retainNewest(eligible, SUMMARY_BYTES);
    if (!messages.length) fail("unavailable", "This bounded conversation sample contains no text to summarize.");
    const result = await (this.ports.summarize ?? summarizeMessages)({ contact, messages, providers, signal, now: this.ports.now });
    await this.unchanged(contact, binding, signal);
    return { contactId, ...result, sampledMessages: messages.length, omittedMessages: history.bounds.received - messages.length,
      shortenedMessages: history.omissions.textShortened, limitations: [...history.limitations, "Only sampled text messages are analyzed; reaction, edit, deletion and attachment contents are excluded."] };
  }
  async capabilities(contactId: string, signal: AbortSignal): Promise<MessageCapabilitiesResult> {
    const { contact, binding } = await this.selected(contactId); signal.throwIfAborted();
    if (binding.version === 1) {
      await this.read(contact, binding, 1, signal);
      return { contactId, provider: "imessage", ready: false,
        actions: Object.fromEntries(AUTOMATION_ACTIONS.map(kind => [kind, { available: false, reason: "This selection is read-only. Enroll it through messaging before composing actions." }])) as MessageCapabilitiesResult["actions"],
        threadedReplies: { available: false, reason: THREADING_REASON } };
    }
    const client = this.ports.client(); if (!client) fail("unavailable", "Messaging automation is not configured.");
    const enrollment = await client.poll(binding.enrollmentId, signal); assertAutomationBinding(binding, enrollment);
    const status = await client.status(binding.identity.provider, signal);
    if (automationHash(status.identity) !== automationHash(binding.identity)) fail("conflict", "The messaging account changed. Enroll this contact again.");
    await this.unchanged(contact, binding, signal);
    const ready = enrollment.ready && status.connected && status.events.available;
    return { contactId, provider: binding.identity.provider, ready,
      actions: Object.fromEntries(AUTOMATION_ACTIONS.map(kind => [kind, ready ? { ...status.actions[kind] } : { available: false, reason: "Messaging connection or catchup is incomplete." }])) as MessageCapabilitiesResult["actions"],
      threadedReplies: { available: false, reason: THREADING_REASON } };
  }
}
