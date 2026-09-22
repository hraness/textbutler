import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunJournal } from "./journal.ts";

export const HABITAT_LIMITS = Object.freeze({ episodes: 16, followups: 5, windowMs: 1_800_000, quietMs: 30_000, evaluationsPerDay: 8, stateBytes: 524_288 });
const text = (maximum: number) => z.string().refine(value => Buffer.byteLength(value) <= maximum && !value.includes("\0"));
const id = text(256).min(1);
const timestamp = z.number().int().nonnegative().safe();
const planSchema = z.strictObject({ version: z.literal(1), guidance: text(4096), contextMessages: z.number().int().min(4).max(32), maxReplyCharacters: z.number().int().min(80).max(1600), humor: z.enum(["off", "light", "match"]), webSearch: z.boolean(), memeSearch: z.boolean() });
export type HabitatPlan = z.infer<typeof planSchema>;
export const DEFAULT_HABITAT_PLAN: HabitatPlan = Object.freeze({ version: 1, guidance: "Be useful, concise, and honest. Match explicit preferences; do not manufacture familiarity. Stay silent when help is not wanted.", contextMessages: 12, maxReplyCharacters: 640, humor: "match", webSearch: false, memeSearch: true });
export const parseHabitatPlan = (value: unknown): HabitatPlan => Object.freeze(planSchema.parse(value));
export const habitatDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const observationSchema = z.strictObject({ id, at: timestamp, author: z.enum(["owner", "contact"]), kind: z.enum(["message", "reaction"]), text: text(2048), relatedMessageId: id.nullable() });
export type HabitatObservation = z.infer<typeof observationSchema>;
const replySchema = z.strictObject({ runId: id, at: timestamp, intent: text(1024), trigger: observationSchema, context: z.array(observationSchema).max(12), messageIds: z.array(id).max(8), text: text(8192), planDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable() });
export type HabitatReply = z.infer<typeof replySchema>;
const reflectionSchema = z.strictObject({ candidate: planSchema.nullable(), reason: text(1024), evidenceIds: z.array(id).max(40) });
const episodeSchema = z.strictObject({ reply: replySchema, followups: z.array(observationSchema).max(HABITAT_LIMITS.followups), initialClaimed: z.boolean(), followupClaimed: z.boolean(), reflection: reflectionSchema.nullable().default(null) });
export type HabitatEpisode = z.infer<typeof episodeSchema>;
const evaluationSchema = z.strictObject({ key: id, at: timestamp, phase: z.enum(["initial", "followup"]), status: z.enum(["pending", "retained", "promoted"]), reason: text(1024), receipts: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)).max(8).default([]), evidenceIds: z.array(id).max(40).default([]) });
const lineageSchema = z.strictObject({ key: id, kind: z.enum(["promotion", "rollback"]), from: planSchema, to: planSchema, reason: text(1024) });
const stateSchema = z.strictObject({ version: z.literal(1), revision: timestamp, champion: planSchema, episodes: z.array(episodeSchema).max(HABITAT_LIMITS.episodes), evaluations: z.array(evaluationSchema).max(64), lineage: z.array(lineageSchema).max(16), ancestors: z.array(planSchema).max(16).default([]) });
export type HabitatState = z.infer<typeof stateSchema>;
export type HabitatCheckpoint = Readonly<{ key: string; phase: "initial" | "followup"; baseDigest: string; evidenceDigest: string; episode: HabitatEpisode; cases: readonly HabitatEpisode[]; plan: HabitatPlan }>;
const assessmentSchema = z.strictObject({ candidate: planSchema.nullable(), reason: text(1024), evidenceIds: z.array(id).max(40), scores: z.array(z.strictObject({ runId: id, incumbent: z.number().min(0).max(1), candidate: z.number().min(0).max(1), safe: z.boolean() })).max(4) });
export type HabitatAssessment = z.infer<typeof assessmentSchema>;
export const parseHabitatAssessment = (value: unknown): HabitatAssessment => assessmentSchema.parse(value);
const evidence = (episodes: readonly HabitatEpisode[]) => episodes.map(episode => ({ reply: episode.reply, followups: episode.followups }));
const due = (episode: HabitatEpisode, now: number) => !episode.initialClaimed || !episode.followupClaimed && (episode.followups.length >= HABITAT_LIMITS.followups
  || now >= episode.reply.at + HABITAT_LIMITS.windowMs || episode.followups.length >= 3 && now >= episode.followups.at(-1)!.at + HABITAT_LIMITS.quietMs);

