import { expect, test } from "bun:test";
import { RunJournal } from "./journal.ts";
import { ContactHabitat, DEFAULT_HABITAT_PLAN, HABITAT_LIMITS, habitatDigest, parseHabitatPlan, type HabitatMemory, type HabitatObservation, type HabitatPlan, type HabitatReply } from "./contact-habitat.ts";

const at = Date.parse("2026-09-20T12:00:00.000Z");
const message = (id: string, time = at, author: HabitatObservation["author"] = "contact"): HabitatObservation => ({ id, at: time, author, kind: "message", text: "A synthetic question", relatedMessageId: null });
const reply = (id = "run-1", time = at): HabitatReply => ({ runId: id, at: time, intent: "Explain the answer briefly", trigger: message(`trigger-${id}`, time - 1000), context: [], messageIds: [`sent-${id}`], text: "A synthetic answer", planDigest: null });
const improved = (runIds: [string, string], evidenceIds: string[], candidate: HabitatPlan | null) => ({ candidate, reason: "Both examples improved", evidenceIds,
  scores: runIds.map((runId, index) => ({ runId, incumbent: 0.6, candidate: 0.8 + index * 0.1, safe: true })) });
const retain = (remember?: string[]) => ({ candidate: null, reason: "Retain attributed observations", evidenceIds: [], scores: [], ...(remember === undefined ? {} : { remember }) });
const followupCheckpoint = (habitat: ContactHabitat) => {
  habitat.record(reply()); habitat.observe(message("feedback-1", at + 1, "owner"), at + 1);
  habitat.observe(message("more-1", at + 2), at + 2); habitat.observe(message("more-2", at + 3), at + 3);
  habitat.finish(habitat.claim(at + 1)!, { reason: "Initial", candidate: null, scores: [], evidenceIds: [] });
  habitat.finish(habitat.claim(at + 31_001)!, { reason: "Need more evidence", candidate: null, scores: [], evidenceIds: [] });
  habitat.record(reply("run-2", at + 60_000)); habitat.observe(message("feedback-2", at + 60_001), at + 60_001);
  habitat.observe(message("more-3", at + 60_002), at + 60_002); habitat.observe(message("more-4", at + 60_003), at + 60_003);
  habitat.finish(habitat.claim(at + 60_001)!, { reason: "Initial", candidate: null, scores: [], evidenceIds: [] });
  return habitat.claim(at + 91_003)!;
};

test("habitats are isolated, reads are inert, and replayed reply observations are idempotent", () => {
  const journal = RunJournal.memory();
  try {
    const a = new ContactHabitat(journal, "contact-a"), b = new ContactHabitat(journal, "contact-b");
    expect(a.snapshot().revision).toBe(0); expect(journal.habitatState("contact-a")).toBeNull();
    a.record(reply()); a.record(reply());
    expect(a.snapshot().episodes).toHaveLength(1); expect(a.snapshot().revision).toBe(1);
    expect(b.snapshot().episodes).toHaveLength(0);
    expect(() => a.record({ ...reply(), text: "Different output" })).toThrow();
    expect(new ContactHabitat(journal, "contact-a").snapshot()).toEqual(a.snapshot());
  } finally { journal.close(); }
});

test("follow-up windows ignore echoes, unrelated reactions, old messages and duplicates", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
    habitat.observe(message("old", at - 1), at);
    habitat.observe(message("sent-run-1", at + 1), at + 1);
    habitat.observe({ ...message("reaction", at + 1), kind: "reaction", relatedMessageId: "foreign" }, at + 1);
    habitat.observe(message("follow", at + 1), at + 1); habitat.observe(message("follow", at + 1), at + 1);
    habitat.observe(message("future", at + 9_000_000), at + 2);
    habitat.observe(message("late", at + 1_800_001), at + 1_800_001);
    expect(habitat.snapshot().episodes[0]?.followups.map(value => value.id)).toEqual(["follow"]);
    habitat.observe({ ...message("tapback", at + 2), kind: "reaction", relatedMessageId: "sent-run-1" }, at + 2);
    expect(habitat.snapshot().episodes[0]?.followups).toHaveLength(2);
  } finally { journal.close(); }
});

