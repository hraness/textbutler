import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSupportFoundationInputs, isReviewedSupportRuntime } from "./support-runtime-policy.ts";

test("support exception binds exact path, bundled bytes and reviewed foundation inputs", async () => {
  const root = resolve(import.meta.dir, "..");
  await assertSupportFoundationInputs(root);
  const source = await readFile(resolve(root, "dist/support-runtime.js"), "utf8");
  expect(isReviewedSupportRuntime("dist/support-runtime.js", source)).toBe(true);
  expect(isReviewedSupportRuntime("dist/cli.js", source)).toBe(false);
  expect(isReviewedSupportRuntime("src/support-runtime.ts", source)).toBe(false);
  expect(isReviewedSupportRuntime("dist/support-runtime.js", source + "\n")).toBe(false);
});
