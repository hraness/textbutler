#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WORKFLOW_PATH = ".github/workflows";
const PRODUCTION_REF = "refs/heads/website-production";
const CANARY_REF = "refs/heads/website-production-writer-canary";
const PRODUCTION_RECEIPT_SCHEMA = "message-like-me-workflow-range-v1";
const CANARY_RECEIPT_SCHEMA = "message-like-me-canary-workflow-range-v1";
const EXPECTED_REPOSITORY = "hraness/textbutler";
const EXPECTED_REPOSITORY_ID = 1_342_143_606;
const MAIN_REF = "refs/heads/main";
const PRODUCTION_CONTROL_EPOCH_DOMAIN = "message-like-me/control-epoch/production/v2";
const CANARY_CONTROL_EPOCH_DOMAIN = "message-like-me/control-epoch/canary/v2";
const PRODUCTION_CONTROL_EPOCH_SCHEMA = "message-like-me-production-control-epoch-v2";
const CANARY_CONTROL_EPOCH_SCHEMA = "message-like-me-canary-control-epoch-v2";
const SITE_CONTROL_EPOCH_DOMAIN = "textbutler/control-epoch/site/v1";
const SITE_CONTROL_EPOCH_SCHEMA = "textbutler-site-control-epoch-v1";
export const CONTROL_EPOCH_CANARY_NO_TAG = "no-tag";
const MAXIMUM_GIT_OUTPUT_BYTES = 256 * 1024;
const GIT_TIMEOUT_MILLISECONDS = 120_000;
const WORKFLOW_TREE_CHUNK_SIZE = 64;
const MAXIMUM_ENCODED_RECEIPT_BYTES = 4 * 1024;
const MAXIMUM_ENCODED_CONTROL_EPOCH_RECEIPT_BYTES = 128 * 1024;
export const MAXIMUM_WORKFLOW_RANGE_COMMITS = 250;

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function fail(message) {
  throw new Error(message);
}

function decode(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8.`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value, label) {
  if (!isRecord(value)) fail(`${label} is not an object.`);
  return value;
}

function expectExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has an unexpected shape.`);
  }
}

function expectSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is not one exact commit SHA.`);
  return value;
}

function exactProtectedRef(value = PRODUCTION_REF) {
  if (value !== PRODUCTION_REF && value !== CANARY_REF) {
    fail("workflow-range protected ref is not exact production or canary");
  }
  return value;
}

function schemaForProtectedRef(value) {
  return exactProtectedRef(value) === PRODUCTION_REF
    ? PRODUCTION_RECEIPT_SCHEMA
    : CANARY_RECEIPT_SCHEMA;
}

function exactCommandOutput(result, label) {
  if (
    result === null
    || typeof result !== "object"
    || !Number.isSafeInteger(result.exitCode)
    || !(result.stdout instanceof Uint8Array)
    || !(result.stderr instanceof Uint8Array)
  ) {
    fail(`${label} returned a malformed Git result.`);
  }
  if (result.exitCode !== 0) fail(`${label} failed closed.`);
  return result.stdout;
}

function createDefaultGitRunner(workingDirectory) {
  return (arguments_) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        ...arguments_,
      ],
      {
        cwd: workingDirectory,
        encoding: "buffer",
        env: {
          GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          SSH_ASKPASS: "/bin/false",
        },
        maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MILLISECONDS,
      },
    );
    if (result.error !== undefined || result.status === null) {
      return fail("Git command could not complete within its fixed resource bounds.");
    }
    return Object.freeze({
      exitCode: result.status,
      stderr: new Uint8Array(result.stderr),
      stdout: new Uint8Array(result.stdout),
    });
  };
}

function command(runner, arguments_, label) {
  return exactCommandOutput(runner(arguments_), label);
}

function exactSingleLine(value, label, pattern) {
  const text = decode(value, label);
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail(`${label} is not one canonical line.`);
  }
  const line = text.slice(0, -1);
  if (line.includes("\n") || !pattern.test(line)) fail(`${label} is malformed.`);
  return line;
}

function exactCommit(runner, sha, label) {
  const commit = exactSingleLine(
    command(runner, ["rev-parse", "--verify", `${sha}^{commit}`], label),
    label,
    SHA,
  );
  if (commit !== sha) fail(`${label} did not resolve to the expected exact commit.`);
}

function parseNewCommits(value, verifiedSha) {
  const text = decode(value, "Newly reachable commit inventory");
  if (text.length === 0 || !text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail("Newly reachable commit inventory is empty or malformed.");
  }
  const commits = text.slice(0, -1).split("\n");
  if (commits.length === 0 || commits.length > MAXIMUM_WORKFLOW_RANGE_COMMITS) {
    fail(`Newly reachable commit inventory exceeds the ${String(MAXIMUM_WORKFLOW_RANGE_COMMITS)}-commit bound.`);
  }
  const unique = new Set();
  for (const commit of commits) {
    if (!SHA.test(commit) || unique.has(commit)) {
      fail("Newly reachable commit inventory is noncanonical.");
    }
    unique.add(commit);
  }
  if (!unique.has(verifiedSha)) fail("Newly reachable commit inventory omits the verified release commit.");
  return Object.freeze(commits);
}

function parseWorkflowTrees(value, expectedCount, label) {
  const text = decode(value, label);
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail(`${label} is not canonical line-oriented output.`);
  }
  const rows = text.slice(0, -1).split("\n");
  if (rows.length !== expectedCount || rows.some((row) => !SHA.test(row))) {
    fail(`${label} has an unexpected shape.`);
  }
  return Object.freeze(rows);
}

function readWorkflowTreeOids(runner, commits) {
  const oids = [];
  for (let index = 0; index < commits.length; index += WORKFLOW_TREE_CHUNK_SIZE) {
    const chunk = commits.slice(index, index + WORKFLOW_TREE_CHUNK_SIZE);
    const output = command(
      runner,
      ["rev-parse", ...chunk.map((commit) => `${commit}:${WORKFLOW_PATH}`)],
      "Workflow tree inventory",
    );
    oids.push(...parseWorkflowTrees(output, chunk.length, "Workflow tree inventory"));
  }
  return Object.freeze(oids);
}

function normalizedWorkflowRangeReceipt(value) {
  const receipt = expectRecord(value, "workflow-range receipt");
  expectExactKeys(receipt, [
    "newCommitCount",
    "newCommitDigest",
    "previousSha",
    "productionRef",
    "schema",
    "verifiedSha",
    "workflowTreeOid",
  ], "workflow-range receipt");
  const productionRef = exactProtectedRef(receipt.productionRef);
  if (receipt.schema !== schemaForProtectedRef(productionRef)) {
    fail("workflow-range receipt has the wrong schema or production ref.");
  }
  if (
    !Number.isSafeInteger(receipt.newCommitCount)
    || receipt.newCommitCount <= 0
    || receipt.newCommitCount > MAXIMUM_WORKFLOW_RANGE_COMMITS
  ) {
    fail("workflow-range receipt has an invalid commit count.");
  }
  if (typeof receipt.newCommitDigest !== "string" || !SHA256.test(receipt.newCommitDigest)) {
    fail("workflow-range receipt has an invalid commit digest.");
  }
  return Object.freeze({
    newCommitCount: receipt.newCommitCount,
    newCommitDigest: receipt.newCommitDigest,
    previousSha: expectSha(receipt.previousSha, "workflow-range receipt previousSha"),
    productionRef,
    schema: receipt.schema,
    verifiedSha: expectSha(receipt.verifiedSha, "workflow-range receipt verifiedSha"),
    workflowTreeOid: expectSha(receipt.workflowTreeOid, "workflow-range receipt workflowTreeOid"),
  });
}

function verifyProtectedWorkflowRange({
  previousSha,
  productionRef,
  runner,
  verifiedSha,
  workingDirectory = process.cwd(),
}) {
  const oldCommit = expectSha(previousSha, "workflow-range previous SHA");
  const newCommit = expectSha(verifiedSha, "workflow-range verified SHA");
  const protectedRef = exactProtectedRef(productionRef);
  if (oldCommit === newCommit) fail("workflow-range verification requires one advancing transition.");
  const git = runner ?? createDefaultGitRunner(workingDirectory);

  const shallow = exactSingleLine(
    command(git, ["rev-parse", "--is-shallow-repository"], "Repository shallow-state check"),
    "Repository shallow-state check",
    /^(?:false|true)$/u,
  );
  if (shallow !== "false") fail("Workflow range requires complete, non-shallow Git history.");
  exactCommit(git, oldCommit, "Previous production commit identity");
  exactCommit(git, newCommit, "Verified release commit identity");

  const ancestry = git(["merge-base", "--is-ancestor", oldCommit, newCommit]);
  if (ancestry.exitCode !== 0) {
    fail("Workflow range does not prove complete fast-forward ancestry.");
  }
  const commits = parseNewCommits(command(
    git,
    ["rev-list", "--topo-order", "--reverse", `${oldCommit}..${newCommit}`],
    "Newly reachable commit inventory",
  ), newCommit);
  const allCommits = Object.freeze([oldCommit, ...commits]);
  const trees = readWorkflowTreeOids(git, allCommits);
  const baselineTree = trees[0];
  if (baselineTree === undefined) fail("Baseline workflow tree is unavailable.");
  const type = exactSingleLine(
    command(git, ["cat-file", "-t", baselineTree], "Baseline workflow tree type"),
    "Baseline workflow tree type",
    /^[a-z]+$/u,
  );
  if (type !== "tree") fail("Baseline workflow path is not a Git tree.");
  const changedIndex = trees.findIndex((tree) => tree !== baselineTree);
  if (changedIndex >= 0) {
    const changedCommit = allCommits[changedIndex];
    fail(`Commit ${String(changedCommit)} changes ${WORKFLOW_PATH}; use the reviewed control-epoch digest.`);
  }

  return normalizedWorkflowRangeReceipt(Object.freeze({
    newCommitCount: commits.length,
    newCommitDigest: createHash("sha256").update(`${commits.join("\n")}\n`, "utf8").digest("hex"),
    previousSha: oldCommit,
    productionRef: protectedRef,
    schema: schemaForProtectedRef(protectedRef),
    verifiedSha: newCommit,
    workflowTreeOid: baselineTree,
  }));
}

export function verifyWorkflowRange(input) {
  return verifyProtectedWorkflowRange({ ...input, productionRef: PRODUCTION_REF });
}

export function verifyCanaryWorkflowRange(input) {
  return verifyProtectedWorkflowRange({ ...input, productionRef: CANARY_REF });
}

function assertProtectedWorkflowRangeReceipt(value, {
  previousSha,
  productionRef,
  verifiedSha,
}) {
  const receipt = normalizedWorkflowRangeReceipt(value);
  const oldCommit = expectSha(previousSha, "expected workflow-range previous SHA");
  const newCommit = expectSha(verifiedSha, "expected workflow-range verified SHA");
  const protectedRef = exactProtectedRef(productionRef);
  if (
    receipt.previousSha !== oldCommit ||
    receipt.productionRef !== protectedRef ||
    receipt.verifiedSha !== newCommit
  ) {
    fail("workflow-range receipt does not bind the leased production transition.");
  }
  return receipt;
}

export function assertWorkflowRangeReceipt(value, expected) {
  return assertProtectedWorkflowRangeReceipt(
    value,
    { ...expected, productionRef: PRODUCTION_REF },
  );
}

export function assertCanaryWorkflowRangeReceipt(value, expected) {
  return assertProtectedWorkflowRangeReceipt(
    value,
    { ...expected, productionRef: CANARY_REF },
  );
}

export function encodeWorkflowRangeReceipt(value) {
  const receipt = normalizedWorkflowRangeReceipt(value);
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_ENCODED_RECEIPT_BYTES) {
    fail("Encoded workflow-range receipt exceeds its byte bound.");
  }
  return encoded;
}

export function decodeWorkflowRangeReceipt(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAXIMUM_ENCODED_RECEIPT_BYTES
    || !BASE64URL.test(value)
  ) {
    fail("Encoded workflow-range receipt is missing or malformed.");
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("Encoded workflow-range receipt is noncanonical.");
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Encoded workflow-range")) throw error;
    fail("Encoded workflow-range receipt is not canonical JSON.");
  }
  return normalizedWorkflowRangeReceipt(decoded);
}

function exactString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is missing or malformed.`);
  return value;
}

function exactPositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} is not one positive integer.`);
  return parsed;
}

function controlEpochBoundary(mode) {
  if (mode === "site") {
    return Object.freeze({ domain: SITE_CONTROL_EPOCH_DOMAIN, protectedRef: PRODUCTION_REF, schema: SITE_CONTROL_EPOCH_SCHEMA });
  }
  if (mode === "production") {
    return Object.freeze({
      domain: PRODUCTION_CONTROL_EPOCH_DOMAIN,
      protectedRef: PRODUCTION_REF,
      schema: PRODUCTION_CONTROL_EPOCH_SCHEMA,
    });
  }
  if (mode === "canary") {
    return Object.freeze({
      domain: CANARY_CONTROL_EPOCH_DOMAIN,
      protectedRef: CANARY_REF,
      schema: CANARY_CONTROL_EPOCH_SCHEMA,
    });
  }
  fail("control-epoch mode is not exact production or canary.");
}

function controlEpochModeForReceipt(receipt) {
  if (receipt.schema === SITE_CONTROL_EPOCH_SCHEMA && receipt.domain === SITE_CONTROL_EPOCH_DOMAIN && receipt.protectedRef === PRODUCTION_REF) return "site";
  if (
    receipt.schema === PRODUCTION_CONTROL_EPOCH_SCHEMA
    && receipt.domain === PRODUCTION_CONTROL_EPOCH_DOMAIN
    && receipt.protectedRef === PRODUCTION_REF
  ) return "production";
  if (
    receipt.schema === CANARY_CONTROL_EPOCH_SCHEMA
    && receipt.domain === CANARY_CONTROL_EPOCH_DOMAIN
    && receipt.protectedRef === CANARY_REF
  ) return "canary";
  fail("control-epoch receipt has the wrong domain, schema, or protected ref.");
}

function readControlEpochInventory({ inventoryEndSha, previousSha, runner, workingDirectory }) {
  const oldCommit = expectSha(previousSha, "control-epoch previous SHA");
  const inventoryEndCommit = expectSha(inventoryEndSha, "control-epoch inventory-end SHA");
  if (oldCommit === inventoryEndCommit) fail("control-epoch verification requires one advancing transition.");
  const git = runner ?? createDefaultGitRunner(workingDirectory);
  const shallow = exactSingleLine(
    command(git, ["rev-parse", "--is-shallow-repository"], "Control-epoch shallow-state check"),
    "Control-epoch shallow-state check",
    /^(?:false|true)$/u,
  );
  if (shallow !== "false") fail("Control epoch requires complete, non-shallow Git history.");
  exactCommit(git, oldCommit, "Control-epoch previous commit identity");
  exactCommit(git, inventoryEndCommit, "Control-epoch inventory-end commit identity");
  if (git(["merge-base", "--is-ancestor", oldCommit, inventoryEndCommit]).exitCode !== 0) {
    fail("Control epoch does not prove complete fast-forward ancestry.");
  }
  const commits = parseNewCommits(command(
    git,
    ["rev-list", "--topo-order", "--reverse", `${oldCommit}..${inventoryEndCommit}`],
    "Control-epoch commit inventory",
  ), inventoryEndCommit);
  const orderedCommits = Object.freeze([oldCommit, ...commits]);
  const trees = readWorkflowTreeOids(git, orderedCommits);
  const baselineTree = trees[0];
  if (baselineTree === undefined) fail("Control-epoch baseline workflow tree is unavailable.");
  const type = exactSingleLine(
    command(git, ["cat-file", "-t", baselineTree], "Control-epoch baseline workflow tree type"),
    "Control-epoch baseline workflow tree type",
    /^[a-z]+$/u,
  );
  if (type !== "tree") fail("Control-epoch baseline workflow path is not a Git tree.");
  const inventory = Object.freeze(orderedCommits.map((commitSha, index) => Object.freeze({
    commitSha,
    workflowTreeOid: trees[index],
  })));
  return Object.freeze({ git, inventory, inventoryEndCommit, oldCommit });
}

function controlEpochChanges(inventory) {
  const changes = [];
  for (let index = 1; index < inventory.length; index += 1) {
    const previous = inventory[index - 1];
    const current = inventory[index];
    if (previous === undefined || current === undefined) fail("Control-epoch inventory is incomplete.");
    if (current.workflowTreeOid !== previous.workflowTreeOid) {
      changes.push(Object.freeze({
        commitSha: current.commitSha,
        previousWorkflowTreeOid: previous.workflowTreeOid,
        workflowTreeOid: current.workflowTreeOid,
      }));
    }
  }
  if (changes.length === 0) fail("Control-epoch receipt has no ordered workflow change.");
  return Object.freeze(changes);
}

function controlEpochPreimage(value) {
  return Object.freeze({
    domain: value.domain,
    repositoryId: value.repositoryId,
    protectedRef: value.protectedRef,
    previousSha: value.previousSha,
    targetSha: value.targetSha,
    workflowSha: value.workflowSha,
    tag: value.tag,
    inventory: value.inventory,
  });
}

export function controlEpochDigest(value) {
  const preimage = controlEpochPreimage(value);
  return createHash("sha256").update(JSON.stringify(preimage), "utf8").digest("hex");
}

function normalizedControlEpochReceipt(value) {
  const receipt = expectRecord(value, "control-epoch receipt");
  expectExactKeys(receipt, [
    "changes",
    "digest",
    "domain",
    "inventory",
    "previousSha",
    "protectedRef",
    "repository",
    "repositoryId",
    "schema",
    "tag",
    "targetSha",
    "workflowSha",
  ], "control-epoch receipt");
  const mode = controlEpochModeForReceipt(receipt);
  if (receipt.repository !== EXPECTED_REPOSITORY || receipt.repositoryId !== EXPECTED_REPOSITORY_ID) {
    fail("control-epoch receipt has the wrong repository boundary.");
  }
  const previousSha = expectSha(receipt.previousSha, "control-epoch receipt previousSha");
  const targetSha = expectSha(receipt.targetSha, "control-epoch receipt targetSha");
  const workflowSha = expectSha(receipt.workflowSha, "control-epoch receipt workflowSha");
  const tag = mode === "site" ? receipt.tag : exactString(receipt.tag, "control-epoch receipt tag");
  if (mode === "site" ? tag !== null : mode === "production" ? !STABLE_TAG.test(tag) : tag !== CONTROL_EPOCH_CANARY_NO_TAG) {
    fail("control-epoch receipt has the wrong production tag or canary no-tag sentinel.");
  }
  if (!Array.isArray(receipt.inventory) || receipt.inventory.length < 2 || receipt.inventory.length > MAXIMUM_WORKFLOW_RANGE_COMMITS + 1) {
    fail("control-epoch receipt has an invalid inventory bound.");
  }
  const seen = new Set();
  const inventory = Object.freeze(receipt.inventory.map((entry, index) => {
    const item = expectRecord(entry, `control-epoch inventory[${String(index)}]`);
    expectExactKeys(item, ["commitSha", "workflowTreeOid"], `control-epoch inventory[${String(index)}]`);
    const commitSha = expectSha(item.commitSha, `control-epoch inventory[${String(index)}].commitSha`);
    if (seen.has(commitSha)) fail("control-epoch receipt inventory repeats a commit.");
    seen.add(commitSha);
    return Object.freeze({
      commitSha,
      workflowTreeOid: expectSha(
        item.workflowTreeOid,
        `control-epoch inventory[${String(index)}].workflowTreeOid`,
      ),
    });
  }));
  if (
    previousSha === targetSha
    || inventory[0]?.commitSha !== previousSha
    || inventory.at(-1)?.commitSha !== workflowSha
    || !inventory.some((entry) => entry.commitSha === targetSha)
  ) {
    fail("control-epoch receipt inventory does not bind its old, target, and workflow-source SHAs.");
  }
  const baselineTree = inventory[0]?.workflowTreeOid;
  if (baselineTree === undefined || !inventory.slice(1).some((entry) => entry.workflowTreeOid !== baselineTree)) {
    fail("control-epoch receipt does not contain an actual workflow-tree change.");
  }
  const changes = controlEpochChanges(inventory);
  if (JSON.stringify(receipt.changes) !== JSON.stringify(changes)) {
    fail("control-epoch receipt ordered changes do not match its inventory.");
  }
  const normalized = Object.freeze({
    changes,
    digest: exactString(receipt.digest, "control-epoch receipt digest"),
    domain: receipt.domain,
    inventory,
    previousSha,
    protectedRef: receipt.protectedRef,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    schema: receipt.schema,
    tag,
    targetSha,
    workflowSha,
  });
  if (!SHA256.test(normalized.digest) || controlEpochDigest(normalized) !== normalized.digest) {
    fail("control-epoch receipt digest does not bind its complete preimage.");
  }
  return normalized;
}

function exactControlEpochTag(mode, tag, targetSha, git) {
  if (mode === "site") {
    if (tag !== null) fail("Site control epoch cannot claim a package release tag.");
    return null;
  }
  if (mode === "canary") {
    if (tag !== CONTROL_EPOCH_CANARY_NO_TAG) {
      fail("Canary control epoch requires the exact no-tag sentinel.");
    }
    return tag;
  }
  if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
    fail("Production control epoch requires one stable annotated tag.");
  }
  const tagRef = `refs/tags/${tag}`;
  const type = exactSingleLine(
    command(git, ["cat-file", "-t", tagRef], "Control-epoch annotated tag type"),
    "Control-epoch annotated tag type",
    /^[a-z]+$/u,
  );
  if (type !== "tag") fail("Production control-epoch tag is not annotated.");
  const commit = exactSingleLine(
    command(git, ["rev-parse", "--verify", `${tagRef}^{commit}`], "Control-epoch tag target"),
    "Control-epoch tag target",
    SHA,
  );
  if (commit !== targetSha) fail("Production control-epoch tag does not target the exact release SHA.");
  return tag;
}

function inspectControlEpochCoordinate({
  currentMainSha,
  mode,
  previousSha,
  protectedRef,
  repository,
  repositoryId,
  runner,
  tag,
  targetSha,
  verifiedSha,
  workflowSha,
  workingDirectory = process.cwd(),
}) {
  const boundary = controlEpochBoundary(mode);
  if (protectedRef !== boundary.protectedRef) fail("control-epoch protected ref does not match its mode.");
  if (repository !== EXPECTED_REPOSITORY || exactPositiveInteger(repositoryId, "control-epoch repository ID") !== EXPECTED_REPOSITORY_ID) {
    fail("control epoch must run for exact repository ID 1342143606.");
  }
  const target = expectSha(targetSha ?? verifiedSha, "control-epoch target SHA");
  const source = expectSha(workflowSha, "control-epoch workflow source SHA");
  const currentMain = expectSha(currentMainSha, "control-epoch current-main SHA");
  if (source !== currentMain) fail("control-epoch workflow source drifted from exact current main.");
  const range = readControlEpochInventory({
    inventoryEndSha: source,
    previousSha,
    runner,
    workingDirectory,
  });
  exactCommit(range.git, target, "Control-epoch target commit identity");
  const head = exactSingleLine(
    command(range.git, ["rev-parse", "--verify", "HEAD^{commit}"], "Control-epoch checkout identity"),
    "Control-epoch checkout identity",
    SHA,
  );
  if (head !== source) fail("control-epoch checkout is not the current workflow source SHA.");
  if (target === range.oldCommit || range.git(["merge-base", "--is-ancestor", range.oldCommit, target]).exitCode !== 0) {
    fail("control-epoch target is not an advancing descendant of the protected-ref baseline.");
  }
  if (range.git(["merge-base", "--is-ancestor", target, source]).exitCode !== 0) {
    fail("control-epoch target is not in current workflow-source history.");
  }
  if ((mode === "canary" || mode === "site") && target !== source) {
    fail("canary control epoch target is not the current workflow source SHA.");
  }
  const exactTag = exactControlEpochTag(mode, tag, target, range.git);
  return Object.freeze({ boundary, exactTag, range, source, target });
}

function controlEpochReceiptFromInspection({ boundary, exactTag, range, source, target }) {
  const base = Object.freeze({
    changes: controlEpochChanges(range.inventory),
    domain: boundary.domain,
    inventory: range.inventory,
    previousSha: range.oldCommit,
    protectedRef: boundary.protectedRef,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    schema: boundary.schema,
    tag: exactTag,
    targetSha: target,
    workflowSha: source,
  });
  return normalizedControlEpochReceipt(Object.freeze({
    ...base,
    digest: controlEpochDigest(base),
  }));
}

export function describeControlEpoch(input) {
  return controlEpochReceiptFromInspection(inspectControlEpochCoordinate(input));
}

export class ControlEpochAdmissionError extends Error {
  constructor(message, receipt) {
    super(message);
    this.name = "ControlEpochAdmissionError";
    this.receipt = receipt;
  }
}

function verifyProtectedWorkflowAdmission(input) {
  const inspection = inspectControlEpochCoordinate(input);
  const baselineTree = inspection.range.inventory[0]?.workflowTreeOid;
  if (baselineTree === undefined) fail("control-epoch baseline workflow tree is unavailable.");
  const hasWorkflowChange = inspection.range.inventory
    .slice(1)
    .some((entry) => entry.workflowTreeOid !== baselineTree);
  const rawDigest = input.controlEpochDigest;
  const hasDigest = rawDigest !== undefined && rawDigest !== "";
  if (!hasWorkflowChange) {
    const routine = input.mode === "canary"
      ? verifyCanaryWorkflowRange({
        previousSha: input.previousSha,
        runner: input.runner,
        verifiedSha: input.targetSha ?? input.verifiedSha,
        workingDirectory: input.workingDirectory,
      })
      : verifyWorkflowRange({
        previousSha: input.previousSha,
        runner: input.runner,
        verifiedSha: input.targetSha ?? input.verifiedSha,
        workingDirectory: input.workingDirectory,
      });
    if (hasDigest) fail("Control-epoch digest is forbidden for a routine unchanged-workflow range.");
    return routine;
  }
  const receipt = controlEpochReceiptFromInspection(inspection);
  if (!hasDigest) {
    throw new ControlEpochAdmissionError(
      "Workflow-changing range requires its exact reviewed control-epoch digest before key admission.",
      receipt,
    );
  }
  if (typeof rawDigest !== "string" || !SHA256.test(rawDigest)) {
    throw new ControlEpochAdmissionError("Control-epoch digest is not one lowercase SHA-256 digest.", receipt);
  }
  if (rawDigest !== receipt.digest) {
    throw new ControlEpochAdmissionError("Control-epoch digest does not match the complete bound inventory.", receipt);
  }
  if (
    input.githubActions !== "true"
    || input.eventName !== "workflow_dispatch"
    || input.eventRef !== MAIN_REF
    || expectSha(input.eventSha, "control-epoch event SHA") !== receipt.workflowSha
    || exactPositiveInteger(input.runAttempt, "control-epoch run attempt") !== 1
  ) {
    throw new ControlEpochAdmissionError(
      "Control epoch is not one manual attempt-1 dispatch from exact current main.",
      receipt,
    );
  }
  return receipt;
}

export function verifyProductionWorkflowAdmission(input) {
  return verifyProtectedWorkflowAdmission({
    ...input,
    mode: "production",
    protectedRef: input.protectedRef ?? PRODUCTION_REF,
  });
}

export function verifySiteWorkflowAdmission(input) {
  return verifyProtectedWorkflowAdmission({ ...input, mode: "site", protectedRef: PRODUCTION_REF, tag: null });
}

export function assertSiteWorkflowAdmissionReceipt(value, expected) {
  if (isRecord(value) && value.schema === SITE_CONTROL_EPOCH_SCHEMA) {
    const receipt = normalizedControlEpochReceipt(value);
    if (controlEpochModeForReceipt(receipt) !== "site" || receipt.previousSha !== expected.previousSha ||
        receipt.targetSha !== expected.targetSha || receipt.workflowSha !== expected.targetSha || receipt.tag !== null) {
      fail("site control epoch does not bind the exact current-main transition.");
    }
    return receipt;
  }
  return assertWorkflowRangeReceipt(value, { previousSha: expected.previousSha, verifiedSha: expected.targetSha });
}

export function verifyCanaryWorkflowAdmission(input) {
  return verifyProtectedWorkflowAdmission({
    ...input,
    mode: "canary",
    protectedRef: input.protectedRef ?? CANARY_REF,
    tag: input.tag ?? CONTROL_EPOCH_CANARY_NO_TAG,
  });
}

export function assertProductionControlEpochReceipt(value, expected) {
  const receipt = normalizedControlEpochReceipt(value);
  if (
    controlEpochModeForReceipt(receipt) !== "production"
    || receipt.previousSha !== expectSha(expected.previousSha, "expected control-epoch previous SHA")
    || receipt.targetSha !== expectSha(expected.targetSha ?? expected.verifiedSha, "expected control-epoch target SHA")
    || receipt.workflowSha !== expectSha(expected.workflowSha, "expected control-epoch workflow SHA")
    || receipt.tag !== expected.tag
  ) fail("production control-epoch receipt does not bind the expected transition.");
  return receipt;
}

export function assertCanaryControlEpochReceipt(value, expected) {
  const receipt = normalizedControlEpochReceipt(value);
  if (
    controlEpochModeForReceipt(receipt) !== "canary"
    || receipt.previousSha !== expectSha(expected.previousSha, "expected canary control-epoch previous SHA")
    || receipt.targetSha !== expectSha(expected.targetSha ?? expected.verifiedSha, "expected canary control-epoch target SHA")
    || receipt.workflowSha !== expectSha(expected.workflowSha, "expected canary control-epoch workflow SHA")
    || receipt.tag !== CONTROL_EPOCH_CANARY_NO_TAG
  ) fail("canary control-epoch receipt does not bind the expected transition.");
  return receipt;
}

export function encodeControlEpochReceipt(value) {
  const receipt = normalizedControlEpochReceipt(value);
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_ENCODED_CONTROL_EPOCH_RECEIPT_BYTES) {
    fail("Encoded control-epoch receipt exceeds its byte bound.");
  }
  return encoded;
}

export function decodeControlEpochReceipt(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAXIMUM_ENCODED_CONTROL_EPOCH_RECEIPT_BYTES
    || !BASE64URL.test(value)
  ) fail("Encoded control-epoch receipt is missing or malformed.");
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("Encoded control-epoch receipt is noncanonical.");
    return normalizedControlEpochReceipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Encoded control-epoch")) throw error;
    if (error instanceof Error && error.message.startsWith("control-epoch")) throw error;
    fail("Encoded control-epoch receipt is not canonical JSON.");
  }
}

export function encodeWorkflowAdmissionReceipt(value) {
  if (isRecord(value) && (
    value.schema === PRODUCTION_CONTROL_EPOCH_SCHEMA
    || value.schema === CANARY_CONTROL_EPOCH_SCHEMA
    || value.schema === SITE_CONTROL_EPOCH_SCHEMA
  )) return encodeControlEpochReceipt(value);
  return encodeWorkflowRangeReceipt(value);
}

export function decodeWorkflowAdmissionReceipt(value) {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value)) {
    fail("Encoded workflow admission receipt is missing or malformed.");
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("Encoded workflow admission receipt is noncanonical.");
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Encoded workflow admission")) throw error;
    fail("Encoded workflow admission receipt is not canonical JSON.");
  }
  return isRecord(decoded) && (
    decoded.schema === PRODUCTION_CONTROL_EPOCH_SCHEMA
    || decoded.schema === CANARY_CONTROL_EPOCH_SCHEMA
    || decoded.schema === SITE_CONTROL_EPOCH_SCHEMA
  )
    ? decodeControlEpochReceipt(value)
    : decodeWorkflowRangeReceipt(value);
}

export function assertProductionWorkflowAdmissionReceipt(value, expected) {
  if (isRecord(value) && value.schema === PRODUCTION_CONTROL_EPOCH_SCHEMA) {
    return assertProductionControlEpochReceipt(value, expected);
  }
  return assertWorkflowRangeReceipt(value, {
    previousSha: expected.previousSha,
    verifiedSha: expected.targetSha ?? expected.verifiedSha,
  });
}

export function assertCanaryWorkflowAdmissionReceipt(value, expected) {
  if (isRecord(value) && value.schema === CANARY_CONTROL_EPOCH_SCHEMA) {
    return assertCanaryControlEpochReceipt(value, expected);
  }
  return assertCanaryWorkflowRangeReceipt(value, {
    previousSha: expected.previousSha,
    verifiedSha: expected.targetSha ?? expected.verifiedSha,
  });
}

function writeOutput(name, value) {
  const line = `${name}=${String(value)}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output === "string" && output.length > 0) appendFileSync(output, line, { encoding: "utf8" });
  else process.stdout.write(line);
}

