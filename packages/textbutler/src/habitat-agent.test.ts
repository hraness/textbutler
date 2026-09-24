import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./journal.ts";
import { ContactWorkspace } from "./workspace.ts";
import { newContact } from "./config.ts";
import { createFastDriver } from "./fast-driver.ts";
import { createHabitatAgent, admitPublicQuery } from "./habitat-agent.ts";
import { ContactHabitat, DEFAULT_HABITAT_PLAN, habitatDigest, type HabitatMemory } from "./contact-habitat.ts";
import type { AgentRequest } from "./runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const replyOutput = { respond: true, confidence: 0.95, reason: "requested", summary: "Explain briefly", actions: [{ kind: "text", text: "A useful answer" }], tool: null };
const driverEvidence = (body: string): { history: { id: string }[]; results: { file?: string; [key: string]: unknown }[]; tools: string[]; memory: HabitatMemory[]; memoryOmitted: number } => JSON.parse(JSON.parse(body).messages[1].content).context.inputs.context.evidence;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(output: unknown, evolution?: Parameters<typeof createHabitatAgent>[0]["evolution"], overrides: Partial<Pick<Parameters<typeof createHabitatAgent>[0], "memes" | "getWorkspace">> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-habitat-"))), journal = RunJournal.memory(), workspace = await ContactWorkspace.create(root);
  const contact = { ...newContact("synthetic-contact", "Synthetic", "route"), enabled: true }, now = Date.parse("2026-09-20T12:00:00.000Z");
  await workspace.write("history/recent.json", JSON.stringify({ messages: [{ id: "message", at: now - 1000, author: "contact", text: "butler help" }] }));
  let calls = 0, clock = now;
  const driver = createFastDriver({ kind: "local", model: "synthetic", baseUrl: "http://127.0.0.1:1234/v1" }, { journal, fetch: async (_url, init) => { calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value: typeof output === "function" ? await output(String(init?.body), calls) : output }) } }] }); } });
  const habitat = createHabitatAgent({ journal, driver, getWorkspace: async id => { expect(id).toBe(contact.id); return workspace; }, capabilities: async () => ["text", "attachment"], active: () => true, now: () => clock,
    ...(evolution === undefined ? {} : { evolution }), ...overrides });
  cleanups.push(async () => { await habitat.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const request: AgentRequest = { runId: "synthetic-run", contact, signal: controller.signal, event: { id: "message", contactId: contact.id, routeId: contact.routeId, revision: "1", occurredAt: now - 1000, observedAt: now - 1000, author: "contact", kind: "message", text: "butler help", historical: false, group: false } };
  return { habitat, journal, workspace, driver, request, now, controller, calls: () => calls, advance(ms: number) { clock += ms; } };
}
function seedMemory(f: Awaited<ReturnType<typeof fixture>>, texts: string[], longIds = false) {
  const sources = texts.map((text, index) => ({ id: longIds ? `memory-${index}`.padEnd(256, "m") : `memory-${index}`, at: f.now - 100_000 + index, author: "contact" as const, kind: "message" as const, text, relatedMessageId: null }));
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  state.record({ runId: "memory-seed", at: f.now - 90_000, intent: "Seed observed preferences", trigger: sources[0]!, context: sources.slice(1), text: "Earlier answer", messageIds: ["seed-sent"], planDigest: null });
  state.finish(state.claim(f.now - 90_000)!, { candidate: null, reason: "Retain observed sources", evidenceIds: [], scores: [], remember: sources.map(source => source.id) });
  return state;
}

test("JavaScript is owner-granted, executes pure calculations and records only a code digest label", async () => {
  const denied = await fixture((body: string) => {
    expect(driverEvidence(body).tools).not.toContain("javascript");
    return { ...replyOutput, actions: [], tool: { kind: "javascript", code: "return 42;" } };
  });
  await expect(denied.habitat.agent.compose(denied.request)).rejects.toThrow("not available");
  expect(denied.calls()).toBe(1);
  const code = "return input.values.reduce((sum,value) => sum + value, 0);";
  const f = await fixture((body: string, call: number) => {
    const evidence = driverEvidence(body);
    expect(evidence.tools).toContain("javascript");
    if (call === 1) return { ...replyOutput, actions: [], tool: { kind: "javascript", code, input: { values: [2, 5, 8] } } };
    expect(evidence.results[0]).toEqual({ tool: "javascript", result: { ok: true, value: 15 } });
    return replyOutput;
  });
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  state.configure(0, { ...DEFAULT_HABITAT_PLAN, javascript: true });
  await f.habitat.agent.compose(f.request); expect(f.calls()).toBe(2); expect(state.snapshot().episodes).toEqual([]);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  expect(state.snapshot().episodes[0]?.reply.tools).toEqual([{ kind: "javascript", query: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    result: JSON.stringify({ tool: "javascript", result: { ok: true, value: 15 } }) }]);
});

test("JavaScript failures remain bounded observations and the normal two-tool budget applies", async () => {
  const limited = await fixture((body: string, call: number) => {
    if (call === 1) return { ...replyOutput, actions: [], tool: { kind: "javascript", code: "while(true){}" } };
    expect(driverEvidence(body).results[0]).toEqual({ tool: "javascript", result: { ok: false, error: "resource-limit" } });
    return replyOutput;
  });
  new ContactHabitat(limited.journal, limited.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, javascript: true });
  await expect(limited.habitat.agent.compose(limited.request)).resolves.toMatchObject({ actions: replyOutput.actions });
  const exhausted = await fixture({ ...replyOutput, actions: [], tool: { kind: "javascript", code: "return 1;" } });
  new ContactHabitat(exhausted.journal, exhausted.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, javascript: true });
  await expect(exhausted.habitat.agent.compose(exhausted.request)).rejects.toThrow("tool budget"); expect(exhausted.calls()).toBe(3);
});

