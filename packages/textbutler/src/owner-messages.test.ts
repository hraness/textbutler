import { afterEach, expect, test } from "bun:test";
import { CONTROL_PROTOCOL, parseControlResponse } from "../../control/src/index.ts";
import { AUTOMATION_ACTIONS, automationBindingDigest, createGhostgetAutomationClient, type AutomationMessage } from "../../transport/src/automation.ts";
import { automationBinding } from "./automation-owner.ts";
import { newContact } from "./config.ts";
import type { OwnerRuntimeState } from "./control-service.ts";
import { RunJournal } from "./journal.ts";
import { OwnerMessages, type OwnerMessagesPorts } from "./owner-messages.ts";
import type { ConversationBinding } from "./enrollment.ts";

const journals: RunJournal[] = [];
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });
const NOW = Date.parse("2026-09-20T12:00:00Z"), signal = () => AbortSignal.timeout(5000);
function setup() {
  const journal = RunJournal.memory(); journals.push(journal);
  const contact = { ...newContact("synthetic", "Synthetic", "enrollment:synthetic"), enabled: false };
  const identity = { provider: "imessage" as const, authId: "synthetic", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
  const conversation = { coordinate: { provider: "imessage" as const, chatGuid: "iMessage;-;synthetic@example.test", service: "iMessage" as const, observedChatRowId: 1 }, title: "Synthetic", kind: "single" as const, participants: ["synthetic@example.test"] };
  const enrollment = { id: "enrollment:synthetic", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 1, ready: true, reason: null };
  let state: OwnerRuntimeState = { revision: 1, settings: { schemaVersion: 1, paused: true, maxActiveContacts: 5, contacts: [contact] }, bindings: { synthetic: automationBinding(enrollment) }, grants: {} };
  const messages: AutomationMessage[] = [{ id: "message:1", coordinate: conversation.coordinate, direction: "incoming", occurredAt: new Date(NOW).toISOString(), text: "Dinner at 7?", kind: "message", relatedMessageId: null,
    attachments: [{ name: "menu.png", mimeType: "image/png", sizeBytes: 1234 }] }];
  const calls: string[] = [], samples: Parameters<NonNullable<OwnerMessagesPorts["summarize"]>>[0][] = [];
  let afterHistory = () => {}, statusIdentity = identity, disabled: string | undefined;
  const client = createGhostgetAutomationClient(async (method, params) => {
    calls.push(method);
    if (method === "history") { afterHistory(); return { enrollment, messages: messages.slice(-Number(params.limit)) }; }
    if (method === "poll") return enrollment;
    if (method === "status") return { identity: statusIdentity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(AUTOMATION_ACTIONS.map(kind => [kind, { available: kind !== disabled, reason: kind === disabled ? "Unavailable on this provider." : null }])) };
    throw Error(`No mutation is permitted in the read fixture: ${method}`);
  });
  const ports: OwnerMessagesPorts = { state: async () => structuredClone(state), client: () => client, enrollment: () => undefined, journal, now: () => NOW,
    providers: () => ({ selection: async () => { throw Error("The synthetic summarizer owns this test"); }, runManagedTask: async () => { throw Error("No live provider calls"); } }),
    summarize: async input => { samples.push(input); return { summary: "Dinner is being planned.", citations: [input.messages.at(-1)!.id] }; } };
  return { owner: new OwnerMessages(ports), ports, state: () => state, replaceState: (next: OwnerRuntimeState) => { state = next; }, messages, calls, samples, journal, enrollment,
    afterHistory: (callback: () => void) => { afterHistory = callback; }, statusIdentity: (value: typeof identity) => { statusIdentity = value; }, disable: (kind: string) => { disabled = kind; } };
}

test("owner history remains available while paused/disabled and returns exact IDs and metadata without mutations", async () => {
  const f = setup(), result = await f.owner.history("synthetic", 20, signal());
  expect(result).toMatchObject({ contactId: "synthetic", provider: "imessage", ready: true, bounds: { requested: 20, received: 1, returned: 1 }, omissions: { messages: 0, textShortened: 0 },
    messages: [{ id: "message:1", author: "contact", kind: "message", text: "Dinner at 7?", attachments: [{ name: "menu.png", mimeType: "image/png", sizeBytes: 1234 }] }] });
  expect(f.calls).toEqual(["history"]);
  expect(parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "message-history", ...result })).toMatchObject(result);
});

