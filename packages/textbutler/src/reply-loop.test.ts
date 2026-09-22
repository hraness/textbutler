import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationBindingDigest, automationHash, createGhostgetAutomationClient, type AutomationEvent, type AutomationMessage, type AutomationPlan } from "../../transport/src/automation.ts";
import { newContact, type Settings } from "./config.ts";
import { automationBinding } from "./automation-owner.ts";
import { Hooks } from "./hooks.ts";
import { RunJournal } from "./journal.ts";
import { createDaemonReplyLoop } from "./reply-loop.ts";
import type { ButlerAgent } from "./runtime.ts";
import { createFastDriver } from "./fast-driver.ts";
import { ContactHabitat } from "./contact-habitat.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(fast = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-loop-"))), journal = RunJournal.memory();
  let time = Date.parse("2026-09-11T12:00:00.000Z"), revision = 0;
  let settings: Settings = { schemaVersion: 1, paused: false, maxActiveContacts: 5, contacts: [{ ...newContact("contact-1", "Synthetic", "enrollment:fixture"), enabled: true }] };
  const listeners = new Set<(settings: Settings) => void>();
  const identity = { provider: "imessage" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
  const conversation = { coordinate: { provider: "imessage" as const, chatGuid: "iMessage;-;fixture@example.test", service: "iMessage" as const, observedChatRowId: 1 }, title: "Synthetic", kind: "single" as const, participants: ["fixture@example.test"] };
  const enrolled = () => ({ id: "enrollment:fixture", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision, ready: true, reason: null });
  const binding = automationBinding(enrolled()), events: AutomationEvent[] = [], messages: AutomationMessage[] = [], sent: readonly unknown[][] = [];
  const mutableSent = sent as unknown[][], plans = new Map<string, AutomationPlan>();
  const client = createGhostgetAutomationClient(async (method, params) => {
    if (method === "poll") return enrolled();
    if (method === "history") return { enrollment: enrolled(), messages: messages.slice(-Number(params.limit)) };
    if (method === "events") return { events: events.slice(Number(params.cursor ?? 0)), nextCursor: String(events.length), caughtUp: true };
    if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: true, reason: null }])) };
    if (method === "prepare") { const body = { ...params, bindingDigest: binding.bindingDigest, expiresAt: new Date(time + 120000).toISOString() }, digest = automationHash(body), plan = { ...body, digest, id: `plan:${digest}` } as AutomationPlan; plans.set(plan.id, plan); return plan; }
    if (method === "submit") { const plan = plans.get(String(params.planId))!; mutableSent.push([...plan.actions]); return { id: `run:${sent.length}`, planId: plan.id, intentId: plan.intentId, enrollmentId: binding.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:${sent.length}:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
    throw new Error(`Unexpected fixture operation ${method}`);
  }, () => time);
  let compositions = 0, classifications = 0, agent: ButlerAgent = {
    async qualified() { return true; }, async classify() { classifications++; return { respond: true, confidence: 0.99, reason: "requested" }; },
    async compose(request) { compositions++; return { summary: "Here is help", actions: [{ kind: "text", text: "Hello" }, { kind: "reaction", messageId: request.event.id, emoji: "👍", action: "add" }] }; },
  };
  const driver = createFastDriver({ kind: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "synthetic" }, { journal, fetch: async () => {
    compositions++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value: { respond: true, confidence: 0.99, reason: "requested", summary: "Explain briefly", actions: [{ kind: "text", text: "Synthetic answer" }], tool: null } }) } }] });
  } });
  const loop = await createDaemonReplyLoop({ client, automatic: false, now: () => time, hooks: new Hooks(),
    ...(fast ? { habitat: { config: { enabled: true, driver: driver.config, evolutionModel: null, debounceMs: 1000 }, driver } }
      : { agent: { qualified: (contact: Parameters<ButlerAgent["qualified"]>[0]) => agent.qualified(contact), classify: (request: Parameters<ButlerAgent["classify"]>[0]) => agent.classify(request), compose: (request: Parameters<ButlerAgent["compose"]>[0]) => agent.compose(request) } }), service: {
    dataDir: root, providers: undefined, runtimeState: async () => ({ settings, bindings: { "contact-1": binding }, grants: {} }), runJournal: () => journal,
    delegatedGrant: async contact => !settings.paused && settings.contacts.some(current => current.enabled && current.id === contact.id && current.revision === contact.revision) ? "grant:fixture" : null,
    onSettingsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notePending() {},
  } });
  cleanup.push(async () => { await loop.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  return { loop, journal, sent, stats: () => ({ compositions, classifications }), advance(ms: number) { time += ms; }, replaceAgent(next: ButlerAgent) { agent = next; },
    change(next: Settings) { settings = next; for (const listener of listeners) listener(next); }, settings: () => settings,
    add(text: string, direction: AutomationMessage["direction"] = "incoming", ageMs = 0) { revision++; const message: AutomationMessage = { id: `message:${revision}`, coordinate: conversation.coordinate, direction, occurredAt: new Date(time - ageMs).toISOString(), text, kind: "message", relatedMessageId: null, attachments: [] }; messages.push(message); events.push({ sequence: revision, enrollmentId: binding.enrollmentId, revision, message }); },
  };
}
test("reply loop establishes a silent startup boundary then debounces a disclosed rich reply", async () => {
  const f = await fixture(); f.add("butler this was queued before startup"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle(); expect(f.sent).toHaveLength(0);
  f.add("butler help with this"); await f.loop.tick(); await f.loop.idle(); expect(f.sent).toHaveLength(0);
  f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toEqual([{ kind: "text", text: "🤖{ Hello }" }, { kind: "reaction", messageId: "message:2", emoji: "👍", remove: false }]);
  expect(f.journal.recent("contact-1")[0]?.state).toBe("submitted");
});
test("backfill and an active owner conversation never reach the response agent", async () => {
  const f = await fixture(); await f.loop.tick();
  f.add("butler old imported request", "incoming", 3600000); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  f.add("I am answering this", "outgoing"); f.add("butler another request"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.stats().compositions).toBe(0); expect(f.sent).toHaveLength(0);
});
test("an owner keyword invocation replies; plain owner text still answers", async () => {
  const f = await fixture(); await f.loop.tick();
  f.add("hey butler tell me what you can do", "outgoing"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(1);
  // Recent owner activity does not block an explicit invocation.
  f.add("still talking", "outgoing"); f.add("butler another thing", "outgoing");
  await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(2);
  // Plain owner text answers the thread and cools the butler down.
  f.add("I am answering this", "outgoing"); f.add("butler one more");
  await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(2);
});
test("global pause immediately cancels an in-progress composition", async () => {
  const f = await fixture(); await f.loop.tick();
  let started!: () => void; const composing = new Promise<void>(resolve => { started = resolve; });
  f.replaceAgent({ async qualified() { return true; }, async classify() { return { respond: true, confidence: 1, reason: "requested" }; }, async compose(request) { started(); return new Promise((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }); } });
  f.add("butler please help"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await composing;
  f.change({ ...f.settings(), paused: true }); await f.loop.idle();
  expect(f.sent).toHaveLength(0); expect(f.journal.recent("contact-1")[0]?.state).toBe("cancelled");
});
test("smart mode classifies once and disabling prevents subsequent turns", async () => {
  const f = await fixture(); await f.loop.tick(); f.add("Could you find a useful explanation?"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.stats().classifications).toBe(1); expect(f.sent).toHaveLength(1);
  f.change({ ...f.settings(), contacts: f.settings().contacts.map(contact => ({ ...contact, enabled: false, revision: contact.revision + 1 })) });
  f.add("butler answer again"); f.advance(9000); await f.loop.tick(); await f.loop.idle(); expect(f.sent).toHaveLength(1);
});
test("the optional habitat driver replies after its short debounce with one inference and records follow-ups", async () => {
  const f = await fixture(true); await f.loop.tick();
  f.add("Could you explain this?"); await f.loop.tick(); f.advance(1100); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(1); expect(f.stats().compositions).toBe(1);
  const habitat = new ContactHabitat(f.journal, "contact-1");
  expect(habitat.snapshot().episodes).toHaveLength(1);
  f.advance(1000); f.add("Thanks, that example helped."); await f.loop.tick();
  expect(habitat.snapshot().episodes[0]?.followups.map(value => value.text)).toEqual(["Thanks, that example helped."]);
});

test("self-chat echoes never answer the pending inbound or erase a newer one", async () => {
  const f = await fixture();
  f.change({ ...f.settings(), contacts: f.settings().contacts.map(contact => ({ ...contact, selfChat: true })) });
  await f.loop.tick();
  f.add("butler what is up", "outgoing"); f.add("butler what is up", "incoming");
  await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(1);
  f.add("butler one more", "incoming"); f.add("🤖{ Hello }", "incoming"); f.add("🤖{ Hello }", "outgoing");
  await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(2);
});