test("memory-search reads only the contact archive and retains retrieved source provenance after submission", async () => {
  const f = await fixture((body: string, call: number) => {
    const evidence = driverEvidence(body);
    expect(evidence.tools).toContain("memory-search");
    if (call === 1) return { ...replyOutput, actions: [], tool: { kind: "memory-search", query: "violet picnic" } };
    expect(evidence.results[0]).toMatchObject({ tool: "memory-search", matches: [{ id: "archive-0", category: "shared-reference", sourceDigest: "a".repeat(64), text: "Remember the violet picnic" }] });
    return replyOutput;
  });
  const habitat = new ContactHabitat(f.journal, f.request.contact.id), initial = habitat.snapshot();
  const memory = Array.from({ length: 12 }, (_, index) => ({ id: `archive-${index}`, at: f.now - 10_000 + index, author: "contact" as const,
    text: index === 0 ? "Remember the violet picnic" : `Ordinary archived context ${index}`, category: "shared-reference" as const, sourceDigest: "a".repeat(64), truncated: false }));
  f.journal.writeHabitatState(f.request.contact.id, 0, JSON.stringify({ ...initial, revision: 1, memory }));
  const before = habitat.snapshot();
  await f.habitat.agent.compose(f.request);
  expect(habitat.snapshot()).toEqual(before);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  const recorded = habitat.snapshot().episodes[0]!.reply;
  expect(recorded.tools?.[0]?.kind).toBe("memory-search");
  expect([...(recorded.memory ?? []), ...(recorded.priorMemory ?? [])]).toContainEqual(expect.objectContaining({ id: "archive-0", sourceDigest: "a".repeat(64) }));
  expect(habitat.snapshot().memory).toEqual(memory);
  const denied = await fixture({ ...replyOutput, actions: [], tool: { kind: "memory-search", query: "violet picnic" } });
  new ContactHabitat(denied.journal, denied.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, memorySearch: false });
  await expect(denied.habitat.agent.compose(denied.request)).rejects.toThrow("not available");
});

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
  const candidate = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer one short example.", contextMessages: 4, personality: { tone: "warm" as const, formality: "casual" as const } };
  const replaySizes: number[] = [];
  let decisions = 0;
  const f = await fixture((body: string) => { const evidence = driverEvidence(body); replaySizes.push(evidence.history.length); expect(evidence.tools).toEqual([]); expect(evidence.memory).toHaveLength(1); expect(evidence.memory[0]?.id).toMatch(/^prior-memory-[12]$/u); return { text: body.includes(candidate.guidance) ? "Better example" : "Long baseline" }; }, async (_contact, runId) => ({ id: "synthetic-evolver", async execute(request) {
    decisions++;
    if (!runId.startsWith("judge-")) {
      const context = request.context as unknown as { inputs: { context: { evidence: { memory: HabitatMemory[] } } } };
      expect(context.inputs.context.evidence.memory.map(entry => entry.id)).toEqual(["trigger-2"]);
      return { candidate, reason: "Examples were requested", evidenceIds: ["feedback-1-0", "feedback-2-0"], memoryUpdate: { remember: [{ id: "trigger-2", category: "shared-reference" }], forget: [] } };
    }
    expect(request.prompt).toContain("neither text-only replay executes tools");
    const context = request.context as unknown as { inputs: { context: { evidence: { cases: { runId: string; a: string; b: string; memory: HabitatMemory[]; observedReply: { tools: unknown[]; actionKinds: string[] } }[]; output: string } } } };
    expect(context.inputs.context.evidence.output).toContain("not tools executed by either replay");
    for (const value of context.inputs.context.evidence.cases) { expect(value.observedReply.tools).toHaveLength(1); expect(value.observedReply.actionKinds).toEqual(["text", "attachment"]); expect(value.memory[0]?.id).toMatch(/^prior-memory-[12]$/u); }
    return { reason: "Both cases prefer the clearer example", evidenceIds: ["feedback-1-0", "feedback-2-0"], scores: context.inputs.context.evidence.cases.map(value => ({ runId: value.runId, scoreA: value.a === "Better example" ? 0.9 : 0.5, scoreB: value.b === "Better example" ? 0.9 : 0.5, safe: true })) };
  } }), { memes: { async search() { throw Error("Offline replay must not search"); }, async image() { throw Error("Offline replay must not fetch images"); } } });
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  for (const n of [1, 2]) {
    const time = f.now - (3 - n) * 60_000;
    state.record({ runId: `case-${n}`, at: time, intent: "Explain clearly", trigger: { id: `trigger-${n}`, at: time - 1000, author: "contact", kind: "message", text: "Explain this", relatedMessageId: null },
      context: Array.from({ length: 8 }, (_, index) => ({ id: `context-${n}-${index}`, at: time - 9000 + index * 1000, author: "contact" as const, kind: "message" as const, text: "Prior context", relatedMessageId: null })),
      messageIds: [`sent-${n}`], text: "Earlier answer", planDigest: null, tools: [{ kind: "meme-search", query: "shrug", result: "One public template" }], actionKinds: ["text", "attachment"],
      memory: [{ id: `prior-memory-${n}`, at: time - 30_000, author: "owner", text: `Earlier remembered statement ${n}`, sourceDigest: habitatDigest({ case: n }), truncated: false }] });
    for (let i = 0; i < 3; i++) state.observe({ id: `feedback-${n}-${i}`, at: time + 1000 + i, author: "contact", kind: "message", text: "Could you give an example?", relatedMessageId: null }, f.now);
    state.finish(state.claim(time + 2000)!, { candidate: null, reason: "Initial", evidenceIds: [], scores: [], remember: [`trigger-${n}`] });
    if (n === 1) state.finish(state.claim(time + 40_000)!, { candidate: null, reason: "Collect another case", evidenceIds: [], scores: [] });
  }
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(decisions).toBe(2); expect(f.calls()).toBe(4); expect(state.snapshot().champion).toEqual(candidate);
  expect(replaySizes).toEqual([8, 4, 8, 4]);
  expect(state.snapshot().memory?.map(value => [value.id, value.category])).toContainEqual(["trigger-2", "shared-reference"]);
  expect(state.snapshot().evaluations.at(-1)?.memoryChanged).toBe(true);
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

