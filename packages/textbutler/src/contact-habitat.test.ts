import { expect, test } from "bun:test";
import { RunJournal } from "./journal.ts";
import { ContactHabitat, DEFAULT_HABITAT_PLAN, parseHabitatPlan, type HabitatObservation, type HabitatReply } from "./contact-habitat.ts";

const at = Date.parse("2026-09-20T12:00:00.000Z");
const message = (id: string, time = at, author: HabitatObservation["author"] = "contact"): HabitatObservation => ({ id, at: time, author, kind: "message", text: "A synthetic question", relatedMessageId: null });
const reply = (id = "run-1", time = at): HabitatReply => ({ runId: id, at: time, intent: "Explain the answer briefly", trigger: message(`trigger-${id}`, time - 1000), context: [], messageIds: [`sent-${id}`], text: "A synthetic answer", planDigest: null });

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
