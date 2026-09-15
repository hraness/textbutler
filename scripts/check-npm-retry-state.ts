import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { verifyNpmProvenance } from "./npm-provenance-verification";
import { registryVersionMetadata, registryVersionUrl } from "./npm-release-policy";
import {
  releaseDistribution,
  releasePackageForName,
  type NpmReleaseCoordinate,
} from "./release-distribution-policy";

const maximumTarballBytes = 32 * 1_024 * 1_024;

function required(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (value === undefined || !pattern.test(value)) {
    throw new Error(`npm retry admission requires valid ${name}.`);
  }
  return value;
}

async function boundedArtifact(response: Response, label: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    response.status !== 200
    || (declared !== null && (
      !/^[1-9][0-9]*$/u.test(declared)
      || Number(declared) > maximumTarballBytes
    ))
  ) throw new Error(`${label} did not return one finite artifact.`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} returned no body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumTarballBytes) throw new Error(`${label} exceeded its byte bound.`);
      chunks.push(item.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the bounded result remains authoritative */ }
    reader.releaseLock();
  }
  if (length === 0) throw new Error(`${label} was empty.`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const [argument, manifestArgument, extra] = process.argv.slice(2);
if (argument === undefined || extra !== undefined) {
  throw new Error("Usage: check-npm-retry-state.ts ARTIFACT.tgz [MANIFEST.json]");
}
const tarball = resolve(argument);
const information = await stat(tarball);
if (!information.isFile() || information.size <= 0 || information.size > maximumTarballBytes) {
  throw new Error("npm retry admission requires one finite tarball.");
}
const bytes = await readFile(tarball);
const manifest = JSON.parse(
  await readFile(resolve(manifestArgument ?? resolve(import.meta.dir, "..", "package.json")), "utf8"),
) as Readonly<{ license?: unknown; name?: unknown; version?: unknown }>;
if (typeof manifest.name !== "string" || manifest.license !== "MIT" || typeof manifest.version !== "string") {
  throw new Error("npm retry artifact coordinate is invalid.");
}
const distribution = releaseDistribution(releasePackageForName(manifest.name));
if (basename(tarball) !== distribution.releaseArchiveName(manifest.version)) {
  throw new Error("npm retry artifact coordinate is invalid.");
}

async function metadata(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": "message-like-me-release-retry",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return registryVersionMetadata(response, distribution.package.name, manifest.version as string);
}

type CompleteRelease = Readonly<{
  latest: NpmReleaseCoordinate;
  version: NpmReleaseCoordinate;
}>;

const registryBase = `https://registry.npmjs.org/${encodeURIComponent(distribution.package.name)}`;
const versionPayload = await metadata(registryVersionUrl(distribution.package.name, manifest.version));
let release: CompleteRelease | null = null;
if (versionPayload !== null) {
  const latestPayload = await metadata(`${registryBase}/latest`);
  if (latestPayload === null) throw new Error("The exact npm version exists but npm latest is absent.");
  release = Object.freeze({
    latest: distribution.parseNpmRelease(latestPayload, manifest.version),
    version: distribution.parseNpmRelease(versionPayload, manifest.version),
  });
}

const output = required("GITHUB_OUTPUT", /^.{1,4096}$/u);
if (release === null) {
  await appendFile(output, "npm_state=absent\n", { encoding: "utf8" });
  console.log("Exact npm version is absent; this positive attempt may publish the reviewed bytes.");
} else {
  const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const expectedShasum = createHash("sha1").update(bytes).digest("hex");
  if (
    release.version.integrity !== expectedIntegrity
    || release.version.shasum !== expectedShasum
    || release.latest.integrity !== expectedIntegrity
    || release.latest.shasum !== expectedShasum
  ) throw new Error("Existing npm version or latest has different immutable bytes.");
  const remote = await boundedArtifact(await fetch(release.version.tarball, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", "User-Agent": "message-like-me-release-retry" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  }), "Existing npm tarball");
  if (!Buffer.from(remote).equals(bytes)) {
    throw new Error("Existing npm tarball differs from the reviewed workflow artifact.");
  }
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const maximumAttempt = Number(required("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u));
  await verifyNpmProvenance(remote, {
    maximumAttempt,
    releasePackage: distribution.package,
    requiredRunId: runId,
    verifiedSha: required("VERIFIED_SHA", /^[0-9a-f]{40}$/u),
    verifiedTag: required(
      "VERIFIED_TAG",
      /^(?:v|agentrouter-v)(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
    ),
    version: manifest.version,
  });
  await appendFile(output, "npm_state=exact_same_run\n", { encoding: "utf8" });
  console.log("Existing exact npm version is bound to this run at an allowed positive attempt.");
}