for (const escaped of [false, true]) test(`long ${escaped ? "escape-heavy" : "ordinary"} tool observations fit the judge budget without changing stored evidence`, async () => {
  const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "g".repeat(4096), contextMessages: 32, maxReplyCharacters: 1600 };
  const candidate = { ...plan, personality: { tone: "warm" as const, formality: "casual" as const } };
  let judgeCalls = 0, contextBytes = 0;
  const evidenceId = (caseNumber: number, index: number) => `feedback-${caseNumber}-${index}-`.padEnd(64, "f");
  const f = await fixture({ text: "r".repeat(1600) }, async (_contact, runId) => ({ id: "bounded-evolver", async execute(request) {
    if (!runId.startsWith("judge-")) return { candidate, reason: "Review observed feedback", evidenceIds: [evidenceId(2, 0)] };
    judgeCalls++;
    const context = request.context as unknown as { inputs: { context: { preferences: unknown; evidence: { output: string; cases: {
      runId: string; observedReply: { text: string; textTruncated: boolean; tools: { result: string; resultTruncated: boolean }[] };
    }[] } } } };
    const value = context.inputs.context;
    contextBytes = Buffer.byteLength(JSON.stringify(value)); expect(contextBytes).toBeLessThanOrEqual(98_304);
    expect(value.evidence.output).toContain("do not infer what was omitted");
    const full = structuredClone(value), episodes = new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes;
    for (const item of value.evidence.cases) {
      expect(Buffer.byteLength(item.observedReply.text)).toBe(512); expect(item.observedReply.textTruncated).toBe(true);
      for (const tool of item.observedReply.tools) {
        expect(Buffer.byteLength(tool.result)).toBeLessThanOrEqual(1024);
        expect(Buffer.byteLength(JSON.stringify(tool.result))).toBeLessThanOrEqual(1026);
        expect(tool.resultTruncated).toBe(true);
      }
    }
    for (const item of full.evidence.cases) {
      const reply = episodes.find(episode => episode.reply.runId === item.runId)!.reply;
      item.observedReply.text = reply.text;
      item.observedReply.tools = reply.tools!.map(tool => ({ ...tool, resultTruncated: false }));
    }
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(98_304);
    return { reason: "Both cases improved", evidenceIds: [evidenceId(1, 0), evidenceId(2, 0)],
      scores: value.evidence.cases.map(item => ({ runId: item.runId, scoreA: 0.8, scoreB: 0.8, safe: true })) };
  } }));
  const state = new ContactHabitat(f.journal, f.request.contact.id); state.configure(0, plan);
  for (const n of [1, 2]) {
    const time = f.now - (3 - n) * 60_000;
    state.record({ runId: `large-case-${n}`, at: time, intent: "i".repeat(1024), trigger: { id: `trigger-${n}`.padEnd(64, "t"), at: time - 1000, author: "contact", kind: "message", text: "t".repeat(2048), relatedMessageId: null },
      context: Array.from({ length: 32 }, (_, index) => ({ id: `context-${n}-${index}`.padEnd(64, "c"), at: time - 33_000 + index * 1000, author: "contact" as const, kind: "message" as const, text: "c".repeat(512), relatedMessageId: null })),
      messageIds: [`sent-${n}`], text: "o".repeat(1600), planDigest: null,
      tools: ["meme-search", "meme-image"].map(kind => ({ kind: kind as "meme-search" | "meme-image", query: "q".repeat(256), result: (escaped ? "\u0001" : "x").repeat(4096) })), actionKinds: ["text", "attachment"] });
    for (let index = 0; index < 5; index++) state.observe({ id: evidenceId(n, index), at: time + 1000 + index, author: "contact", kind: "message", text: "f".repeat(2048), relatedMessageId: null }, f.now);
    state.finish(state.claim(time + 2000)!, { candidate: null, reason: "Initial", evidenceIds: [], scores: [] });
    if (n === 1) state.finish(state.claim(time + 3000)!, { candidate: null, reason: "Collect another case", evidenceIds: [], scores: [] });
  }
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(judgeCalls).toBe(1); expect(contextBytes).toBeGreaterThan(0); expect(f.calls()).toBe(4);
  for (const episode of state.snapshot().episodes) {
    expect(Buffer.byteLength(episode.reply.text)).toBe(1600);
    expect(episode.reply.tools?.every(tool => Buffer.byteLength(tool.result) === 4096)).toBe(true);
  }
});