test("history preserves unknown authors and journal-derived butler provenance", async () => {
  const f = setup(), first = f.messages[0]!;
  f.journal.claim("run:synthetic", "synthetic", "event:synthetic", NOW);
  f.journal.recordSentMessages("synthetic", "run:synthetic", ["message:butler"], NOW);
  f.messages.push({ ...first, id: "message:butler", direction: "outgoing", text: "I can make it." }, { ...first, id: "message:unknown", direction: "unknown", kind: "reaction", relatedMessageId: first.id });
  const result = await f.owner.history("synthetic", 200, signal());
  expect(result.messages.find(value => value.id === "message:butler")?.author).toBe("butler");
  expect(result.messages.find(value => value.id === "message:unknown")).toMatchObject({ author: "unknown", kind: "reaction", relatedMessageId: "message:1" });
});

test("history truncates UTF-8 text and drops only oldest records to fit the bounded response", async () => {
  const f = setup(), first = f.messages[0]!;
  f.messages.splice(0, 1, ...Array.from({ length: 200 }, (_, index) => ({ ...first, id: `message:${String(index).padStart(3, "0")}`, occurredAt: new Date(NOW + index).toISOString(), text: "🙂".repeat(3000) })));
  const result = await f.owner.history("synthetic", 200, signal());
  expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(512000);
  expect(result.omissions.messages).toBeGreaterThan(0); expect(result.omissions.textShortened).toBe(200);
  expect(result.messages.at(-1)?.id).toBe("message:199");
  expect(result.messages.every(value => Buffer.byteLength(value.text!) <= 4096 && !value.text!.includes("�") && value.textTruncated)).toBe(true);
  expect(result.bounds.returned + result.omissions.messages).toBe(200);
});

test("invalid limits, duplicate message IDs and account/conversation drift fail closed", async () => {
  const f = setup();
  for (const limit of [0, 201, 1.2, NaN]) await expect(f.owner.history("synthetic", limit, signal())).rejects.toMatchObject({ code: "invalid-request" });
  expect(f.calls).toEqual([]);
  f.messages.push({ ...f.messages[0]! });
  await expect(f.owner.history("synthetic", 200, signal())).rejects.toMatchObject({ code: "unavailable" });
  f.messages.pop();
  f.afterHistory(() => { f.replaceState({ ...f.state(), settings: { ...f.state().settings, contacts: f.state().settings.contacts.map(contact => ({ ...contact, revision: contact.revision + 1 })) } }); });
  await expect(f.owner.history("synthetic", 200, signal())).rejects.toMatchObject({ code: "conflict" });
  await expect(f.owner.history("other", 20, signal())).rejects.toMatchObject({ code: "invalid-request" });
});

test("summary samples at most 96000 JSON bytes, excludes non-text events, and reports omissions", async () => {
  const f = setup(), first = f.messages[0]!;
  f.messages.splice(0, 1, ...Array.from({ length: 150 }, (_, index) => ({ ...first, id: `message:${String(index).padStart(3, "0")}`, occurredAt: new Date(NOW + index).toISOString(), text: "x".repeat(5000) })));
  f.messages.push({ ...first, id: "reaction:latest", kind: "reaction", relatedMessageId: "message:149" });
  const result = await f.owner.summarize("synthetic", 200, signal());
  expect(f.samples).toHaveLength(1); expect(Buffer.byteLength(JSON.stringify(f.samples[0]!.messages))).toBeLessThanOrEqual(96000);
  expect(f.samples[0]!.messages.at(-1)?.id).toBe("message:149");
  expect(result.sampledMessages + result.omittedMessages).toBe(151); expect(result.shortenedMessages).toBe(150);
  expect(result.citations).toEqual(["message:149"]); expect(f.calls).toEqual(["history"]);
  expect(parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "message-summary", ...result })).toMatchObject(result);
});

test("summary rejects missing text, cancellation and identity changes during inference", async () => {
  const empty = setup(); empty.messages[0] = { ...empty.messages[0]!, text: null };
  await expect(empty.owner.summarize("synthetic", 20, signal())).rejects.toMatchObject({ code: "unavailable" }); expect(empty.samples).toHaveLength(0);
  const changed = setup(); changed.ports.summarize = async () => { changed.replaceState({ ...changed.state(), bindings: {} }); return { summary: "Never publish", citations: [] }; };
  await expect(changed.owner.summarize("synthetic", 20, signal())).rejects.toThrow();
  const stopped = setup(), controller = new AbortController(); controller.abort();
  await expect(stopped.owner.summarize("synthetic", 20, controller.signal)).rejects.toThrow(); expect(stopped.calls).toEqual([]);
});

