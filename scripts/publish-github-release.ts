import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  type ReleasePageSource,
  publicRepository,
  releaseDistribution,
  releasePackageForName,
} from "./release-distribution-policy.ts";
import { parseGitHubIncludedJsonResponse } from "./release-included-response.ts";
import { publicReleaseEnvironment } from "./release-process-environment.ts";
import { assertReviewedMainComparison } from "./release-ref-authority.ts";

const [tagArgument, tarballArgument, checksumArgument, manifestArgument] = process.argv.slice(2);
if (
  tagArgument === undefined || tarballArgument === undefined || checksumArgument === undefined
  || process.argv.length > 6
) {
  throw new Error("Usage: publish-github-release.ts TAG ARTIFACT.tgz SHA256SUMS [MANIFEST.json]");
}
if (process.env.GITHUB_REPOSITORY !== publicRepository) {
  throw new Error(`GitHub Release publication must run in ${publicRepository}.`);
}
const verifiedShaValue = process.env.VERIFIED_SHA;
if (verifiedShaValue === undefined || !/^[0-9a-f]{40}$/u.test(verifiedShaValue)) {
  throw new Error("GitHub Release publication requires one verified release commit.");
}
const verifiedSha: string = verifiedShaValue;
const defaultBranchValue = process.env.DEFAULT_BRANCH;
if (defaultBranchValue === undefined || !/^[A-Za-z0-9._/-]+$/u.test(defaultBranchValue)) {
  throw new Error("GitHub Release publication requires one verified default branch.");
}
const defaultBranch: string = defaultBranchValue;

const manifest = JSON.parse(
  readFileSync(resolve(manifestArgument ?? resolve(import.meta.dir, "..", "package.json")), "utf8"),
) as Readonly<{
  name?: unknown;
  version?: unknown;
}>;
if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
  throw new Error("The public package manifest identity is invalid.");
}
const releasePackage = releasePackageForName(manifest.name);
const distribution = releaseDistribution(releasePackage);
const expectedTag = `${releasePackage.tagPrefix}${manifest.version}`;
if (tagArgument !== expectedTag) throw new Error(`Release tag must be ${expectedTag}.`);
const releaseTag = tagArgument;
const releaseVersion = manifest.version;

const tarball = resolve(tarballArgument);
const checksum = resolve(checksumArgument);
if (basename(tarball) !== distribution.releaseArchiveName(manifest.version) || basename(checksum) !== "SHA256SUMS") {
  throw new Error("Release artifact names do not match the public package coordinate.");
}
const tarballBytes = readFileSync(tarball);
const checksumBytes = readFileSync(checksum);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expectedTitle = distribution.releaseTitle(releaseVersion);
// The page body is rendered from CHANGELOG.md at the verified commit before
// any release object exists, so a missing, empty, or Unreleased section fails
// before creation. Assigned once, after the tag is proven to target the commit.
let pageSource: ReleasePageSource | undefined;
let expectedBody = "";
// GitHub's release list lags `gh release create` by a few seconds (v0.8.1,
// v0.8.2, and v0.8.3 each missed the draft on the first read). Bound the
// read-after-write wait; ambiguity and shape checks in findDraft still fail closed.
const DRAFT_VISIBILITY_ATTEMPTS = 6;
const DRAFT_VISIBILITY_DELAY_MILLISECONDS = 5_000;

