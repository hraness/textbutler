import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicEntries, publicGraphProblems } from "./check-public-graphs.ts";

test("checks transitive public JS and declaration dependencies with positive controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "message-like-me-public-graph-"));
  try {
    for (const entry of publicEntries) {
      await writeFile(join(root, `${entry}.js`), 'export {value} from "./shared.js";');
      await writeFile(join(root, `${entry}.d.ts`), 'export declare const value: number;');
    }
    await writeFile(join(root, "shared.js"), "export const value=1;");
    expect(await publicGraphProblems(root)).toEqual([]);
    await writeFile(join(root, "shared.js"), 'export {Effect} from "effect";');
    expect((await publicGraphProblems(root)).some((problem) => problem.includes("exposes an Effect dependency"))).toBe(true);
    await writeFile(join(root, "shared.js"), '// node_modules/effect/dist/esm/internal/core.js\nexport const value=1;');
    expect((await publicGraphProblems(root)).some((problem) => problem.includes("embeds the command runtime"))).toBe(true);
    await writeFile(join(root, "shared.js"), 'export {runSupportCommand} from "./support-runtime.js";');
    await writeFile(join(root, "support-runtime.js"), "export const runSupportCommand=()=>{};");
    expect((await publicGraphProblems(root)).some((problem) => problem.includes("embeds optional CLI support"))).toBe(true);
    await writeFile(join(root, "shared.js"), "export const value=1;");
    await writeFile(join(root, "index.d.ts"), 'export declare const value: import("effect").Effect.Effect<void>;');
    expect((await publicGraphProblems(root)).some((problem) => problem.includes("exposes an Effect dependency"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
