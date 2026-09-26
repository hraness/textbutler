import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunJournal } from "./journal.ts";

export const HABITAT_LIMITS = Object.freeze({ episodes: 16, followups: 5, windowMs: 1_800_000, quietMs: 30_000, evaluationsPerDay: 8, stateBytes: 524_288, memoryEntries: 64, memoryTextBytes: 1024, memoryBytes: 98_304, memorySnapshotEntries: 8, memorySnapshotTextBytes: 512, memoryExposureReferences: 24, memoryChanges: 8 });
const text = (maximum: number) => z.string().refine(value => Buffer.byteLength(value) <= maximum && !value.includes("\0"));
const id = text(256).min(1);
const timestamp = z.number().int().nonnegative().safe();
const personalitySchema = z.strictObject({ tone: z.enum(["neutral", "warm", "playful", "direct"]), formality: z.enum(["casual", "balanced", "formal"]) });
const soulCoreSchema = z.strictObject({ voice: text(512), relationshipContext: text(512), sharedContext: text(512), boundaries: text(512) });
// Optional fields stay absent in older plans: filling defaults here would change
// the identities of retained champions, rollback tombstones and ALGAL receipts.
const planInputSchema = z.strictObject({ version: z.literal(1), guidance: text(4096), contextMessages: z.number().int().min(4).max(32), maxReplyCharacters: z.number().int().min(80).max(1600), humor: z.enum(["off", "light", "match"]), webSearch: z.boolean(), memeSearch: z.boolean(), personality: personalitySchema.optional(), javascript: z.boolean().optional(), memorySearch: z.boolean().optional(), soulCore: soulCoreSchema.optional(), repoAccess: z.boolean().optional() });
export type HabitatPlan = Omit<z.infer<typeof planInputSchema>, "personality" | "javascript" | "memorySearch" | "soulCore" | "repoAccess"> & { personality?: z.infer<typeof personalitySchema>; javascript?: boolean; memorySearch?: boolean; soulCore?: z.infer<typeof soulCoreSchema>; repoAccess?: boolean };
const planSchema = planInputSchema.transform((value): HabitatPlan => {
  const { personality, javascript, memorySearch, soulCore, repoAccess, ...plan } = value;
  return { ...plan, ...(personality === undefined ? {} : { personality }), ...(javascript === undefined ? {} : { javascript }), ...(memorySearch === undefined ? {} : { memorySearch }), ...(soulCore === undefined ? {} : { soulCore }), ...(repoAccess === undefined ? {} : { repoAccess }) };
});
export const DEFAULT_HABITAT_PLAN: HabitatPlan = Object.freeze({ version: 1, guidance: "Be useful, concise, and honest. Match explicit preferences; do not manufacture familiarity. Stay silent when help is not wanted.", contextMessages: 12, maxReplyCharacters: 640, humor: "match", webSearch: false, memeSearch: true, javascript: false, memorySearch: true });
export const parseHabitatPlan = (value: unknown): HabitatPlan => Object.freeze(planSchema.parse(value));
export const habitatDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const observationSchema = z.strictObject({ id, at: timestamp, author: z.enum(["owner", "contact"]), kind: z.enum(["message", "reaction"]), text: text(2048), relatedMessageId: id.nullable(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), truncated: z.boolean().optional() });
export type HabitatObservation = z.infer<typeof observationSchema>;
const prefix = (value: string, maximum: number) => { let result = "", bytes = 0; for (const point of value) { const size = Buffer.byteLength(point); if (bytes + size > maximum) break; result += point; bytes += size; } return result; };
/** Trusted ingestion only: bind the full bounded (2048-byte) observation before
 * projecting it into the shorter history/memory view. This is not a raw
 * transport-content digest; upstream history may itself already be bounded. */