async function readBoundedCommandOutput(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 32 * 1_024 * 1_024) {
        kill();
        throw new Error("GitHub release command output exceeded its bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function run(command: string[], allowFailure = false) {
  const token = process.env.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("GitHub Release publication requires one GitHub token.");
  }
  const environment = publicReleaseEnvironment({
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    NO_COLOR: "1",
  });
  const child = Bun.spawn(command, { env: environment, stdout: "pipe", stderr: "pipe" });
  const kill = () => child.kill(9);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedCommandOutput(child.stdout, kill),
      readBoundedCommandOutput(child.stderr, kill),
    ]);
    if (timedOut) throw new Error(`GitHub ${command[1] ?? "command"} timed out.`);
    if (exitCode !== 0 && !allowFailure) {
      const diagnosticState = stderr.byteLength === 0
        ? "without diagnostic output"
        : "with redacted diagnostic output";
      throw new Error(`GitHub ${command[1] ?? "command"} failed ${diagnosticState}.`);
    }
    return Object.freeze({ exitCode, stderr, stdout });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(command: string[]): Promise<Readonly<Record<string, unknown>>> {
  const value = JSON.parse((await run(command)).stdout.toString()) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Command did not return one JSON object: ${command.join(" ")}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function readJsonValue(command: string[]): Promise<unknown> {
  return JSON.parse((await run(command)).stdout.toString()) as unknown;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function verifyRemoteAnnotatedTag(): Promise<void> {
  const tagRef = await readJson([
    "gh", "api", `/repos/${publicRepository}/git/ref/tags/${tagArgument}`,
  ]);
  const tagObject = record(tagRef.object, `Remote release ref ${tagArgument} object`);
  if (
    tagRef.ref !== `refs/tags/${tagArgument}`
    || tagObject.type !== "tag"
    || typeof tagObject.sha !== "string"
    || !/^[0-9a-f]{40}$/u.test(tagObject.sha)
  ) throw new Error(`Remote release ref ${tagArgument} is not one annotated tag object.`);
  const annotated = await readJson([
    "gh", "api", `/repos/${publicRepository}/git/tags/${tagObject.sha}`,
  ]);
  const target = record(annotated.object, `Remote annotated tag ${tagArgument} target`);
  if (
    annotated.tag !== tagArgument
    || target.type !== "commit"
    || target.sha !== verifiedSha
  ) throw new Error(`Remote annotated tag ${tagArgument} does not target ${verifiedSha}.`);
  const readDefaultHead = async (): Promise<string> => {
    const head = await readJson([
      "gh", "api", `/repos/${publicRepository}/git/ref/heads/${defaultBranch}`,
    ]);
    const headObject = record(head.object, `Remote ${defaultBranch} ref object`);
    const headSha = headObject.sha;
    if (
      head.ref !== `refs/heads/${defaultBranch}`
      || headObject.type !== "commit"
      || typeof headSha !== "string"
      || !/^[0-9a-f]{40}$/u.test(headSha)
    ) throw new Error(`Remote ${defaultBranch} ref is invalid.`);
    return headSha;
  };
  const headSha = await readDefaultHead();
  const comparison = await readJson([
    "gh", "api", `/repos/${publicRepository}/compare/${verifiedSha}...${headSha}`,
  ]);
  assertReviewedMainComparison(
    comparison,
    verifiedSha,
    headSha,
    `Reviewed release ancestry to current ${defaultBranch}`,
  );
  if (await readDefaultHead() !== headSha) {
    throw new Error(`Remote ${defaultBranch} changed during reviewed release ancestry verification.`);
  }
}

async function readReleaseChangelog(): Promise<string> {
  const changelog = await run([
    "gh", "api",
    "-H", "Accept: application/vnd.github.raw+json",
    `/repos/${publicRepository}/contents/CHANGELOG.md?ref=${verifiedSha}`,
  ]);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(changelog.stdout);
  } catch {
    throw new Error(`CHANGELOG.md at ${verifiedSha} is not UTF-8.`);
  }
}

async function readRelease(): Promise<unknown> {
  return JSON.parse((await run([
    "gh", "api", `/repos/${publicRepository}/releases/tags/${tagArgument}`,
  ])).stdout.toString()) as unknown;
}

type ExactDraft = Readonly<{
  assets: readonly Readonly<Record<string, unknown>>[];
  id: number;
}>;

function exactDraft(value: unknown): ExactDraft {
  const draft = record(value, `Residual GitHub Release draft ${tagArgument}`);
  if (
    draft.tag_name !== tagArgument
    || draft.name !== expectedTitle
    || draft.body !== expectedBody
    || draft.draft !== true
    || draft.prerelease !== false
    || !Number.isSafeInteger(draft.id)
    || Number(draft.id) <= 0
    || !Array.isArray(draft.assets)
    || draft.assets.length > 2
  ) throw new Error(`Residual draft for ${tagArgument} does not match the exact recoverable release.`);
  const assets = draft.assets.map((asset) => record(asset, "Residual draft asset"));
  const names = new Set(assets.map((asset) => asset.name));
  if (
    names.size !== assets.length
    || [...names].some((name) => name !== basename(tarball) && name !== basename(checksum))
  ) throw new Error(`Residual draft for ${tagArgument} contains ambiguous assets.`);
  return Object.freeze({ assets: Object.freeze(assets), id: Number(draft.id) });
}

async function findDraft(): Promise<ExactDraft | null> {
  const inventory = await readJsonValue([
    "gh", "api", `/repos/${publicRepository}/releases?per_page=100&page=1`,
  ]);
  if (!Array.isArray(inventory) || inventory.length >= 100) {
    throw new Error("GitHub Release draft inventory is malformed or incomplete.");
  }
  const matches = inventory.filter((item) => {
    const candidate = record(item, "GitHub Release inventory item");
    return candidate.draft === true && candidate.tag_name === tagArgument;
  });
  if (matches.length > 1) throw new Error(`Multiple residual drafts exist for ${tagArgument}.`);
  return matches.length === 0 ? null : exactDraft(matches[0]);
}

async function readDraftById(id: number): Promise<ExactDraft> {
  const draft = exactDraft(await readJson([
    "gh", "api", `/repos/${publicRepository}/releases/${String(id)}`,
  ]));
  if (draft.id !== id) throw new Error(`Residual draft ${tagArgument} changed provider identifiers.`);
  return draft;
}

async function verifyDraftAssets(draft: ExactDraft): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const source of [tarball, checksum]) {
    const expectedName = basename(source);
    const asset = draft.assets.find((candidate) => candidate.name === expectedName);
    if (asset === undefined) {
      missing.push(source);
      continue;
    }
    if (
      asset.state !== "uploaded"
      || !Number.isSafeInteger(asset.id)
      || Number(asset.id) <= 0
      || asset.size !== readFileSync(source).byteLength
      || asset.digest !== `sha256:${sha256(readFileSync(source))}`
    ) throw new Error(`Residual draft asset ${expectedName} has different immutable metadata.`);
    const downloaded = await run([
      "gh", "api",
      "-H", "Accept: application/octet-stream",
      `/repos/${publicRepository}/releases/assets/${String(asset.id)}`,
    ]);
    if (!downloaded.stdout.equals(readFileSync(source))) {
      throw new Error(`Residual draft asset ${expectedName} has different bytes.`);
    }
  }
  return Object.freeze(missing);
}

