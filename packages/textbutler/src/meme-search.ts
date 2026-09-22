import { z } from "zod";
import { boundedHttpBytes, type FastFetch } from "./fast-driver.ts";

const template = z.object({ id: z.string().regex(/^\d{1,24}$/u), name: z.string().min(1).max(200), url: z.string().regex(/^https:\/\/i\.imgflip\.com\/[a-z0-9]{1,32}\.(?:jpg|png)$/u), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) });
const catalog = z.object({ success: z.literal(true), data: z.object({ memes: z.array(template).max(200) }) });
export function createMemeSearch(options: { fetch?: FastFetch; now?: () => number } = {}) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  let cached: z.infer<typeof template>[] | undefined, cachedAt = 0;
  return {
    async search(query: string, external: AbortSignal) {
      if (!query.trim() || Buffer.byteLength(query) > 256) throw Error("Meme query exceeds its bound");
      const signal = AbortSignal.any([external, AbortSignal.timeout(8000)]); signal.throwIfAborted();
      if (!cached || now() - cachedAt > 3_600_000) {
        const response = await fetcher("https://api.imgflip.com/get_memes", { redirect: "error", signal });
        const bytes = await boundedHttpBytes(response, 262_144, signal);
        const parsed = catalog.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).data.memes;
        if (new Set(parsed.map(value => value.id)).size !== parsed.length) throw Error("Ambiguous meme catalog");
        cached = parsed; cachedAt = now();
      }
      const terms = query.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1).slice(0, 12);
      return cached.map(value => ({ ...value, score: terms.filter(term => value.name.toLowerCase().includes(term)).length }))
        .filter(value => value.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 8)
        .map(({ id, name, url }) => ({ id, name, url, source: "Imgflip popular templates; not full-library search" }));
    },
    async image(id: string, external: AbortSignal) {
      const selected = cached?.find(value => value.id === id);
      if (!selected || now() - cachedAt > 3_600_000) throw Error("Meme image must come from the current admitted catalog");
      const signal = AbortSignal.any([external, AbortSignal.timeout(8000)]); signal.throwIfAborted();
      const response = await fetcher(selected.url, { redirect: "error", signal });
      const bytes = await boundedHttpBytes(response, 4_194_304, signal);
      const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!(png && selected.url.endsWith(".png") || jpeg && selected.url.endsWith(".jpg"))) throw Error("Meme image type does not match its admitted URL");
      return { bytes, extension: png ? "png" : "jpg", mimeType: png ? "image/png" : "image/jpeg", source: selected.url };
    },
  };
}
export type MemeSearch = ReturnType<typeof createMemeSearch>;