test("a web-search request under the default plan is refused before any provider call", async () => {
  const f = await fixture({ respond: true, confidence: 0.95, reason: "helpful", summary: "Search", actions: [], tool: { kind: "web-search", query: "public news" } });
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow();
  expect(f.calls()).toBe(1);
});

test("evolution backoff resets its attempt cycle once firstAt ages past six hours", async () => {
  let attempts = 0;
  const f = await fixture({}, async () => { attempts++; throw Error("Unavailable"); });
  new ContactHabitat(f.journal, f.request.contact.id).record({ runId: "recorded", at: f.now, intent: "Explain", trigger: { id: "trigger", at: f.now - 1000, author: "contact", kind: "message", text: "Synthetic request", relatedMessageId: null }, context: [], text: "Answer", messageIds: ["sent"], planDigest: null });
  for (let i = 0; i < 11; i++) { f.habitat.schedule(f.request.contact); await f.habitat.idle(); f.advance(2_000_000); }
  expect(attempts).toBe(3);
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(attempts).toBe(4);
  f.advance(30_000); f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(attempts).toBe(4);
});

test("recorded episode context follows the champion plan's context window", async () => {
  const f = await fixture({ respond: true, confidence: 0.95, reason: "requested", summary: "Explain briefly", actions: [{ kind: "text", text: "A useful answer" }], tool: null });
  await f.workspace.write("history/recent.json", JSON.stringify({ messages: Array.from({ length: 25 }, (_, index) => ({ id: `history-${index}`, at: f.now - 25_000 + index * 1000, author: index % 2 ? "owner" : "contact", text: `message ${index}` })) }));
  f.journal.writeHabitatState(f.request.contact.id, 0, JSON.stringify({ version: 1, revision: 1, champion: { ...DEFAULT_HABITAT_PLAN, contextMessages: 20 }, episodes: [], evaluations: [], lineage: [], ancestors: [], denied: [] }));
  await f.habitat.agent.compose(f.request);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  const episode = new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes[0];
  expect(episode?.reply.context).toHaveLength(20);
  expect(episode?.reply.context[0]?.id).toBe("history-5");
});

