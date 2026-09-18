#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { MAXIMUM_WORKFLOW_RANGE_COMMITS } from "./release-workflow-range.mjs";

const EXPECTED_REPOSITORY = "hraness/textbutler";
const PRODUCTION_REF = "refs/heads/website-production";
const CANARY_REF = "refs/heads/website-production-writer-canary";
const MAIN_REF = "refs/heads/main";
const FIXED_REMOTE = "https://github.com/hraness/textbutler.git";
const GIT_EXECUTABLE = "/usr/bin/git";
const FIXED_PATH = "/usr/bin:/bin";
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const MAX_TOKEN_BYTES = 4096;
const MAX_DIAGNOSTIC_BYTES = 4096;
const GIT_TIMEOUT_MILLISECONDS = 60_000;
const PROTECTED_REF_ANCESTRY_FETCH_DEPTH = MAXIMUM_WORKFLOW_RANGE_COMMITS + 1;
const STERILE_REF_PREFIX = "refs/message-like-me-release-writer";
const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$MLM_RELEASE_REF_TOKEN" ;;
  *) exit 1 ;;
esac
`;

function fail(message) {
  throw new Error(message);
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is not one exact lowercase SHA`);
  return value;
}

function exactToken(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("MLM_RELEASE_REF_TOKEN is missing or malformed");
  }
  return value;
}

function exactStableTag(value) {
  if (typeof value !== "string" || !STABLE_TAG.test(value)) {
    fail("verified release tag is not one stable semantic-version tag");
  }
  return value;
}

function boundedDiagnostic(value, token) {
  if (typeof value !== "string") return "";
  const redacted = value.replaceAll(token, "[redacted]");
  const framed = redacted.endsWith("\r\n")
    ? redacted.slice(0, -2)
    : redacted.endsWith("\n")
      ? redacted.slice(0, -1)
      : redacted;
  return Buffer.byteLength(framed, "utf8") <= MAX_DIAGNOSTIC_BYTES
    ? framed
    : `${Buffer.from(framed, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")}…`;
}

function protectedRefPushArguments(
  protectedRef,
  expectedOldSha,
  verifiedSha,
  label,
  expectedLabel,
  targetLabel,
  allowSame = false,
) {
  const expectedOld = exactSha(expectedOldSha, expectedLabel);
  const verified = exactSha(verifiedSha, targetLabel);
  if (!allowSame && expectedOld === verified) fail(`${label} is already exact`);
  return Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.proxy=",
    "-c",
    "push.followTags=false",
    "-c",
    "push.gpgSign=false",
    "push",
    "--porcelain",
    `--force-with-lease=${protectedRef}:${expectedOld}`,
    "--no-follow-tags",
    "--no-tags",
    "--no-signed",
    "--no-verify",
    "--recurse-submodules=no",
    FIXED_REMOTE,
    `${verified}:${protectedRef}`,
  ]);
}

export function websiteProductionPushArguments(expectedOldSha, verifiedSha) {
  return protectedRefPushArguments(
    PRODUCTION_REF,
    expectedOldSha,
    verifiedSha,
    "website-production",
    "expected website-production SHA",
    "verified release SHA",
  );
}

export function websiteProductionCanaryPushArguments(expectedOldSha, targetSha) {
  return protectedRefPushArguments(
    CANARY_REF,
    expectedOldSha,
    targetSha,
    "website-production writer canary",
    "expected canary SHA",
    "canary target SHA",
  );
}

export function websiteProductionCanaryStaleLeasePushArguments(staleExpectedSha) {
  return protectedRefPushArguments(
    CANARY_REF,
    staleExpectedSha,
    staleExpectedSha,
    "website-production writer canary stale-lease probe",
    "stale expected canary SHA",
    "canary rollback probe SHA",
    true,
  );
}

