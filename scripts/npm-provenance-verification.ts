import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { publicReleaseEnvironment } from "./release-process-environment";
import {
  type ReleasePackage,
  releasePackageForName,
  rootReleasePackage,
} from "./release-distribution-policy";

const REPOSITORY = "hraness/message-like-me";
const REPOSITORY_ID = "1342143606";
const REGISTRY = "https://registry.npmjs.org/";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const WORKFLOW_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const SHA = /^[0-9a-f]{40}$/u;
const SHA512 = /^[0-9a-f]{128}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAXIMUM_AUDIT_BYTES = 4 * 1_024 * 1_024;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exactAttestationUrl(releasePackage: ReleasePackage, version: string): string {
  return `${REGISTRY}-/npm/v1/attestations/${releasePackage.name.replaceAll("/", "%2f")}@${version}`;
}

function decodePayload(value: unknown): JsonRecord {
  const encoded = text(value, BASE64, "npm provenance DSSE payload");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1_024 || bytes.toString("base64") !== encoded) {
    throw new Error("npm provenance DSSE payload is not canonical bounded base64.");
  }
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "npm provenance statement");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("npm provenance statement")) throw error;
    throw new Error("npm provenance DSSE payload is not canonical UTF-8 JSON.");
  }
}

export type NpmProvenanceCoordinate = Readonly<{
  maximumAttempt?: number;
  releasePackage: ReleasePackage;
  requiredAttempt?: number;
  requiredRunId?: string;
  sha512: string;
  verifiedSha: string;
  verifiedTag: string;
  version: string;
}>;

export type VerifiedNpmProvenance = Readonly<{
  bundle: JsonRecord;
  invocation: string;
}>;