test("low-confidence outputs carrying actions or tools are clamped to silence", async () => {
  const sloppy = await fixture({ respond: true, confidence: 0.8, reason: "helpful", summary: "Tentative", actions: [{ kind: "text", text: "Sloppy" }], tool: null });
  expect((await sloppy.habitat.agent.classify(sloppy.request) as { respond: boolean }).respond).toBe(false);
  await expect(sloppy.habitat.agent.compose(sloppy.request)).rejects.toThrow();
  expect(sloppy.calls()).toBe(1);
  const tooled = await fixture({ respond: false, confidence: 0.95, reason: "not_needed", summary: "Nothing needed", actions: [], tool: { kind: "meme-search", query: "shrug" } });
  expect((await tooled.habitat.agent.classify(tooled.request) as { respond: boolean }).respond).toBe(false);
  await expect(tooled.habitat.agent.compose(tooled.request)).rejects.toThrow();
  expect(tooled.calls()).toBe(1);
});

test("low confidence stays silent and unsupported rich actions cannot be proposed as text", async () => {
  const silent = await fixture({ respond: false, confidence: 0.4, reason: "uncertain", summary: "No request", actions: [], tool: null });
  await expect(silent.habitat.agent.compose(silent.request)).rejects.toThrow(); expect(silent.calls()).toBe(1);
  const rich = await fixture({ respond: true, confidence: 1, reason: "requested", summary: "React", actions: [{ kind: "poll", question: "When?", options: ["Today", "Tomorrow"], maximumSelections: null }], tool: null });
  await expect(rich.habitat.agent.compose(rich.request)).rejects.toThrow(); expect(rich.calls()).toBe(1);
});

test("submitted episodes retain bounded completed tool outcomes and actual action kinds", async () => {
  let searches = 0, images = 0;
  const f = await fixture((body: string, call: number) => call < 3
    ? { ...replyOutput, actions: [], tool: { kind: call === 1 ? "meme-search" : "meme-image", query: call === 1 ? "shrug" : "1" } }
    : { ...replyOutput, actions: [{ kind: "attachment", file: driverEvidence(body).results.at(-1)!.file, name: "meme.png", mimeType: "image/png" }] }, undefined,
  { memes: {
    async search() { searches++; return [{ id: "1", name: "🎭".repeat(1500), url: "https://i.imgflip.com/1.png", source: "Synthetic catalog" }]; },
    async image() { images++; return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), extension: "png", mimeType: "image/png", source: "https://i.imgflip.com/1.png" }; },
  } });
  const result = await f.habitat.agent.compose(f.request) as { actions: [{ kind: "attachment"; file: string; name: string; mimeType: string }] };
  expect(searches).toBe(1); expect(images).toBe(1); expect(f.calls()).toBe(3);
  expect(f.journal.habitatState(f.request.contact.id)).toBeNull();
  f.habitat.submitted({ ...f.request, actions: result.actions, messageIds: ["accepted-image"], at: f.now });
  const episode = new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes[0]!;
  expect(episode.reply.actionKinds).toEqual(["attachment"]);
  expect(episode.reply.tools?.map(value => [value.kind, value.query])).toEqual([["meme-search", "shrug"], ["meme-image", "1"]]);
  expect(episode.reply.tools?.every(value => Buffer.byteLength(value.result) <= 4096)).toBe(true);
  expect(episode.reply.tools?.[1]?.result).toContain(result.actions[0].file);
});

test("tool outcomes never become learning episodes after silence, failure, or an over-bound query", async () => {
  for (const outcome of ["silent", "invalid", "query"] as const) {
    let searches = 0;
    const f = await fixture((_body: string, call: number) => call === 1
      ? { ...replyOutput, actions: [], tool: { kind: "meme-search", query: outcome === "query" ? "🎭".repeat(65) : "shrug" } }
      : outcome === "silent" ? { ...replyOutput, respond: false, actions: [] } : {}, undefined,
    { memes: { async search() { searches++; return []; }, async image() { throw Error("Unexpected image"); } } });
    await expect(f.habitat.agent.compose(f.request)).rejects.toThrow();
    f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "Not submitted" }], messageIds: ["invalid"], at: f.now });
    expect(f.journal.habitatState(f.request.contact.id)).toBeNull();
    expect(searches).toBe(outcome === "query" ? 0 : 1);
  }
});

