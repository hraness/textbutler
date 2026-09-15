import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  registryVersionMetadata,
  registryVersionUrl,
} from "./npm-release-policy.ts";
import {
  type NpmReleaseCoordinate,
  releaseDistribution,
  releasePackageForName,
} from "./release-distribution-policy.ts";
import { trustedPublishingEnvironment } from "./release-process-environment.ts";

export type NpmWriterTransition = "observe_existing" | "publish";

export function chooseNpmWriterTransition(
  input: Readonly<{
    currentAttempt: number;
    preflightAttempt: number;
    preflightState: "absent" | "exact_same_run";
    releaseExists: boolean;
  }>,
): NpmWriterTransition {
  if (
    !Number.isSafeInteger(input.preflightAttempt) ||
    input.preflightAttempt <= 0 ||
    !Number.isSafeInteger(input.currentAttempt) ||
    input.currentAttempt <= 0 ||
    input.currentAttempt < input.preflightAttempt
  ) {
    throw new Error(
      "npm publication requires an ordered positive preflight and writer attempt.",
    );
  }
  if (input.preflightState === "exact_same_run") {
    if (!input.releaseExists) {
      throw new Error(
        "The exact npm release disappeared after retry admission.",
      );
    }
    return "observe_existing";
  }
  if (!input.releaseExists) return "publish";
  if (input.currentAttempt === input.preflightAttempt) {
    throw new Error(
      "The exact npm release appeared during the admitted attempt; refusing an ambiguous publication.",
    );
  }
  return "observe_existing";
}