export function parseVerifiedNpmProvenance(
  value: unknown,
  coordinate: NpmProvenanceCoordinate,
): VerifiedNpmProvenance {
  if (
    !SEMVER.test(coordinate.version)
    || !SHA512.test(coordinate.sha512)
    || !SHA.test(coordinate.verifiedSha)
    || coordinate.verifiedTag !== `${coordinate.releasePackage.tagPrefix}${coordinate.version}`
    || (
      coordinate.requiredRunId !== undefined
      && !/^[1-9][0-9]*$/u.test(coordinate.requiredRunId)
    )
    || (
      coordinate.maximumAttempt !== undefined
      && (!Number.isSafeInteger(coordinate.maximumAttempt) || coordinate.maximumAttempt < 1)
    )
    || (
      coordinate.requiredAttempt !== undefined
      && (!Number.isSafeInteger(coordinate.requiredAttempt) || coordinate.requiredAttempt < 1)
    )
  ) throw new Error("npm provenance verification coordinate is invalid.");

  const audit = record(value, "npm audit signatures result");
  const missing = array(audit.missing, "npm audit signatures missing");
  const invalid = array(audit.invalid, "npm audit signatures invalid");
  const verified = array(audit.verified, "npm audit signatures verified");
  // npm audits the whole installed tree: dependencies may carry their own
  // attestations or none. The release package itself must be verified exactly
  // once and no audited package may carry an invalid signature.
  if (invalid.length !== 0) {
    throw new Error("npm reported a cryptographically invalid package signature.");
  }
  const releaseVerified = verified.filter((entry) => {
    const candidate = record(entry, "npm verified package");
    return candidate.name === coordinate.releasePackage.name;
  });
  const releaseMissing = missing.some((entry) => {
    const candidate = record(entry, "npm audit signatures missing package");
    return candidate.name === coordinate.releasePackage.name;
  });
  if (releaseVerified.length !== 1 || releaseMissing) {
    throw new Error("npm did not cryptographically verify exactly one provenance-bearing release package.");
  }

  const packageResult = record(releaseVerified[0], "npm verified package");
  if (
    packageResult.name !== coordinate.releasePackage.name
    || packageResult.version !== coordinate.version
    || packageResult.location !== `node_modules/${coordinate.releasePackage.name}`
    || packageResult.registry !== REGISTRY
  ) throw new Error("npm verified the wrong package coordinate.");

  const attestations = record(packageResult.attestations, "npm verified package attestations");
  const provenance = record(attestations.provenance, "npm verified package provenance");
  if (
    attestations.url !== exactAttestationUrl(coordinate.releasePackage, coordinate.version)
    || provenance.predicateType !== SLSA_PREDICATE
  ) throw new Error("npm verified package provenance metadata is not exact.");

  const bundles = array(packageResult.attestationBundles, "npm verified package attestation bundles");
  const slsaBundles = bundles.filter((item) =>
    record(item, "npm attestation bundle").predicateType === SLSA_PREDICATE
  );
  if (slsaBundles.length !== 1) throw new Error("npm did not verify exactly one SLSA provenance bundle.");
  const bundleRecord = record(slsaBundles[0], "npm SLSA provenance bundle");
  const bundle = record(bundleRecord.bundle, "npm SLSA Sigstore bundle");
  if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") {
    throw new Error("npm SLSA provenance used the wrong Sigstore bundle format.");
  }
  const envelope = record(bundle.dsseEnvelope, "npm SLSA DSSE envelope");
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    throw new Error("npm SLSA provenance used the wrong DSSE payload type.");
  }
  const signatures = array(envelope.signatures, "npm SLSA DSSE signatures");
  if (signatures.length !== 1) throw new Error("npm SLSA provenance signature count is not exact.");

  const statement = decodePayload(envelope.payload);
  if (
    statement._type !== "https://in-toto.io/Statement/v1"
    || statement.predicateType !== SLSA_PREDICATE
  ) throw new Error("npm provenance statement identity is invalid.");
  const subject = array(statement.subject, "npm provenance subject");
  if (subject.length !== 1) throw new Error("npm provenance must bind exactly one subject.");
  const subjectRecord = record(subject[0], "npm provenance subject");
  const subjectDigest = record(subjectRecord.digest, "npm provenance subject digest");
  if (
    subjectRecord.name !== `pkg:npm/${coordinate.releasePackage.name.replace(/^@/, "%40")}@${coordinate.version}`
    || subjectDigest.sha512 !== coordinate.sha512
  ) throw new Error("npm provenance subject does not bind the exact package tarball.");

  const predicate = record(statement.predicate, "npm provenance predicate");
  const buildDefinition = record(predicate.buildDefinition, "npm provenance build definition");
  const external = record(buildDefinition.externalParameters, "npm provenance external parameters");
  const workflow = record(external.workflow, "npm provenance workflow");
  if (
    buildDefinition.buildType !== WORKFLOW_BUILD_TYPE
    || workflow.ref !== `refs/tags/${coordinate.verifiedTag}`
    || workflow.repository !== `https://github.com/${REPOSITORY}`
    || workflow.path !== coordinate.releasePackage.workflowPath
  ) throw new Error("npm provenance does not bind the exact release workflow and tag.");

  const internal = record(buildDefinition.internalParameters, "npm provenance internal parameters");
  const github = record(internal.github, "npm provenance GitHub parameters");
  if (github.event_name !== "push" || github.repository_id !== REPOSITORY_ID) {
    throw new Error("npm provenance does not bind the exact GitHub repository event.");
  }
  const dependencies = array(buildDefinition.resolvedDependencies, "npm provenance dependencies");
  if (dependencies.length !== 1) throw new Error("npm provenance must bind one source dependency.");
  const source = record(dependencies[0], "npm provenance source dependency");
  const sourceDigest = record(source.digest, "npm provenance source digest");
  if (
    source.uri !== `git+https://github.com/${REPOSITORY}@refs/tags/${coordinate.verifiedTag}`
    || sourceDigest.gitCommit !== coordinate.verifiedSha
  ) throw new Error("npm provenance does not bind the exact reviewed Git commit.");

  const runDetails = record(predicate.runDetails, "npm provenance run details");
  const builder = record(runDetails.builder, "npm provenance builder");
  const metadata = record(runDetails.metadata, "npm provenance run metadata");
  const invocation = text(
    metadata.invocationId,
    /^https:\/\/github\.com\/hraness\/message-like-me\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u,
    "npm provenance invocation",
  );
  if (builder.id !== "https://github.com/actions/runner/github-hosted" || invocation.length > 256) {
    throw new Error("npm provenance builder or invocation is invalid.");
  }
  const invocationMatch =
    /^https:\/\/github\.com\/hraness\/message-like-me\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u
      .exec(invocation);
  if (invocationMatch === null) throw new Error("npm provenance invocation is invalid.");
  const [, runId, attemptText] = invocationMatch;
  const attempt = Number(attemptText);
  if (
    (coordinate.requiredRunId !== undefined && runId !== coordinate.requiredRunId)
    || (coordinate.maximumAttempt !== undefined && attempt > coordinate.maximumAttempt)
    || (coordinate.requiredAttempt !== undefined && attempt !== coordinate.requiredAttempt)
  ) throw new Error("npm provenance is not bound to an allowed workflow run attempt.");
  return Object.freeze({ bundle, invocation });
}

