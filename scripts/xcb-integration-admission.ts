import { join } from "node:path";
import { contactCapabilityIdentity, type ButlerPurpose } from "../packages/textbutler/src/contact-capabilities.ts";
import type { XcbIntegrationAdmission } from "../packages/textbutler/src/xcb-integration.ts";
import { physicalDirectory, readArtifact, sha256 } from "./textbutler-distribution.ts";

export const XCB_INTEGRATION_RECEIPT = "qualification/xcb-textbutler-v1.json";
/** Reviewed composition boundary, including the build-time admission gate.
 * An additional source requires an explicit change to this inventory. */
export const XCB_INTEGRATION_SOURCES = Object.freeze([
  "packages/control/src/index.ts",
  "packages/transport/src/automation-contract.ts",
  "packages/transport/src/automation-diagnostics.ts",
  "packages/textbutler/src/xcb-host.ts",
  "packages/textbutler/src/xcb-client.ts",
  "packages/textbutler/src/xcb-integration.ts",
  "packages/textbutler/src/native-subscription.ts",
  "packages/textbutler/src/native-task.ts",
  "packages/textbutler/src/contact-capabilities.ts",
  "packages/textbutler/src/control-service.ts",
  "packages/textbutler/src/contact-habitat.ts",
  "packages/textbutler/src/contact-repos.ts",
  "packages/textbutler/src/habitat-agent.ts",
  "packages/textbutler/src/habitat-program.ts",
  "packages/textbutler/src/javascript-tool.ts",
  "packages/textbutler/src/javascript-worker-entry.ts",
  "packages/textbutler/src/memory-search.ts",
  "packages/textbutler/src/habitat-evolution.ts",
  "packages/textbutler/src/reply-loop.ts",
  "packages/textbutler/src/fast-driver.ts",
  "packages/textbutler/src/gateway-search.ts",
  "packages/textbutler/src/meme-search.ts",
  "packages/textbutler/src/journal.ts",
  "packages/textbutler/src/message-summary.ts",
  "packages/textbutler/src/messages-cli.ts",
  "packages/textbutler/src/owner-cli.ts",
  "packages/textbutler/src/owner-messages.ts",
  "packages/textbutler/src/owner-replies.ts",
  "packages/textbutler/src/routed-agent.ts",
  "packages/textbutler/src/provider-host.ts",
  "packages/textbutler/src/daemon.ts",
  "packages/textbutler/src/host-config.ts",
  "packages/textbutler/src/workspace.ts",
  "packages/textbutler/src/runtime.ts",
  "packages/textbutler/src/runtime-entry.ts",
  "packages/textbutler/src/cli.ts",
  "packages/textbutler/src/launch-agent.ts",
  "packages/textbutler/src/macos-app.ts",
  "packages/textbutler/src/imessage-setup.ts",
  "scripts/build-textbutler.ts",
  "scripts/xcb-integration-admission.ts",
  "package.json",
  "bun.lock",
] as const);
const PURPOSES = ["classify", "respond"] as const;
const invalid = (): never => { throw Error("Textbutler XCB integration admission is missing, invalid or does not match the reviewed sources."); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return invalid();
  return value;
}

/** Consume independently reviewed evidence; this function never creates it.
 * The validation digest references the retained review/test receipt. It is not
 * inferred from source hashes, provider sign-in or executable admission.
 * When supplied, bundledSources binds the exact bytes observed by the builder. */
export async function validateXcbIntegrationAdmission(root: string,
  bundledSources?: ReadonlyMap<string, string>): Promise<XcbIntegrationAdmission> {
  await physicalDirectory(root);
  let bytes: Buffer, receipt: Record<string, unknown>;
  try {
    bytes = await readArtifact(join(root, XCB_INTEGRATION_RECEIPT), 64 * 1024);
    receipt = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      ["version", "profiles", "sources", "validation"]);
  } catch { return invalid(); }
  if (receipt.version !== 1) return invalid();
  const validation = record(receipt.validation, ["command", "receiptSha256"]);
  if (typeof validation.command !== "string" || validation.command.trim().length === 0
    || Buffer.byteLength(validation.command) > 4096 || /[\u0000-\u001f\u007f]/u.test(validation.command)) return invalid();
  digest(validation.receiptSha256);
  const identities = record(receipt.profiles, PURPOSES);
  const profiles = Object.fromEntries(PURPOSES.map(purpose => {
    const expected = contactCapabilityIdentity(purpose), observed = record(identities[purpose], ["id", "version", "digest"]);
    if (observed.id !== expected.id || observed.version !== expected.version || digest(observed.digest) !== expected.digest) return invalid();
    return [purpose, Object.freeze({ id: expected.id, version: expected.version, digest: expected.digest })];
  })) as Record<ButlerPurpose, ReturnType<typeof contactCapabilityIdentity>>;
  // Exact equality rejects traversal, absolute paths, aliases, missing required
  // files and unreviewed additions before any source path is opened.
  const sources = record(receipt.sources, XCB_INTEGRATION_SOURCES);
  const canonicalSources: Record<string, string> = {};
  for (const source of [...XCB_INTEGRATION_SOURCES].sort()) {
    const expected = digest(sources[source]);
    let actual: string;
    try { actual = sha256(await readArtifact(join(root, source), 4 * 1024 * 1024)); }
    catch { return invalid(); }
    if (actual !== expected || bundledSources !== undefined && bundledSources.get(source) !== expected) return invalid();
    canonicalSources[source] = expected;
  }
  const evidenceDigest = sha256(bytes);
  if (bundledSources !== undefined && bundledSources.get(XCB_INTEGRATION_RECEIPT) !== evidenceDigest) return invalid();
  return Object.freeze({ version: 1, evidenceDigest, sourceDigest: sha256(JSON.stringify(canonicalSources)), profiles: Object.freeze(profiles) });
}