function parseRequiredStatusErroredDenial(error, input) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.replaceAll("\r\n", "\n").split("\n");
  const violationMarker = "GH013:";
  const ruleReasonMarker = "remote: - ";
  const requiredStatusMarker = "Required status check ";
  const violationLines = lines.filter((line) => line.includes("GH013:"));
  const ruleReasonLines = lines.filter((line) => line.includes(ruleReasonMarker));
  const requiredStatusLines = lines.filter((line) => line.includes("Required status check "));
  const exactViolation = `GH013: Repository rule violations found for ${input.protectedRef}.`;
  const exactReason = `remote: - Required status check "${input.context}" is errored.`;
  const withoutKnownGitDisplaySuffix = (line) => {
    const suffixLength = line.endsWith("        ") ? 8 : line.endsWith(" ") ? 1 : 0;
    return Object.freeze({
      line: suffixLength === 0 ? line : line.slice(0, -suffixLength),
      suffixLength,
    });
  };
  const violation = violationLines.length === 1
    ? withoutKnownGitDisplaySuffix(
      violationLines[0].slice(violationLines[0].indexOf(violationMarker)),
    )
    : Object.freeze({ line: "", suffixLength: -1 });
  const ruleReason = ruleReasonLines.length === 1
    ? withoutKnownGitDisplaySuffix(ruleReasonLines[0])
    : Object.freeze({ line: "", suffixLength: -1 });
  const requiredStatus = requiredStatusLines.length === 1
    ? withoutKnownGitDisplaySuffix(requiredStatusLines[0])
    : Object.freeze({ line: "", suffixLength: -1 });
  if (
    message.split(violationMarker).length !== 2 ||
    message.split(ruleReasonMarker).length !== 2 ||
    message.split(requiredStatusMarker).length !== 2 ||
    violationLines.length !== 1 ||
    ruleReasonLines.length !== 1 ||
    requiredStatusLines.length !== 1 ||
    violation.line !== exactViolation ||
    ruleReason.line !== exactReason ||
    requiredStatus.line !== exactReason ||
    violation.suffixLength !== ruleReason.suffixLength ||
    ruleReason.suffixLength !== requiredStatus.suffixLength
  ) {
    fail(input.failureMessage);
  }
  return Object.freeze({
    classification: "required-status-errored",
    diagnosticSha256: createHash("sha256").update(message, "utf8").digest("hex"),
  });
}

export function parseWebsiteProductionCanaryRequiredStatusDenial(error) {
  return parseRequiredStatusErroredDenial(error, {
    context: "message-like-me/website-production-writer-canary-authority",
    failureMessage: "writer canary push failure is not the exact required-status-errored ruleset denial",
    protectedRef: CANARY_REF,
  });
}

export function parseWebsiteProductionRequiredStatusDenial(error) {
  return parseRequiredStatusErroredDenial(error, {
    context: "message-like-me/website-production-authority",
    failureMessage: "production push failure is not the exact required-status-errored ruleset denial",
    protectedRef: PRODUCTION_REF,
  });
}

export function verifiedReleaseFetchArguments(verifiedTag) {
  const tag = exactStableTag(verifiedTag);
  return Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.proxy=",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    `--depth=${String(PROTECTED_REF_ANCESTRY_FETCH_DEPTH)}`,
    FIXED_REMOTE,
    `refs/tags/${tag}`,
  ]);
}

function protectedBranchFetchArguments(remoteRef, localRef) {
  return Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.proxy=",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    `--depth=${String(PROTECTED_REF_ANCESTRY_FETCH_DEPTH)}`,
    FIXED_REMOTE,
    `${remoteRef}:${localRef}`,
  ]);
}

