import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  publicRepository,
  releaseDistribution,
  releasePackageForName,
} from "./release-distribution-policy";
import { verifyNpmProvenance } from "./npm-provenance-verification";
import { assertReviewedMainComparison } from "./release-ref-authority";

const maximumJsonBytes = 512 * 1_024;
const maximumArtifactBytes = 32 * 1_024 * 1_024;

function requireEnvironment(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`Public release admission requires a valid ${name}.`);
  }
  return value;
}

async function readBounded(response: Response, label: string, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error(`${label} exceeds its declared byte bound.`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} has no response body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumBytes) throw new Error(`${label} exceeds its byte bound.`);
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

async function readJson(response: Response, label: string): Promise<unknown> {
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/vnd.github+json") {
    throw new Error(`${label} did not return JSON.`);
  }
  const bytes = await readBounded(response, label, maximumJsonBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

async function fetchJson(url: string, label: string, headers: HeadersInit = {}): Promise<unknown> {
  return readJson(await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }), label);
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

const repository = requireEnvironment("GITHUB_REPOSITORY");
if (repository !== publicRepository) throw new Error(`Public release admission must run in ${publicRepository}.`);
const token = requireEnvironment("GITHUB_TOKEN");
const verifiedSha = requireEnvironment("VERIFIED_SHA", /^[0-9a-f]{40}$/u);
const verifiedTag = requireEnvironment("VERIFIED_TAG", /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const [manifestArgument, extraArgument] = process.argv.slice(2);
if (extraArgument !== undefined) throw new Error("Usage: check-public-release.ts [MANIFEST.json]");
const releaseManifest = JSON.parse(
  await readFile(resolve(manifestArgument ?? resolve(import.meta.dir, "..", "package.json")), "utf8"),
);
const releasePackage = releasePackageForName(
  (releaseManifest as Readonly<{ name?: unknown }>).name as string,
);
const distribution = releaseDistribution(releasePackage);
const releaseVersion = distribution.releaseVersionForCurrentAdmission(releaseManifest, verifiedTag);

const encodedPackage = encodeURIComponent(releasePackage.name);
const registryBase = `https://registry.npmjs.org/${encodedPackage}`;
const versionPayload = await fetchJson(
  `${registryBase}/${encodeURIComponent(releaseVersion)}`,
  "npm exact version",
);
const latestPayload = await fetchJson(`${registryBase}/latest`, "npm latest version");
const npmVersion = distribution.parseNpmRelease(versionPayload, releaseVersion);
const npmLatest = distribution.parseNpmRelease(latestPayload, releaseVersion);
if (npmLatest.integrity !== npmVersion.integrity || npmLatest.shasum !== npmVersion.shasum) {
  throw new Error("npm latest does not resolve to the exact verified version bytes.");
}
const npmTarball = await fetchArtifact(npmVersion.tarball, "npm release tarball");
const npmSha512 = `sha512-${createHash("sha512").update(npmTarball).digest("base64")}`;
const npmSha1 = createHash("sha1").update(npmTarball).digest("hex");
if (npmSha512 !== npmVersion.integrity || npmSha1 !== npmVersion.shasum) {
  throw new Error("npm release tarball bytes do not match registry integrity metadata.");
}
const preNpmState = process.env.PRE_NPM_STATE;
if (preNpmState !== undefined && preNpmState !== "absent" && preNpmState !== "exact_same_run") {
  throw new Error("Public release admission received an invalid npm retry state.");
}
const constrainedRunId = preNpmState === undefined
  ? undefined
  : requireEnvironment("GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
const constrainedAttempt = preNpmState === undefined
  ? undefined
  : Number(requireEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u));
const expectedReleaseRunId = process.env.EXPECTED_RELEASE_RUN_ID ?? "";
const expectedReleaseAttempt = process.env.EXPECTED_RELEASE_RUN_ATTEMPT ?? "";
const laterRunConstraint = expectedReleaseRunId.length > 0 || expectedReleaseAttempt.length > 0;
const npmWriterResult = process.env.NPM_WRITER_RESULT ?? "";
const npmCompletionRunId = process.env.NPM_COMPLETION_RUN_ID ?? "";
const npmCompletionRunAttempt = process.env.NPM_COMPLETION_RUN_ATTEMPT ?? "";
const writerConstraint = npmWriterResult.length > 0
  || npmCompletionRunId.length > 0
  || npmCompletionRunAttempt.length > 0;
const npmWriterResultRequired = process.env.NPM_WRITER_RESULT_REQUIRED;
if (
  (laterRunConstraint && (
    !/^[1-9][0-9]*$/u.test(expectedReleaseRunId)
    || !/^[1-9][0-9]*$/u.test(expectedReleaseAttempt)
  ))
  || (writerConstraint && (
    !["observed_existing", "published"].includes(npmWriterResult)
    || !/^[1-9][0-9]*$/u.test(npmCompletionRunId)
    || !/^[1-9][0-9]*$/u.test(npmCompletionRunAttempt)
  ))
  || (npmWriterResultRequired !== undefined && npmWriterResultRequired !== "true")
  || (npmWriterResultRequired === "true" && !writerConstraint)
  || [preNpmState !== undefined, laterRunConstraint, writerConstraint].filter(Boolean).length > 1
) throw new Error("Public release admission received conflicting or invalid run constraints.");
await verifyNpmProvenance(npmTarball, {
  releasePackage,
  ...(preNpmState === "exact_same_run"
    ? { maximumAttempt: constrainedAttempt as number, requiredRunId: constrainedRunId as string }
    : {}),
  ...(preNpmState === "absent"
    ? { requiredAttempt: constrainedAttempt as number, requiredRunId: constrainedRunId as string }
    : {}),
  ...(laterRunConstraint
    ? {
      maximumAttempt: Number(expectedReleaseAttempt),
      requiredRunId: expectedReleaseRunId,
    }
    : {}),
  ...(npmWriterResult === "published"
    ? {
      requiredAttempt: Number(npmCompletionRunAttempt),
      requiredRunId: npmCompletionRunId,
    }
    : {}),
  ...(npmWriterResult === "observed_existing"
    ? {
      maximumAttempt: Number(npmCompletionRunAttempt),
      requiredRunId: npmCompletionRunId,
    }
    : {}),
  verifiedSha,
  verifiedTag,
  version: releaseVersion,
});

const githubHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "message-like-me-release-admission",
  "X-GitHub-Api-Version": "2026-03-10",
};
const apiBase = `https://api.github.com/repos/${publicRepository}`;
const ref = await fetchJson(
  `${apiBase}/git/ref/tags/${encodeURIComponent(verifiedTag)}`,
  "GitHub annotated tag ref",
  githubHeaders,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown; url?: unknown }>; ref?: unknown }>;