test("initial reflection and bounded follow-up review are separate at-most-once checkpoints", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
    const initial = habitat.claim(at)!; expect(initial.phase).toBe("initial");
    expect(habitat.claim(at)).toBeNull();
    habitat.finish(initial, { reason: "Waiting for evidence", candidate: null, scores: [], evidenceIds: [] });
    habitat.observe(message("follow", at + 1000), at + 1000);
    expect(habitat.claim(at + 31_000)).toBeNull();
    habitat.observe(message("follow-2", at + 1001), at + 1001); habitat.observe(message("follow-3", at + 1002), at + 1002);
    const followup = habitat.claim(at + 31_002)!; expect(followup.phase).toBe("followup");
    habitat.finish(followup, { reason: "Insufficient evidence", candidate: null, scores: [], evidenceIds: [] });
    expect(habitat.claim(at + 1_800_000)).toBeNull();
    expect(habitat.snapshot().evaluations).toHaveLength(2);
  } finally { journal.close(); }
});

test("silence is unknown, does not promote, and an interrupted checkpoint is not replayed", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
    const initial = habitat.claim(at)!;
    expect(new ContactHabitat(journal, "contact-a").claim(at + 1)).toBeNull();
    habitat.finish(initial, { reason: "No observed feedback", candidate: { ...DEFAULT_HABITAT_PLAN, guidance: "A candidate" }, scores: [], evidenceIds: [] });
    const silent = habitat.claim(at + 1_800_000)!;
    expect(silent.episode.followups).toHaveLength(0);
    expect(habitat.finish(silent, { reason: "Silence is inconclusive", candidate: { ...DEFAULT_HABITAT_PLAN, guidance: "A candidate" }, scores: [], evidenceIds: [] })).toBe(false);
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
  } finally { journal.close(); }
});

test("only evidence-bound improvement with no case regressions promotes; rollback retains lineage", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    habitat.record(reply()); habitat.observe(message("feedback-1", at + 1, "owner"), at + 1);
    habitat.observe(message("more-1", at + 2), at + 2); habitat.observe(message("more-2", at + 3), at + 3);
    const first = habitat.claim(at + 1)!; habitat.finish(first, { reason: "Initial", candidate: null, scores: [], evidenceIds: [] });
    const firstFollow = habitat.claim(at + 31_001)!; habitat.finish(firstFollow, { reason: "Need more evidence", candidate: null, scores: [], evidenceIds: [] });
    habitat.record(reply("run-2", at + 60_000)); habitat.observe(message("feedback-2", at + 60_001), at + 60_001);
    habitat.observe(message("more-3", at + 60_002), at + 60_002); habitat.observe(message("more-4", at + 60_003), at + 60_003);
    const second = habitat.claim(at + 60_001)!; habitat.finish(second, { reason: "Initial", candidate: null, scores: [], evidenceIds: [] });
    const checkpoint = habitat.claim(at + 91_003)!;
    const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer concise explanations with one example." };
    expect(habitat.finish(checkpoint, { candidate: plan, reason: "Both examples improved", evidenceIds: ["feedback-1", "feedback-2"], scores: [{ runId: "run-1", incumbent: 0.6, candidate: 0.8, safe: true }, { runId: "run-2", incumbent: 0.6, candidate: 0.9, safe: true }] })).toBe(true);
    expect(habitat.snapshot().champion).toEqual(plan);
    const revision = habitat.snapshot().revision;
    habitat.rollback(revision); expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
    expect(habitat.snapshot().lineage).toHaveLength(2);
    expect(() => habitat.rollback(revision)).toThrow();
    expect(() => habitat.rollback(habitat.snapshot().revision)).toThrow();
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
  } finally { journal.close(); }
});

test("evolution cannot flip egress flags; identical flags still promote", () => {
  const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer concise explanations." };
  for (const flip of [{ webSearch: true }, { memeSearch: false }, { javascript: true }, { memorySearch: false }]) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a");
      expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], { ...plan, ...flip }))).toBe(false);
      expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
      expect(habitat.snapshot().evaluations.at(-1)?.status).toBe("retained");
    } finally { journal.close(); }
  }
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], plan))).toBe(true);
    expect(habitat.snapshot().champion).toEqual(plan);
  } finally { journal.close(); }
});