function runGit(
  spawnImplementation,
  arguments_,
  environment,
  label,
  token,
  workingDirectory,
) {
  const result = spawnImplementation(GIT_EXECUTABLE, arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MILLISECONDS,
  });
  if (result.error !== undefined) {
    const detail = boundedDiagnostic(result.error.message, token);
    fail(`${label} could not start${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  if (result.status !== 0) {
    const detail = boundedDiagnostic(result.stderr, token);
    fail(`${label} failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return result;
}

function exactCommonGitEnvironment(gitDirectory) {
  return Object.freeze({
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_DIR: gitDirectory,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PATH: FIXED_PATH,
  });
}

function initializeSterileRepository(spawnImplementation, root, repositoryDirectory, templateDirectory, token) {
  const environment = Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    LC_ALL: "C",
    PATH: FIXED_PATH,
  });
  runGit(
    spawnImplementation,
    [
      "-c",
      "init.defaultBranch=main",
      "init",
      "--bare",
      "--object-format=sha1",
      `--template=${templateDirectory}`,
      repositoryDirectory,
    ],
    environment,
    "sterile release-writer repository initialization",
    token,
    root,
  );
  const commonEnvironment = exactCommonGitEnvironment(repositoryDirectory);
  const inspection = runGit(
    spawnImplementation,
    ["config", "--local", "--null", "--list"],
    commonEnvironment,
    "sterile release-writer repository config inspection",
    token,
    root,
  );
  const entries = inspection.stdout.split("\0").filter((entry) => entry.length > 0);
  const exact = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf("\n");
    if (separator < 1) fail("sterile release-writer repository config is malformed");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (exact.has(key)) fail("sterile release-writer repository config repeats a key");
    exact.set(key, value);
  }
  const allowedKeys = new Set([
    "core.bare",
    "core.filemode",
    "core.ignorecase",
    "core.precomposeunicode",
    "core.repositoryformatversion",
  ]);
  const ignoreCase = exact.get("core.ignorecase");
  const precomposeUnicode = exact.get("core.precomposeunicode");
  if (
    [...exact.keys()].some((key) => !allowedKeys.has(key)) ||
    exact.get("core.bare") !== "true" ||
    (exact.get("core.filemode") !== "true" && exact.get("core.filemode") !== "false") ||
    (ignoreCase !== undefined && ignoreCase !== "true") ||
    (precomposeUnicode !== undefined &&
      precomposeUnicode !== "true" &&
      precomposeUnicode !== "false") ||
    exact.get("core.repositoryformatversion") !== "0"
  ) {
    fail("sterile release-writer repository config is not exact");
  }
  return commonEnvironment;
}

function withSterileRepository(spawnImplementation, token, prefix, operation) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const askpassPath = join(root, "askpass.sh");
  const repositoryDirectory = join(root, "repository.git");
  const templateDirectory = join(root, "empty-template");
  try {
    mkdirSync(templateDirectory, { mode: 0o700 });
    writeFileSync(askpassPath, ASKPASS, { encoding: "utf8", flag: "wx", mode: 0o700 });
    const commonEnvironment = initializeSterileRepository(
      spawnImplementation,
      root,
      repositoryDirectory,
      templateDirectory,
      token,
    );
    const authenticatedEnvironment = Object.freeze({
      ...commonEnvironment,
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      MLM_RELEASE_REF_TOKEN: token,
    });
    return operation(Object.freeze({
      authenticatedEnvironment,
      commonEnvironment,
      repositoryDirectory,
      root,
    }));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function exactSterileCommit(spawnImplementation, expression, label, token, sterile) {
  const resolved = runGit(
    spawnImplementation,
    ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", expression],
    sterile.commonEnvironment,
    label,
    token,
    sterile.root,
  );
  if (!SHA.test(resolved.stdout.trim()) || resolved.stdout !== `${resolved.stdout.trim()}\n`) {
    fail(`${label} returned a malformed commit identity`);
  }
  return resolved.stdout.trim();
}

function fetchExactCanaryCoordinate(
  spawnImplementation,
  token,
  sterile,
  { expectedCanarySha, targetMainSha, protectedRef = CANARY_REF },
) {
  const canaryLocalRef = `${STERILE_REF_PREFIX}/canary`;
  const mainLocalRef = `${STERILE_REF_PREFIX}/main`;
  runGit(
    spawnImplementation,
    protectedBranchFetchArguments(protectedRef, canaryLocalRef),
    sterile.authenticatedEnvironment,
    "exact writer-canary ref fetch",
    token,
    sterile.root,
  );
  runGit(
    spawnImplementation,
    protectedBranchFetchArguments(MAIN_REF, mainLocalRef),
    sterile.authenticatedEnvironment,
    "exact current-main ref fetch",
    token,
    sterile.root,
  );
  if (
    exactSterileCommit(
      spawnImplementation,
      `${canaryLocalRef}^{commit}`,
      "sterile writer-canary commit",
      token,
      sterile,
    ) !== expectedCanarySha ||
    exactSterileCommit(
      spawnImplementation,
      `${mainLocalRef}^{commit}`,
      "sterile current-main commit",
      token,
      sterile,
    ) !== targetMainSha
  ) {
    fail("sterile writer coordinate does not bind the exact remote refs");
  }
  runGit(
    spawnImplementation,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "merge-base",
      "--is-ancestor",
      expectedCanarySha,
      targetMainSha,
    ],
    sterile.commonEnvironment,
    "canary fast-forward ancestry",
    token,
    sterile.root,
  );
}