async function completeDraftAssets(draft: ExactDraft): Promise<ExactDraft> {
  let current = await readDraftById(draft.id);
  for (const source of [tarball, checksum]) {
    const missing = await verifyDraftAssets(current);
    if (!missing.includes(source)) continue;
    await run([
      "gh", "api", "--method", "POST",
      "-H", "Accept: application/vnd.github+json",
      "-H", "Content-Type: application/octet-stream",
      "--input", source,
      `https://uploads.github.com/repos/${publicRepository}/releases/${String(current.id)}/assets?name=${encodeURIComponent(basename(source))}`,
    ]);
    current = await readDraftById(draft.id);
    await verifyDraftAssets(current);
  }
  return current;
}

async function verifyPublishedRelease(): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const coordinate = distribution.parseGitHubRelease(await readRelease(), releaseVersion, pageSource);
      assertReleaseAssetBytes(coordinate, tarballBytes, checksumBytes, sha256);
      const directory = mkdtempSync(join(tmpdir(), "message-like-me-release-assets-"));
      try {
        await run([
          "gh", "release", "download", releaseTag,
          "--repo", publicRepository,
          "--dir", directory,
          "--pattern", basename(tarball),
          "--pattern", basename(checksum),
        ]);
        for (const source of [tarball, checksum]) {
          if (!readFileSync(source).equals(readFileSync(join(directory, basename(source))))) {
            throw new Error(`GitHub Release ${tagArgument} contains different ${basename(source)} bytes.`);
          }
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(3_000);
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`GitHub Release ${tagArgument} did not become exact and immutable.${detail}`);
}

