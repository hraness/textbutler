import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const supportFoundationPin = "github:hraness/support-foundation#2d034b357680353574411217d68b02b6755b07ed";
const reviewedInputs: Readonly<Record<string, string>> = {
  "dist/node.js": "e5867b56351d8ebdf3d6a8de3dd8a992dd59aedfde930d1cc96adc806962de95",
  "dist/index.js": "8c80132d2eaa0fcbf91fe9db2a4ece735ced307e629bd411030c8e2d6f9fa3c5",
  "LICENSE": "74b69bf37c8f340c9c2a54d431a15218738d9c463d0e014fa6a8bb8edce4e539"
};
// Bun 1.3.14 output of src/support-runtime.ts, admitted independently with this change.
const reviewedBundleSha256 = "6510a8046a611d4e47d1e220869bce4ae308ac59587944d3fdf10883eb3fd63e";
const sha256 = (source: string | Uint8Array): string => createHash("sha256").update(source).digest("hex");

export function isReviewedSupportRuntime(path: string, source: string): boolean {
  return path === "dist/support-runtime.js" && sha256(source) === reviewedBundleSha256;
}

export async function assertSupportFoundationInputs(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
  if (manifest.devDependencies?.["@hraness/support-foundation"] !== supportFoundationPin) throw new Error("Support foundation pin drifted");
  for (const [path, expected] of Object.entries(reviewedInputs)) {
    if (sha256(await readFile(join(root, "node_modules/@hraness/support-foundation", path))) !== expected) throw new Error(`Support foundation input drifted: ${path}`);
  }
  const license = await readFile(join(root, "node_modules/@hraness/support-foundation/LICENSE"), "utf8");
  const notice = await readFile(join(root, "docs/support-foundation-notice.md"), "utf8");
  if (!notice.includes(license.trim()) || !notice.includes(supportFoundationPin.split("#")[1]!)) throw new Error("Support foundation attribution drifted");
}