function parseProtectedRefPushReceipt(result, input) {
  const expectedOldSha = exactSha(input.expectedOldSha, `${input.label} expected old SHA`);
  const targetSha = exactSha(input.targetSha, `${input.label} target SHA`);
  const escapedRef = input.protectedRef.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const lines = result.stdout.split("\n");
  if (
    lines.length !== 4 ||
    lines[0] !== `To ${FIXED_REMOTE}` ||
    lines[3] !== ""
  ) {
    fail(`${input.label} did not return one exact porcelain push receipt`);
  }
  const match = new RegExp(
    `^ \\t${targetSha}:${escapedRef}\\t([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40})$`,
    "u",
  ).exec(lines[1]);
  if (
    match === null ||
    lines[2] !== "Done" ||
    !expectedOldSha.startsWith(match[1]) ||
    !targetSha.startsWith(match[2])
  ) {
    fail(`${input.label} was not one attributable fast-forward update`);
  }
  return Object.freeze({
    classification: "fast-forward",
    fromSha: expectedOldSha,
    protectedRef: input.protectedRef,
    summarySha256: createHash("sha256").update(lines[1], "utf8").digest("hex"),
    toSha: targetSha,
  });
}

export function advanceWebsiteProductionRef(options) {
  if (options.repository !== EXPECTED_REPOSITORY) {
    fail(`release ref writer is bound to ${EXPECTED_REPOSITORY}`);
  }
  const token = exactToken(options.environment.MLM_RELEASE_REF_TOKEN);
  const verifiedSha = exactSha(options.verifiedSha, "verified release SHA");
  const fetchArguments = verifiedReleaseFetchArguments(options.verifiedTag);
  const pushArguments = websiteProductionPushArguments(options.expectedOldSha, verifiedSha);
  return withSterileRepository(
    options.spawnImplementation,
    token,
    "message-like-me-release-writer-",
    (sterile) => {
    const authenticatedGitEnvironment = Object.freeze({
      ...sterile.authenticatedEnvironment,
    });
    runGit(
      options.spawnImplementation,
      fetchArguments,
      authenticatedGitEnvironment,
      "verified release tag fetch",
      token,
      sterile.root,
    );
    if (
      exactSterileCommit(
        options.spawnImplementation,
        "FETCH_HEAD^{commit}",
        "fetched release commit verification",
        token,
        sterile,
      ) !== verifiedSha
    ) {
      fail("fetched release tag does not peel to the verified release SHA");
    }
    runGit(
      options.spawnImplementation,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-base",
        "--is-ancestor",
        exactSha(options.expectedOldSha, "expected website-production SHA"),
        verifiedSha,
      ],
      sterile.commonEnvironment,
      "website-production fast-forward ancestry",
      token,
      sterile.root,
    );
    const pushResult = runGit(
      options.spawnImplementation,
      pushArguments,
      authenticatedGitEnvironment,
      "website-production Git push",
      token,
      sterile.root,
    );
    return parseProtectedRefPushReceipt(pushResult, {
      expectedOldSha: options.expectedOldSha,
      label: "website-production Git push",
      protectedRef: PRODUCTION_REF,
      targetSha: verifiedSha,
    });
    },
  );
}