await verifyRemoteAnnotatedTag();
pageSource = Object.freeze({ changelog: await readReleaseChangelog(), commit: verifiedSha });
expectedBody = distribution.releaseBody(releaseVersion, pageSource);

const existing = await run([
  "gh", "api", "--include", `/repos/${publicRepository}/releases/tags/${tagArgument}`,
], true);
const existingResponse = parseGitHubIncludedJsonResponse(existing.stdout);
if (existing.exitCode === 0 && existingResponse.status === 200) {
  if (existingResponse.body.draft === true) {
    const draft = exactDraft(existingResponse.body);
    const completeDraft = await completeDraftAssets(draft);
    if ((await verifyDraftAssets(completeDraft)).length !== 0) {
      throw new Error(`Residual draft ${tagArgument} could not be completed exactly.`);
    }
    await run([
      "gh", "api", "--method", "PATCH",
      `/repos/${publicRepository}/releases/${String(completeDraft.id)}`,
      "-F", "draft=false", "-f", "make_latest=true",
    ]);
    await verifyPublishedRelease();
    console.log(`Completed exact residual GitHub Release draft ${tagArgument}.`);
  } else {
    await verifyPublishedRelease();
    console.log(`GitHub Release ${tagArgument} already contains the exact verified artifacts.`);
  }
} else {
  if (
    existing.exitCode === 0
    || existingResponse.status !== 404
    || existingResponse.body.message !== "Not Found"
    || existingResponse.body.status !== "404"
  ) {
    const diagnosticState = existing.stderr.byteLength === 0
      ? "without diagnostic output"
      : "with redacted diagnostic output";
    throw new Error(
      `Could not determine whether GitHub Release ${tagArgument} exists ${diagnosticState}.`,
    );
  }
  let draft = await findDraft();
  if (draft === null) {
    await run([
      "gh", "release", "create", tagArgument,
      "--draft",
      "--notes", expectedBody,
      "--repo", publicRepository,
      "--title", expectedTitle,
      "--verify-tag",
    ]);
    // The release list can lag the create call by a few seconds; bound the
    // read-after-write wait instead of failing on the first empty inventory.
    for (let attempt = 1; draft === null && attempt <= DRAFT_VISIBILITY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await Bun.sleep(DRAFT_VISIBILITY_DELAY_MILLISECONDS);
      draft = await findDraft();
    }
    if (draft === null) throw new Error(`GitHub did not create the exact draft for ${tagArgument}.`);
  }
  const completeDraft = await completeDraftAssets(draft);
  if ((await verifyDraftAssets(completeDraft)).length !== 0) {
    throw new Error(`GitHub Release draft ${tagArgument} did not acquire the exact artifacts.`);
  }
  await run([
    "gh", "api", "--method", "PATCH",
    `/repos/${publicRepository}/releases/${String(completeDraft.id)}`,
    "-F", "draft=false", "-f", "make_latest=true",
  ]);
  await verifyPublishedRelease();
  console.log(`Created immutable GitHub Release ${tagArgument} from the exact verified artifacts.`);
}

const latest = JSON.parse((await run([
  "gh", "api", `/repos/${publicRepository}/releases/latest`,
])).stdout.toString()) as Readonly<{ tag_name?: unknown }>;
if (latest.tag_name !== tagArgument) throw new Error(`Latest GitHub Release is not ${tagArgument}.`);
await verifyRemoteAnnotatedTag();
