import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Executor, JsonValue } from "@hraness/algal";
import { parseActionIntent } from "../../transport/src/index.ts";
import type { AgentRequest, ButlerAgent, SubmittedReply } from "./runtime.ts";
import { NoReplyNeeded } from "./runtime.ts";
import type { ContactSettings } from "./config.ts";
import type { RunJournal } from "./journal.ts";
import { ContactHabitat, habitatDigest, parseHabitatPlan, parseHabitatAssessment, type HabitatObservation, type HabitatPlan } from "./contact-habitat.ts";
import { executeHabitatProgram } from "./habitat-program.ts";
import type { ContactWorkspace } from "./workspace.ts";
import type { FastDriver } from "./fast-driver.ts";
import { createMemeSearch, type MemeSearch } from "./meme-search.ts";

const outputSchema = z.strictObject({ respond: z.boolean(), confidence: z.number().min(0).max(1), reason: z.enum(["requested", "helpful", "human_active", "not_needed", "uncertain"]),
  summary: z.string().min(1).max(1024), actions: z.array(z.unknown()).max(7), tool: z.strictObject({ kind: z.enum(["web-search", "meme-search", "meme-image"]), query: z.string().min(1).max(256) }).nullable() });
const outputContract = { respond: "boolean", confidence: "number 0..1; below 0.85 stays silent", reason: "requested|helpful|human_active|not_needed|uncertain", summary: "brief intended purpose of this response", actions: "0..7 action objects", tool: "null or {kind:web-search|meme-search|meme-image,query:string}" };
const actionContract = [
  { kind: "text", text: "The response" }, { kind: "attachment", file: "an existing outbox path", name: "file.png", mimeType: "image/png" },
  { kind: "reaction", messageId: "an actual message id", emoji: "a supported reaction", action: "add" },
  { kind: "sticker", file: "an existing outbox path", messageId: null }, { kind: "link", url: "https://example.com" },
  { kind: "poll", question: "Question", options: ["One", "Two"], maximumSelections: null },
];
const historySchema = z.object({ messages: z.array(z.object({ id: z.string().max(256), at: z.number().int().nonnegative(), author: z.enum(["owner", "contact", "butler"]), text: z.string().max(16384) })).max(200) });
const clip = (value: string, maximum: number) => { let result = value; while (Buffer.byteLength(result) > maximum) result = result.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(result) - maximum) / 4))); return result; };
const eventObservation = (request: AgentRequest): HabitatObservation => ({ id: request.event.id, at: request.event.occurredAt, author: request.event.author === "owner" ? "owner" : "contact", kind: "message", text: clip(request.event.text, 2048), relatedMessageId: null });
const PRIVATE_SHAPE = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{7,}\d|https?:\/\/[^\s]*:[^\s@]+@)/iu;
/** A public query must not contain identifier shapes, any private 2-3 word span, or a
 * proper-noun token seen in private context. Fully paraphrased private facts remain a
 * residual risk, so web search stays plan-gated and owner-visible rather than default-on. */
export function admitPublicQuery(query: string, corpus: string): boolean {
  if (PRIVATE_SHAPE.test(query)) return false;
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(word => word.length >= 2);
  const q = words(query), corpusWords = words(corpus), grams = new Set<string>();
  for (const size of [2, 3]) for (let index = 0; index + size <= corpusWords.length; index++) grams.add(corpusWords.slice(index, index + size).join(" "));
  for (const size of [2, 3]) for (let index = 0; index + size <= q.length; index++) if (grams.has(q.slice(index, index + size).join(" "))) return false;
  const properNouns = (value: string) => new Set((value.match(/\b[A-Z][a-z]{3,}\b/gu) ?? []).map(word => word.toLowerCase()));
  const corpusNouns = properNouns(corpus);
  return ![...properNouns(query)].some(word => corpusNouns.has(word));
}