export function advanceWebsiteProductionCanaryRef(options) {
  if (options.repository !== EXPECTED_REPOSITORY) {
    fail(`release ref writer is bound to ${EXPECTED_REPOSITORY}`);
  }
  const token = exactToken(options.environment.MLM_RELEASE_REF_TOKEN);
  const expectedOldSha = exactSha(options.expectedOldSha, "expected canary SHA");
  const targetSha = exactSha(options.targetSha, "canary target SHA");
  const workflowSha = exactSha(options.workflowSha, "canary workflow SHA");
  if (targetSha !== workflowSha) {
    fail("canary target must equal the exact current-main workflow source");
  }
  return withSterileRepository(
    options.spawnImplementation,
    token,
    "message-like-me-canary-writer-",
    (sterile) => {
    fetchExactCanaryCoordinate(options.spawnImplementation, token, sterile, {
      expectedCanarySha: expectedOldSha,
      targetMainSha: targetSha,
    });
    const pushResult = runGit(
      options.spawnImplementation,
      websiteProductionCanaryPushArguments(expectedOldSha, targetSha),
      sterile.authenticatedEnvironment,
      "website-production writer canary Git push",
      token,
      sterile.root,
    );
    return parseProtectedRefPushReceipt(pushResult, {
      expectedOldSha,
      label: "website-production writer canary Git push",
      protectedRef: CANARY_REF,
      targetSha,
    });
    },
  );
}

// Site promotion binds an advancing production ref directly to current main.
// It shares the sterile Git transport, ref verification, ancestry and lease
// implementation with the canary; it never fabricates a package tag.
export function advanceWebsiteProductionSiteRef(options) {
  if (options.repository !== EXPECTED_REPOSITORY) fail(`site ref writer is bound to ${EXPECTED_REPOSITORY}`);
  const token = exactToken(options.environment.MLM_RELEASE_REF_TOKEN);
  const expectedOldSha = exactSha(options.expectedOldSha, "expected site production SHA");
  const targetSha = exactSha(options.targetSha, "site target SHA");
  if (targetSha !== exactSha(options.workflowSha, "site workflow SHA")) fail("site target must equal exact current main");
  return withSterileRepository(options.spawnImplementation ?? spawnSync, token, "textbutler-site-writer-", sterile => {
    fetchExactCanaryCoordinate(options.spawnImplementation ?? spawnSync, token, sterile, {
      expectedCanarySha: expectedOldSha, targetMainSha: targetSha, protectedRef: PRODUCTION_REF,
    });
    const result = runGit(options.spawnImplementation ?? spawnSync,
      websiteProductionPushArguments(expectedOldSha, targetSha), sterile.authenticatedEnvironment,
      "website-production Git push", token, sterile.root);
    return parseProtectedRefPushReceipt(result, { expectedOldSha, targetSha, protectedRef: PRODUCTION_REF, label: "website-production Git push" });
  });
}

export function proveWebsiteProductionSiteRequiredStatusDenial(options) {
  try { advanceWebsiteProductionSiteRef(options); }
  catch (error) { return parseWebsiteProductionRequiredStatusDenial(error); }
  fail("site production writer without current status unexpectedly succeeded");
}