test("a rolled-back plan is denied re-promotion by a later evaluation", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), plan = { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer concise explanations with one example." };
    expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], plan))).toBe(true);
    habitat.rollback(habitat.snapshot().revision);
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
    expect(habitat.snapshot().denied).toEqual([habitatDigest(plan)]);
    habitat.record(reply("run-3", at + 120_000)); habitat.observe(message("feedback-3", at + 120_001), at + 120_001);
    habitat.observe(message("more-5", at + 120_002), at + 120_002); habitat.observe(message("more-6", at + 120_003), at + 120_003);
    habitat.finish(habitat.claim(at + 120_001)!, { reason: "Initial", candidate: null, scores: [], evidenceIds: [] });
    expect(habitat.finish(habitat.claim(at + 151_003)!, improved(["run-2", "run-3"], ["feedback-2", "feedback-3"], plan))).toBe(false);
    expect(habitat.snapshot().evaluations.at(-1)?.status).toBe("retained");
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
  } finally { journal.close(); }
});

test("states stored before rollback tombstones still parse", () => {
  const journal = RunJournal.memory();
  try {
    journal.writeHabitatState("contact-a", 0, JSON.stringify({ version: 1, revision: 1, champion: DEFAULT_HABITAT_PLAN, episodes: [], evaluations: [], lineage: [], ancestors: [] }));
    expect(new ContactHabitat(journal, "contact-a").snapshot().denied).toEqual([]);
  } finally { journal.close(); }
});

test("submitted replies without accepted IDs remain visible but cannot trigger evolution", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record({ ...reply(), messageIds: [] });
    expect(habitat.snapshot().episodes).toHaveLength(1);
    expect(habitat.snapshot().episodes[0]?.reflection?.reason).toContain("no stable message IDs");
    expect(habitat.claim(at + 1_800_000)).toBeNull();
  } finally { journal.close(); }
});

test("plans cannot add authorities, unbounded context, or executable programs", () => {
  expect(() => parseHabitatPlan({ ...DEFAULT_HABITAT_PLAN, provider: "other" })).toThrow();
  expect(() => parseHabitatPlan({ ...DEFAULT_HABITAT_PLAN, tools: ["shell"] })).toThrow();
  expect(() => parseHabitatPlan({ ...DEFAULT_HABITAT_PLAN, contextMessages: 10000 })).toThrow();
  expect(() => parseHabitatPlan({ ...DEFAULT_HABITAT_PLAN, guidance: "x".repeat(5000) })).toThrow();
});

test("owner configuration seeds one personality, records its baseline, and rejects stale writes", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), other = new ContactHabitat(journal, "contact-b");
    const plan: HabitatPlan = { ...DEFAULT_HABITAT_PLAN, guidance: "Offer one practical next step.", personality: { tone: "warm", formality: "casual" }, webSearch: true, memeSearch: false };
    habitat.configure(0, plan);
    expect(habitat.snapshot().champion).toEqual(plan);
    expect(habitat.snapshot().ownerRevision).toBe(1);
    expect(habitat.snapshot().lineage.at(-1)).toMatchObject({ kind: "configuration", from: DEFAULT_HABITAT_PLAN, to: plan });
    expect(other.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
    const stored = journal.habitatState("contact-a");
    expect(() => habitat.configure(0, DEFAULT_HABITAT_PLAN)).toThrow("conflict");
    expect(() => habitat.configure(1, { ...plan, personality: { tone: "warm", formality: "casual", tools: ["shell"] } })).toThrow();
    expect(journal.habitatState("contact-a")).toEqual(stored);
  } finally { journal.close(); }
});

test("personality can evolve with feedback while owner tool choices stay fixed", () => {
  for (const changeTools of [false, true]) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a");
      const seeded: HabitatPlan = { ...DEFAULT_HABITAT_PLAN, webSearch: true, memeSearch: false, personality: { tone: "neutral", formality: "balanced" } };
      habitat.configure(0, seeded);
      const candidate: HabitatPlan = { ...seeded, personality: { tone: "direct", formality: "casual" }, ...(changeTools ? { memeSearch: true } : {}) };
      expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], candidate))).toBe(!changeTools);
      expect(habitat.snapshot().champion).toEqual(changeTools ? seeded : candidate);
    } finally { journal.close(); }
  }
});

test("owner changes invalidate pending evolution even if the plan returns to identical bytes", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), checkpoint = followupCheckpoint(habitat);
    habitat.configure(habitat.snapshot().revision, { ...DEFAULT_HABITAT_PLAN, webSearch: true });
    habitat.configure(habitat.snapshot().revision, DEFAULT_HABITAT_PLAN);
    expect(habitatDigest(habitat.snapshot().champion)).toBe(checkpoint.baseDigest);
    expect(habitat.finish(checkpoint, improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], { ...DEFAULT_HABITAT_PLAN, guidance: "An obsolete candidate" }))).toBe(false);
    expect(habitat.snapshot().champion).toEqual(DEFAULT_HABITAT_PLAN);
    expect(habitat.snapshot().evaluations.at(-1)).toMatchObject({ status: "retained", reason: expect.stringContaining("owner changed") });
    expect(habitat.snapshot().episodes).toHaveLength(2);
  } finally { journal.close(); }
});