export function boundHabitatObservation(value: HabitatObservation, maximum = 2048): HabitatObservation {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 2048) throw Error("Invalid observation bound");
  const source = { id: value.id, at: value.at, author: value.author, kind: value.kind, text: prefix(value.text, 2048), relatedMessageId: value.relatedMessageId };
  const text = prefix(source.text, maximum), truncated = value.truncated === true || text !== value.text;
  return observationSchema.parse(truncated ? { ...source, text, sourceDigest: value.sourceDigest ?? habitatDigest(source), truncated: true } : source);
}
const memoryCategory = z.enum(["preference", "shared-reference", "open-loop", "context"]);
const memorySchema = z.strictObject({ id, at: timestamp, author: z.enum(["owner", "contact"]), text: text(HABITAT_LIMITS.memoryTextBytes), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), truncated: z.boolean(), category: memoryCategory.optional() });
export type HabitatMemory = z.infer<typeof memorySchema>;
const memoryList = z.array(memorySchema).max(HABITAT_LIMITS.memoryEntries).refine(values => new Set(values.map(value => value.id)).size === values.length && Buffer.byteLength(JSON.stringify(values)) <= HABITAT_LIMITS.memoryBytes);
const memorySnapshot = z.array(memorySchema.extend({ text: text(HABITAT_LIMITS.memorySnapshotTextBytes) })).max(HABITAT_LIMITS.memorySnapshotEntries).refine(values => new Set(values.map(value => value.id)).size === values.length);
const rememberSchema = z.array(id).max(HABITAT_LIMITS.memoryChanges).refine(values => new Set(values).size === values.length);
const memoryUpdateSchema = z.strictObject({ remember: z.array(z.strictObject({ id, category: memoryCategory })).max(HABITAT_LIMITS.memoryChanges), forget: rememberSchema }).refine(value => new Set(value.remember.map(entry => entry.id)).size === value.remember.length && value.remember.every(entry => !value.forget.includes(entry.id)));
const toolSchema = z.strictObject({ kind: z.enum(["web-search", "meme-search", "meme-image", "javascript", "memory-search", "repo-sync", "repo-read", "repo-search"]), query: text(256), result: text(4096) }).refine(value => value.kind !== "javascript" || /^sha256:[a-f0-9]{64}$/u.test(value.query));
const actionKind = z.enum(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"]);
const priorMemorySchema = z.array(z.strictObject({ id, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u) })).max(HABITAT_LIMITS.memoryExposureReferences).refine(values => new Set(values.map(value => value.id)).size === values.length);
const replySchema = z.strictObject({ runId: id, at: timestamp, intent: text(1024), trigger: observationSchema, context: z.array(observationSchema).max(32), messageIds: z.array(id).max(8), text: text(8192), planDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), tools: z.array(toolSchema).max(2).optional(), actionKinds: z.array(actionKind).max(8).optional(), memory: memorySnapshot.optional(), priorMemory: priorMemorySchema.optional() });
export type HabitatReply = z.infer<typeof replySchema>;
const reflectionSchema = z.strictObject({ candidate: planSchema.nullable(), reason: text(1024), evidenceIds: z.array(id).max(40) });
const episodeSchema = z.strictObject({ reply: replySchema, followups: z.array(observationSchema).max(HABITAT_LIMITS.followups), initialClaimed: z.boolean(), followupClaimed: z.boolean(), reflection: reflectionSchema.nullable().default(null) });
export type HabitatEpisode = z.infer<typeof episodeSchema>;
const evaluationSchema = z.strictObject({ key: id, at: timestamp, phase: z.enum(["initial", "followup"]), status: z.enum(["pending", "retained", "promoted"]), reason: text(1024), receipts: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)).max(8).default([]), evidenceIds: z.array(id).max(40).default([]), memoryChanged: z.boolean().optional(), memoryEvicted: z.number().int().min(0).max(HABITAT_LIMITS.memoryEntries + HABITAT_LIMITS.memoryChanges).optional() });
const lineageSchema = z.strictObject({ key: id, kind: z.enum(["promotion", "rollback", "configuration"]), from: planSchema, to: planSchema, reason: text(1024) });
const stateSchema = z.strictObject({ version: z.literal(1), revision: timestamp, champion: planSchema, episodes: z.array(episodeSchema).max(HABITAT_LIMITS.episodes), evaluations: z.array(evaluationSchema).max(64), lineage: z.array(lineageSchema).max(16), ancestors: z.array(planSchema).max(16).default([]), denied: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(16).default([]), ownerRevision: timestamp.optional(), memory: memoryList.optional(), memoryCutoff: timestamp.optional() });
export type HabitatState = z.infer<typeof stateSchema>;
export type HabitatCheckpoint = Readonly<{ key: string; at: number; phase: "initial" | "followup"; baseDigest: string; evidenceDigest: string; ownerRevision: number; episode: HabitatEpisode; cases: readonly HabitatEpisode[]; plan: HabitatPlan; memory: readonly HabitatMemory[]; memoryDigest: string; memoryCutoff: number | null }>;
const assessmentSchema = z.strictObject({ candidate: planSchema.nullable(), reason: text(1024), evidenceIds: z.array(id).max(40), scores: z.array(z.strictObject({ runId: id, incumbent: z.number().min(0).max(1), candidate: z.number().min(0).max(1), safe: z.boolean() })).max(4), remember: rememberSchema.optional(), memoryUpdate: memoryUpdateSchema.optional() }).refine(value => value.remember === undefined || value.memoryUpdate === undefined);
export type HabitatAssessment = z.infer<typeof assessmentSchema>;
export const parseHabitatAssessment = (value: unknown): HabitatAssessment => assessmentSchema.parse(value);
const evidence = (episodes: readonly HabitatEpisode[]) => episodes.map(episode => ({ reply: episode.reply, followups: episode.followups }));
const sources = (episode: HabitatEpisode) => [episode.reply.trigger, ...episode.reply.context, ...episode.followups];
function remembered(source: HabitatObservation): HabitatMemory {
  let prefix = "", bytes = 0;
  for (const point of source.text) { const size = Buffer.byteLength(point); if (bytes + size > HABITAT_LIMITS.memoryTextBytes) break; prefix += point; bytes += size; }
  return { id: source.id, at: source.at, author: source.author, text: prefix, sourceDigest: source.sourceDigest ?? habitatDigest(source), truncated: source.truncated === true || prefix !== source.text };
}
function resolveMemory(checkpoint: HabitatCheckpoint, ids: readonly string[]): HabitatMemory[] {
  const available = new Map<string, HabitatMemory | null>();
  const add = (entry: HabitatMemory) => {
    if (entry.at > checkpoint.at || checkpoint.memoryCutoff !== null && entry.at <= checkpoint.memoryCutoff) return;
    if (available.has(entry.id) && habitatDigest(available.get(entry.id)) !== habitatDigest(entry)) {
      const previous = available.get(entry.id);
      if (!previous || previous.sourceDigest !== entry.sourceDigest || previous.at !== entry.at || previous.author !== entry.author
        || !(previous.text.startsWith(entry.text) || entry.text.startsWith(previous.text))) available.set(entry.id, null);
      else if (entry.text.length > previous.text.length) available.set(entry.id, previous.category === undefined ? entry : { ...entry, category: previous.category });
    }
    else if (!available.has(entry.id)) available.set(entry.id, entry);
  };
  checkpoint.memory.forEach(add);
  const observations = sources(checkpoint.episode);
  const nonMessages = new Set(observations.filter(value => value.kind !== "message").map(value => value.id));
  for (const source of observations) if (source.kind === "message") add(remembered(source));
  for (const id of nonMessages) available.set(id, null);
  return ids.map(id => { const entry = available.get(id); if (!entry) throw Error("Memory source is unavailable or ambiguous"); return structuredClone(entry); });
}
function updateMemory(checkpoint: HabitatCheckpoint, update: NonNullable<HabitatAssessment["memoryUpdate"]>): { memory: HabitatMemory[]; evicted: number } {
  if (update.forget.some(id => !checkpoint.memory.some(entry => entry.id === id))) throw Error("Memory forget target is unavailable");
  const resolved = resolveMemory(checkpoint, update.remember.map(entry => entry.id));
  const replacements = new Map(resolved.map((entry, index) => [entry.id, { ...entry, category: update.remember[index]!.category }]));
  const memory = checkpoint.memory.filter(entry => entry.at <= checkpoint.at && (checkpoint.memoryCutoff === null || entry.at > checkpoint.memoryCutoff) && !update.forget.includes(entry.id))
    .map(entry => replacements.get(entry.id) ?? structuredClone(entry));
  for (const entry of replacements.values()) if (!memory.some(previous => previous.id === entry.id)) memory.push(entry);
  let evicted = 0;
  while (memory.length > HABITAT_LIMITS.memoryEntries || Buffer.byteLength(JSON.stringify(memory)) > HABITAT_LIMITS.memoryBytes) {
    const oldest = memory.reduce((index, entry, current) => entry.at < memory[index]!.at || entry.at === memory[index]!.at && entry.id < memory[index]!.id ? current : index, 0);
    memory.splice(oldest, 1); evicted++;
  }
  return { memory, evicted };
}
const due = (episode: HabitatEpisode, now: number) => !episode.initialClaimed || !episode.followupClaimed && (episode.followups.length >= HABITAT_LIMITS.followups
  || now >= episode.reply.at + HABITAT_LIMITS.windowMs || episode.followups.length >= 3 && now >= episode.followups.at(-1)!.at + HABITAT_LIMITS.quietMs);