export function createHabitatAgent(ports: { journal: RunJournal; driver: FastDriver; getWorkspace(id: string): Promise<ContactWorkspace>;
  capabilities(contact: ContactSettings): Promise<readonly string[]>; evolution?: (contact: ContactSettings, operationId: string) => Promise<Executor>;
  active(contact: ContactSettings): boolean; memes?: MemeSearch; now?: () => number }) {
  const now = ports.now ?? Date.now, memes = ports.memes ?? createMemeSearch(), shutdown = new AbortController();
  const cached = new Map<string, { result: z.infer<typeof outputSchema>; context: HabitatObservation[]; plan: HabitatPlan }>();
  let evolving: Promise<void> | undefined, evolutionController: AbortController | undefined, evolutionContact: ContactSettings | undefined;
  const backoff = new Map<string, { attempts: number; after: number; firstAt: number }>();
  const evalChecked = new Map<string, number>();
  async function answer(request: AgentRequest) {
    const existing = cached.get(request.runId); if (existing) return existing.result;
    request.signal.throwIfAborted(); shutdown.signal.throwIfAborted();
    if (cached.size >= 64) throw Error("Fast driver capacity reached");
    const signal = AbortSignal.any([request.signal, shutdown.signal]), workspace = await ports.getWorkspace(request.contact.id);
    const plan = new ContactHabitat(ports.journal, request.contact.id).snapshot().champion;
    const guidance: Record<string, string> = {};
    for (const path of ["AGENTS.md", "ABOUT.md", "MEMORY.md", "STYLE.md"]) guidance[path] = clip(await workspace.read(path), 2048);
    const history = historySchema.parse(JSON.parse(await workspace.read("history/recent.json"))).messages.slice(-plan.contextMessages)
      .map(message => ({ ...message, text: clip(message.text, 512) }));
    const capabilities = request.capabilities ?? await ports.capabilities(request.contact), results: JsonValue[] = [], admittedMemes = new Set<string>();
    const files = (await workspace.list()).filter(file => /^(?:outbox|attachments)\//u.test(file.path)).map(file => file.path).slice(-32);
    const privateCorpus = [request.event.text, ...Object.values(guidance), ...history.map(message => message.text)].join("\n");
    for (let step = 0; step < 3; step++) {
      signal.throwIfAborted();
      const context = { guidance, history, message: eventObservation(request), capabilities: [...capabilities], files, results, outputContract,
        allowedActions: actionContract.filter(action => capabilities.includes(action.kind)),
        tools: step === 2 ? [] : [...(plan.webSearch && ports.driver.config.kind === "gateway" ? ["web-search"] : []), ...(plan.memeSearch ? ["meme-search", "meme-image"] : [])],
        rules: `Return strict JSON with all output fields. If no reply is wanted, set respond=false and actions=[]. Otherwise use the proposed reply actions OR one tool request with actions=[]. Never both. Total text must be at most ${plan.maxReplyCharacters} characters. Humor preference: ${plan.humor}. Tools are optional; ordinary replies should finish immediately. Meme search matches popular template names locally, not the whole web; meme-image takes only an ID returned by meme-search. Template images have no new caption rendered into them. Never request tools when respond=false or confidence<0.85. Do not use search queries containing personal identifiers or copied private messages.` };
      const run = await executeHabitatProgram({ phase: "respond", plan, context: context as JsonValue, executor: ports.driver.executor(`${request.runId}-driver-${step}`), signal });
      ports.journal.recordHabitatEvidence(request.contact.id, run.receipt.digest, JSON.stringify(run), now());
      let result = outputSchema.parse(run.output);
      if (!result.respond || result.confidence < 0.85) result = { ...result, respond: false, actions: [], tool: null };
      if (result.tool) {
        if (step >= 2 || result.actions.length) throw Error("Fast driver tool budget exceeded");
        const tool = result.tool;
        if (tool.kind === "web-search") {
          if (!plan.webSearch || !admitPublicQuery(tool.query, privateCorpus)) throw Error("Public search query is not admitted");
          results.push({ tool: tool.kind, result: await ports.driver.search(`${request.runId}-search-${step}`, tool.query, signal) });
        } else {
          if (!plan.memeSearch) throw Error("Meme tools are disabled for this plan");
          if (tool.kind === "meme-search") {
            const matches = await memes.search(tool.query, signal); for (const match of matches) admittedMemes.add(match.id);
            results.push({ tool: tool.kind, matches });
          } else {
            if (!admittedMemes.has(tool.query) || !capabilities.includes("attachment")) throw Error("Meme image is not admitted for this conversation");
            const image = await memes.image(tool.query, signal); signal.throwIfAborted();
            const file = await workspace.importPublicAsset(image.bytes, image.extension); signal.throwIfAborted(); files.push(file.path);
            results.push({ tool: tool.kind, file: file.path, mimeType: image.mimeType, source: image.source });
          }
        }
        continue;
      } else if (result.respond) {
        const actions = result.actions.map(parseActionIntent);
        if (!actions.length || actions.some(action => !capabilities.includes(action.kind)) || actions.filter(action => action.kind === "text").reduce((sum, action) => sum + action.text.length, 0) > plan.maxReplyCharacters) throw Error("Fast driver response violates its action budget");
      }
      const contextMessages = history.filter(message => message.author !== "butler").slice(-plan.contextMessages).map(message => ({ ...message, author: message.author as "owner" | "contact", kind: "message" as const, relatedMessageId: null }));
      cached.set(request.runId, { result, context: contextMessages, plan });
      signal.addEventListener("abort", () => cached.delete(request.runId), { once: true });
      return result;
    }
    throw Error("Fast driver did not finish within its tool budget");
  }
  const agent: ButlerAgent = {
    async qualified() { return !shutdown.signal.aborted; },
    async classify(request) { const result = await answer(request); return { respond: result.respond, confidence: result.confidence, reason: result.reason }; },
    async compose(request) { const result = await answer(request); if (!result.respond || result.confidence < 0.85) throw new NoReplyNeeded(); return { summary: result.summary, actions: result.actions }; },
  };
  async function evolve(contact: ContactSettings, signal: AbortSignal) {
    if (!ports.evolution || !ports.active(contact)) return;
    const executor = await ports.evolution(contact, `habitat-${randomUUID()}`);
    signal.throwIfAborted();
    if (!ports.active(contact)) return;
    const habitat = new ContactHabitat(ports.journal, contact.id), checkpoint = habitat.claim(now()); if (!checkpoint) return;
    const receipts: string[] = [];
    try {
      const proposal = await executeHabitatProgram({ phase: "reflect", plan: checkpoint.plan, executor, signal,
        context: { episode: checkpoint.episode, phase: checkpoint.phase, planShape: checkpoint.plan,
          output: "Return {candidate: a plan with exactly the same fields, or null, reason:string,evidenceIds:string[]}. Do not supply scores. Initial reflection may identify a candidate for later review, but cannot promote. Other past replay cases are not shown." } as unknown as JsonValue });
      ports.journal.recordHabitatEvidence(contact.id, proposal.receipt.digest, JSON.stringify(proposal), now()); receipts.push(proposal.receipt.digest);
      const proposed = proposal.output as Record<string, unknown>;
      if (!proposed || Object.keys(proposed).sort().join(",") !== "candidate,evidenceIds,reason") throw Error("Invalid habitat proposal");
      const assessment = parseHabitatAssessment({ ...proposed, scores: [] });
      if (!ports.active(contact)) throw Error("Habitat revoked");
      if (checkpoint.phase === "initial" || assessment.candidate === null || checkpoint.cases.length < 2 || !checkpoint.episode.followups.length) { habitat.finish(checkpoint, assessment, receipts); return; }
      const candidate = parseHabitatPlan(assessment.candidate), cases = checkpoint.cases, replays: JsonValue[] = [], swapped = new Map<string, boolean>();
      for (const episode of cases) {
        const variants: string[] = [];
        for (const [variant, plan] of [checkpoint.plan, candidate].entries()) {
          if (!ports.active(contact)) throw Error("Habitat revoked");
          const replay = await executeHabitatProgram({ phase: "respond", plan, signal,
            executor: ports.driver.executor(habitatDigest({ checkpoint: checkpoint.key, runId: episode.reply.runId, variant })),
            context: { message: episode.reply.trigger, history: episode.reply.context, capabilities: ["text"], tools: [],
              output: 'Return {"text":string} with a single appropriate reply. This is an offline evaluation, not a send. No external tools are available.' } as unknown as JsonValue });
          ports.journal.recordHabitatEvidence(contact.id, replay.receipt.digest, JSON.stringify(replay), now()); receipts.push(replay.receipt.digest);
          const value = z.strictObject({ text: z.string().min(1).max(plan.maxReplyCharacters) }).parse(replay.output); variants.push(value.text);
        }
        const flip = Number.parseInt(habitatDigest({ checkpoint: checkpoint.key, runId: episode.reply.runId }).slice(0, 2), 16) % 2 === 1;
        swapped.set(episode.reply.runId, flip);
        replays.push({ runId: episode.reply.runId, intent: episode.reply.intent, trigger: episode.reply.trigger, context: episode.reply.context, feedback: episode.followups, a: variants[flip ? 1 : 0]!, b: variants[flip ? 0 : 1]! } as unknown as JsonValue);
      }
      const judge = await executeHabitatProgram({ phase: "judge", plan: checkpoint.plan, signal,
        executor: await ports.evolution(contact, `judge-${checkpoint.key}`), context: { cases: replays,
          output: 'Return {"reason":string,"evidenceIds":string[],"scores":[{"runId":string,"scoreA":number,"scoreB":number,"safe":boolean}]}. Compare anonymized a and b for each case; their ordering varies. Scores are 0..1. Cite feedback IDs for every case. Mark safe=false for uncertainty about policy compliance.' } });
      ports.journal.recordHabitatEvidence(contact.id, judge.receipt.digest, JSON.stringify(judge), now()); receipts.push(judge.receipt.digest);
      const judged = z.strictObject({ reason: z.string().max(1024), evidenceIds: z.array(z.string().max(256)).max(40), scores: z.array(z.strictObject({ runId: z.string().max(256), scoreA: z.number().min(0).max(1), scoreB: z.number().min(0).max(1), safe: z.boolean() })).max(2) }).parse(judge.output);
      if (!ports.active(contact)) throw Error("Habitat revoked");
      habitat.finish(checkpoint, parseHabitatAssessment({ ...judged, candidate, scores: judged.scores.map(score => ({ runId: score.runId, safe: score.safe,
        incumbent: swapped.get(score.runId) ? score.scoreB : score.scoreA, candidate: swapped.get(score.runId) ? score.scoreA : score.scoreB })) }), receipts);
    } catch {
      habitat.finish(checkpoint, { candidate: null, reason: "Evaluation unavailable, interrupted, stale, or invalid; incumbent retained without retry.", evidenceIds: [], scores: [] }, receipts);
    }
  }
  return {
    agent,
    submitted(reply: SubmittedReply) {
      const context = cached.get(reply.runId); if (!context) return;
      new ContactHabitat(ports.journal, reply.contact.id).record({ runId: reply.runId, at: reply.at, intent: context.result.summary,
        trigger: eventObservation({ ...reply, signal: shutdown.signal }), context: context.context, text: clip(context.result.actions.map(parseActionIntent).filter(action => action.kind === "text").map(action => action.text).join("\n"), 8192),
        messageIds: [...reply.messageIds], planDigest: habitatDigest(context.plan) });
    },
    observe(contactId: string, message: HabitatObservation) { if (!shutdown.signal.aborted) new ContactHabitat(ports.journal, contactId).observe(message, now()); },
    reconcile() { if (evolutionContact && !ports.active(evolutionContact)) evolutionController?.abort(); },
    settingsChanged() { backoff.clear(); },
    schedule(contact: ContactSettings) {
      let failed = backoff.get(contact.id);
      if (failed && now() - failed.firstAt >= 21_600_000) { backoff.delete(contact.id); failed = undefined; }
      if (evolving || shutdown.signal.aborted || !ports.evolution || !ports.active(contact) || (failed?.attempts ?? 0) >= 3 || (failed?.after ?? 0) > now()
        || (evalChecked.get(contact.id) ?? 0) > now() - 15_000) return;
      if (evalChecked.size >= 200 && !evalChecked.has(contact.id)) evalChecked.delete(evalChecked.keys().next().value!);
      evalChecked.set(contact.id, now());
      if (!new ContactHabitat(ports.journal, contact.id).needsEvaluation(now())) return;
      evolutionController = new AbortController(); evolutionContact = contact;
      evolving = evolve(contact, AbortSignal.any([shutdown.signal, evolutionController.signal])).catch(() => {
        evalChecked.delete(contact.id);
        if (backoff.size >= 200 && !backoff.has(contact.id)) backoff.delete(backoff.keys().next().value!);
        const attempts = (failed?.attempts ?? 0) + 1;
        backoff.set(contact.id, { attempts, after: now() + 60_000 * 5 ** (attempts - 1), firstAt: failed?.firstAt ?? now() });
      }).finally(() => { evolving = undefined; evolutionController = undefined; evolutionContact = undefined; });
    },
    async idle() { await evolving; },
    async close() { shutdown.abort(); await evolving; cached.clear(); backoff.clear(); evalChecked.clear(); },
  };
}
export type HabitatAgent = ReturnType<typeof createHabitatAgent>;