if (
  ref.ref !== `refs/tags/${verifiedTag}`
  || ref.object?.type !== "tag"
  || typeof ref.object.sha !== "string"
  || !/^[0-9a-f]{40}$/u.test(ref.object.sha)
  || ref.object.url !== `${apiBase}/git/tags/${ref.object.sha}`
) throw new Error("GitHub release ref is not one exact annotated tag object.");
const tag = await fetchJson(ref.object.url, "GitHub annotated tag", githubHeaders) as Readonly<{
  object?: Readonly<{ sha?: unknown; type?: unknown }>;
  tag?: unknown;
}>;
if (tag.tag !== verifiedTag || tag.object?.type !== "commit" || tag.object.sha !== verifiedSha) {
  throw new Error("GitHub annotated tag does not target the verified release commit.");
}
const branch = requireEnvironment("DEFAULT_BRANCH", /^[A-Za-z0-9._/-]+$/u);
const branchRef = await fetchJson(
  `${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`,
  "GitHub default branch",
  githubHeaders,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown }> }>;
const branchSha = branchRef.object?.sha;
if (branchRef.object?.type !== "commit" || typeof branchSha !== "string") {
  throw new Error(`Current ${branch} ref is not one exact commit.`);
}
const comparison = await fetchJson(
  `${apiBase}/compare/${verifiedSha}...${branchSha}`,
  "GitHub reviewed-main ancestry",
  githubHeaders,
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
  githubHeaders,
) as Readonly<{ object?: Readonly<{ sha?: unknown; type?: unknown }> }>;
if (terminalBranchRef.object?.type !== "commit" || terminalBranchRef.object.sha !== branchSha) {
  throw new Error(`Current ${branch} ref changed during reviewed release ancestry verification.`);
}
const [releasePayload, githubLatestPayload] = await Promise.all([
  fetchJson(
    `${apiBase}/releases/tags/${encodeURIComponent(verifiedTag)}`,
    "GitHub Release",
    githubHeaders,
  ),
  fetchJson(`${apiBase}/releases/latest`, "Latest GitHub Release", githubHeaders),
]);
if ((githubLatestPayload as Readonly<{ tag_name?: unknown }>).tag_name !== verifiedTag) {
  throw new Error("Latest GitHub Release does not match the admitted annotated tag.");
}
const release = distribution.parseGitHubRelease(releasePayload, releaseVersion);
const [githubTarball, githubChecksum] = await Promise.all([
  fetchArtifact(release.tarball.browserDownloadUrl, "GitHub Release tarball"),
  fetchArtifact(release.checksum.browserDownloadUrl, "GitHub Release checksum"),
]);
assertReleaseAssetBytes(
  release,
  githubTarball,
  githubChecksum,
  (bytes) => createHash("sha256").update(bytes).digest("hex"),
);
if (!Buffer.from(githubTarball).equals(Buffer.from(npmTarball))) {
  throw new Error("npm and GitHub do not expose the same exact release tarball bytes.");
}

console.log(`Public release admission passed for ${releasePackage.name}@${releaseVersion}.`);
console.log("- npm latest: exact MIT package, cryptographically verified trusted-publisher provenance, SHA-1 and SHA-512 integrity");
console.log("- GitHub Release: exact annotated tag, commit, tarball, SHA256SUMS, sizes, and SHA-256 digests");