test("contact invalidation rejects cached replies and preserves another contact's cache", async () => {
  let workspace!: ContactWorkspace;
  const f = await fixture(replyOutput, undefined, { getWorkspace: async () => workspace }); workspace = f.workspace;
  const other = { ...f.request, runId: "other-run", contact: { ...f.request.contact, id: "other-contact" }, event: { ...f.request.event, contactId: "other-contact" } };
  await f.habitat.agent.classify(f.request); await f.habitat.agent.classify(other);
  f.habitat.invalidateContact(f.request.contact.id);
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow();
  expect(await f.habitat.agent.compose(other)).toEqual({ summary: replyOutput.summary, actions: replyOutput.actions });
  expect(f.calls()).toBe(2);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "Old reply" }], messageIds: ["old"], at: f.now });
  expect(f.journal.habitatState(f.request.contact.id)).toBeNull();
  await expect(f.habitat.agent.compose({ ...f.request, runId: "fresh-run" })).resolves.toBeDefined();
  expect(f.calls()).toBe(3);
});

test("invalidation while loading contact guidance rejects before inference", async () => {
  const f = await fixture(replyOutput), entered = deferred(), release = deferred(), read = f.workspace.read.bind(f.workspace);
  f.workspace.read = async path => { if (path === "AGENTS.md") { entered.resolve(); await release.promise; } return read(path); };
  const pending = f.habitat.agent.compose(f.request);
  await entered.promise; f.habitat.invalidateContact(f.request.contact.id); release.resolve();
  await expect(pending).rejects.toThrow(); expect(f.calls()).toBe(0);
});

test("invalidation rejects an in-flight model even when the provider ignores cancellation", async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return replyOutput; });
  const pending = f.habitat.agent.compose(f.request);
  await entered.promise; f.habitat.invalidateContact(f.request.contact.id); release.resolve();
  await expect(pending).rejects.toThrow();
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow(); expect(f.calls()).toBe(1);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "Old reply" }], messageIds: ["old"], at: f.now });
  expect(f.journal.habitatState(f.request.contact.id)).toBeNull();
});

test("contact invalidation cancels only its own in-flight evolution", async () => {
  const entered = deferred(), release = deferred(); let evolutionSignal: AbortSignal | undefined;
  const candidate = { ...DEFAULT_HABITAT_PLAN, personality: { tone: "warm" as const, formality: "casual" as const } };
  const f = await fixture({}, async () => ({ id: "waiting-evolver", async execute(_request, signal) { evolutionSignal = signal; entered.resolve(); await release.promise; return { candidate, reason: "Candidate", evidenceIds: [] }; } }));
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  state.record({ runId: "recorded", at: f.now, intent: "Explain", trigger: { id: "trigger", at: f.now - 1000, author: "contact", kind: "message", text: "Synthetic request", relatedMessageId: null }, context: [], text: "Answer", messageIds: ["sent"], planDigest: null });
  f.habitat.schedule(f.request.contact); await entered.promise;
  f.habitat.invalidateContact("other-contact"); expect(evolutionSignal?.aborted).toBe(false);
  f.habitat.invalidateContact(f.request.contact.id); expect(evolutionSignal?.aborted).toBe(true);
  release.resolve(); await f.habitat.idle();
  expect(state.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
  expect(state.snapshot().evaluations.at(-1)?.status).toBe("retained");
});

test("tool inventory and dispatch both reject web search on a local driver", async () => {
  let searches = 0;
  const f = await fixture((body: string) => {
    expect(driverEvidence(body).tools).not.toContain("web-search");
    expect(driverEvidence(body).tools).not.toContain("meme-image");
    return { ...replyOutput, actions: [], tool: { kind: "web-search", query: "public news" } };
  });
  new ContactHabitat(f.journal, f.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, webSearch: true });
  f.driver.search = async () => { searches++; return {}; };
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow("Tool is not available");
  expect(searches).toBe(0);
});