export function writeControlEpochReview(value) {
  const receipt = normalizedControlEpochReceipt(value);
  const title = `Control epoch ${receipt.digest} for ${receipt.protectedRef}`;
  writeOutput("control_epoch_title", title);
  writeOutput("control_epoch_domain", receipt.domain);
  writeOutput("control_epoch_ref", receipt.protectedRef);
  writeOutput("control_epoch_old_sha", receipt.previousSha);
  writeOutput("control_epoch_target_sha", receipt.targetSha);
  writeOutput("control_epoch_workflow_sha", receipt.workflowSha);
  writeOutput("control_epoch_tag", receipt.tag);
  writeOutput("control_epoch_digest", receipt.digest);
  writeOutput("control_epoch_inventory", JSON.stringify(receipt.inventory));
  writeOutput("control_epoch_changes", JSON.stringify(receipt.changes));
  writeOutput("control_epoch_receipt", encodeControlEpochReceipt(receipt));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summary === "string" && summary.length > 0) {
    const changeCommits = new Set(receipt.changes.map((entry) => entry.commitSha));
    const rows = receipt.inventory.map((entry, index) =>
      `| ${String(index)} | \`${entry.commitSha}\` | \`${entry.workflowTreeOid}\` | ${changeCommits.has(entry.commitSha) ? "yes" : "no"} |`
    ).join("\n");
    appendFileSync(summary, [
      `\n## ${title}`,
      "",
      `- Domain: \`${receipt.domain}\``,
      `- Protected ref: \`${receipt.protectedRef}\``,
      `- Old SHA: \`${receipt.previousSha}\``,
      `- Target SHA: \`${receipt.targetSha}\``,
      `- Workflow source SHA: \`${receipt.workflowSha}\``,
      `- Tag: \`${receipt.tag}\``,
      `- Digest: \`${receipt.digest}\``,
      "",
      "| Order | Commit | `.github/workflows` tree | Changed from preceding row |",
      "| ---: | --- | --- | :---: |",
      rows,
      "",
    ].join("\n"), { encoding: "utf8" });
  }
  process.stdout.write(`::notice title=${title}::domain=${receipt.domain} old=${receipt.previousSha} target=${receipt.targetSha} workflow=${receipt.workflowSha} tag=${receipt.tag}\n`);
  return receipt;
}