test("evolved candidates cannot grant themselves repository access", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), checkpoint = followupCheckpoint(habitat);
    const candidate = { ...DEFAULT_HABITAT_PLAN, repoAccess: true };
    expect(habitat.finish(checkpoint, improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], candidate))).toBe(false);
    expect(habitat.snapshot().champion.repoAccess).toBeUndefined();
    expect(habitat.snapshot().evaluations.at(-1)?.status).toBe("retained");
    // The owner grants the flag; a candidate carrying the identical grant still
    // promotes on its own merits.
    const granted = new ContactHabitat(journal, "contact-b");
    granted.configure(0, { ...DEFAULT_HABITAT_PLAN, repoAccess: true });
    const next = followupCheckpoint(granted), styled = { ...granted.snapshot().champion, guidance: "Prefer one short example." };
    expect(granted.finish(next, improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], styled))).toBe(true);
    expect(granted.snapshot().champion).toEqual(styled);
    // And stripping an owner grant in a candidate cannot promote either.
    const stripped = new ContactHabitat(journal, "contact-c");
    stripped.configure(0, { ...DEFAULT_HABITAT_PLAN, repoAccess: true });
    const last = followupCheckpoint(stripped);
    expect(stripped.finish(last, improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], DEFAULT_HABITAT_PLAN))).toBe(false);
    expect(stripped.snapshot().champion.repoAccess).toBe(true);
  } finally { journal.close(); }
});

test("a new owner baseline preserves history and cannot roll back to older tool grants", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    habitat.configure(0, { ...DEFAULT_HABITAT_PLAN, webSearch: true });
    const candidate = { ...habitat.snapshot().champion, guidance: "An improved explanation style" };
    expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], candidate))).toBe(true);
    habitat.configure(habitat.snapshot().revision, { ...candidate, webSearch: false, memeSearch: false });
    expect(habitat.snapshot().episodes).toHaveLength(2);
    expect(habitat.snapshot().evaluations).toHaveLength(4);
    expect(habitat.snapshot().lineage.map(entry => entry.kind)).toEqual(["configuration", "promotion", "configuration"]);
    expect(() => habitat.rollback(habitat.snapshot().revision)).toThrow("conflict");
    expect(habitat.snapshot().champion.webSearch).toBe(false);
  } finally { journal.close(); }
});

test("legacy plans and replies retain their identities without synthetic personality or tool fields", () => {
  const journal = RunJournal.memory();
  try {
    const legacyPlan = { ...DEFAULT_HABITAT_PLAN, guidance: "A legacy plan" };
    expect(JSON.stringify(parseHabitatPlan(legacyPlan))).toBe(JSON.stringify(legacyPlan));
    const state = { version: 1 as const, revision: 1, champion: legacyPlan, episodes: [{ reply: reply(), followups: [], initialClaimed: false, followupClaimed: false, reflection: null }], evaluations: [], lineage: [], ancestors: [DEFAULT_HABITAT_PLAN], denied: [habitatDigest(legacyPlan)] };
    expect(Object.hasOwn(parseHabitatPlan({ ...legacyPlan, personality: undefined }), "personality")).toBe(false);
    journal.writeHabitatState("contact-a", 0, JSON.stringify(state));
    const habitat = new ContactHabitat(journal, "contact-a");
    expect(habitat.snapshot()).toEqual(state);
    expect(habitatDigest(habitat.snapshot().champion)).toBe(state.denied[0]!);
    habitat.record(reply());
    expect(journal.habitatState("contact-a")?.value).toBe(JSON.stringify(state));
  } finally { journal.close(); }
});