test("gateway search rejects private names and phrases found only in owner plan guidance", async () => {
  for (const query of ["Ryaan github", "ryaan github", "RYAAN github", "confidential project updates"]) {
    let searches = 0;
    const f = await fixture({ ...replyOutput, actions: [], tool: { kind: "web-search", query } });
    new ContactHabitat(f.journal, f.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, guidance: "Ryaan coordinates our confidential project", webSearch: true });
    f.driver.config = { kind: "gateway", model: "alibaba/qwen3.5-flash", credentialFile: "synthetic", dailyBudgetUsd: 1 };
    f.driver.search = async () => { searches++; return {}; };
    await expect(f.habitat.agent.compose(f.request)).rejects.toThrow("Public search query is not admitted");
    expect(searches).toBe(0);
  }
});

test("one web search exhausts the reply's search inventory and dispatch budget", async () => {
  let searches = 0;
  const f = await fixture((body: string, call: number) => {
    expect(driverEvidence(body).tools.includes("web-search")).toBe(call === 1);
    return { ...replyOutput, actions: [], tool: { kind: "web-search", query: "public news" } };
  });
  new ContactHabitat(f.journal, f.request.contact.id).configure(0, { ...DEFAULT_HABITAT_PLAN, webSearch: true });
  f.driver.config = { kind: "gateway", model: "alibaba/qwen3.5-flash", credentialFile: "synthetic", dailyBudgetUsd: 1 };
  f.driver.search = async () => { searches++; return { excerpt: "Synthetic public result" }; };
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow("Tool is not available");
  expect(f.calls()).toBe(2); expect(searches).toBe(1);
});

test("meme image availability requires an admitted search result and attachment support", async () => {
  let images = 0;
  const f = await fixture((body: string, call: number) => {
    expect(driverEvidence(body).tools).not.toContain("meme-image");
    return { ...replyOutput, actions: [], tool: { kind: call === 1 ? "meme-search" : "meme-image", query: call === 1 ? "shrug" : "1" } };
  }, undefined, { memes: {
    async search() { return [{ id: "1", name: "Shrug", url: "https://i.imgflip.com/1.png", source: "Synthetic catalog" }]; },
    async image() { images++; throw Error("Image should be unavailable"); },
  } });
  await expect(f.habitat.agent.compose({ ...f.request, capabilities: ["text"] })).rejects.toThrow("Tool is not available");
  expect(images).toBe(0);
});

test("learning records all eight accepted actions including the trusted disclosure companion", async () => {
  const actions = Array.from({ length: 7 }, () => ({ kind: "link" as const, url: "https://example.com" }));
  const f = await fixture({ ...replyOutput, actions });
  await f.habitat.agent.compose({ ...f.request, capabilities: ["text", "link"] });
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "BUTLER[Links]" }, ...actions], messageIds: Array.from({ length: 8 }, (_, index) => `accepted-${index}`), at: f.now });
  expect(new ContactHabitat(f.journal, f.request.contact.id).snapshot().episodes[0]?.reply.actionKinds).toEqual(["text", ...Array(7).fill("link")]);
});

test("memory fits every tool step and records the final view plus compact prior exposure", async () => {
  const shown: HabitatMemory[][] = [], omissions: number[] = [];
  const f = await fixture((body: string, call: number) => {
    const context = JSON.parse(JSON.parse(body).messages[1].content).context.inputs.context;
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(32_768);
    const evidence = driverEvidence(body); shown.push(structuredClone(evidence.memory)); omissions.push(evidence.memoryOmitted);
    return call === 1 ? { ...replyOutput, actions: [], tool: { kind: "meme-search", query: "shrug" } } : replyOutput;
  }, undefined, { memes: { async search() { return [{ id: "1", name: "r".repeat(2500), url: "https://i.imgflip.com/1.png", source: "Synthetic" }]; }, async image() { throw Error("No image expected"); } } });
  const state = seedMemory(f, Array(8).fill("\u0001".repeat(512)), true);
  state.configure(state.snapshot().revision, { ...DEFAULT_HABITAT_PLAN, contextMessages: 32, guidance: "g".repeat(1024) });
  for (const path of ["ABOUT.md", "MEMORY.md", "STYLE.md"]) await f.workspace.write(path, "g".repeat(2048));
  await f.workspace.write("history/recent.json", JSON.stringify({ messages: Array.from({ length: 24 }, (_, index) => ({ id: `history-${index}`.padEnd(64, "h"), at: f.now - 30_000 + index * 1000, author: "contact", text: "h".repeat(512) })) }));
  await f.habitat.agent.compose(f.request);
  expect(shown).toHaveLength(2); expect(shown[0]!.length).toBeGreaterThan(shown[1]!.length); expect(omissions[1]).toBeGreaterThan(omissions[0]!);
  expect(shown[0]!.every(entry => entry.truncated)).toBe(true);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  const episode = state.snapshot().episodes.at(-1)!;
  expect(episode.reply.memory).toEqual(shown[1]);
  expect(episode.reply.priorMemory).toEqual(shown[0]!.filter(entry => !shown[1]!.some(final => final.id === entry.id)).map(({ id, sourceDigest }) => ({ id, sourceDigest })));
  expect(state.snapshot().memory?.every(entry => entry.text.length === 512 && !entry.truncated)).toBe(true);
  expect(f.calls()).toBe(2);
});

