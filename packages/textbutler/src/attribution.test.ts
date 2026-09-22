import { afterEach, expect, test } from "bun:test";
import { disclose, newContact, parseContact, type ContactSettings } from "./config.ts";
import { messageAuthor, pendingCluster } from "./attribution.ts";
import { RunJournal } from "./journal.ts";
import type { AutomationMessage } from "../../transport/src/automation.ts";

const NOW = Date.parse("2026-09-21T18:41:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const journal = (): RunJournal => { const value = RunJournal.memory(); cleanup.push(() => value.close()); return value; };

const coordinate: AutomationMessage["coordinate"] = { provider: "imessage", chatGuid: "iMessage;-;+15551234567", service: "iMessage", observedChatRowId: 1 };
const row = (id: string, direction: AutomationMessage["direction"], text: string | null, at: number): AutomationMessage =>
  ({ id, coordinate, direction, occurredAt: new Date(at).toISOString(), text, kind: "message", relatedMessageId: null, attachments: [] });

const contact = (selfChat: boolean, over: Partial<ContactSettings> = {}): ContactSettings =>
  ({ ...newContact("self-1", "Me", "enrollment:self"), selfChat, ...over });

test("selfChat defaults off and clears to a plain contact", () => {
  expect(newContact("c", "C", "r").selfChat).toBe(false);
  expect(parseContact({ ...newContact("c", "C", "r"), selfChat: true }).selfChat).toBe(true);
  expect(() => parseContact({ ...newContact("c", "C", "r"), selfChat: true, disclosure: { character: "", begin: "", end: "" } })).toThrow("wrap");
  expect(() => parseContact({ ...newContact("c", "C", "r"), selfChat: "yes" })).toThrow("self");
});

test("ordinary chats keep echo-free attribution", () => {
  const person = contact(false), log = journal();
  expect(messageAuthor(row("a", "incoming", "hi", NOW), person, log)).toBe("contact");
  expect(messageAuthor(row("b", "outgoing", "hi", NOW), person, log)).toBe("owner");
  expect(messageAuthor(row("c", "outgoing", disclose("done"), NOW), person, log)).toBe("butler");
  // Even a wrapped text sent by the person stays theirs outside a self chat.
  expect(messageAuthor(row("d", "incoming", disclose("done"), NOW), person, log)).toBe("contact");
  // A plain owner text ends the pending run: the conversation is answered.
  expect(pendingCluster([row("a", "incoming", "hi", NOW - 1), row("b", "outgoing", "hi", NOW)], person, log)).toBeNull();
});

test("a keyword-bearing owner run is pending; plain owner text is not", () => {
  const person = contact(false), log = journal();
  expect(pendingCluster([row("a", "outgoing", "hey butler tell me what you can do", NOW)], person, log)).toMatchObject({ count: 1, latestId: "a" });
  expect(pendingCluster([row("b", "outgoing", "I am answering this", NOW)], person, log)).toBeNull();
  // A newer owner follow-up travels with the invocation.
  const run = [row("c", "outgoing", "butler what time is it", NOW - 1), row("d", "outgoing", "in utc please", NOW)];
  expect(pendingCluster(run, person, log)).toMatchObject({ count: 2, latestId: "d" });
  // Contact text then owner text: only the owner tail is pending.
  expect(pendingCluster([row("e", "incoming", "question?", NOW - 2), ...run], person, log)).toMatchObject({ count: 2, latestId: "d" });
  // A butler reply ends it.
  expect(pendingCluster([row("f", "outgoing", "butler hi", NOW), row("g", "outgoing", disclose("Done"), NOW + 1)], person, log)).toBeNull();
});

test("self chat treats the outbound echo as the owner's own text, never an answer", () => {
  const me = contact(true), log = journal();
  expect(messageAuthor(row("a", "incoming", "hi", NOW), me, log)).toBe("contact");
  expect(messageAuthor(row("b", "outgoing", "hi", NOW), me, log)).toBe("self");
  // The butler's own send echoes back inbound under a fresh row id.
  expect(messageAuthor(row("c", "incoming", disclose("On it"), NOW), me, log)).toBe("butler");
  expect(messageAuthor(row("d", "outgoing", disclose("On it"), NOW), me, log)).toBe("butler");
});

test("self chat pending keeps each owner text once and ignores its echo", () => {
  const me = contact(true), log = journal();
  const pair = [row("in-1", "incoming", "butler hi", NOW - 2), row("out-1", "outgoing", "butler hi", NOW - 1)];
  expect(pendingCluster(pair, me, log)).toMatchObject({ count: 1, latestId: "in-1" });
  const two = [...pair, row("in-2", "incoming", "and this", NOW), row("out-2", "outgoing", "and this", NOW + 1)];
  expect(pendingCluster(two, me, log)).toMatchObject({ count: 2, latestId: "in-2" });
  // A butler reply row and its inbound echo both close the run.
  const answered = [...two, row("out-3", "outgoing", disclose("Done"), NOW + 2), row("in-3", "incoming", disclose("Done"), NOW + 3)];
  expect(pendingCluster(answered, me, log)).toBeNull();
});

test("self chat correlates text-less inbound echoes by recent send time", () => {
  const me = contact(true), log = journal();
  log.recordSentMessages(me.id, "run-1", ["sent-1"], NOW - 10_000);
  expect(messageAuthor(row("echo", "incoming", null, NOW - 9_000), me, log)).toBe("butler");
  expect(messageAuthor(row("later", "incoming", null, NOW + 90_000), me, log)).toBe("contact");
  expect(messageAuthor(row("plain", "incoming", null, NOW), contact(false), log)).toBe("contact");
});