test("submitted tool observations are bounded and part of reply identity", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    const tool = { kind: "web-search" as const, query: "public research", result: "An observed public excerpt" };
    const recorded: HabitatReply = { ...reply(), tools: [tool], actionKinds: ["text", "link"] };
    habitat.record(recorded); habitat.record(recorded);
    expect(habitat.snapshot().episodes[0]?.reply.tools).toEqual([tool]);
    expect(() => habitat.record({ ...recorded, tools: [{ ...tool, result: "Different evidence" }] })).toThrow("identity changed");
    for (const tools of [[tool, tool, tool], [{ ...tool, result: "💬".repeat(1025) }], [{ ...tool, query: "é".repeat(129) }]]) {
      expect(() => habitat.record({ ...reply("other"), tools })).toThrow();
    }
    expect(habitat.snapshot().episodes).toHaveLength(1);
  } finally { journal.close(); }
});

test("owner configuration preserves rejection history and invalidates pending initial reflection", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), rejected = { ...DEFAULT_HABITAT_PLAN, guidance: "A rejected personality" };
    expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], rejected))).toBe(true);
    habitat.rollback(habitat.snapshot().revision);
    habitat.record(reply("run-3", at + 120_000));
    const pending = habitat.claim(at + 120_000)!;
    habitat.configure(habitat.snapshot().revision, DEFAULT_HABITAT_PLAN);
    expect(habitat.snapshot().denied).toEqual([habitatDigest(rejected)]);
    expect(habitat.finish(pending, { candidate: rejected, reason: "Old reflection", scores: [], evidenceIds: [] })).toBe(false);
    expect(habitat.snapshot().episodes.at(-1)?.reflection).toBeNull();
  } finally { journal.close(); }
});

test("source-backed memory persists separately per contact with codepoint-safe attribution", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), source = { ...message("preference", at - 1000, "owner"), text: "é".repeat(511) + "😀tail" };
    habitat.record({ ...reply(), trigger: source });
    expect(habitat.finish(habitat.claim(at)!, retain([source.id]))).toBe(false);
    const state = habitat.snapshot(), memory = state.memory![0]!;
    expect(memory).toEqual({ id: source.id, at: source.at, author: "owner", text: "é".repeat(511), sourceDigest: habitatDigest(source), truncated: true });
    expect(Buffer.byteLength(memory.text)).toBeLessThanOrEqual(HABITAT_LIMITS.memoryTextBytes);
    expect(state.champion).toEqual(DEFAULT_HABITAT_PLAN); expect(state.evaluations.at(-1)?.memoryChanged).toBe(true);
    expect(new ContactHabitat(journal, "contact-a").snapshot().memory).toEqual(state.memory);
    expect(new ContactHabitat(journal, "contact-b").snapshot().memory).toBeUndefined();
    habitat.record(reply("run-2", at + 1000)); habitat.finish(habitat.claim(at + 1000)!, retain());
    expect(habitat.snapshot().memory).toEqual(state.memory);
    habitat.record(reply("run-3", at + 2000)); habitat.finish(habitat.claim(at + 2000)!, retain([]));
    expect(habitat.snapshot().memory).toEqual([]);
  } finally { journal.close(); }
});

test("memory refuses invented, duplicate, reaction, future, and contradictory source IDs", () => {
  for (const scenario of ["invented", "duplicate", "reaction", "future", "ambiguous", "body", "too-many"] as const) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a"), source = message("source", scenario === "future" ? at + 1 : at - 1);
      habitat.record({ ...reply(), trigger: scenario === "reaction" ? { ...source, kind: "reaction" } : source,
        context: scenario === "ambiguous" ? [{ ...source, text: "A different statement" }] : [] });
      const checkpoint = habitat.claim(at)!;
      const ids = scenario === "invented" ? ["not-observed"] : scenario === "duplicate" ? ["source", "source"] : scenario === "too-many" ? Array.from({ length: 9 }, (_, i) => `id-${i}`) : ["source"];
      expect(() => habitat.finish(checkpoint, scenario === "body" ? { ...retain(ids), remember: [{ id: "source", text: "Invented" }] } as never : retain(ids))).toThrow();
      expect(habitat.snapshot().memory).toBeUndefined();
    } finally { journal.close(); }
  }
});

test("memory copies reconcile proven clipped views but reject same-ID source changes", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), source = { ...message("source", at - 1000), text: "s".repeat(900) };
    const clipped = { ...source, text: source.text.slice(0, 512), sourceDigest: habitatDigest(source), truncated: true };
    habitat.record({ ...reply(), trigger: source, context: [clipped] });
    habitat.finish(habitat.claim(at)!, retain([source.id]));
    expect(habitat.snapshot().memory?.[0]).toMatchObject({ text: "s".repeat(900), sourceDigest: habitatDigest(source), truncated: false });
    habitat.record({ ...reply("run-2", at + 1000), context: [clipped] });
    habitat.finish(habitat.claim(at + 1000)!, retain([source.id, "trigger-run-2"]));
    expect(habitat.snapshot().memory).toHaveLength(2);
    habitat.record({ ...reply("run-3", at + 2000), context: [{ ...clipped, sourceDigest: "a".repeat(64) }] });
    expect(() => habitat.finish(habitat.claim(at + 2000)!, retain([source.id]))).toThrow("ambiguous");
  } finally { journal.close(); }
});