export function proveWebsiteProductionCanaryStaleLease(options) {
  if (options.repository !== EXPECTED_REPOSITORY) {
    fail(`release ref writer is bound to ${EXPECTED_REPOSITORY}`);
  }
  const token = exactToken(options.environment.MLM_RELEASE_REF_TOKEN);
  const staleExpectedSha = exactSha(options.staleExpectedSha, "stale expected canary SHA");
  const currentSha = exactSha(options.currentSha, "current canary SHA");
  if (staleExpectedSha === currentSha) {
    fail("stale canary lease probe requires one completed advancing transition");
  }
  return withSterileRepository(
    options.spawnImplementation,
    token,
    "message-like-me-canary-stale-writer-",
    (sterile) => {
    fetchExactCanaryCoordinate(options.spawnImplementation, token, sterile, {
      expectedCanarySha: currentSha,
      targetMainSha: currentSha,
    });
    if (
      exactSterileCommit(
        options.spawnImplementation,
        `${staleExpectedSha}^{commit}`,
        "sterile stale writer-canary commit",
        token,
        sterile,
      ) !== staleExpectedSha
    ) {
      fail("stale canary lease probe does not bind the exact stale commit");
    }
    runGit(
      options.spawnImplementation,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-base",
        "--is-ancestor",
        staleExpectedSha,
        currentSha,
      ],
      sterile.commonEnvironment,
      "stale canary rollback ancestry",
      token,
      sterile.root,
    );
    const result = options.spawnImplementation(
      GIT_EXECUTABLE,
      websiteProductionCanaryStaleLeasePushArguments(staleExpectedSha),
      {
        cwd: sterile.root,
        encoding: "utf8",
        env: sterile.authenticatedEnvironment,
        maxBuffer: MAX_DIAGNOSTIC_BYTES,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MILLISECONDS,
      },
    );
    if (result.error !== undefined || result.status === null) {
      fail("stale canary lease probe was indeterminate");
    }
    if (result.status === 0) {
      fail("stale canary lease probe unexpectedly succeeded");
    }
    const stdout = boundedDiagnostic(result.stdout, token);
    const stderr = boundedDiagnostic(result.stderr, token);
    const lines = stdout.split("\n");
    if (
      result.status !== 1 ||
      lines.length !== 3 ||
      lines[0] !== `To ${FIXED_REMOTE}` ||
      lines[1] !== `!\t${staleExpectedSha}:${CANARY_REF}\t[rejected] (stale info)` ||
      lines[2] !== "Done" ||
      !stderr.includes("failed to push some refs")
    ) {
      fail("stale canary lease probe did not return the exact stale-info denial");
    }
    return Object.freeze({
      classification: "stale-info",
      diagnosticSha256: createHash("sha256")
        .update(`${stdout}\n${stderr}`, "utf8")
        .digest("hex"),
    });
    },
  );
}

export function advanceWebsiteProductionRefFromEnvironment(input) {
  return advanceWebsiteProductionRef({
    environment: input.environment,
    expectedOldSha: input.expectedOldSha,
    repository: input.repository,
    spawnImplementation: spawnSync,
    verifiedSha: input.verifiedSha,
    verifiedTag: input.verifiedTag,
  });
}

export function proveWebsiteProductionRequiredStatusDenialFromEnvironment(input) {
  try {
    advanceWebsiteProductionRefFromEnvironment(input);
  } catch (error) {
    return parseWebsiteProductionRequiredStatusDenial(error);
  }
  fail("production writer without current status unexpectedly succeeded");
}

export function advanceWebsiteProductionCanaryRefFromEnvironment(input) {
  return advanceWebsiteProductionCanaryRef({
    environment: input.environment,
    expectedOldSha: input.expectedOldSha,
    repository: input.repository,
    spawnImplementation: spawnSync,
    targetSha: input.targetSha,
    workflowSha: input.workflowSha,
  });
}

export function proveWebsiteProductionCanaryStaleLeaseFromEnvironment(input) {
  return proveWebsiteProductionCanaryStaleLease({
    currentSha: input.currentSha,
    environment: input.environment,
    repository: input.repository,
    spawnImplementation: spawnSync,
    staleExpectedSha: input.staleExpectedSha,
  });
}