async function main(): Promise<void> {
  const tarballArgument = process.argv[2];
  const manifestArgument = process.argv[3];
  if (tarballArgument === undefined || process.argv.length > 4) {
    throw new Error("Usage: publish-npm-release.ts ARTIFACT.tgz [MANIFEST.json]");
  }
  const tarball = resolve(tarballArgument);
  const information = await stat(tarball);
  if (
    !information.isFile() || information.size <= 0 ||
    information.size > 32 * 1_024 * 1_024
  ) {
    throw new Error("npm publication requires one finite release tarball.");
  }
  const bytes = await readFile(tarball);
  const expectedIntegrity = `sha512-${
    createHash("sha512").update(bytes).digest("base64")
  }`;
  const expectedShasum = createHash("sha1").update(bytes).digest("hex");
  const verifiedSha = process.env.VERIFIED_SHA;
  const verifiedTag = process.env.VERIFIED_TAG;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const preNpmState = process.env.PRE_NPM_STATE;
  const preNpmRunId = process.env.PRE_NPM_RUN_ID;
  const preNpmRunAttempt = process.env.PRE_NPM_RUN_ATTEMPT;
  if (verifiedSha === undefined || !/^[0-9a-f]{40}$/u.test(verifiedSha)) {
    throw new Error("npm publication requires one verified release commit.");
  }
  if (
    runId === undefined ||
    !/^[1-9][0-9]*$/u.test(runId) ||
    runAttempt === undefined ||
    !/^[1-9][0-9]*$/u.test(runAttempt)
  ) {
    throw new Error(
      "npm publication requires one verified GitHub workflow run and attempt.",
    );
  }
  if (preNpmState !== "absent" && preNpmState !== "exact_same_run") {
    throw new Error("npm publication requires one admitted retry state.");
  }
  if (
    preNpmRunId === undefined ||
    !/^[1-9][0-9]*$/u.test(preNpmRunId) ||
    preNpmRunAttempt === undefined ||
    !/^[1-9][0-9]*$/u.test(preNpmRunAttempt) ||
    preNpmRunId !== runId
  ) {
    throw new Error(
      "npm publication requires preflight provenance from this same workflow run.",
    );
  }
  const currentAttempt = Number(runAttempt);
  const preflightAttempt = Number(preNpmRunAttempt);
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined || output.length === 0 || output.length > 4_096) {
    throw new Error("npm publication requires one bounded GitHub output file.");
  }

  const manifest = JSON.parse(
    await Bun.file(
      resolve(manifestArgument ?? resolve(import.meta.dir, "..", "package.json")),
    ).text(),
  ) as Readonly<{
    license?: unknown;
    name?: unknown;
    publishConfig?: Readonly<
      { access?: unknown; provenance?: unknown; registry?: unknown }
    >;
    repository?: Readonly<{ type?: unknown; url?: unknown }>;
    version?: unknown;
  }>;
  if (
    typeof manifest.name !== "string" ||
    manifest.license !== "MIT" ||
    typeof manifest.version !== "string" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig.provenance !== true ||
    manifest.publishConfig.registry !== "https://registry.npmjs.org"
  ) {
    throw new Error(
      "The public CLI package identity or publication policy is invalid.",
    );
  }
  const releasePackage = releasePackageForName(manifest.name);
  // npm rejects a published manifest whose repository.url does not match the
  // repository its provenance was generated from.
  if (
    manifest.repository?.type !== "git" ||
    manifest.repository.url !== `git+https://github.com/${releasePackage.repository}.git`
  ) {
    throw new Error("The public package repository does not bind the provenance repository.");
  }
  const distribution = releaseDistribution(releasePackage);
  if (verifiedTag !== `${releasePackage.tagPrefix}${manifest.version}`) {
    throw new Error(
      `npm publication requires verified tag ${releasePackage.tagPrefix}${manifest.version}.`,
    );
  }
  if (basename(tarball) !== distribution.releaseArchiveName(manifest.version)) {
    throw new Error(
      "npm publication tarball name does not match the package coordinate.",
    );
  }
  const coordinate = `${manifest.name}@${manifest.version}`;
  const registryUrl = registryVersionUrl(manifest.name, manifest.version);
  const registryLatestUrl = `https://registry.npmjs.org/${
    encodeURIComponent(manifest.name)
  }/latest`;

  async function fetchMetadata(
    url: string,
  ): Promise<Record<string, unknown> | null> {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "message-like-me-release",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return registryVersionMetadata(
      response,
      manifest.name as string,
      manifest.version as string,
    );
  }

  type CompleteRelease = Readonly<{
    latest: NpmReleaseCoordinate;
    version: NpmReleaseCoordinate;
  }>;

  async function lookupCompleteRelease(): Promise<CompleteRelease | null> {
    const versionPayload = await fetchMetadata(registryUrl);
    if (versionPayload === null) return null;
    const latestPayload = await fetchMetadata(registryLatestUrl);
    if (latestPayload === null) {
      throw new Error(`${coordinate} exists but npm latest is missing.`);
    }
    return Object.freeze({
      latest: distribution.parseNpmRelease(latestPayload, manifest.version as string),
      version: distribution.parseNpmRelease(versionPayload, manifest.version as string),
    });
  }

  async function fetchExistingTarball(url: string): Promise<Uint8Array> {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": "message-like-me-release",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const declared = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      (declared !== null && (
        !/^[1-9][0-9]*$/u.test(declared) ||
        Number(declared) > 32 * 1_024 * 1_024
      ))
    ) {
      throw new Error(
        `${coordinate} did not return one finite existing tarball.`,
      );
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error(`${coordinate} returned no existing tarball body.`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > 32 * 1_024 * 1_024) {
          throw new Error(
            `${coordinate} existing tarball exceeded its byte bound.`,
          );
        }
        chunks.push(item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch { /* the bounded result remains authoritative */ }
      reader.releaseLock();
    }
    if (length === 0) {
      throw new Error(`${coordinate} existing tarball was empty.`);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async function drainBoundedPublishOutput(
    stream: ReadableStream<Uint8Array>,
    kill: () => void,
  ): Promise<boolean> {
    const reader = stream.getReader();
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) return true;
        length += item.value.byteLength;
        if (length > 256 * 1_024) {
          kill();
          return false;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function publishTarball(): Promise<number> {
    const directory = await mkdtemp(
      join(tmpdir(), "message-like-me-npm-publish-"),
    );
    try {
      const npmrc = join(directory, ".npmrc");
      const globalNpmrc = join(directory, "global.npmrc");
      await Promise.all([
        writeFile(
          npmrc,
          "registry=https://registry.npmjs.org/\nprovenance=true\n",
          { mode: 0o600 },
        ),
        writeFile(globalNpmrc, "", { mode: 0o600 }),
      ]);
      const environment = trustedPublishingEnvironment({
        CI: "true",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: join(directory, "cache"),
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
        NPM_CONFIG_PROVENANCE: "true",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        NPM_CONFIG_USERCONFIG: npmrc,
      });
      const child = Bun.spawn(
        [
          "npm",
          "publish",
          tarball,
          "--access",
          "public",
          "--ignore-scripts",
          "--provenance",
          "--registry",
          "https://registry.npmjs.org/",
          "--tag",
          "latest",
        ],
        { cwd: directory, env: environment, stderr: "pipe", stdout: "pipe" },
      );
      let timedOut = false;
      const kill = () => child.kill(9);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, 120_000);
      try {
        const [exitCode, stdoutWithinBound, stderrWithinBound] = await Promise
          .all([
            child.exited,
            drainBoundedPublishOutput(child.stdout, kill),
            drainBoundedPublishOutput(child.stderr, kill),
          ]);
        if (timedOut) {
          console.error(
            `npm publish exceeded its two-minute bound for ${coordinate}.`,
          );
        }
        if (!stdoutWithinBound || !stderrWithinBound) {
          console.error(
            `npm publish output exceeded its private-output bound for ${coordinate}.`,
          );
        }
        return exitCode;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  function requireExactRelease(actual: CompleteRelease): void {
    if (
      actual.version.integrity !== expectedIntegrity ||
      actual.version.shasum !== expectedShasum ||
      actual.latest.integrity !== expectedIntegrity ||
      actual.latest.shasum !== expectedShasum
    ) {
      throw new Error(
        `${coordinate} exists without the exact immutable npm latest bytes.`,
      );
    }
  }

  async function recordCompletion(
    mode: "observed_existing" | "published",
  ): Promise<void> {
    await appendFile(
      output as string,
      `npm_completion=${mode}\nnpm_completion_run_id=${runId}\nnpm_completion_run_attempt=${runAttempt}\n`,
      { encoding: "utf8" },
    );
  }

  const existing = await lookupCompleteRelease();
  const transition = chooseNpmWriterTransition({
    currentAttempt,
    preflightAttempt,
    preflightState: preNpmState,
    releaseExists: existing !== null,
  });
  if (transition === "observe_existing") {
    if (existing === null) {
      throw new Error("npm publication transition lost its existing release.");
    }
    requireExactRelease(existing);
    const existingBytes = await fetchExistingTarball(existing.version.tarball);
    if (!Buffer.from(existingBytes).equals(bytes)) {
      throw new Error(
        `${coordinate} existing tarball differs from the reviewed workflow artifact.`,
      );
    }
    await recordCompletion("observed_existing");
    console.log(
      `${coordinate} already contains the exact MIT, trusted-publisher npm latest tarball; publish is idempotently complete.`,
    );
  } else {
    const publishExitCode = await publishTarball();

    let observed: CompleteRelease | null = null;
    let lookupFailure: unknown;
    const deadline = Date.now() + 180_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (attempt > 0) await Bun.sleep(3_000);
      attempt += 1;
      try {
        const candidate = await lookupCompleteRelease();
        if (candidate !== null) {
          requireExactRelease(candidate);
          observed = candidate;
          break;
        }
      } catch (error) {
        observed = null;
        lookupFailure = error;
      }
    }
    if (observed === null) {
      const detail = lookupFailure instanceof Error
        ? ` Last registry error: ${lookupFailure.message}`
        : "";
      throw new Error(
        `npm publish did not produce a verifiable MIT, provenance-bearing npm latest ${coordinate} release.${detail}`,
      );
    }
    if (publishExitCode !== 0) {
      throw new Error(
        `${coordinate} appeared after npm rejected this attempt; refusing an ambiguous same-attempt race.`,
      );
    }
    await recordCompletion("published");
    console.log(
      `${coordinate} is publicly readable as npm latest with exact bytes and trusted-publisher metadata.`,
    );
  }
  console.log(
    `${coordinate} is ready for separate read-only cryptographic provenance admission.`,
  );
}

if (import.meta.main) await main();