function admissionInputFromEnvironment(mode, previousSha, targetSha) {
  return Object.freeze({
    controlEpochDigest: process.env.CONTROL_EPOCH_DIGEST,
    currentMainSha: process.env.CURRENT_MAIN_SHA ?? process.env.GITHUB_SHA,
    eventName: process.env.GITHUB_EVENT_NAME,
    eventRef: process.env.GITHUB_REF,
    eventSha: process.env.GITHUB_SHA,
    githubActions: process.env.GITHUB_ACTIONS,
    mode,
    previousSha,
    protectedRef: controlEpochBoundary(mode).protectedRef,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    tag: mode === "production" ? process.env.VERIFIED_TAG : CONTROL_EPOCH_CANARY_NO_TAG,
    targetSha,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  });
}

function main() {
  const [previousSha, verifiedSha, mode, ...extra] = process.argv.slice(2);
  if (previousSha === undefined || verifiedSha === undefined || extra.length > 0) {
    fail("Usage: release-workflow-range.mjs PREVIOUS_SHA VERIFIED_SHA [--canary|--admit-production|--admit-canary]");
  }
  if (process.env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    fail("Workflow range must run for exact repository hraness/textbutler.");
  }
  if (
    mode !== undefined
    && mode !== "--canary"
    && mode !== "--admit-production"
    && mode !== "--admit-canary"
  ) {
    fail("workflow-range mode is not exact production, canary, or control-epoch admission");
  }
  if (mode === "--admit-production" || mode === "--admit-canary") {
    const admissionMode = mode === "--admit-production" ? "production" : "canary";
    let receipt;
    try {
      const input = admissionInputFromEnvironment(admissionMode, previousSha, verifiedSha);
      receipt = admissionMode === "production"
        ? verifyProductionWorkflowAdmission(input)
        : verifyCanaryWorkflowAdmission(input);
    } catch (error) {
      if (error instanceof ControlEpochAdmissionError) writeControlEpochReview(error.receipt);
      throw error;
    }
    if (isRecord(receipt) && (
      receipt.schema === PRODUCTION_CONTROL_EPOCH_SCHEMA
      || receipt.schema === CANARY_CONTROL_EPOCH_SCHEMA
    )) writeControlEpochReview(receipt);
    writeOutput("receipt", encodeWorkflowAdmissionReceipt(receipt));
    return;
  }
  const receipt = mode === "--canary"
    ? verifyCanaryWorkflowRange({ previousSha, verifiedSha })
    : verifyWorkflowRange({ previousSha, verifiedSha });
  process.stdout.write(`receipt=${encodeWorkflowRangeReceipt(receipt)}\n`);
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}