test("owner, memory, and source changes invalidate pending retention without overwriting newer state", () => {
  for (const change of ["owner", "memory", "source"] as const) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
      const checkpoint = habitat.claim(at)!;
      if (change === "owner") habitat.configure(habitat.snapshot().revision, DEFAULT_HABITAT_PLAN);
      else if (change === "source") habitat.observe(message("later", at + 1), at + 1);
      else {
        habitat.record(reply("run-2", at + 1000));
        habitat.finish(habitat.claim(at + 1000)!, retain(["trigger-run-2"]));
      }
      const memory = habitat.snapshot().memory;
      habitat.finish(checkpoint, retain(["trigger-run-1"]));
      expect(habitat.snapshot().memory).toEqual(memory);
      expect(habitat.snapshot().evaluations.find(value => value.key === checkpoint.key)?.memoryChanged).toBe(false);
    } finally { journal.close(); }
  }
});

test("owner clear blocks in-flight and later resurrection while preserving personality history", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), future = message("future-source", at + 20_000);
    habitat.record({ ...reply(), context: [future] });
    const pending = habitat.claim(at)!;
    const before = habitat.snapshot(); habitat.clearMemory(before.revision, at);
    expect(habitat.snapshot().memoryCutoff).toBe(future.at); expect(habitat.snapshot().ownerRevision).toBe(1);
    expect(habitat.snapshot().champion).toEqual(before.champion); expect(habitat.snapshot().ancestors).toEqual(before.ancestors);
    habitat.finish(pending, retain(["trigger-run-1"])); expect(habitat.snapshot().memory).toEqual([]);
    habitat.record({ ...reply("run-2", at + 30_000), context: [future] });
    const next = habitat.claim(at + 30_000)!;
    expect(() => habitat.finish(next, retain([future.id]))).toThrow("unavailable");
    habitat.finish(next, retain(["trigger-run-2"])); expect(habitat.snapshot().memory?.map(value => value.id)).toEqual(["trigger-run-2"]);
    expect(() => habitat.clearMemory(before.revision, at + 40_000)).toThrow("conflict");
  } finally { journal.close(); }
});

const archived = (index: number, text = "A synthetic remembered statement"): HabitatMemory => {
  const source = { ...message(`memory-${index}`, at - 10_000 + index), text };
  return { id: source.id, at: source.at, author: source.author, text, sourceDigest: habitatDigest(source), truncated: false };
};
const seedMemory = (journal: RunJournal, memory: HabitatMemory[]) => journal.writeHabitatState("contact-a", 0, JSON.stringify({ version: 1, revision: 1, champion: DEFAULT_HABITAT_PLAN, episodes: [], evaluations: [], lineage: [], ancestors: [], denied: [], memory }));

test("categorized memory deltas accumulate beyond active recall and preserve unmentioned sources", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    for (let batch = 0; batch < 2; batch++) {
      const context = Array.from({ length: 8 }, (_, i) => message(`source-${batch}-${i}`, at - 1000 + batch * 10 + i));
      habitat.record({ ...reply(`run-${batch}`, at + batch * 1000), context });
      habitat.finish(habitat.claim(at + batch * 1000)!, { ...retain(), memoryUpdate: { remember: context.map(entry => ({ id: entry.id, category: "shared-reference" })), forget: [] } });
    }
    const before = habitat.snapshot().memory!;
    expect(before).toHaveLength(16); expect(before.every(entry => entry.category === "shared-reference")).toBe(true);
    expect(new ContactHabitat(journal, "contact-a").snapshot().memory).toEqual(before);
    expect(new ContactHabitat(journal, "contact-b").snapshot().memory).toBeUndefined();
    habitat.record(reply("run-3", at + 3000));
    habitat.finish(habitat.claim(at + 3000)!, { ...retain(), memoryUpdate: { remember: [{ id: before[0]!.id, category: "preference" }], forget: [before[1]!.id] } });
    expect(habitat.snapshot().memory).toEqual([{ ...before[0]!, category: "preference" }, ...before.slice(2)]);
  } finally { journal.close(); }
});

