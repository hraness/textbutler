import { z } from "zod";
import { boundedHttpBytes, FAST_DRIVER_LIMITS, type FastFetch } from "./fast-driver.ts";
import type { RunJournal } from "./journal.ts";
import { parseXcbJson } from "./xcb-client.ts";

const https = z.string().max(2048).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } });
const responseSchema = z.object({ requestId: z.string().min(1).max(160), results: z.array(z.object({ title: z.string().max(4096), url: https,
  text: z.string().max(16384).optional(), highlights: z.array(z.string().max(8192)).max(20).optional() })).max(10),
  costDollars: z.object({ total: z.number().min(0).max(10).optional() }).optional() });
export function parseGatewaySearch(value: unknown) {
  const result = responseSchema.parse(value);
  return { requestId: result.requestId, sources: result.results.slice(0, 5).map(row => ({ title: row.title.slice(0, 240), url: row.url,
    excerpt: (row.highlights?.join("\n") || row.text || "").slice(0, 800) })), provenance: "Provider-executed Exa search results; untrusted excerpts, not model-generated citations." };
}
const wireSchema = z.object({ content: z.array(z.looseObject({ type: z.string().max(40), toolName: z.string().max(80).optional(), providerExecuted: z.boolean().optional(), result: z.unknown().optional() })).max(16),
  providerMetadata: z.looseObject({ gateway: z.looseObject({ generationId: z.string().min(1).max(160).optional(), cost: z.string().max(40).regex(/^\d+(?:\.\d+)?$/u).optional() }).catch({}).optional() }).catch({}).optional() });

export async function searchGateway(options: { model: string; credential: string; query: string; operationId: string; dailyBudgetUsd: number; journal: Pick<RunJournal, "reserveApiUsage" | "settleApiUsage">; signal: AbortSignal; now: () => number; fetch?: FastFetch }) {
  if (!options.query.trim() || Buffer.byteLength(options.query) > 256 || !options.credential || options.credential.length > 8192 || /\s/u.test(options.credential)) throw Error("Invalid bounded Gateway search");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]); signal.throwIfAborted();
  const body = JSON.stringify({ maxOutputTokens: 512,
    tools: [{ type: "provider", name: "exa_search", id: "gateway.exa_search",
      args: { type: "fast", numResults: 5, contents: { text: false, highlights: { maxCharacters: 800 } } } }],
    toolChoice: { type: "tool", toolName: "exa_search" },
    prompt: [{ role: "user", content: [{ type: "text", text: `Call exa_search exactly once for this public query. Do not answer from memory or invent URLs. Query: ${JSON.stringify(options.query)}` }] }],
    providerOptions: { gateway: { only: ["alibaba"] }, alibaba: { enableThinking: false } } });
  if (Buffer.byteLength(body) > FAST_DRIVER_LIMITS.inputBytes) throw Error("Search request budget exceeded");
  signal.throwIfAborted(); options.journal.reserveApiUsage(options.operationId, options.now(), FAST_DRIVER_LIMITS.reservationMicroUsd, Math.floor(options.dailyBudgetUsd * 1_000_000));
  let response: Response;
  try { response = await (options.fetch ?? fetch)("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${options.credential}`,
      "ai-gateway-auth-method": "api-key", "ai-gateway-protocol-version": "0.0.1",
      "ai-language-model-specification-version": "4", "ai-language-model-id": options.model, "ai-language-model-streaming": "false" }, body }); }
  catch { throw Error("Gateway Exa search request failed; no automatic retry"); }
  const bytes = await boundedHttpBytes(response, 262_144, signal);
  const wire = wireSchema.parse(parseXcbJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  signal.throwIfAborted();
  const calls = wire.content.filter(part => part.type === "tool-call" && part.providerExecuted === true && part.toolName === "exa_search");
  const results = wire.content.filter(part => part.type === "tool-result" && part.toolName === "exa_search");
  if (calls.length !== 1 || results.length !== 1) throw Error("No unique provider-executed Exa result");
  const search = parseGatewaySearch(results[0]!.result), gateway = wire.providerMetadata?.gateway;
  const cost = gateway?.cost === undefined ? undefined : Number(gateway.cost);
  if (gateway?.generationId !== undefined && cost !== undefined && Number.isFinite(cost) && cost <= 10)
    options.journal.settleApiUsage(options.operationId, gateway.generationId, Math.max(1, Math.ceil(cost * 1_000_000)));
  signal.throwIfAborted();
  return search;
}
