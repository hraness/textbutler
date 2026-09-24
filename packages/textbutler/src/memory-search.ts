import type { HabitatMemory } from "./contact-habitat.ts";

const words = (text: string) => text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const excerpt = (text: string) => { let result = "", bytes = 0; for (const point of text) { const size = Buffer.byteLength(point); if (bytes + size > 256) break; result += point; bytes += size; } return result; };

/** A read-only search over the exact contact archive supplied by the host. */
export function searchHabitatMemory(memory: readonly HabitatMemory[], query: string) {
  if (typeof query !== "string" || !query.trim() || query.includes("\0") || Buffer.byteLength(query) > 256 || memory.length > 64) throw Error("Invalid memory search bounds");
  const terms = [...new Set(words(query))].slice(0, 16);
  const ranked = memory.map(entry => {
    const tokens = new Set(words(entry.text)), matches = terms.filter(term => tokens.has(term)).length;
    return { entry, score: matches ? matches + (terms.length > 1 && entry.text.normalize("NFKC").toLowerCase().includes(terms.join(" ")) ? 4 : 0) : 0 };
  }).filter(value => value.score > 0).sort((a, b) => b.score - a.score || b.entry.at - a.entry.at || a.entry.id.localeCompare(b.entry.id));
  const matches = ranked.slice(0, 8).map(({ entry }) => { const text = excerpt(entry.text); return { ...entry, text,
    category: entry.category ?? "context", truncated: entry.truncated || text !== entry.text }; });
  const result = { matches, omitted: ranked.length - matches.length };
  while (Buffer.byteLength(JSON.stringify(result)) > 4096 && matches.length) { matches.pop(); result.omitted++; }
  return result;
}