test("capabilities bind the live account and report unsupported threading without creating authority", async () => {
  const f = setup(); f.disable("sticker");
  const result = await f.owner.capabilities("synthetic", signal());
  expect(result).toMatchObject({ ready: true, actions: { text: { available: true }, sticker: { available: false } }, threadedReplies: { available: false } });
  expect(f.calls).toEqual(["poll", "status"]);
  expect(parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "message-capabilities", ...result })).toMatchObject(result);
  f.statusIdentity({ ...f.enrollment.identity, accountSubject: "different-account" });
  await expect(f.owner.capabilities("synthetic", signal())).rejects.toMatchObject({ code: "conflict" });
});

test("incomplete catchup is labelled in history and disables reported actions", async () => {
  const f = setup(); f.enrollment.ready = false;
  const history = await f.owner.history("synthetic", 20, signal());
  expect(history.ready).toBe(false); expect(history.limitations.join(" ")).toContain("catchup");
  expect(Object.values((await f.owner.capabilities("synthetic", signal())).actions).every(value => !value.available)).toBe(true);
});

test("legacy read-only history revalidates its exact conversation and never invents rich metadata or sending", async () => {
  const f = setup();
  const binding: ConversationBinding = { version: 1, authId: "synthetic", authIdentity: "a".repeat(64), authHash: "b".repeat(64), accountSubject: "synthetic-account",
    chatGuid: "iMessage;-;synthetic@example.test", observedChatRowId: 1, service: "iMessage", participants: ["synthetic@example.test"], observedAccountId: null, observedAccountLogin: null, observedLastAddressedHandle: null };
  f.replaceState({ ...f.state(), bindings: { synthetic: binding } });
  let observed = binding;
  f.ports.client = () => undefined;
  f.ports.enrollment = () => ({ list: async () => { throw Error("No discovery"); }, read: async () => ({ conversation: { binding: observed, title: "Synthetic", kind: "single" },
    messages: [{ id: "legacy:1", at: NOW, text: "Read only", author: "contact" }] }) });
  const history = await f.owner.history("synthetic", 20, signal());
  expect(history.messages).toEqual([{ id: "legacy:1", at: NOW, text: "Read only", textTruncated: false, author: "contact", kind: "message", relatedMessageId: null, attachments: [] }]);
  expect(history.limitations.join(" ")).toContain("legacy read-only");
  const capabilities = await f.owner.capabilities("synthetic", signal());
  expect(capabilities.ready).toBe(false); expect(Object.values(capabilities.actions).every(value => !value.available)).toBe(true); expect(f.calls).toEqual([]);
  observed = { ...binding, accountSubject: "different-account" };
  await expect(f.owner.history("synthetic", 20, signal())).rejects.toThrow("Conversation account or participants changed");
});

test("control response parser refuses over-limit or inconsistent body metadata", async () => {
  const f = setup(), history = await f.owner.history("synthetic", 20, signal());
  const response = { protocol: CONTROL_PROTOCOL, ok: true, kind: "message-history", ...history };
  for (const changed of [{ bounds: { ...history.bounds, returned: 2 } }, { bounds: { ...history.bounds, requested: 201 } }, { omissions: { messages: 1, textShortened: 0 } },
    { messages: [{ ...history.messages[0], text: "🙂".repeat(2000) }] }, { messages: [{ ...history.messages[0], attachments: Array.from({ length: 21 }, () => ({ name: null, mimeType: null, sizeBytes: null })) }] }]) {
    expect(() => parseControlResponse({ ...response, ...changed })).toThrow();
  }
  const capabilities = await f.owner.capabilities("synthetic", signal());
  expect(() => parseControlResponse({ protocol: CONTROL_PROTOCOL, ok: true, kind: "message-capabilities", ...capabilities, threadedReplies: { available: true, reason: "pretend" } })).toThrow();
  const summary = { protocol: CONTROL_PROTOCOL, ok: true, kind: "message-summary", contactId: "synthetic", summary: "Dinner", citations: ["message:1"], sampledMessages: 1, omittedMessages: 0, shortenedMessages: 0, limitations: [] };
  for (const changed of [{ sampledMessages: 200, omittedMessages: 1 }, { citations: ["message:1", "message:2"] }, { shortenedMessages: 2 }, { summary: " " }]) expect(() => parseControlResponse({ ...summary, ...changed })).toThrow();
});
