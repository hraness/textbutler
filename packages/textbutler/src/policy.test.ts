import { describe, expect, test } from "bun:test";
import { configureContact, DEFAULT_ACTIVE_LIMIT, disclose, disclosedText, disclosureMarkers, newContact, parseDisclosure, parseSettings } from "./config.ts";
import { CLASSIFIER_INSTRUCTIONS, decideReply, keywordPresent, type ConversationState, type MessageEvent } from "./decision.ts";

const now = 1_800_000_000_000;
const contact = { ...newContact("c1", "Example", "r1"), enabled: true, mode: "smart" as const };
const settings = parseSettings({ schemaVersion: 1, paused: false, maxActiveContacts: DEFAULT_ACTIVE_LIMIT, contacts: [contact] });
const event: MessageEvent = { id: "m1", contactId: "c1", routeId: "r1", revision: "v1", occurredAt: now - 10_000, observedAt: now - 10_000, author: "contact", kind: "message", text: "Butler, can you help?", historical: false, group: false };
const state: ConversationState = { latestRevision: "v1", lastOwnerAt: null, ownerTyping: false, synchronizedAt: now, repliesInLastHour: 0 };

describe("contact settings", () => {
  test("default keyword mode, explicit activation, and atomic cap", () => {
    expect(newContact("x", "Example", "rx")).toMatchObject({ enabled: false, mode: "keyword", keyword: "butler" });
    const full = parseSettings({ ...settings, maxActiveContacts: 1, contacts: [contact, newContact("c2", "Second", "r2")] });
    expect(() => configureContact(full, "c2", { enabled: true })).toThrow("limit");
    expect(full.contacts[1]?.enabled).toBe(false);
    expect(configureContact(full, "c1", { enabled: false }).contacts[0]?.revision).toBe(2);
  });
  test("disclosure accepts grapheme symbols, always adds wrapper, rejects invisible fields", () => {
    expect(disclose("hello this is my response")).toBe("🤖{ hello this is my response }");
    expect(disclose("hi", { character: "🧑‍💼", begin: "[", end: "]" })).toBe("🧑‍💼[ hi ]");
    for (const character of [" ", "a b", "\u202e", "\n", "\u200b", "\u2060", "\u0301"]) expect(() => parseDisclosure({ character, begin: "{", end: "}" })).toThrow();
  });
  test("disclosure fields may be cleared; only the fully cleared wrap disappears", () => {
    const cleared = parseDisclosure({ character: "", begin: "", end: "" });
    expect(disclosureMarkers(cleared)).toBeNull();
    expect(disclose("hello this is my response", cleared)).toBe("hello this is my response");
    expect(disclosedText("hello this is my response", cleared)).toBe(false);
    // Each field clears independently; a partial wrap still marks the reply.
    expect(disclose("hi", { character: "", begin: "{", end: "}" })).toBe("{ hi }");
    expect(disclose("hi", { character: "\ud83e\udd16", begin: "", end: "" })).toBe("\ud83e\udd16 hi");
    expect(disclose("hi", { character: "", begin: "", end: "}" })).toBe("hi }");
    expect(disclosedText("{ hi }", { character: "", begin: "{", end: "}" })).toBe(true);
    expect(disclosedText("hi }", { character: "", begin: "", end: "}" })).toBe(true);
  });
  test("rejects duplicate routes and path traversal contact IDs", () => {
    expect(() => newContact("../outside", "Example", "r")).toThrow();
    expect(() => parseSettings({ ...settings, contacts: [contact, { ...contact, id: "c2" }] })).toThrow("Duplicate");
  });
});
describe("reply admission", () => {
  test("keyword boundaries handle Unicode and punctuation", () => {
    expect(keywordPresent("Hey BUTLER!", "butler")).toBe(true);
    expect(keywordPresent("butlerish", "butler")).toBe(false);
    expect(keywordPresent("butleré", "butler")).toBe(false);
    expect(keywordPresent("Ｍｙ ＢＵＴＬＥＲ", "butler")).toBe(true);
  });
  test("explicit invocation cannot interrupt owner activity", () => {
    expect(decideReply(settings, contact, event, state, now).outcome).toBe("reply");
    expect(decideReply(settings, contact, event, { ...state, lastOwnerAt: now - 20_000 }, now).reason).toBe("owner-active");
    expect(decideReply(settings, contact, event, { ...state, ownerTyping: true }, now).reason).toBe("owner-typing");
  });
  test("ignores replay, outgoing, groups and nonmessage events", () => {
    for (const patch of [{ historical: true }, { author: "owner" as const, text: "I am answering this" }, { author: "butler" as const }, { group: true }, { kind: "reaction" as const }, { revision: "old" }, { routeId: "elsewhere" }]) expect(decideReply(settings, contact, { ...event, ...patch }, state, now).outcome).toBe("ignore");
  });
  test("owner keyword invocation replies unless the owner takes over after it", () => {
    const invoke = { ...event, author: "owner" as const };
    expect(decideReply(settings, contact, invoke, state, now)).toMatchObject({ outcome: "reply", reason: "owner-keyword" });
    // The invocation is not owner presence: equal time or earlier owner activity never suppresses it.
    expect(decideReply(settings, contact, invoke, { ...state, lastOwnerAt: event.occurredAt }, now).outcome).toBe("reply");
    expect(decideReply(settings, contact, invoke, { ...state, lastOwnerAt: now - 20_000 }, now).outcome).toBe("reply");
    // A newer owner message is a takeover and still ends the invocation.
    expect(decideReply(settings, contact, invoke, { ...state, lastOwnerAt: event.occurredAt + 1000 }, now).reason).toBe("owner-active");
    expect(decideReply(settings, contact, { ...invoke, kind: "reaction" as const }, state, now).outcome).toBe("ignore");
  });
  test("keyword mode ignores every ordinary message without the trigger word", () => {
    const keyed = { ...contact, mode: "keyword" as const };
    expect(decideReply(settings, keyed, { ...event, text: "Can you find a recipe?" }, state, now).outcome).toBe("ignore");
    expect(decideReply(settings, keyed, { ...event, text: "https://docs.google.com/document/d/abc" }, state, now).outcome).toBe("ignore");
    expect(decideReply(settings, keyed, event, state, now).outcome).toBe("reply");
  });
  test("debounce, stale sync, rate cap, and smart classifier are separate gates", () => {
    expect(decideReply(settings, contact, { ...event, observedAt: now - 100 }, state, now).reason).toBe("collecting-messages");
    expect(decideReply(settings, contact, event, { ...state, synchronizedAt: now - 20_000 }, now).reason).toBe("refresh-required");
    expect(decideReply(settings, contact, event, { ...state, repliesInLastHour: 12 }, now).reason).toBe("rate-limit");
    expect(decideReply(settings, contact, { ...event, text: "Can you find a recipe?" }, state, now).outcome).toBe("classify");
    expect(decideReply({ ...settings, paused: true }, contact, event, state, now).reason).toBe("paused");
  });
  test("event age is measured from admission, not the post-composition recheck", () => {
    // Sixteen minutes old at recheck is past the live window, yet an admission
    // 100 seconds ago saw it inside the window and keeps the event.
    const aged = { ...event, occurredAt: now - 16 * 60_000, observedAt: now - 16 * 60_000 };
    expect(decideReply(settings, contact, aged, { ...state, synchronizedAt: now }, now).reason).toBe("stale-event");
    expect(decideReply(settings, contact, aged, { ...state, synchronizedAt: now }, now, now - 100_000).outcome).toBe("reply");
    expect(decideReply(settings, contact, aged, { ...state, lastOwnerAt: now - 20_000 }, now, now - 100_000).reason).toBe("owner-active");
  });
  test("the smart classifier requires an explicit ask and keeps shares silent", () => {
    expect(CLASSIFIER_INSTRUCTIONS).toContain("explicitly asks for help");
    expect(CLASSIFIER_INSTRUCTIONS).toContain("a question, a task, or a direct address");
    expect(CLASSIFIER_INSTRUCTIONS).toContain("A shared link, document, or media item without an explicit ask is context, not a request");
    expect(CLASSIFIER_INSTRUCTIONS).toContain("confidence at or above 0.85 requires an explicit request");
    expect(CLASSIFIER_INSTRUCTIONS).toContain("You have no tools");
  });
});