export class ContactHabitat {
  constructor(private readonly journal: Pick<RunJournal, "habitatState" | "writeHabitatState">, readonly contactId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId)) throw Error("Invalid habitat contact");
  }
  snapshot(): HabitatState {
    const stored = this.journal.habitatState(this.contactId);
    if (stored === null) return { version: 1, revision: 0, champion: { ...DEFAULT_HABITAT_PLAN }, episodes: [], evaluations: [], lineage: [], ancestors: [] };
    const state = stateSchema.parse(JSON.parse(stored.value));
    if (state.revision !== stored.revision) throw Error("Habitat revision mismatch");
    return state;
  }
  private save(state: HabitatState): void {
    const expected = state.revision;
    state.revision++;
    let value = JSON.stringify(stateSchema.parse(state));
    while (Buffer.byteLength(value) > HABITAT_LIMITS.stateBytes && state.episodes.length > 2) { state.episodes.shift(); value = JSON.stringify(state); }
    if (Buffer.byteLength(value) > HABITAT_LIMITS.stateBytes) throw Error("Habitat capacity reached");
    this.journal.writeHabitatState(this.contactId, expected, value);
  }
  record(value: HabitatReply): void {
    const reply = replySchema.parse(value), state = this.snapshot(), previous = state.episodes.find(episode => episode.reply.runId === reply.runId);
    if (previous) {
      if (habitatDigest(previous.reply) !== habitatDigest(reply)) throw Error("Habitat reply identity changed");
      return;
    }
    state.episodes.push({ reply, followups: [], initialClaimed: reply.messageIds.length === 0, followupClaimed: reply.messageIds.length === 0, reflection: reply.messageIds.length ? null
      : { candidate: null, reason: "The submitted receipt contained no stable message IDs; retained for inspection, not promotion.", evidenceIds: [] } });
    state.episodes = state.episodes.slice(-HABITAT_LIMITS.episodes);
    this.save(state);
  }
  observe(value: HabitatObservation, now: number): void {
    const message = observationSchema.parse(value), state = this.snapshot();
    if (!Number.isSafeInteger(now) || message.at > now + 30_000 || state.episodes.some(episode => episode.reply.messageIds.includes(message.id))) return;
    const episode = [...state.episodes].reverse().find(candidate => message.at > candidate.reply.at && message.at <= candidate.reply.at + HABITAT_LIMITS.windowMs
      && (message.kind === "message" || message.relatedMessageId !== null && candidate.reply.messageIds.includes(message.relatedMessageId)));
    if (!episode || episode.followupClaimed || episode.followups.length >= HABITAT_LIMITS.followups || episode.followups.some(observed => observed.id === message.id)) return;
    episode.followups.push(message);
    episode.followups.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    this.save(state);
  }
  needsEvaluation(now: number): boolean {
    const state = this.snapshot();
    return state.evaluations.filter(value => value.at >= Math.floor(now / 86_400_000) * 86_400_000).length < HABITAT_LIMITS.evaluationsPerDay && state.episodes.some(episode => due(episode, now));
  }
  claim(now: number): HabitatCheckpoint | null {
    if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid habitat clock");
    const state = this.snapshot();
    if (state.evaluations.filter(value => value.at >= Math.floor(now / 86_400_000) * 86_400_000).length >= HABITAT_LIMITS.evaluationsPerDay) return null;
    const episode = state.episodes.find(value => due(value, now));
    if (!episode) return null;
    const phase = episode.initialClaimed ? "followup" : "initial", baseDigest = habitatDigest(state.champion);
    const cases = state.episodes.filter(value => value.followups.length > 0).slice(-2);
    const evidenceDigest = habitatDigest(evidence(cases)), key = habitatDigest({ runId: episode.reply.runId, phase, baseDigest, evidenceDigest });
    if (phase === "initial") episode.initialClaimed = true; else episode.followupClaimed = true;
    state.evaluations.push({ key, phase, at: now, status: "pending", reason: "Checkpoint claimed before inference; an interrupted attempt is not replayed.", receipts: [], evidenceIds: [] });
    state.evaluations = state.evaluations.slice(-64);
    this.save(state);
    return { key, phase, baseDigest, evidenceDigest, episode: structuredClone(episode), cases: structuredClone(cases), plan: structuredClone(state.champion) };
  }
  finish(checkpoint: HabitatCheckpoint, input: HabitatAssessment, receipts: readonly string[] = []): boolean {
    const assessment = parseHabitatAssessment(input), state = this.snapshot(), evaluation = state.evaluations.find(value => value.key === checkpoint.key);
    if (!evaluation || evaluation.status !== "pending") throw Error("Habitat checkpoint is not pending");
    const cases = state.episodes.filter(value => checkpoint.cases.some(previous => previous.reply.runId === value.reply.runId));
    const cited = new Set(assessment.evidenceIds), scores = new Map(assessment.scores.map(score => [score.runId, score]));
    const promoted = checkpoint.phase === "followup" && assessment.candidate !== null && checkpoint.episode.followups.length > 0 && cases.length >= 2
      && habitatDigest(state.champion) === checkpoint.baseDigest && habitatDigest(evidence(cases)) === checkpoint.evidenceDigest
      && habitatDigest(assessment.candidate) !== checkpoint.baseDigest && assessment.scores.length === cases.length && scores.size === cases.length
      && cited.size > 0 && [...cited].every(id => cases.some(value => value.followups.some(message => message.id === id)))
      && cases.every(value => value.followups.some(message => cited.has(message.id)) && scores.get(value.reply.runId)?.safe === true
        && scores.get(value.reply.runId)!.candidate >= scores.get(value.reply.runId)!.incumbent)
      && assessment.scores.reduce((sum, score) => sum + score.candidate - score.incumbent, 0) / cases.length >= 0.1;
    evaluation.status = promoted ? "promoted" : "retained"; evaluation.reason = assessment.reason;
    evaluation.receipts = evaluationSchema.shape.receipts.parse([...receipts]); evaluation.evidenceIds = [...assessment.evidenceIds];
    const episode = state.episodes.find(value => value.reply.runId === checkpoint.episode.reply.runId);
    if (checkpoint.phase === "initial" && episode) episode.reflection = { candidate: assessment.candidate, reason: assessment.reason, evidenceIds: assessment.evidenceIds };
    if (promoted) {
      state.ancestors = [...state.ancestors, state.champion].slice(-16);
      state.lineage.push({ key: checkpoint.key, kind: "promotion", from: state.champion, to: assessment.candidate!, reason: assessment.reason });
      state.lineage = state.lineage.slice(-16); state.champion = assessment.candidate!;
    }
    this.save(state); return promoted;
  }
  rollback(expectedRevision: number): void {
    const state = this.snapshot(), previous = state.ancestors.pop();
    if (state.revision !== expectedRevision || !previous) throw Error("Habitat rollback conflict");
    state.lineage.push({ key: `rollback-${expectedRevision}`, kind: "rollback", from: state.champion, to: previous, reason: "Explicit owner rollback" });
    state.lineage = state.lineage.slice(-16); state.champion = previous; this.save(state);
  }
}
