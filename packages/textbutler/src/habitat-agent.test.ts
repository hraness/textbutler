import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./journal.ts";
import { ContactWorkspace } from "./workspace.ts";
import { newContact } from "./config.ts";
import { createFastDriver } from "./fast-driver.ts";
import { createHabitatAgent, admitPublicQuery } from "./habitat-agent.ts";
import { ContactHabitat, DEFAULT_HABITAT_PLAN } from "./contact-habitat.ts";
import type { AgentRequest } from "./runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(output: unknown, evolution?: Parameters<typeof createHabitatAgent>[0]["evolution"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-habitat-"))), journal = RunJournal.memory(), workspace = await ContactWorkspace.create(root);
  const contact = { ...newContact("synthetic-contact", "Synthetic", "route"), enabled: true }, now = Date.parse("2026-09-20T12:00:00.000Z");
  await workspace.write("history/recent.json", JSON.stringify({ messages: [{ id: "message", at: now - 1000, author: "contact", text: "butler help" }] }));
  let calls = 0, clock = now;
  const driver = createFastDriver({ kind: "local", model: "synthetic", baseUrl: "http://127.0.0.1:1234/v1" }, { journal, fetch: async (_url, init) => { calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value: typeof output === "function" ? output(String(init?.body)) : output }) } }] }); } });
  const habitat = createHabitatAgent({ journal, driver, getWorkspace: async id => { expect(id).toBe(contact.id); return workspace; }, capabilities: async () => ["text", "attachment"], active: () => true, now: () => clock,
    ...(evolution === undefined ? {} : { evolution }) });
  cleanups.push(async () => { await habitat.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const request: AgentRequest = { runId: "synthetic-run", contact, signal: controller.signal, event: { id: "message", contactId: contact.id, routeId: contact.routeId, revision: "1", occurredAt: now - 1000, observedAt: now - 1000, author: "contact", kind: "message", text: "butler help", historical: false, group: false } };
  return { habitat, journal, request, now, controller, calls: () => calls, advance(ms: number) { clock += ms; } };
}

test("classification and composition share one model call; only an actual receipt creates learning evidence", async () => {
  const f = await fixture({ respond: true, confidence: 0.95, reason: "requested", summary: "Explain briefly", actions: [{ kind: "text", text: "A useful answer" }], tool: null });
  expect((await f.habitat.agent.classify(f.request) as { respond: boolean }).respond).toBe(true);
  const result = await f.habitat.agent.compose(f.request) as { actions: { kind: "text"; text: string }[] };
  expect(f.calls()).toBe(1); expect(new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes).toHaveLength(0);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "BUTLER[A useful answer]" }], messageIds: ["accepted-id"], at: f.now });
  expect(result.actions).toHaveLength(1);
  expect(new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes).toHaveLength(1);
  expect(new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes[0]?.reply.text).toBe("A useful answer");
  f.controller.abort(); await expect(f.habitat.agent.compose(f.request)).rejects.toThrow(); expect(f.calls()).toBe(1);
});

