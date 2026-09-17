import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  publicRepository,
  releaseDistribution,
  releasePackageForName,
} from "./release-distribution-policy";
import { assertReviewedMainComparison } from "./release-ref-authority";

const maximumJsonBytes = 512 * 1_024;
// The reviewed-main ancestry comparison carries per-file patches for up to 300
// changed files, so it shares the pinned provider helper's 8 MiB response bound.
const maximumComparisonBytes = 8 * 1_024 * 1_024;
const maximumArtifactBytes = 32 * 1_024 * 1_024;

function required(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`GitHub release admission requires valid ${name}.`);
  }
  return value;
}

async function readBounded(response: Response, label: string, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new Error(`${label} exceeded its declared bound.`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} returned no response body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) throw new Error(`${label} exceeded its byte bound.`);
      chunks.push(item.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the bounded result remains authoritative */ }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchJson(
  url: string,
  label: string,
  headers: Readonly<Record<string, string>>,
  maximumBytes: number = maximumJsonBytes,
): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json", "Cache-Control": "no-cache", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  const bytes = await readBounded(response, label, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

async function fetchArtifact(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", "User-Agent": "message-like-me-release-admission" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  return readBounded(response, label, maximumArtifactBytes);
}

const [tarballArgument, checksumArgument, manifestArgument, extra] = process.argv.slice(2);
if (tarballArgument === undefined || checksumArgument === undefined || extra !== undefined) {
  throw new Error("Usage: check-github-release.ts ARTIFACT.tgz SHA256SUMS [MANIFEST.json]");
}
if (required("GITHUB_REPOSITORY") !== publicRepository) {
  throw new Error(`GitHub release admission must run in ${publicRepository}.`);
}
const token = required("GITHUB_TOKEN");
const verifiedSha = required("VERIFIED_SHA", /^[0-9a-f]{40}$/u);
const verifiedTag = required(
  "VERIFIED_TAG",
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
);
const branch = required("DEFAULT_BRANCH", /^[A-Za-z0-9._/-]+$/u);
const tarballPath = resolve(tarballArgument);
const checksumPath = resolve(checksumArgument);
const [tarballInformation, checksumInformation] = await Promise.all([
  stat(tarballPath),
  stat(checksumPath),
]);
if (
  !tarballInformation.isFile()
  || tarballInformation.size <= 0
  || tarballInformation.size > maximumArtifactBytes
  || !checksumInformation.isFile()
  || checksumInformation.size <= 0
  || checksumInformation.size > 256
) throw new Error("GitHub release admission requires finite local artifacts.");
const [tarballBytes, checksumBytes] = await Promise.all([
  readFile(tarballPath),
  readFile(checksumPath),
]);
const manifest = JSON.parse(
  await readFile(resolve(manifestArgument ?? resolve(import.meta.dir, "..", "package.json")), "utf8"),
) as Readonly<{ license?: unknown; name?: unknown; version?: unknown }>;
if (typeof manifest.name !== "string" || manifest.license !== "MIT" || typeof manifest.version !== "string") {
  throw new Error("GitHub release admission coordinate is invalid.");
}
const distribution = releaseDistribution(releasePackageForName(manifest.name));
if (
  verifiedTag !== `${distribution.package.tagPrefix}${manifest.version}`
  || basename(tarballPath) !== distribution.releaseArchiveName(manifest.version)
  || basename(checksumPath) !== "SHA256SUMS"
) throw new Error("GitHub release admission coordinate is invalid.");

const headers = {
  Authorization: `Bearer ${token}`,
  "User-Agent": "message-like-me-release-admission",
  "X-GitHub-Api-Version": "2026-03-10",
};
const apiBase = `https://api.github.com/repos/${publicRepository}`;
const reference = await fetchJson(
  `${apiBase}/git/ref/tags/${encodeURIComponent(verifiedTag)}`,
  "GitHub annotated tag ref",
  headers,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown; url?: unknown }>; ref?: unknown }>;
if (
  reference.ref !== `refs/tags/${verifiedTag}`
  || reference.object?.type !== "tag"
  || typeof reference.object.sha !== "string"
  || !/^[0-9a-f]{40}$/u.test(reference.object.sha)
  || reference.object.url !== `${apiBase}/git/tags/${reference.object.sha}`
) throw new Error("GitHub release ref is not one exact annotated tag object.");
const tag = await fetchJson(
  reference.object.url,
  "GitHub annotated tag",
  headers,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown }>; tag?: unknown }>;
if (tag.tag !== verifiedTag || tag.object?.type !== "commit" || tag.object.sha !== verifiedSha) {
  throw new Error("GitHub annotated tag does not target the verified release commit.");
}
const branchRef = await fetchJson(
  `${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`,
  "GitHub default branch",
  headers,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown }> }>;
const branchSha = branchRef.object?.sha;
if (branchRef.object?.type !== "commit" || typeof branchSha !== "string") {
  throw new Error(`Current ${branch} ref is not one exact commit.`);
}
const comparison = await fetchJson(
  `${apiBase}/compare/${verifiedSha}...${branchSha}`,
  "GitHub reviewed-main ancestry",
  headers,
  maximumComparisonBytes,
) as Readonly<{
  [key: string]: unknown;
}>;
assertReviewedMainComparison(
  comparison,
  verifiedSha,
  branchSha,
  `Reviewed release ancestry to current ${branch}`,
);
const terminalBranchRef = await fetchJson(
  `${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`,
  "terminal GitHub default branch",
  headers,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown }> }>;
if (terminalBranchRef.object?.type !== "commit" || terminalBranchRef.object.sha !== branchSha) {
  throw new Error(`Current ${branch} ref changed during reviewed release ancestry verification.`);
}

const [releasePayload, latestPayload] = await Promise.all([
  fetchJson(`${apiBase}/releases/tags/${encodeURIComponent(verifiedTag)}`, "GitHub Release", headers),
  fetchJson(`${apiBase}/releases/latest`, "Latest GitHub Release", headers),
]);
if ((latestPayload as Readonly<{ tag_name?: unknown }>).tag_name !== verifiedTag) {
  throw new Error("Latest GitHub Release does not match the admitted annotated tag.");
}
const release = distribution.parseGitHubRelease(releasePayload, manifest.version);
const [publishedTarball, publishedChecksum] = await Promise.all([
  fetchArtifact(release.tarball.browserDownloadUrl, "GitHub Release tarball"),
  fetchArtifact(release.checksum.browserDownloadUrl, "GitHub Release checksum"),
]);
assertReleaseAssetBytes(
  release,
  publishedTarball,
  publishedChecksum,
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
);
if (
  !Buffer.from(publishedTarball).equals(tarballBytes)
  || !Buffer.from(publishedChecksum).equals(checksumBytes)
) throw new Error("GitHub Release bytes differ from the reviewed workflow artifact.");

console.log(`Immutable Latest GitHub Release ${verifiedTag} exposes the exact reviewed bytes.`);