test("deltas upgrade proven shorter excerpts without changing provenance or losing category", () => {
  const journal = RunJournal.memory();
  try {
    const source = { ...message("source", at - 1000, "owner"), text: "é".repeat(600) };
    const old: HabitatMemory = { id: source.id, at: source.at, author: source.author, text: "é".repeat(256), sourceDigest: habitatDigest(source), truncated: true, category: "context" };
    seedMemory(journal, [old]);
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record({ ...reply(), trigger: source });
    habitat.finish(habitat.claim(at)!, { ...retain(), memoryUpdate: { remember: [{ id: source.id, category: "open-loop" }], forget: [] } });
    expect(habitat.snapshot().memory).toEqual([{ ...old, text: "é".repeat(512), category: "open-loop" }]);
    habitat.record({ ...reply("run-2", at + 1000), context: [{ ...source, text: "é".repeat(256), sourceDigest: habitatDigest(source), truncated: true }] });
    habitat.finish(habitat.claim(at + 1000)!, retain([source.id]));
    expect(habitat.snapshot().memory?.[0]?.category).toBe("open-loop");
  } finally { journal.close(); }
});

test("archive eviction is deterministic by source age and bounded by encoded JSON bytes", () => {
  for (const escaped of [false, true]) {
    const journal = RunJournal.memory();
    try {
      const original = Array.from({ length: 64 }, (_, i) => archived(i, "x".repeat(1024)));
      seedMemory(journal, original);
      const context = Array.from({ length: 8 }, (_, i) => ({ ...message(`new-${i}`, at - 100 + i), text: (escaped ? "\u0001" : "n").repeat(1024) }));
      const habitat = new ContactHabitat(journal, "contact-a"); habitat.record({ ...reply(), context });
      habitat.finish(habitat.claim(at)!, { ...retain(), memoryUpdate: { remember: context.map(entry => ({ id: entry.id, category: "context" })), forget: [] } });
      const state = habitat.snapshot(), memory = state.memory!, evicted = state.evaluations.at(-1)!.memoryEvicted!;
      expect(memory.length).toBeLessThanOrEqual(64); expect(Buffer.byteLength(JSON.stringify(memory))).toBeLessThanOrEqual(HABITAT_LIMITS.memoryBytes);
      expect(evicted).toBeGreaterThanOrEqual(8); expect(escaped ? evicted > 8 : evicted === 8).toBe(true);
      expect(memory.slice(0, -8)).toEqual(original.slice(evicted));
      expect(memory.slice(-8).map(entry => entry.id)).toEqual(context.map(entry => entry.id));
    } finally { journal.close(); }
  }
});

test("memory deltas reject inventions, contradictory edits, extra text, and oversized changes atomically", () => {
  const invalid = [
    { remember: [{ id: "unknown", category: "context" }], forget: [] },
    { remember: [], forget: ["unknown"] },
    { remember: [{ id: "trigger-run-1", category: "context" }, { id: "trigger-run-1", category: "preference" }], forget: [] },
    { remember: [{ id: "memory-0", category: "context" }], forget: ["memory-0"] },
    { remember: [{ id: "trigger-run-1", category: "friendship" }], forget: [] },
    { remember: [{ id: "trigger-run-1", category: "context", text: "Invented" }], forget: [] },
    { remember: Array.from({ length: 9 }, (_, i) => ({ id: `memory-${i}`, category: "context" })), forget: [] },
  ];
  for (const memoryUpdate of invalid) {
    const journal = RunJournal.memory();
    try {
      seedMemory(journal, [archived(0)]);
      const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
      const checkpoint = habitat.claim(at)!, before = journal.habitatState("contact-a");
      expect(() => habitat.finish(checkpoint, { ...retain(), memoryUpdate } as never)).toThrow();
      expect(journal.habitatState("contact-a")).toEqual(before);
    } finally { journal.close(); }
  }
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
    expect(() => habitat.finish(habitat.claim(at)!, { ...retain([]), memoryUpdate: { remember: [], forget: [] } })).toThrow();
  } finally { journal.close(); }
});