test("remembered private names cannot escape through gateway search", async () => {
  let searches = 0;
  const f = await fixture({ ...replyOutput, actions: [], tool: { kind: "web-search", query: "ryaan github" } });
  const state = seedMemory(f, ["Ryaan prefers tea"]); state.configure(state.snapshot().revision, { ...DEFAULT_HABITAT_PLAN, webSearch: true });
  f.driver.config = { kind: "gateway", model: "alibaba/qwen3.5-flash", credentialFile: "synthetic", dailyBudgetUsd: 1 };
  f.driver.search = async () => { searches++; return {}; };
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow("Public search query is not admitted"); expect(searches).toBe(0);
});

test("owner-authored soul details are included in public-search privacy checks", async () => {
  const f = await fixture({ ...replyOutput, actions: [], tool: { kind: "web-search", query: "Zelphora recipe" } });
  const state = new ContactHabitat(f.journal, f.request.contact.id);
  state.configure(0, { ...DEFAULT_HABITAT_PLAN, webSearch: true, soulCore: { voice: "Zelphora is the private project name", relationshipContext: "", sharedContext: "", boundaries: "" } });
  f.driver.config = { kind: "gateway", model: "alibaba/qwen3.5-flash", credentialFile: "synthetic", dailyBudgetUsd: 1 };
  f.driver.search = async () => { throw Error("Private query must not escape"); };
  await expect(f.habitat.agent.compose(f.request)).rejects.toThrow("Public search query is not admitted");
});

test("reflection learns a long trigger also shown in clipped history without another model call", async () => {
  let reflections = 0;
  const f = await fixture(replyOutput, async () => ({ id: "source-picker", async execute() { reflections++; return { candidate: null, reason: "Remember the explicit preference", evidenceIds: [], memoryUpdate: { remember: [{ id: "message", category: "preference" }], forget: [] } }; } }));
  const request = { ...f.request, event: { ...f.request.event, text: "p".repeat(900) } };
  await f.workspace.write("history/recent.json", JSON.stringify({ messages: [{ id: request.event.id, at: request.event.occurredAt, author: "contact", text: request.event.text }] }));
  await f.habitat.agent.compose(request);
  f.habitat.submitted({ ...request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  f.habitat.schedule(request.contact); await f.habitat.idle();
  const state = new ContactHabitat(f.journal, request.contact.id).snapshot();
  expect(state.episodes[0]?.reply.context[0]?.truncated).toBe(true);
  expect(state.memory?.[0]).toMatchObject({ id: "message", text: "p".repeat(900), truncated: false, category: "preference" });
  expect(state.memory?.[0]?.sourceDigest).toBe(habitatDigest({ id: request.event.id, at: request.event.occurredAt, author: "contact", kind: "message", text: request.event.text, relatedMessageId: null }));
  expect(f.calls()).toBe(1); expect(reflections).toBe(1);
});

test("reflection memory deltas preserve older contact notes when learning a new relationship preference", async () => {
  const f = await fixture(replyOutput, async () => ({ id: "source-picker", async execute() { return { candidate: null, reason: "Add the new preference while preserving prior context", evidenceIds: [],
    memoryUpdate: { remember: [{ id: "message", category: "shared-reference" }], forget: [] } }; } }));
  const habitat = seedMemory(f, ["They prefer concise answers"], false);
  await f.habitat.agent.compose(f.request);
  f.habitat.submitted({ ...f.request, actions: [{ kind: "text", text: "A useful answer" }], messageIds: ["accepted"], at: f.now });
  expect(habitat.needsEvaluation(f.now)).toBe(true);
  f.habitat.schedule(f.request.contact); await f.habitat.idle();
  expect(habitat.snapshot().evaluations.at(-1)?.memoryChanged).toBe(true);
  expect(habitat.snapshot().memory?.map(value => [value.id, value.text, value.category])).toEqual([
    ["memory-0", "They prefer concise answers", undefined], ["message", "butler help", "shared-reference"],
  ]);
});
