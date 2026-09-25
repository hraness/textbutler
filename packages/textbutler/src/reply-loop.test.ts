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
import { ContactHabitat, boundHabitatObservation } from "./contact-habitat.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(fast = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-loop-"))), journal = RunJournal.memory();
  let time = Date.parse("2026-09-11T12:00:00.000Z"), revision = 0;
  let settings: Settings = { schemaVersion: 1, paused: false, maxActiveContacts: 5, contacts: [{ ...newContact("contact-1", "Synthetic", "enrollment:fixture"), enabled: true }] };
  const listeners = new Set<(settings: Settings) => void>();
  const habitatListeners = new Set<(contactId: string) => void>();
  const identity = { provider: "imessage" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
  const conversation = { coordinate: { provider: "imessage" as const, chatGuid: "iMessage;-;fixture@example.test", service: "iMessage" as const, observedChatRowId: 1 }, title: "Synthetic", kind: "single" as const, participants: ["fixture@example.test"] };
  const enrolled = () => ({ id: "enrollment:fixture", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision, ready: true, reason: null });
  const binding = automationBinding(enrolled()), events: AutomationEvent[] = [], messages: AutomationMessage[] = [], sent: readonly unknown[][] = [];
  const mutableSent = sent as unknown[][], plans = new Map<string, AutomationPlan>(), statuses: { state: string; detail: string }[] = [];
  let failEvents = 0, eventsCalls = 0;
  let beforeSubmit: (() => Promise<void>) | undefined;
  const client = createGhostgetAutomationClient(async (method, params) => {
    if (method === "poll") return enrolled();
    if (method === "history") return { enrollment: enrolled(), messages: messages.slice(-Number(params.limit)) };
    if (method === "events") { eventsCalls++; if (failEvents > 0) { failEvents--; throw new Error("Synthetic events stream failure"); }
      return { events: events.slice(Number(params.cursor ?? 0)), nextCursor: String(events.length), caughtUp: true }; }
    if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: true, reason: null }])) };
    if (method === "prepare") { const body = { ...params, bindingDigest: binding.bindingDigest, expiresAt: new Date(time + 120000).toISOString() }, digest = automationHash(body), plan = { ...body, digest, id: `plan:${digest}` } as AutomationPlan; plans.set(plan.id, plan); return plan; }
    if (method === "submit") { await beforeSubmit?.(); const plan = plans.get(String(params.planId))!; mutableSent.push([...plan.actions]); return { id: `run:${sent.length}`, planId: plan.id, intentId: plan.intentId, enrollmentId: binding.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:${sent.length}:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
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
  const loop = await createDaemonReplyLoop({ client, automatic: false, now: () => time, hooks: new Hooks(), onStatus: value => { statuses.push({ state: value.state, detail: value.detail }); },
    ...(fast ? { habitat: { config: { enabled: true, driver: driver.config, evolutionModel: null, debounceMs: 1000 }, driver } }
      : { agent: { qualified: (contact: Parameters<ButlerAgent["qualified"]>[0]) => agent.qualified(contact), classify: (request: Parameters<ButlerAgent["classify"]>[0]) => agent.classify(request), compose: (request: Parameters<ButlerAgent["compose"]>[0]) => agent.compose(request) } }), service: {
    dataDir: root, providers: undefined, runtimeState: async () => ({ settings, bindings: { "contact-1": binding }, grants: {} }), runJournal: () => journal,
    delegatedGrant: async contact => !settings.paused && settings.contacts.some(current => current.enabled && current.id === contact.id && current.revision === contact.revision) ? "grant:fixture" : null,
    onSettingsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onHabitatChanged(listener) { habitatListeners.add(listener); return () => habitatListeners.delete(listener); },
    notePending() {},
  } });
  cleanup.push(async () => { await loop.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  return { loop, journal, sent, statuses, coordinate: conversation.coordinate, stats: () => ({ compositions, classifications }), advance(ms: number) { time += ms; }, replaceAgent(next: ButlerAgent) { agent = next; },
    change(next: Settings) { settings = next; for (const listener of listeners) listener(next); }, settings: () => settings,
    habitatChanged(id: string) { for (const listener of habitatListeners) listener(id); }, habitatListenerCount: () => habitatListeners.size,
    beforeSubmit(callback: () => Promise<void>) { beforeSubmit = callback; },
    failNextEvents(count: number) { failEvents = count; }, eventsCalls: () => eventsCalls,
    push(message: AutomationMessage) { revision++; messages.push(message); events.push({ sequence: revision, enrollmentId: binding.enrollmentId, revision, message }); },
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
test("a habitat change cancels only that contact's pre-dispatch run and releases the listener on close", async () => {
  const f = await fixture(); await f.loop.tick();
  let started!: () => void, signal: AbortSignal | undefined;
  const composing = new Promise<void>(resolve => { started = resolve; });
  f.replaceAgent({ async qualified() { return true; }, async classify() { return { respond: true, confidence: 1, reason: "requested" }; },
    async compose(request) { signal = request.signal; started(); return new Promise((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }); }); } });
  f.add("butler please help"); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await composing;
  f.habitatChanged("other-contact"); expect(signal?.aborted).toBe(false);
  f.habitatChanged("contact-1"); expect(signal?.aborted).toBe(true);
  await f.loop.idle(); expect(f.sent).toHaveLength(0); expect(f.journal.recent("contact-1")[0]?.state).toBe("cancelled");
  await f.loop.close(); expect(f.habitatListenerCount()).toBe(0);
});
test("a habitat change preserves a send that has already entered dispatch", async () => {
  const f = await fixture(true); await f.loop.tick();
  let started!: () => void, finish!: () => void;
  const dispatching = new Promise<void>(resolve => { started = resolve; }), submitted = new Promise<void>(resolve => { finish = resolve; });
  f.beforeSubmit(async () => { started(); await submitted; });
  f.add("butler please help"); await f.loop.tick(); f.advance(1100); await f.loop.tick(); await dispatching;
  expect(f.journal.recent("contact-1")[0]?.state).toBe("dispatching");
  f.habitatChanged("contact-1"); finish(); await f.loop.idle();
  expect(f.sent).toHaveLength(1); expect(f.journal.recent("contact-1")[0]?.state).toBe("submitted");
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
  f.advance(1); f.add("x".repeat(5000)); await f.loop.tick();
  const observed = habitat.snapshot().episodes[0]?.followups.at(-1)!;
  expect(observed.text).toHaveLength(2048); expect(observed.truncated).toBe(true);
  const historyView = boundHabitatObservation({ id: observed.id, at: observed.at, author: observed.author, kind: observed.kind, text: "x".repeat(4096), relatedMessageId: null }, 512);
  expect(historyView.sourceDigest).toBe(observed.sourceDigest); expect(historyView.truncated).toBe(true);
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

test("a tapback between texts never answers or drops the pending reply", async () => {
  const f = await fixture(); await f.loop.tick();
  f.add("butler could you explain?"); await f.loop.tick();
  // A reaction lands mid-debounce: it advances the conversation revision but is
  // not an answer, so the pending inbound must still produce its reply.
  f.push({ id: "reaction:1", coordinate: f.coordinate, direction: "incoming", occurredAt: new Date(Date.parse("2026-09-11T12:00:01.000Z")).toISOString(),
    text: null, kind: "reaction", relatedMessageId: "message:1", attachments: [] });
  f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(1);
  // And a contact message still supersedes the pending one normally.
  f.add("butler first question"); f.push({ id: "reaction:2", coordinate: f.coordinate, direction: "incoming", occurredAt: new Date(Date.parse("2026-09-11T12:00:11.000Z")).toISOString(),
    text: null, kind: "reaction", relatedMessageId: "message:3", attachments: [] });
  f.add("butler the real latest question"); f.advance(9000); await f.loop.tick(); f.advance(9000); await f.loop.tick(); await f.loop.idle();
  expect(f.sent).toHaveLength(2);
  expect(f.journal.recent("contact-1")[0]?.eventId).toBe("message:5");
});

test("a continuous inbound stream resolves within the bounded debounce cap", async () => {
  const f = await fixture(); await f.loop.tick();
  // Every message refreshes the pending event; without a cap the debounce would
  // starve forever. The cap resolves at firstAt + max(2*debounce, 30s).
  for (let index = 0; index < 20; index++) { f.add(`butler still typing ${index}`); f.advance(2_000); await f.loop.tick(); }
  await f.loop.idle();
  // The cap fires 30s after the stream began — message:16 — instead of starving
  // until the flood pauses.
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.[0]).toMatchObject({ kind: "text", text: "🤖{ Hello }" });
  expect(f.journal.recent("contact-1")[0]?.eventId).toBe("message:16");
});

test("polls overlap across enrollments so one slow poll cannot starve the set", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-loop-"))), journal = RunJournal.memory();
  let time = Date.parse("2026-09-11T12:00:00.000Z"), revision = 0;
  const settings: Settings = { schemaVersion: 1, paused: false, maxActiveContacts: 5, contacts: [
    { ...newContact("contact-1", "Slow", "enrollment:a"), enabled: true },
    { ...newContact("contact-2", "Fast", "enrollment:b"), enabled: true },
  ] };
  const identity = { provider: "imessage" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "synthetic-account", implementationIdentity: "2".repeat(64), sourceGeneration: "synthetic-db" };
  const conversation = (id: number) => ({ coordinate: { provider: "imessage" as const, chatGuid: `iMessage;-;c${id}@example.test`, service: "iMessage" as const, observedChatRowId: id }, title: `C${id}`, kind: "single" as const, participants: [`c${id}@example.test`] });
  const enrolled = (id: string, conv: ReturnType<typeof conversation>) => ({ id, identity, conversation: conv, bindingDigest: automationBindingDigest(identity, conv), revision, ready: true, reason: null });
  const enrollmentA = enrolled("enrollment:a", conversation(1)), enrollmentB = enrolled("enrollment:b", conversation(2));
  const bindingA = automationBinding(enrollmentA), bindingB = automationBinding(enrollmentB);
  const events: AutomationEvent[] = [], messages: AutomationMessage[] = [], sent: readonly unknown[][] = [];
  const mutableSent = sent as unknown[][], plans = new Map<string, AutomationPlan>();
  let releaseSlow!: () => void, slowInvocations = 0, fastInvocations = 0;
  const gate = new Promise<void>(resolve => { releaseSlow = resolve; });
  const client = createGhostgetAutomationClient(async (method, params) => {
    const forEnrollment = String(params.enrollmentId ?? "");
    if (method === "poll") {
      if (forEnrollment === "enrollment:a") { slowInvocations++; await gate; return { ...enrollmentA, revision }; }
      fastInvocations++; return { ...enrollmentB, revision };
    }
    if (method === "history") { const enrollment = forEnrollment === "enrollment:a" ? enrollmentA : enrollmentB; return { enrollment: { ...enrollment, revision }, messages: messages.filter(message => automationHash(message.coordinate) === automationHash(enrollment.conversation.coordinate)).slice(-Number(params.limit)) }; }
    if (method === "events") return { events: events.slice(Number(params.cursor ?? 0)), nextCursor: String(events.length), caughtUp: true };
    if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: true, reason: null }])) };
    if (method === "prepare") { const body = { ...params, bindingDigest: bindingB.bindingDigest, expiresAt: new Date(time + 120000).toISOString() }, digest = automationHash(body), plan = { ...body, digest, id: `plan:${digest}` } as AutomationPlan; plans.set(plan.id, plan); return plan; }
    if (method === "submit") { const plan = plans.get(String(params.planId))!; mutableSent.push([...plan.actions]); return { id: `run:${sent.length}`, planId: plan.id, intentId: plan.intentId, enrollmentId: plan.enrollmentId ?? bindingB.enrollmentId, state: "accepted", accepted: plan.actions.map((_action, index) => ({ messageId: `sent:${sent.length}:${index}`, providerReceiptId: null })), totalActions: plan.actions.length, reason: null, retryable: false }; }
    throw new Error(`Unexpected fixture operation ${method}`);
  }, () => time);
  const loop = await createDaemonReplyLoop({ client, automatic: false, now: () => time, hooks: new Hooks(),
    agent: { async qualified() { return true; }, async classify() { return { respond: true, confidence: 0.99, reason: "requested" }; },
      async compose() { return { summary: "Here is help", actions: [{ kind: "text" as const, text: "Hello" }] }; } },
    service: {
      dataDir: root, providers: undefined, runtimeState: async () => ({ settings, bindings: { "contact-1": bindingA, "contact-2": bindingB }, grants: {} }), runJournal: () => journal,
      delegatedGrant: async contact => settings.contacts.some(current => current.enabled && current.id === contact.id && current.revision === contact.revision) ? "grant:fixture" : null,
      onSettingsChanged() { return () => {}; },
      onHabitatChanged() { return () => {}; },
      notePending() {},
    } });
  cleanup.push(async () => { await loop.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  try {
    const first = loop.tick();
    for (let attempt = 0; attempt < 200 && (slowInvocations === 0 || fastInvocations === 0); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    // Both polls were issued before the slow one settled: contact-2 is not queued
    // behind contact-1's provider work inside a tick.
    expect(slowInvocations).toBe(1); expect(fastInvocations).toBe(1);
    releaseSlow(); await first;
    revision++; const inbound: AutomationMessage = { id: "message:1", coordinate: enrollmentB.conversation.coordinate, direction: "incoming", occurredAt: new Date(time).toISOString(), text: "butler ping", kind: "message", relatedMessageId: null, attachments: [] };
    messages.push(inbound); events.push({ sequence: revision, enrollmentId: enrollmentB.id, revision, message: inbound });
    await loop.tick(); time += 9000; await loop.tick(); await loop.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([{ kind: "text", text: "🤖{ Hello }" }]);
  } finally { releaseSlow(); }
});

test("a degraded events drain keeps pending work and only flags attention after repeated failure", async () => {
  const f = await fixture(); await f.loop.tick();
  f.add("butler could you explain?"); await f.loop.tick();
  f.failNextEvents(1); await f.loop.tick();
  expect(f.statuses.at(-1)?.state).toBe("running");
  f.advance(9_000); await f.loop.tick(); await f.loop.idle();
  // The pending inbound survived the failed drain and still produced its reply.
  expect(f.sent).toHaveLength(1);
  // Three consecutive drain failures surface the attention state.
  f.failNextEvents(10); await f.loop.tick(); await f.loop.tick();
  expect(f.statuses.at(-1)?.state).toBe("running");
  await f.loop.tick();
  expect(f.statuses.at(-1)?.state).toBe("unavailable");
  expect(f.statuses.at(-1)?.detail).toContain("Synthetic");
  // Recovery clears it.
  f.failNextEvents(0); await f.loop.tick();
  expect(f.statuses.at(-1)?.state).toBe("running");
});