test("delta retention keeps source, owner, ledger, and clear-cutoff concurrency guards", () => {
  for (const change of ["owner", "ledger", "source", "clear"] as const) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a"); habitat.record(reply());
      const checkpoint = habitat.claim(at)!;
      if (change === "owner") habitat.configure(habitat.snapshot().revision, DEFAULT_HABITAT_PLAN);
      else if (change === "source") habitat.observe(message("follow", at + 1), at + 1);
      else if (change === "clear") habitat.clearMemory(habitat.snapshot().revision, at);
      else { habitat.record(reply("run-2", at + 1000)); habitat.finish(habitat.claim(at + 1000)!, retain(["trigger-run-2"])); }
      const before = habitat.snapshot().memory;
      habitat.finish(checkpoint, { ...retain(), memoryUpdate: { remember: [{ id: "trigger-run-1", category: "preference" }], forget: [] } });
      expect(habitat.snapshot().memory).toEqual(before); expect(habitat.snapshot().evaluations.find(entry => entry.key === checkpoint.key)?.memoryChanged).toBe(false);
      if (change === "clear") {
        habitat.record({ ...reply("run-3", at + 2000), context: [reply().trigger] });
        expect(() => habitat.finish(habitat.claim(at + 2000)!, { ...retain(), memoryUpdate: { remember: [{ id: "trigger-run-1", category: "context" }], forget: [] } })).toThrow("unavailable");
      }
    } finally { journal.close(); }
  }
});

test("expanded archives do not expand body snapshots or reference-only exposure limits", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a"), snapshot = Array.from({ length: 8 }, (_, i) => archived(i, "x".repeat(512)));
    const priorMemory = Array.from({ length: 24 }, (_, i) => ({ id: `exposure-${i}`, sourceDigest: "a".repeat(64) }));
    habitat.record({ ...reply(), memory: snapshot, priorMemory });
    for (const fields of [{ memory: [...snapshot, archived(9)] }, { memory: [archived(0, "x".repeat(513))] }, { priorMemory: [...priorMemory, { id: "exposure-24", sourceDigest: "b".repeat(64) }] }, { priorMemory: [priorMemory[0]!, priorMemory[0]!] }]) {
      expect(() => habitat.record({ ...reply("run-2"), ...fields })).toThrow();
    }
    expect(habitat.snapshot().episodes).toHaveLength(1);
  } finally { journal.close(); }
});

test("owner soul anchors remain fixed while style adapts and legacy plan identities stay exact", () => {
  const soulCore = { voice: "Brief and kind", relationshipContext: "The owner describes a working relationship", sharedContext: "A synthetic shared project", boundaries: "Ask before making commitments" };
  for (const changeCore of [false, true]) {
    const journal = RunJournal.memory();
    try {
      const habitat = new ContactHabitat(journal, "contact-a"), plan: HabitatPlan = { ...DEFAULT_HABITAT_PLAN, soulCore };
      habitat.configure(0, plan);
      const candidate: HabitatPlan = { ...plan, personality: { tone: "warm", formality: "casual" }, ...(changeCore ? { soulCore: { ...soulCore, relationshipContext: "Invented intimacy" } } : {}) };
      expect(habitat.finish(followupCheckpoint(habitat), improved(["run-1", "run-2"], ["feedback-1", "feedback-2"], candidate))).toBe(!changeCore);
    } finally { journal.close(); }
  }
  const { javascript, memorySearch, ...legacy } = DEFAULT_HABITAT_PLAN;
  expect(JSON.stringify(parseHabitatPlan(legacy))).toBe(JSON.stringify(legacy));
  expect(JSON.stringify(parseHabitatPlan({ ...legacy, javascript: undefined, memorySearch: undefined, soulCore: undefined }))).toBe(JSON.stringify(legacy));
  expect(() => parseHabitatPlan({ ...legacy, soulCore: { ...soulCore, voice: "é".repeat(257) } })).toThrow();
});

test("JavaScript tool evidence contains only a source digest while local memory search keeps bounded results", () => {
  const journal = RunJournal.memory();
  try {
    const habitat = new ContactHabitat(journal, "contact-a");
    habitat.record({ ...reply(), tools: [{ kind: "javascript", query: `sha256:${"a".repeat(64)}`, result: "4" }, { kind: "memory-search", query: "shared project", result: "An attributed observation" }] });
    expect(() => habitat.record({ ...reply("run-2"), tools: [{ kind: "javascript", query: "2 + 2", result: "4" }] })).toThrow();
    expect(habitat.snapshot().episodes).toHaveLength(1);
  } finally { journal.close(); }
});