export class ContactHabitat {
  constructor(private readonly journal: Pick<RunJournal, "habitatState" | "writeHabitatState">, readonly contactId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId)) throw Error("Invalid habitat contact");
  }
  snapshot(): HabitatState {
    const stored = this.journal.habitatState(this.contactId);
    if (stored === null) return { version: 1, revision: 0, champion: { ...DEFAULT_HABITAT_PLAN }, episodes: [], evaluations: [], lineage: [], ancestors: [], denied: [] };
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
    const ownerRevision = state.ownerRevision ?? 0, memory = state.memory ?? [], memoryDigest = habitatDigest(memory);
    const evidenceDigest = habitatDigest(evidence(cases)), key = habitatDigest({ runId: episode.reply.runId, phase, baseDigest, evidenceDigest, ownerRevision, memoryDigest });
    if (phase === "initial") episode.initialClaimed = true; else episode.followupClaimed = true;
    state.evaluations.push({ key, phase, at: now, status: "pending", reason: "Checkpoint claimed before inference; an interrupted attempt is not replayed.", receipts: [], evidenceIds: [] });
    state.evaluations = state.evaluations.slice(-64);
    this.save(state);
    return { key, at: now, phase, baseDigest, evidenceDigest, ownerRevision, episode: structuredClone(episode), cases: structuredClone(cases), plan: structuredClone(state.champion), memory: structuredClone(memory), memoryDigest, memoryCutoff: state.memoryCutoff ?? null };
  }
  finish(checkpoint: HabitatCheckpoint, input: HabitatAssessment, receipts: readonly string[] = []): boolean {
    const assessment = parseHabitatAssessment(input), state = this.snapshot(), evaluation = state.evaluations.find(value => value.key === checkpoint.key);
    if (!evaluation || evaluation.status !== "pending") throw Error("Habitat checkpoint is not pending");
    const cases = state.episodes.filter(value => checkpoint.cases.some(previous => previous.reply.runId === value.reply.runId));
    const cited = new Set(assessment.evidenceIds), scores = new Map(assessment.scores.map(score => [score.runId, score]));
    const ownerUnchanged = (state.ownerRevision ?? 0) === checkpoint.ownerRevision;
    const episode = state.episodes.find(value => value.reply.runId === checkpoint.episode.reply.runId);
    const memoryUnchanged = habitatDigest(state.memory ?? []) === checkpoint.memoryDigest;
    if (assessment.remember !== undefined || assessment.memoryUpdate !== undefined) {
      evaluation.memoryChanged = false;
      if (ownerUnchanged && memoryUnchanged && habitatDigest(state.champion) === checkpoint.baseDigest && episode
        && habitatDigest(evidence([episode])) === habitatDigest(evidence([checkpoint.episode]))) {
        const updated = assessment.memoryUpdate === undefined ? { memory: resolveMemory(checkpoint, assessment.remember!), evicted: 0 } : updateMemory(checkpoint, assessment.memoryUpdate);
        const next = updated.memory;
        evaluation.memoryChanged = habitatDigest(next) !== checkpoint.memoryDigest;
        if (updated.evicted > 0) evaluation.memoryEvicted = updated.evicted;
        if (evaluation.memoryChanged) state.memory = next;
      }
    }
    const promoted = ownerUnchanged && memoryUnchanged && checkpoint.phase === "followup" && assessment.candidate !== null && checkpoint.episode.followups.length > 0 && cases.length >= 2
      && habitatDigest(state.champion) === checkpoint.baseDigest && habitatDigest(evidence(cases)) === checkpoint.evidenceDigest
      && habitatDigest(assessment.candidate) !== checkpoint.baseDigest && !state.denied.includes(habitatDigest(assessment.candidate))
      && assessment.candidate.webSearch === state.champion.webSearch && assessment.candidate.memeSearch === state.champion.memeSearch
      && assessment.candidate.javascript === state.champion.javascript && assessment.candidate.memorySearch === state.champion.memorySearch
      && assessment.candidate.repoAccess === state.champion.repoAccess
      && habitatDigest(assessment.candidate.soulCore ?? null) === habitatDigest(state.champion.soulCore ?? null)
      && assessment.scores.length === cases.length && scores.size === cases.length
      && cited.size > 0 && [...cited].every(id => cases.some(value => value.followups.some(message => message.id === id)))
      && cases.every(value => value.followups.some(message => cited.has(message.id)) && scores.get(value.reply.runId)?.safe === true
        && scores.get(value.reply.runId)!.candidate >= scores.get(value.reply.runId)!.incumbent)
      && assessment.scores.reduce((sum, score) => sum + score.candidate - score.incumbent, 0) / cases.length >= 0.1;
    evaluation.status = promoted ? "promoted" : "retained"; evaluation.reason = ownerUnchanged ? assessment.reason : "The owner changed this habitat after evaluation began; the current plan was retained.";
    evaluation.receipts = evaluationSchema.shape.receipts.parse([...receipts]); evaluation.evidenceIds = [...assessment.evidenceIds];
    if (ownerUnchanged && checkpoint.phase === "initial" && episode) episode.reflection = { candidate: assessment.candidate, reason: assessment.reason, evidenceIds: assessment.evidenceIds };
    if (promoted) {
      state.ancestors = [...state.ancestors, state.champion].slice(-16);
      state.lineage.push({ key: checkpoint.key, kind: "promotion", from: state.champion, to: assessment.candidate!, reason: assessment.reason });
      state.lineage = state.lineage.slice(-16); state.champion = assessment.candidate!;
    }
    this.save(state); return promoted;
  }
  clearMemory(expectedRevision: number, now: number): void {
    const state = this.snapshot();
    if (state.revision !== expectedRevision || !Number.isSafeInteger(now) || now < 0) throw Error("Habitat memory clear conflict");
    state.memoryCutoff = Math.max(now, state.memoryCutoff ?? 0, ...(state.memory ?? []).map(value => value.at),
      ...state.episodes.flatMap(episode => [...sources(episode).map(value => value.at), ...(episode.reply.memory ?? []).map(value => value.at)]));
    state.memory = []; state.ownerRevision = (state.ownerRevision ?? 0) + 1;
    this.save(state);
  }
  /** Owner control only. A new baseline keeps learning history but cannot roll
   * back across the owner's tool choices. Model proposals use finish instead. */
  configure(expectedRevision: number, input: unknown): void {
    const plan = parseHabitatPlan(input), state = this.snapshot();
    if (state.revision !== expectedRevision) throw Error("Habitat configuration conflict");
    state.ownerRevision = (state.ownerRevision ?? 0) + 1;
    state.lineage.push({ key: `configuration-${expectedRevision}`, kind: "configuration", from: state.champion, to: plan, reason: "Explicit owner personality and tool configuration" });
    state.lineage = state.lineage.slice(-16);
    state.champion = plan; state.ancestors = [];
    this.save(state);
  }
  rollback(expectedRevision: number): void {
    const state = this.snapshot(), previous = state.ancestors.pop();
    if (state.revision !== expectedRevision || !previous) throw Error("Habitat rollback conflict");
    state.ownerRevision = (state.ownerRevision ?? 0) + 1;
    state.denied = [...state.denied, habitatDigest(state.champion)].slice(-16);
    state.lineage.push({ key: `rollback-${expectedRevision}`, kind: "rollback", from: state.champion, to: previous, reason: "Explicit owner rollback" });
    state.lineage = state.lineage.slice(-16); state.champion = previous; this.save(state);
  }
}