test("initial reflection is retained without promotion and setup failures have a finite retry budget", async () => {
  const candidate = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer one short example." };
  const f = await fixture({}, async () => ({ id: "synthetic-evolver", async execute() { return { candidate, reason: "Wait for feedback", evidenceIds: [] }; } }));
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  state.record({ runId: "recorded", at: f.now, intent: "Explain", trigger: { id: "trigger", at: f.now - 1000, author: "contact", kind: "message", text: "Synthetic request", relatedMessageId: null }, context: [], text: "Answer", messageIds: ["sent"], planDigest: null });
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(state.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
  expect(state.snapshot().episodes[0]?.reflection?.candidate).toEqual(candidate);
  expect(state.snapshot().evaluations[0]?.receipts).toHaveLength(1);
  expect(f.journal.habitatEvidence(f.request.contact.id, state.snapshot().evaluations[0]!.receipts[0]!)).not.toBeNull();
  let attempts = 0;
  const unavailable = await fixture({}, async () => { attempts++; throw Error("Unavailable"); });
  new ContactHabitat(unavailable.journal, unavailable.request.contact.id).record(state.snapshot().episodes[0]!.reply);
  for (let i = 0; i < 8; i++) { unavailable.habitat.schedule(unavailable.request.contact); await unavailable.habitat.idle(); unavailable.advance(2_000_000); }
  expect(attempts).toBe(3);
  unavailable.habitat.settingsChanged(); unavailable.habitat.schedule(unavailable.request.contact); await unavailable.habitat.idle(); expect(attempts).toBe(4);
});

test("background evolution replays both plans, judges blinded variants and retains the full evidence chain", async () => {
  const candidate = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer one short example." };
  let decisions = 0;
  const f = await fixture((body: string) => ({ text: body.includes(candidate.guidance) ? "Better example" : "Long baseline" }), async (_contact, runId) => ({ id: "synthetic-evolver", async execute(request) {
    decisions++;
    if (!runId.startsWith("judge-")) return { candidate, reason: "Examples were requested", evidenceIds: ["feedback-1-0", "feedback-2-0"] };
    const context = request.context as unknown as { inputs: { context: { evidence: { cases: { runId: string; a: string; b: string }[] } } } };
    return { reason: "Both cases prefer the clearer example", evidenceIds: ["feedback-1-0", "feedback-2-0"], scores: context.inputs.context.evidence.cases.map(value => ({ runId: value.runId, scoreA: value.a === "Better example" ? 0.9 : 0.5, scoreB: value.b === "Better example" ? 0.9 : 0.5, safe: true })) };
  } }));
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  for (const n of [1, 2]) {
    const time = f.now - (3 - n) * 60_000;
    state.record({ runId: `case-${n}`, at: time, intent: "Explain clearly", trigger: { id: `trigger-${n}`, at: time - 1000, author: "contact", kind: "message", text: "Explain this", relatedMessageId: null }, context: [], messageIds: [`sent-${n}`], text: "Earlier answer", planDigest: null });
    for (let i = 0; i < 3; i++) state.observe({ id: `feedback-${n}-${i}`, at: time + 1000 + i, author: "contact", kind: "message", text: "Could you give an example?", relatedMessageId: null }, f.now);
    state.finish(state.claim(time + 2000)!, { candidate: null, reason: "Initial", evidenceIds: [], scores: [] });
    if (n === 1) state.finish(state.claim(time + 40_000)!, { candidate: null, reason: "Collect another case", evidenceIds: [], scores: [] });
  }
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(decisions).toBe(2); expect(f.calls()).toBe(4); expect(state.snapshot().champion).toEqual(candidate);
  expect(state.snapshot().evaluations.at(-1)?.receipts).toHaveLength(6);
  expect(state.snapshot().evaluations.at(-1)?.evidenceIds).toEqual(["feedback-1-0", "feedback-2-0"]);
});

test("public search queries refuse identifier shapes, private spans and private proper nouns", async () => {
  const corpus = "Ryaan Ahmed asked whether the release at 410 Main Street is ready; email ryaan@example.com for notes";
  expect(admitPublicQuery("latest apple intelligence release notes", corpus)).toBe(true);
  expect(admitPublicQuery("Ryaan Ahmed github", corpus)).toBe(false);
  expect(admitPublicQuery("ryaan ahmed", corpus)).toBe(false);
  expect(admitPublicQuery("status of 410 Main Street project", corpus)).toBe(false);
  expect(admitPublicQuery("contact ryaan@example.com", corpus)).toBe(false);
  expect(admitPublicQuery("+15551234567 reviews", corpus)).toBe(false);
  expect(admitPublicQuery("log in at https://user:secret@example.com", corpus)).toBe(false);
});

test("a web-search request under the default plan is refused before any provider call", async () => {
  const f = await fixture({ respond: true, confidence: 0.95, reason: "helpful", summary: "Search", actions: [], tool: { kind: "web-search", query: "public news" } });
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow();
  expect(f.calls()).toBe(1);
});

test("low confidence stays silent and unsupported rich actions cannot be proposed as text", async () => {
  const silent = await fixture({ respond: false, confidence: 0.4, reason: "uncertain", summary: "No request", actions: [], tool: null });
  await expect(silent.habitat.agent.compose(silent.request)).rejects.toThrow(); expect(silent.calls()).toBe(1);
  const rich = await fixture({ respond: true, confidence: 1, reason: "requested", summary: "React", actions: [{ kind: "poll", question: "When?", options: ["Today", "Tomorrow"], maximumSelections: null }], tool: null });
  await expect(rich.habitat.agent.compose(rich.request)).rejects.toThrow(); expect(rich.calls()).toBe(1);
});