async function readBoundedProcessOutput(
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
      if (length > MAXIMUM_AUDIT_BYTES) {
        kill();
        throw new Error("npm provenance verification output exceeded its bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function runNpm(command: string[], cwd: string, environment: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(["npm", ...command], {
    cwd,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  const kill = () => child.kill(9);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 300_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedProcessOutput(child.stdout, kill),
      readBoundedProcessOutput(child.stderr, kill),
    ]);
    if (timedOut) throw new Error(`npm ${command[0] ?? "command"} timed out during provenance verification.`);
    if (exitCode !== 0) {
      const diagnosticState = stderr.byteLength === 0
        ? "without diagnostic output"
        : "with redacted diagnostic output";
      throw new Error(`npm ${command[0] ?? "command"} failed during provenance verification ${diagnosticState}.`);
    }
    return stdout.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

async function verifyReleaseSigner(
  bundle: JsonRecord,
  input: Readonly<{ invocation: string; verifiedSha: string; verifiedTag: string; workflowPath: string }>,
  tufCachePath: string,
): Promise<void> {
  const serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_AUDIT_BYTES) {
    throw new Error("npm Sigstore bundle exceeded its process-input bound.");
  }
  const environment = publicReleaseEnvironment();
  const child = Bun.spawn([
    "node",
    resolve(import.meta.dir, "verify-npm-provenance-signer.mjs"),
    input.verifiedTag,
    input.verifiedSha,
    input.invocation,
    tufCachePath,
    input.workflowPath,
  ], {
    env: environment,
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  child.stdin.write(serialized);
  child.stdin.end();
  let timedOut = false;
  const kill = () => child.kill(9);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 60_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedProcessOutput(child.stdout, kill),
      readBoundedProcessOutput(child.stderr, kill),
    ]);
    if (timedOut) throw new Error("npm Sigstore signer verification timed out.");
    if (exitCode !== 0 || stdout.toString("utf8") !== "verified\n" || stderr.byteLength !== 0) {
      throw new Error("npm Sigstore signer identity verification failed.");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyNpmProvenance(
  tarballBytes: Uint8Array,
  input: Readonly<{
    maximumAttempt?: number;
    releasePackage?: ReleasePackage;
    requiredAttempt?: number;
    requiredRunId?: string;
    verifiedSha: string;
    verifiedTag: string;
    version: string;
  }>,
): Promise<void> {
  const releasePackage = input.releasePackage === undefined
    ? rootReleasePackage
    : releasePackageForName(input.releasePackage.name);
  if (!SEMVER.test(input.version)) {
    throw new Error("npm provenance verification coordinate is invalid.");
  }
  const directory = await mkdtemp(join(tmpdir(), "message-like-me-npm-provenance-"));
  try {
    const npmrc = join(directory, ".npmrc");
    const globalNpmrc = join(directory, "global.npmrc");
    const cache = join(directory, "cache");
    await Promise.all([
      writeFile(npmrc, `registry=${REGISTRY}\naudit=false\nfund=false\n`, { mode: 0o600 }),
      writeFile(globalNpmrc, "", { mode: 0o600 }),
      writeFile(join(directory, "package.json"), `${JSON.stringify({
        dependencies: { [releasePackage.name]: input.version },
        private: true,
        type: "module",
      }, null, 2)}\n`, { mode: 0o600 }),
    ]);
    const environment = publicReleaseEnvironment({
      CI: "true",
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_REGISTRY: REGISTRY,
      NPM_CONFIG_USERCONFIG: npmrc,
    });
    await runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `${releasePackage.name}@${input.version}`,
    ], directory, environment);
    const auditOutput = await runNpm([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
    ], directory, environment);
    if (Buffer.byteLength(auditOutput, "utf8") > MAXIMUM_AUDIT_BYTES) {
      throw new Error("npm provenance verification result exceeded its bound.");
    }
    let audit: unknown;
    try {
      audit = JSON.parse(auditOutput) as unknown;
    } catch {
      throw new Error("npm provenance verification did not return JSON.");
    }
    const provenance = parseVerifiedNpmProvenance(audit, {
      ...(input.maximumAttempt === undefined ? {} : { maximumAttempt: input.maximumAttempt }),
      releasePackage,
      ...(input.requiredAttempt === undefined ? {} : { requiredAttempt: input.requiredAttempt }),
      ...(input.requiredRunId === undefined ? {} : { requiredRunId: input.requiredRunId }),
      sha512: createHash("sha512").update(tarballBytes).digest("hex"),
      verifiedSha: input.verifiedSha,
      verifiedTag: input.verifiedTag,
      version: input.version,
    });
    await verifyReleaseSigner(provenance.bundle, {
      invocation: provenance.invocation,
      verifiedSha: input.verifiedSha,
      verifiedTag: input.verifiedTag,
      workflowPath: releasePackage.workflowPath,
    }, join(cache, "_tuf"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
