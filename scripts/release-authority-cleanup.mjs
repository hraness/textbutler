#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS,
  withReleaseAppTokenFromEnvironment,
} from "./release-app-token.mjs";

const EXPECTED_REPOSITORY = "hraness/textbutler";
const EXPECTED_REPOSITORY_ID = 1_342_143_606;
const EXPECTED_APP_ID = 4_830_612;
const EXPECTED_APP_SLUG = "mlm-prod-ref-writer-1342143606";
const EXPECTED_INSTALLATION_ID = 159_058_102;
const AUTHORITY_CONTEXT = "message-like-me/website-production-authority";
const AUTHORITY_DESCRIPTION = "Release authority consumed after the production-ref attempt";
const AUTHORITY_ADMISSION_DESCRIPTION = "Exact release authority admitted for one production-ref attempt";
const EXPECTED_WORKFLOW_NAME = "Terminalize release authority";
const EXPECTED_WORKFLOW_PATH = ".github/workflows/release-authority-cleanup.yml";
const EXPECTED_WORKFLOW_RUN_PATH = EXPECTED_WORKFLOW_PATH;
const PRODUCTION_WORKFLOW_PATH = ".github/workflows/website-production.yml";
const CANARY_WORKFLOW_PATH = ".github/workflows/production-writer-canary.yml";
const LIFECYCLE_RULESET_ID = 21_821_875;
const AUTHORITY_RULESET_ID = 22_290_922;
const LIFECYCLE_RULESET_NAME = "Immutable website-production lifecycle";
const AUTHORITY_RULESET_NAME = "Message Like Me production status authority";
const PRODUCTION_REF = "refs/heads/website-production";
const QUARANTINE_MILLISECONDS = 65 * 60 * 1000;
// GitHub can keep one workflow run alive for 35 days. Inventory one complete
// extra day so no pre-concurrency run can retain a runnable credential-bearing
// job outside the admitted snapshot.
const INVENTORY_WINDOW_MILLISECONDS = 36 * 24 * 60 * 60 * 1000;
const MAX_WORKFLOW_RUNS_PER_WORKFLOW = 1_000;
const MAX_WORKFLOW_RUN_PAGES = 10;
const MAX_RUN_ATTEMPTS = 51;
// Three complete snapshots (initial, post-approval, and post-status) plus the
// fixed final boundary remain below the repository GITHUB_TOKEN's 1,000/hour
// REST allowance even at the admitted maximum.
const MAX_TOTAL_ATTEMPTS = 150;
const MAX_STATUS_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_FINAL_RECEIPT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const SECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const RECEIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value, label) {
  if (!isRecord(value)) fail(`${label} is not an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function exactKeys(value, keys, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} has unexpected keys`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is not a positive integer`);
  return value;
}

function exactSha(value, label) {
  const result = string(value, label);
  if (!SHA.test(result)) fail(`${label} is not one lowercase 40-hex SHA`);
  return result;
}

function exactSha256(value, label) {
  const result = string(value, label);
  if (!SHA256.test(result)) fail(`${label} is not one lowercase SHA-256 digest`);
  return result;
}

function parseTimestamp(value, label, expression) {
  const result = string(value, label);
  if (!expression.test(result)) fail(`${label} is not canonical`);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not real`);
  return Object.freeze({ milliseconds, timestamp: new Date(milliseconds).toISOString() });
}

function receiptTimestamp(value, label) {
  const parsed = parseTimestamp(value, label, RECEIPT_TIMESTAMP);
  if (parsed.timestamp !== value) fail(`${label} is not one exact receipt timestamp`);
  return parsed;
}

function secondTimestamp(value, label) {
  const parsed = parseTimestamp(value, label, SECOND_TIMESTAMP);
  if (parsed.timestamp.replace(".000Z", "Z") !== value) {
    fail(`${label} is not one exact second timestamp`);
  }
  return Object.freeze({ milliseconds: parsed.milliseconds, timestamp: value });
}

function httpDate(value, label) {
  const date = string(value, label);
  if (!HTTP_DATE.test(date)) fail(`${label} is not one canonical HTTP Date`);
  const milliseconds = Date.parse(date);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== date) {
    fail(`${label} is not one real HTTP Date`);
  }
  return Object.freeze({ milliseconds, timestamp: new Date(milliseconds).toISOString() });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readBoundedJson(response, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    fail(`${label} declared an invalid response length`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) fail(`${label} returned no response body`);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail(`${label} returned malformed bytes`);
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        fail(`${label} exceeded its response bound`);
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) throw error;
    fail(`${label} did not return bounded UTF-8 JSON`);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function exactApiUrl(value) {
  const url = new URL(string(value, "GITHUB_API_URL"));
  if (url.href !== "https://api.github.com/" || url.username !== "" || url.password !== "") {
    fail("cleanup API origin is not exact GitHub");
  }
  return url;
}

async function requestJson(apiUrl, token, path, label, init = {}) {
  const url = new URL(path, apiUrl);
  if (url.origin !== "https://api.github.com" || url.username !== "" || url.password !== "") {
    fail(`${label} escaped the exact GitHub API origin`);
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      "User-Agent": "message-like-me-release-authority-cleanup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method: init.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  const isCreation = init.method === "POST";
  if (
    response.redirected !== false
    || (!isCreation && response.headers.get("location") !== null)
  ) {
    fail(`${label} redirected`);
  }
  const expectedStatus = isCreation ? 201 : 200;
  if (response.status !== expectedStatus) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    fail(`${label} returned HTTP ${String(response.status)}`);
  }
  return Object.freeze({
    body: await readBoundedJson(response, label),
    serverDate: httpDate(response.headers.get("date"), `${label} Date`).timestamp,
  });
}

function parseRepository(value) {
  const repository = record(value, "cleanup repository");
  if (
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    repository.default_branch !== "main"
  ) {
    fail("cleanup repository identity is not exact");
  }
}

function parseCombinedRepository(value) {
  const repository = record(value, "cleanup combined repository");
  const owner = record(repository.owner, "cleanup combined repository owner");
  if (
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    repository.name !== "textbutler" ||
    owner.login !== "hraness" ||
    owner.type !== "Organization"
  ) {
    fail("cleanup combined repository identity is not exact");
  }
}

function parseCommitRef(value, expectedRef, label) {
  const ref = record(value, label);
  const object = record(ref.object, `${label} object`);
  const sha = exactSha(object.sha, `${label} SHA`);
  if (
    ref.ref !== expectedRef ||
    ref.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/${expectedRef}` ||
    object.type !== "commit" ||
    object.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/commits/${sha}`
  ) {
    fail(`${label} is not one exact commit ref`);
  }
  return sha;
}

function parseRelease(value, tag, label) {
  const release = record(value, label);
  const assets = Array.isArray(release.assets) ? release.assets : undefined;
  if (assets === undefined) fail(`${label} assets are missing`);
  const version = tag.slice(1);
  const expectedNames = version === "0.8.0"
    ? []
    : ["SHA256SUMS", `hraness-message-like-me-${version}.tgz`];
  const normalizedAssets = assets.map((asset, index) => {
    const item = record(asset, `${label} asset ${String(index)}`);
    const name = string(item.name, `${label} asset name`);
    const assetDigest = string(item.digest, `${label} asset digest`);
    if (
      item.state !== "uploaded" ||
      !SHA256_DIGEST.test(assetDigest) ||
      !Number.isSafeInteger(item.id) || item.id < 1 ||
      !Number.isSafeInteger(item.size) || item.size < 1 ||
      item.browser_download_url !==
        `https://github.com/${EXPECTED_REPOSITORY}/releases/download/${tag}/${name}`
    ) {
      fail(`${label} asset ${name} is not exact and immutable`);
    }
    return Object.freeze({ digest: assetDigest, id: item.id, name, size: item.size });
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
  const orderedExpectedNames = [...expectedNames].sort(compareCodeUnits);
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    JSON.stringify(normalizedAssets.map((asset) => asset.name)) !==
      JSON.stringify(orderedExpectedNames)
  ) {
    fail(`${label} is not exact, current, immutable, and artifact-complete`);
  }
  return Object.freeze({
    assets: Object.freeze(normalizedAssets),
    id: positiveInteger(release.id, `${label} id`),
    publishedAt: secondTimestamp(release.published_at, `${label} published_at`).timestamp,
    tag,
  });
}

function exactRulesetDetail(value, expected) {
  const detail = record(value, `${expected.label} detail`);
  const conditions = record(detail.conditions, `${expected.label} conditions`);
  const refName = record(conditions.ref_name, `${expected.label} ref condition`);
  const links = record(detail._links, `${expected.label} links`);
  const self = record(links.self, `${expected.label} self link`);
  const html = record(links.html, `${expected.label} html link`);
  if (
    detail.id !== expected.id || detail.name !== expected.name ||
    detail.target !== "branch" || detail.source_type !== "Repository" ||
    detail.source !== EXPECTED_REPOSITORY || detail.enforcement !== "active" ||
    JSON.stringify(refName.exclude) !== "[]" ||
    JSON.stringify(refName.include) !== JSON.stringify([PRODUCTION_REF]) ||
    (Object.hasOwn(detail, "bypass_actors") && JSON.stringify(detail.bypass_actors) !== "[]") ||
    (Object.hasOwn(detail, "current_user_can_bypass") && detail.current_user_can_bypass !== "never") ||
    self.href !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/rulesets/${String(expected.id)}` ||
    html.href !== `https://github.com/${EXPECTED_REPOSITORY}/rules/${String(expected.id)}` ||
    !Array.isArray(detail.rules)
  ) {
    fail(`${expected.label} detail is not exact`);
  }
  return detail.rules;
}

function parseAuthorityRules(value) {
  const closure = record(value, "cleanup authority rules closure");
  if (!Array.isArray(closure.effective) || closure.effective.length !== 4) {
    fail("cleanup authority effective rules are not the exact four-rule closure");
  }
  const lifecycleTypes = new Set(["creation", "deletion", "non_fast_forward"]);
  let authorityFound = false;
  for (const item of closure.effective) {
    const rule = record(item, "cleanup authority effective rule");
    if (
      lifecycleTypes.has(rule.type) && rule.ruleset_id === LIFECYCLE_RULESET_ID &&
      rule.ruleset_source_type === "Repository" && rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      lifecycleTypes.delete(rule.type);
      continue;
    }
    if (
      rule.type === "required_status_checks" && rule.ruleset_id === AUTHORITY_RULESET_ID &&
      rule.ruleset_source_type === "Repository" && rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      const parameters = record(rule.parameters, "cleanup authority parameters");
      const checks = parameters.required_status_checks;
      if (
        authorityFound || parameters.do_not_enforce_on_create !== false ||
        parameters.strict_required_status_checks_policy !== false ||
        !Array.isArray(checks) || checks.length !== 1 || !isRecord(checks[0]) ||
        checks[0].context !== AUTHORITY_CONTEXT || checks[0].integration_id !== EXPECTED_APP_ID
      ) {
        fail("cleanup authority effective status rule is not exact");
      }
      authorityFound = true;
      continue;
    }
    fail("cleanup authority effective rules contain an unknown rule");
  }
  if (lifecycleTypes.size !== 0 || !authorityFound) {
    fail("cleanup authority rules omit a lifecycle or status rule");
  }
  const lifecycle = exactRulesetDetail(closure.lifecycle, {
    id: LIFECYCLE_RULESET_ID,
    label: "cleanup lifecycle ruleset",
    name: LIFECYCLE_RULESET_NAME,
  });
  if (
    lifecycle.length !== 3 ||
    JSON.stringify(lifecycle.map((item) => record(item, "cleanup lifecycle rule").type)) !==
      JSON.stringify(["creation", "deletion", "non_fast_forward"])
  ) {
    fail("cleanup lifecycle ruleset has unexpected rules");
  }
  const authority = exactRulesetDetail(closure.authority, {
    id: AUTHORITY_RULESET_ID,
    label: "cleanup authority ruleset",
    name: AUTHORITY_RULESET_NAME,
  });
  if (authority.length !== 1) fail("cleanup authority ruleset does not have one rule");
  const rule = record(authority[0], "cleanup authority detail rule");
  const parameters = record(rule.parameters, "cleanup authority detail parameters");
  const checks = parameters.required_status_checks;
  if (
    rule.type !== "required_status_checks" ||
    parameters.do_not_enforce_on_create !== false ||
    parameters.strict_required_status_checks_policy !== false ||
    !Array.isArray(checks) || checks.length !== 1 || !isRecord(checks[0]) ||
    checks[0].context !== AUTHORITY_CONTEXT || checks[0].integration_id !== EXPECTED_APP_ID
  ) {
    fail("cleanup authority detail status rule is not exact");
  }
  return Object.freeze({
    authority: Object.freeze({
      doNotEnforceOnCreate: false,
      integrationId: EXPECTED_APP_ID,
      name: AUTHORITY_RULESET_NAME,
      rulesetId: AUTHORITY_RULESET_ID,
      strict: false,
    }),
    lifecycle: Object.freeze({ name: LIFECYCLE_RULESET_NAME, rulesetId: LIFECYCLE_RULESET_ID }),
  });
}

function normalizeRules(value) {
  const receipt = record(value, "cleanup rules receipt");
  const bodySha256 = record(receipt.bodySha256, "cleanup rules body digests");
  const serverDates = record(receipt.serverDates, "cleanup rules server Dates");
  const expectedRules = Object.freeze({
    authority: Object.freeze({
      doNotEnforceOnCreate: false,
      integrationId: EXPECTED_APP_ID,
      name: AUTHORITY_RULESET_NAME,
      rulesetId: AUTHORITY_RULESET_ID,
      strict: false,
    }),
    lifecycle: Object.freeze({ name: LIFECYCLE_RULESET_NAME, rulesetId: LIFECYCLE_RULESET_ID }),
  });
  if (JSON.stringify(receipt.rules) !== JSON.stringify(expectedRules)) {
    fail("cleanup normalized rules are not exact");
  }
  return Object.freeze({
    bodySha256: Object.freeze({
      authority: exactSha256(bodySha256.authority, "cleanup authority rules digest"),
      effective: exactSha256(bodySha256.effective, "cleanup effective rules digest"),
      lifecycle: exactSha256(bodySha256.lifecycle, "cleanup lifecycle rules digest"),
    }),
    rules: expectedRules,
    serverDates: Object.freeze({
      authority: receiptTimestamp(serverDates.authority, "cleanup authority rules Date").timestamp,
      effective: receiptTimestamp(serverDates.effective, "cleanup effective rules Date").timestamp,
      lifecycle: receiptTimestamp(serverDates.lifecycle, "cleanup lifecycle rules Date").timestamp,
    }),
  });
}

async function readRules(apiUrl, token, notBefore) {
  const [effective, lifecycle, authority] = await Promise.all([
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/rules/branches/website-production`, "cleanup effective rules"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/rulesets/${String(LIFECYCLE_RULESET_ID)}`, "cleanup lifecycle rules"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/rulesets/${String(AUTHORITY_RULESET_ID)}`, "cleanup authority rules"),
  ]);
  const normalized = normalizeRules({
    bodySha256: {
      authority: digest(authority.body),
      effective: digest(effective.body),
      lifecycle: digest(lifecycle.body),
    },
    rules: parseAuthorityRules({
      authority: authority.body,
      effective: effective.body,
      lifecycle: lifecycle.body,
    }),
    serverDates: {
      authority: authority.serverDate,
      effective: effective.serverDate,
      lifecycle: lifecycle.serverDate,
    },
  });
  if (
    notBefore !== undefined &&
    Object.values(normalized.serverDates).some((date) => Date.parse(date) < Date.parse(notBefore))
  ) {
    fail("cleanup rules snapshot predates its admitted boundary");
  }
  return normalized;
}

function normalizeReleaseEvidence(value, verifiedTag) {
  const release = record(value, "cleanup release evidence");
  const assets = Array.isArray(release.assets) ? release.assets.map((asset, index) => {
    const item = record(asset, `cleanup release evidence asset ${String(index)}`);
    exactKeys(item, ["digest", "id", "name", "size"], "cleanup release evidence asset");
    const assetDigest = string(item.digest, "cleanup release evidence asset digest");
    if (!SHA256_DIGEST.test(assetDigest)) fail("cleanup release asset digest is not exact");
    return Object.freeze({
      digest: assetDigest,
      id: positiveInteger(item.id, "cleanup release evidence asset id"),
      name: string(item.name, "cleanup release evidence asset name"),
      size: positiveInteger(item.size, "cleanup release evidence asset size"),
    });
  }) : undefined;
  if (
    assets === undefined || release.tag !== verifiedTag ||
    !Number.isSafeInteger(release.id) || release.id < 1
  ) {
    fail("cleanup release evidence is malformed");
  }
  return Object.freeze({
    assets: Object.freeze([...assets].sort((left, right) => compareCodeUnits(left.name, right.name))),
    id: release.id,
    publishedAt: secondTimestamp(release.publishedAt, "cleanup Release publication").timestamp,
    tag: verifiedTag,
  });
}

function normalizeCoordinate(value) {
  const coordinate = record(value, "cleanup coordinate");
  exactKeys(coordinate, [
    "expectedProductionSha", "release", "tagObjectSha", "targetSha", "verifiedTag",
    "workflowSha",
  ], "cleanup coordinate");
  const verifiedTag = string(coordinate.verifiedTag, "cleanup verified tag");
  if (!STABLE_TAG.test(verifiedTag)) fail("cleanup verified tag is not stable");
  const targetSha = exactSha(coordinate.targetSha, "cleanup target SHA");
  return Object.freeze({
    expectedProductionSha: exactSha(
      coordinate.expectedProductionSha,
      "cleanup expected production SHA",
    ),
    release: normalizeReleaseEvidence(coordinate.release, verifiedTag),
    tagObjectSha: exactSha(coordinate.tagObjectSha, "cleanup tag object SHA"),
    targetSha,
    verifiedTag,
    workflowSha: exactSha(coordinate.workflowSha, "cleanup workflow SHA"),
  });
}

function normalizeIncident(value) {
  const incident = record(value, "cleanup incident");
  exactKeys(incident, [
    "conclusion", "createdAt", "displayTitle", "event", "headBranch", "headSha", "htmlUrl",
    "repository", "repositoryId", "runAttempt", "runId", "runStartedAt", "status",
    "updatedAt", "url", "workflowId", "workflowPath",
  ], "cleanup incident");
  const conclusion = string(incident.conclusion, "cleanup incident conclusion");
  if (!new Set([
    "action_required", "cancelled", "failure", "stale", "startup_failure", "timed_out",
  ]).has(conclusion) || incident.status !== "completed") {
    fail("cleanup incident is not one failed credential-capable attempt");
  }
  const runId = positiveInteger(incident.runId, "cleanup incident run id");
  const createdAt = secondTimestamp(incident.createdAt, "cleanup incident createdAt").timestamp;
  const runStartedAt = secondTimestamp(
    incident.runStartedAt,
    "cleanup incident runStartedAt",
  ).timestamp;
  const updatedAt = secondTimestamp(incident.updatedAt, "cleanup incident updatedAt").timestamp;
  if (
    Date.parse(runStartedAt) < Date.parse(createdAt) ||
    Date.parse(updatedAt) < Date.parse(runStartedAt) ||
    incident.headBranch !== "main" || incident.repository !== EXPECTED_REPOSITORY ||
    incident.repositoryId !== EXPECTED_REPOSITORY_ID ||
    incident.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${String(runId)}` ||
    incident.htmlUrl !== `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${String(runId)}`
  ) {
    fail("cleanup incident identity or dates are not exact");
  }
  return Object.freeze({
    conclusion,
    createdAt,
    displayTitle: string(incident.displayTitle, "cleanup incident display title"),
    event: string(incident.event, "cleanup incident event"),
    headBranch: "main",
    headSha: exactSha(incident.headSha, "cleanup incident head SHA"),
    htmlUrl: incident.htmlUrl,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: positiveInteger(incident.runAttempt, "cleanup incident attempt"),
    runId,
    runStartedAt,
    status: "completed",
    updatedAt,
    url: incident.url,
    workflowId: positiveInteger(incident.workflowId, "cleanup incident workflow id"),
    workflowPath: string(incident.workflowPath, "cleanup incident workflow path"),
  });
}

function normalizePredecessor(value, targetSha) {
  const predecessor = record(value, "cleanup predecessor");
  if (predecessor.kind === "absent") {
    exactKeys(predecessor, ["kind"], "cleanup absent predecessor");
    return Object.freeze({ kind: "absent" });
  }
  exactKeys(predecessor, [
    "createdAt", "creatorId", "creatorLogin", "creatorNodeId", "description", "kind",
    "state", "statusId", "statusNodeId", "statusUrl", "targetSha",
  ], "cleanup App predecessor");
  const state = predecessor.state;
  const expectedDescription = state === "success"
    ? AUTHORITY_ADMISSION_DESCRIPTION
    : state === "error"
      ? AUTHORITY_DESCRIPTION
      : undefined;
  const statusNodeId = string(predecessor.statusNodeId, "cleanup predecessor node id");
  const creatorNodeId = string(predecessor.creatorNodeId, "cleanup predecessor creator node id");
  if (
    predecessor.kind !== "app-status" || expectedDescription === undefined ||
    predecessor.description !== expectedDescription || predecessor.targetSha !== targetSha ||
    predecessor.statusUrl !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    predecessor.creatorLogin !== `${EXPECTED_APP_SLUG}[bot]` ||
    statusNodeId.length < 1 || statusNodeId.length > 512 ||
    creatorNodeId.length < 1 || creatorNodeId.length > 512
  ) {
    fail("cleanup predecessor is not one exact App authority status");
  }
  return Object.freeze({
    createdAt: secondTimestamp(predecessor.createdAt, "cleanup predecessor createdAt").timestamp,
    creatorId: positiveInteger(predecessor.creatorId, "cleanup predecessor creator id"),
    creatorLogin: predecessor.creatorLogin,
    creatorNodeId,
    description: expectedDescription,
    kind: "app-status",
    state,
    statusId: positiveInteger(predecessor.statusId, "cleanup predecessor status id"),
    statusNodeId,
    statusUrl: predecessor.statusUrl,
    targetSha,
  });
}

function normalizePreflight(value) {
  const receipt = record(value, "cleanup preflight receipt");
  exactKeys(receipt, [
    "coordinate", "currentRun", "incident", "inventory", "predecessor",
    "quarantineUntil", "repository", "rules", "schema", "serverDates",
  ], "cleanup preflight receipt");
  if (
    receipt.schema !== "message-like-me-release-authority-cleanup-preflight-v2" ||
    receipt.repository !== EXPECTED_REPOSITORY
  ) {
    fail("cleanup preflight receipt has the wrong boundary");
  }
  const coordinate = normalizeCoordinate(receipt.coordinate);
  const currentRun = record(receipt.currentRun, "cleanup current run");
  exactKeys(currentRun, ["runAttempt", "runId", "workflowId", "workflowPath"], "cleanup current run");
  if (currentRun.runAttempt !== 1 || currentRun.workflowPath !== EXPECTED_WORKFLOW_RUN_PATH) {
    fail("cleanup current run is not one exact attempt of the cleanup workflow");
  }
  const inventory = record(receipt.inventory, "cleanup credential inventory");
  const workflowRunCounts = record(inventory.workflowRunCounts, "cleanup workflow run counts");
  const workflowStates = record(inventory.workflowStates, "cleanup workflow states");
  const workflowIds = record(inventory.workflowIds, "cleanup workflow ids");
  exactKeys(inventory, [
    "attemptCount", "digest", "freezeAnchorAt", "since", "workflowRunCounts",
    "workflowIds", "workflowStates",
  ], "cleanup credential inventory");
  exactKeys(workflowRunCounts, ["canary", "cleanup", "production"], "cleanup workflow run counts");
  exactKeys(workflowStates, ["canary", "cleanup", "production"], "cleanup workflow states");
  exactKeys(workflowIds, ["canary", "cleanup", "production"], "cleanup workflow ids");
  if (
    workflowStates.canary !== "disabled_manually" ||
    workflowStates.production !== "disabled_manually" ||
    workflowStates.cleanup !== "active"
  ) {
    fail("cleanup credential workflows are not in the exact frozen state");
  }
  for (const value of Object.values(workflowRunCounts)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WORKFLOW_RUNS_PER_WORKFLOW) {
      fail("cleanup workflow run count is outside its bound");
    }
  }
  for (const value of Object.values(workflowIds)) {
    positiveInteger(value, "cleanup workflow id");
  }
  if (currentRun.workflowId !== workflowIds.cleanup) {
    fail("cleanup current run does not bind the cleanup workflow id");
  }
  const incident = normalizeIncident(receipt.incident);
  const expectedIncidentTitle = incident.event === "workflow_run"
    ? `Promote release target ${coordinate.targetSha}`
    : incident.event === "workflow_dispatch"
      ? `Promote release tag ${coordinate.verifiedTag}`
      : undefined;
  if (
    incident.workflowId !== workflowIds.production ||
    incident.workflowPath !== PRODUCTION_WORKFLOW_PATH ||
    expectedIncidentTitle === undefined ||
    incident.displayTitle !== expectedIncidentTitle
  ) {
    fail("cleanup incident does not bind the exact production workflow coordinate");
  }
  const freezeAnchorAt = receiptTimestamp(
    inventory.freezeAnchorAt,
    "cleanup credential freeze anchor",
  ).timestamp;
  if (Date.parse(freezeAnchorAt) < Date.parse(incident.updatedAt)) {
    fail("cleanup credential freeze anchor predates the selected incident");
  }
  const dates = record(receipt.serverDates, "cleanup preflight server Dates");
  exactKeys(dates, [
    "completedAt", "incidentSourceAt", "inventoryAt", "snapshotAt", "statusFirst",
    "statusHistory", "statusSecond",
  ], "cleanup preflight server Dates");
  const serverDates = Object.freeze({
    completedAt: receiptTimestamp(dates.completedAt, "cleanup completed Date").timestamp,
    incidentSourceAt: receiptTimestamp(
      dates.incidentSourceAt,
      "cleanup incident source Date",
    ).timestamp,
    inventoryAt: receiptTimestamp(dates.inventoryAt, "cleanup inventory Date").timestamp,
    snapshotAt: receiptTimestamp(dates.snapshotAt, "cleanup snapshot Date").timestamp,
    statusFirst: receiptTimestamp(dates.statusFirst, "cleanup first status Date").timestamp,
    statusHistory: receiptTimestamp(dates.statusHistory, "cleanup status history Date").timestamp,
    statusSecond: receiptTimestamp(dates.statusSecond, "cleanup second status Date").timestamp,
  });
  if (
    Date.parse(serverDates.inventoryAt) < Date.parse(serverDates.snapshotAt) ||
    Date.parse(serverDates.incidentSourceAt) < Date.parse(serverDates.inventoryAt) ||
    Date.parse(serverDates.statusFirst) < Date.parse(serverDates.incidentSourceAt) ||
    Date.parse(serverDates.statusHistory) < Date.parse(serverDates.statusFirst) ||
    Date.parse(serverDates.statusSecond) < Date.parse(serverDates.statusHistory) ||
    Date.parse(serverDates.completedAt) < Date.parse(serverDates.statusSecond)
  ) {
    fail("cleanup preflight server Dates regress");
  }
  const quarantineUntil = receiptTimestamp(
    receipt.quarantineUntil,
    "cleanup quarantine boundary",
  ).timestamp;
  if (
    Date.parse(quarantineUntil) !==
      Date.parse(freezeAnchorAt) + QUARANTINE_MILLISECONDS ||
    Date.parse(serverDates.completedAt) < Date.parse(quarantineUntil)
  ) {
    fail("cleanup incident token-expiry quarantine is not complete");
  }
  return Object.freeze({
    coordinate,
    currentRun: Object.freeze({
      runAttempt: 1,
      runId: positiveInteger(currentRun.runId, "cleanup current run id"),
      workflowId: positiveInteger(currentRun.workflowId, "cleanup current workflow id"),
      workflowPath: EXPECTED_WORKFLOW_RUN_PATH,
    }),
    incident,
    inventory: Object.freeze({
      attemptCount: positiveInteger(inventory.attemptCount, "cleanup attempt count"),
      digest: exactSha256(inventory.digest, "cleanup credential inventory digest"),
      freezeAnchorAt,
      since: secondTimestamp(inventory.since, "cleanup inventory lower bound").timestamp,
      workflowRunCounts: Object.freeze({
        canary: workflowRunCounts.canary,
        cleanup: workflowRunCounts.cleanup,
        production: workflowRunCounts.production,
      }),
      workflowIds: Object.freeze({
        canary: workflowIds.canary,
        cleanup: workflowIds.cleanup,
        production: workflowIds.production,
      }),
      workflowStates: Object.freeze({
        canary: "disabled_manually",
        cleanup: "active",
        production: "disabled_manually",
      }),
    }),
    predecessor: normalizePredecessor(receipt.predecessor, coordinate.targetSha),
    quarantineUntil,
    repository: EXPECTED_REPOSITORY,
    rules: normalizeRules(receipt.rules),
    schema: "message-like-me-release-authority-cleanup-preflight-v2",
    serverDates,
  });
}

function encodeReceipt(value, normalize, label) {
  const receipt = normalize(value);
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) fail(`${label} exceeds its byte bound`);
  return encoded;
}

function decodeReceipt(value, normalize, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > MAX_RECEIPT_BYTES) {
    fail(`${label} is missing or malformed`);
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail(`${label} is noncanonical`);
    return normalize(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("cleanup")) throw error;
    fail(`${label} is not canonical JSON`);
  }
}

export function encodeCleanupPreflightReceipt(value) {
  return encodeReceipt(value, normalizePreflight, "cleanup preflight receipt");
}

export function decodeCleanupPreflightReceipt(value) {
  return decodeReceipt(value, normalizePreflight, "cleanup preflight receipt");
}

function stablePreflight(value) {
  const { serverDates: _dates, ...stable } = value;
  const { since: _since, ...stableInventory } = stable.inventory;
  return Object.freeze({
    ...stable,
    inventory: stableInventory,
    rules: Object.freeze({
      bodySha256: stable.rules.bodySha256,
      rules: stable.rules.rules,
    }),
  });
}

function allPreflightApiDates(value) {
  return [
    ...Object.values(value.serverDates),
    ...Object.values(value.rules.serverDates),
  ].map((date) => Date.parse(date));
}

function requireLaterPreflight(earlier, later, label) {
  if (Math.min(...allPreflightApiDates(later)) < Math.max(...allPreflightApiDates(earlier))) {
    fail(`${label} API Dates do not form one causal phase boundary`);
  }
}

function rejectCredentialMix(environment, mode) {
  const forbidden = mode === "app"
    ? ["GH_TOKEN", "GITHUB_TOKEN", "MLM_RELEASE_REF_TOKEN"]
    : Object.keys(environment).filter((key) => key.startsWith("MLM_RELEASE_APP_"));
  for (const key of forbidden) {
    if (typeof environment[key] === "string" && environment[key].length > 0) {
      fail(`cleanup ${mode} process unexpectedly received ${key}`);
    }
  }
  if (environment.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    fail(`cleanup ${mode} process is not bound to Message Like Me`);
  }
}

async function readCoordinate(apiUrl, token, expected) {
  const [repository, main, production, tagRef, release] = await Promise.all([
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}`, "cleanup repository"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/git/ref/heads/main`, "cleanup main ref"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/git/ref/heads/website-production`, "cleanup production ref"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/git/ref/tags/${expected.verifiedTag}`, "cleanup tag ref"),
    requestJson(apiUrl, token, `/repos/${EXPECTED_REPOSITORY}/releases/tags/${expected.verifiedTag}`, "cleanup Release"),
  ]);
  parseRepository(repository.body);
  const firstDates = [repository, main, production, tagRef, release]
    .map((item) => Date.parse(item.serverDate));
  if (
    expected.notBefore !== undefined &&
    firstDates.some((date) => date < Date.parse(expected.notBefore))
  ) {
    fail("cleanup coordinate snapshot predates its admitted boundary");
  }
  const mainSha = parseCommitRef(main.body, "refs/heads/main", "cleanup main ref");
  const productionSha = parseCommitRef(production.body, PRODUCTION_REF, "cleanup production ref");
  const tagRefBody = record(tagRef.body, "cleanup tag ref");
  const tagReference = record(tagRefBody.object, "cleanup tag ref object");
  const tagObjectSha = exactSha(tagReference.sha, "cleanup tag object SHA");
  if (
    mainSha !== expected.workflowSha || productionSha !== expected.expectedProductionSha ||
    tagRefBody.ref !== `refs/tags/${expected.verifiedTag}` || tagReference.type !== "tag" ||
    tagReference.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/tags/${tagObjectSha}`
  ) {
    fail("cleanup repository/ref coordinate is not exact");
  }
  const releaseEvidence = parseRelease(release.body, expected.verifiedTag, "cleanup Release");
  if (
    Date.parse(releaseEvidence.publishedAt) > Date.parse(release.serverDate)
  ) {
    fail("cleanup Release was not immutable before the authenticated observation");
  }
  const firstMaximum = Math.max(...firstDates);
  const tagObject = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/git/tags/${tagObjectSha}`,
    "cleanup annotated tag",
  );
  const tag = record(tagObject.body, "cleanup annotated tag");
  const peeled = record(tag.object, "cleanup annotated tag target");
  const targetSha = exactSha(peeled.sha, "cleanup annotated tag target SHA");
  if (
    tag.sha !== tagObjectSha || tag.tag !== expected.verifiedTag ||
    tag.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/tags/${tagObjectSha}` ||
    peeled.type !== "commit" ||
    peeled.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/commits/${targetSha}` ||
    targetSha !== expected.expectedTargetSha || Date.parse(tagObject.serverDate) < firstMaximum
  ) {
    fail("cleanup tag is not the exact admitted annotated commit tag");
  }
  const compare = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/compare/${targetSha}...${expected.workflowSha}`,
    "cleanup current-main ancestry",
  );
  const comparison = record(compare.body, "cleanup comparison");
  const base = record(comparison.base_commit, "cleanup comparison base");
  const mergeBase = record(comparison.merge_base_commit, "cleanup comparison merge base");
  const commits = Array.isArray(comparison.commits) ? comparison.commits : [];
  const terminal = commits.length === 0 ? undefined : record(commits.at(-1), "cleanup terminal commit");
  if (
    Date.parse(compare.serverDate) < Date.parse(tagObject.serverDate) ||
    base.sha !== targetSha || mergeBase.sha !== targetSha ||
    !((comparison.status === "identical" && targetSha === expected.workflowSha && commits.length === 0) ||
      (comparison.status === "ahead" && targetSha !== expected.workflowSha && terminal?.sha === expected.workflowSha))
  ) {
    fail("cleanup target is not reachable from exact current main");
  }
  return Object.freeze({
    completedAt: compare.serverDate,
    coordinate: normalizeCoordinate({
      expectedProductionSha: expected.expectedProductionSha,
      release: releaseEvidence,
      tagObjectSha,
      targetSha,
      verifiedTag: expected.verifiedTag,
      workflowSha: expected.workflowSha,
    }),
  });
}

function workflowExpectation(path) {
  if (path === PRODUCTION_WORKFLOW_PATH) {
    return Object.freeze({ events: new Set(["workflow_dispatch", "workflow_run"]) });
  }
  if (path === CANARY_WORKFLOW_PATH) {
    return Object.freeze({ events: new Set(["workflow_dispatch"]) });
  }
  if (path === EXPECTED_WORKFLOW_RUN_PATH) {
    return Object.freeze({ events: new Set(["workflow_dispatch"]) });
  }
  fail("cleanup workflow inventory contains an unknown workflow path");
}

function parseWorkflowAttempt(value, expectedPath, expectedWorkflowId) {
  const run = record(value, "cleanup workflow attempt");
  const repository = record(run.repository, "cleanup workflow attempt repository");
  const expectation = workflowExpectation(expectedPath);
  const conclusion = run.conclusion;
  const completed = run.status === "completed";
  const allowedStatuses = new Set(["completed", "in_progress", "pending", "queued", "requested", "waiting"]);
  const allowedConclusions = new Set([
    "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
    "startup_failure", "success", "timed_out",
  ]);
  if (
    run.path !== expectedPath ||
    run.workflow_id !== expectedWorkflowId ||
    !expectation.events.has(run.event) || run.head_branch !== "main" ||
    repository.id !== EXPECTED_REPOSITORY_ID || repository.full_name !== EXPECTED_REPOSITORY ||
    run.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/runs/${String(run.id)}` ||
    run.html_url !== `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${String(run.id)}` ||
    !allowedStatuses.has(run.status) || (!completed && conclusion !== null) ||
    (completed && !allowedConclusions.has(conclusion))
  ) {
    fail("cleanup workflow attempt identity is not exact");
  }
  const createdAt = secondTimestamp(run.created_at, "cleanup workflow attempt createdAt").timestamp;
  const runStartedAt = secondTimestamp(
    run.run_started_at,
    "cleanup workflow attempt runStartedAt",
  ).timestamp;
  const updatedAt = secondTimestamp(run.updated_at, "cleanup workflow attempt updatedAt").timestamp;
  if (
    Date.parse(runStartedAt) < Date.parse(createdAt) ||
    Date.parse(updatedAt) < Date.parse(runStartedAt)
  ) fail("cleanup workflow attempt dates regress");
  return Object.freeze({
    conclusion,
    createdAt,
    displayTitle: string(run.display_title, "cleanup workflow display title"),
    event: run.event,
    headBranch: "main",
    headSha: exactSha(run.head_sha, "cleanup workflow attempt head SHA"),
    htmlUrl: run.html_url,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: positiveInteger(run.run_attempt, "cleanup workflow attempt number"),
    runId: positiveInteger(run.id, "cleanup workflow run id"),
    runStartedAt,
    status: string(run.status, "cleanup workflow attempt status"),
    updatedAt,
    url: run.url,
    workflowId: expectedWorkflowId,
    workflowPath: expectedPath,
  });
}

async function readCredentialInventory(apiUrl, token, expected) {
  const files = Object.freeze([
    [expected.productionWorkflowId, PRODUCTION_WORKFLOW_PATH, "production", "Promote website production", "disabled_manually"],
    [expected.canaryWorkflowId, CANARY_WORKFLOW_PATH, "canary", "Prove production ref writer canary", "disabled_manually"],
    [expected.cleanupWorkflowId, EXPECTED_WORKFLOW_RUN_PATH, "cleanup", EXPECTED_WORKFLOW_NAME, "active"],
  ]);
  const attempts = [];
  const counts = { canary: 0, cleanup: 0, production: 0 };
  const states = { canary: undefined, cleanup: undefined, production: undefined };
  let inventoryAt = expected.notBefore;
  const since = expected.since ?? new Date(
    Date.parse(expected.notBefore) - INVENTORY_WINDOW_MILLISECONDS,
  ).toISOString().replace(".000Z", "Z");
  secondTimestamp(since, "cleanup inventory lower bound");
  let workflowFreezeAnchor = 0;
  for (const [workflowId, path, key, name, requiredState] of files) {
    const metadata = await requestJson(
      apiUrl,
      token,
      `/repos/${EXPECTED_REPOSITORY}/actions/workflows/${String(workflowId)}`,
      `cleanup ${key} workflow metadata`,
    );
    if (Date.parse(metadata.serverDate) < Date.parse(inventoryAt)) {
      fail("cleanup workflow metadata Date regressed");
    }
    inventoryAt = metadata.serverDate;
    const workflow = record(metadata.body, `cleanup ${key} workflow metadata`);
    const updatedAt = receiptTimestamp(
      workflow.updated_at,
      `cleanup ${key} workflow updatedAt`,
    ).timestamp;
    if (
      workflow.id !== workflowId || workflow.name !== name || workflow.path !== path.split("@", 1)[0] ||
      workflow.state !== requiredState ||
      workflow.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/actions/workflows/${String(workflowId)}` ||
      workflow.html_url !== `https://github.com/${EXPECTED_REPOSITORY}/blob/main/${path}`
    ) {
      fail(`cleanup ${key} workflow metadata is not exact`);
    }
    states[key] = requiredState;
    if (key !== "cleanup") workflowFreezeAnchor = Math.max(workflowFreezeAnchor, Date.parse(updatedAt));
    const runs = [];
    let declaredTotal;
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
      const listed = await requestJson(
        apiUrl,
        token,
        `/repos/${EXPECTED_REPOSITORY}/actions/workflows/${String(workflowId)}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
        `cleanup ${key} workflow inventory page ${String(page)}`,
      );
      if (Date.parse(listed.serverDate) < Date.parse(inventoryAt)) {
        fail("cleanup workflow inventory Date regressed");
      }
      inventoryAt = listed.serverDate;
      const body = record(listed.body, `cleanup ${key} workflow inventory`);
      const pageRuns = Array.isArray(body.workflow_runs) ? body.workflow_runs : undefined;
      if (
        pageRuns === undefined || pageRuns.length > PAGE_SIZE ||
        !Number.isSafeInteger(body.total_count) || body.total_count < 0 ||
        body.total_count >= MAX_WORKFLOW_RUNS_PER_WORKFLOW ||
        (declaredTotal !== undefined && body.total_count !== declaredTotal)
      ) {
        fail(`cleanup ${key} workflow inventory exceeds its complete bound`);
      }
      declaredTotal = body.total_count;
      runs.push(...pageRuns);
      if (runs.length === declaredTotal) break;
      if (runs.length > declaredTotal || pageRuns.length < PAGE_SIZE || page === MAX_WORKFLOW_RUN_PAGES) {
        fail(`cleanup ${key} workflow inventory is incomplete`);
      }
    }
    if (declaredTotal === undefined || runs.length !== declaredTotal) {
      fail(`cleanup ${key} workflow inventory is incomplete`);
    }
    counts[key] = runs.length;
    for (const latest of runs) {
      const latestRun = parseWorkflowAttempt(latest, path, workflowId);
      if (latestRun.runAttempt > MAX_RUN_ATTEMPTS) fail("cleanup workflow rerun history exceeds its bound");
      for (let attempt = 1; attempt <= latestRun.runAttempt; attempt += 1) {
        if (attempts.length >= MAX_TOTAL_ATTEMPTS) fail("cleanup credential attempt inventory exceeds its bound");
        const response = await requestJson(
          apiUrl,
          token,
          `/repos/${EXPECTED_REPOSITORY}/actions/runs/${String(latestRun.runId)}/attempts/${String(attempt)}`,
          `cleanup workflow attempt ${String(latestRun.runId)}/${String(attempt)}`,
        );
        if (Date.parse(response.serverDate) < Date.parse(inventoryAt)) {
          fail("cleanup workflow attempt Date regressed");
        }
        inventoryAt = response.serverDate;
        const parsed = parseWorkflowAttempt(response.body, path, workflowId);
        if (parsed.runAttempt !== attempt || parsed.runId !== latestRun.runId) {
          fail("cleanup workflow attempt endpoint returned another attempt");
        }
        attempts.push(parsed);
      }
    }
  }
  if (new Set(attempts.map((item) => `${item.runId}/${item.runAttempt}`)).size !== attempts.length) {
    fail("cleanup credential attempt inventory contains duplicates");
  }
  const currentMatches = attempts.filter((item) =>
    item.runId === expected.currentRunId && item.runAttempt === 1);
  if (
    currentMatches.length !== 1 || currentMatches[0].workflowPath !== EXPECTED_WORKFLOW_RUN_PATH ||
    currentMatches[0].headSha !== expected.workflowSha || currentMatches[0].event !== "workflow_dispatch" ||
    currentMatches[0].displayTitle !==
      `Terminalize release authority target ${expected.expectedTargetSha}`
  ) {
    fail("cleanup current run is not in the complete credential inventory");
  }
  const unexpectedActive = attempts.filter((item) =>
    item.status !== "completed" && !(item.runId === expected.currentRunId && item.runAttempt === 1));
  if (unexpectedActive.length !== 0) {
    fail("another credential-capable workflow attempt is nonterminal during cleanup");
  }
  const failed = attempts.filter((item) => {
    if (
      item.workflowPath !== PRODUCTION_WORKFLOW_PATH || item.status !== "completed" ||
      ["success", "skipped", "neutral"].includes(item.conclusion)
    ) return false;
    if (item.event === "workflow_run") {
      return item.displayTitle === `Promote release target ${expected.expectedTargetSha}`;
    }
    return item.event === "workflow_dispatch" &&
      item.displayTitle === `Promote release tag ${expected.verifiedTag}`;
  });
  if (failed.length === 0) {
    fail("cleanup has no failed production incident for the exact target");
  }
  const newestTime = Math.max(...failed.map((item) => Date.parse(item.updatedAt)));
  const newest = failed.filter((item) => Date.parse(item.updatedAt) === newestTime);
  if (newest.length !== 1) {
    fail("cleanup newest failed production incident for the target is ambiguous");
  }
  const incident = newest[0];
  if (
    incident.runId !== expected.incidentRunId ||
    incident.runAttempt !== expected.incidentRunAttempt
  ) {
    fail("cleanup input does not bind the newest failed production incident for the target");
  }
  const stableAttempts = attempts
    .filter((item) => !(item.runId === expected.currentRunId && item.runAttempt === 1))
    .sort((left, right) => left.runId - right.runId || left.runAttempt - right.runAttempt);
  return Object.freeze({
    currentRun: Object.freeze({
      runAttempt: 1,
      runId: expected.currentRunId,
      workflowId: currentMatches[0].workflowId,
      workflowPath: EXPECTED_WORKFLOW_RUN_PATH,
    }),
    incident: normalizeIncident(incident),
    baseFreezeAnchorAt: new Date(Math.max(
      workflowFreezeAnchor,
      ...stableAttempts.map((item) => Date.parse(item.updatedAt)),
    )).toISOString(),
    inventory: Object.freeze({
      attemptCount: attempts.length,
      digest: digest(stableAttempts),
      since,
      workflowIds: Object.freeze({
        canary: expected.canaryWorkflowId,
        cleanup: expected.cleanupWorkflowId,
        production: expected.productionWorkflowId,
      }),
      workflowRunCounts: Object.freeze(counts),
      workflowStates: Object.freeze(states),
    }),
    inventoryAt,
  });
}

function parseCombinedStatus(value, targetSha) {
  const combined = record(value, "cleanup combined status");
  if (
    combined.sha !== targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status` ||
    !Array.isArray(combined.statuses) || !Number.isSafeInteger(combined.total_count) ||
    combined.total_count < 0 || combined.total_count > 100 ||
    combined.total_count !== combined.statuses.length
  ) {
    fail("cleanup combined status does not bind the exact target");
  }
  parseCombinedRepository(combined.repository);
  const matches = combined.statuses.filter((item) => isRecord(item) && item.context === AUTHORITY_CONTEXT);
  if (matches.length > 1) fail("cleanup combined authority status is not unique");
  if (matches.length === 0) return Object.freeze({ kind: "absent" });
  const status = record(matches[0], "cleanup combined authority status");
  const state = status.state;
  const description = state === "success"
    ? AUTHORITY_ADMISSION_DESCRIPTION
    : state === "error"
      ? AUTHORITY_DESCRIPTION
      : undefined;
  const statusNodeId = string(status.node_id, "cleanup combined authority node id");
  if (
    description === undefined || status.description !== description || status.target_url !== null ||
    status.updated_at !== status.created_at ||
    status.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    statusNodeId.length < 1 || statusNodeId.length > 512
  ) {
    fail("cleanup combined authority status is not an admitted or terminal App state");
  }
  return Object.freeze({
    createdAt: secondTimestamp(status.created_at, "cleanup combined authority createdAt").timestamp,
    description,
    kind: "status",
    state,
    statusId: positiveInteger(status.id, "cleanup combined authority id"),
    statusNodeId,
    statusUrl: status.url,
    targetSha,
  });
}

async function readAuthorityPredecessor(apiUrl, token, targetSha, notBefore) {
  const first = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status?per_page=${String(PAGE_SIZE)}`,
    "cleanup first combined authority",
  );
  if (Date.parse(first.serverDate) < Date.parse(notBefore)) fail("cleanup first status Date regressed");
  const firstStatus = parseCombinedStatus(first.body, targetSha);
  const history = [];
  let historyDate = first.serverDate;
  for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
    const response = await requestJson(
      apiUrl,
      token,
      `/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/statuses?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      `cleanup authority history page ${String(page)}`,
    );
    if (Date.parse(response.serverDate) < Date.parse(historyDate)) {
      fail("cleanup authority history Dates regress");
    }
    historyDate = response.serverDate;
    if (!Array.isArray(response.body) || response.body.length > PAGE_SIZE) {
      fail("cleanup authority history page is malformed");
    }
    history.push(...response.body);
    if (response.body.length < PAGE_SIZE) break;
    if (page === MAX_STATUS_PAGES) fail("cleanup authority history exceeds its complete bound");
  }
  const second = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status?per_page=${String(PAGE_SIZE)}`,
    "cleanup second combined authority",
  );
  if (Date.parse(second.serverDate) < Date.parse(historyDate)) fail("cleanup second status Date regressed");
  const secondStatus = parseCombinedStatus(second.body, targetSha);
  if (JSON.stringify(firstStatus) !== JSON.stringify(secondStatus)) {
    fail("cleanup current authority changed across the complete status-history read");
  }
  const contextHistory = history.filter((item) => isRecord(item) && item.context === AUTHORITY_CONTEXT);
  if (firstStatus.kind === "absent") {
    if (contextHistory.length !== 0) fail("cleanup absent authority contradicts status history");
    return Object.freeze({
      predecessor: Object.freeze({ kind: "absent" }),
      serverDates: Object.freeze({
        statusFirst: first.serverDate,
        statusHistory: historyDate,
        statusSecond: second.serverDate,
      }),
    });
  }
  const exactMatches = contextHistory.filter((item) => isRecord(item) && item.id === firstStatus.statusId);
  if (exactMatches.length !== 1) fail("cleanup current authority ID is absent or duplicated in history");
  const exact = record(exactMatches[0], "cleanup current authority history item");
  const creator = record(exact.creator, "cleanup current authority creator");
  const creatorNodeId = string(creator.node_id, "cleanup current authority creator node id");
  if (
    exact.node_id !== firstStatus.statusNodeId || exact.state !== firstStatus.state ||
    exact.description !== firstStatus.description || exact.target_url !== null ||
    exact.created_at !== firstStatus.createdAt || exact.updated_at !== firstStatus.createdAt ||
    exact.url !== firstStatus.statusUrl || creator.login !== `${EXPECTED_APP_SLUG}[bot]` ||
    creator.type !== "Bot" || creator.site_admin !== false ||
    creatorNodeId.length < 1 || creatorNodeId.length > 512
  ) {
    fail("cleanup current authority history does not bind the exact App creator");
  }
  return Object.freeze({
    predecessor: normalizePredecessor({
      createdAt: firstStatus.createdAt,
      creatorId: creator.id,
      creatorLogin: creator.login,
      creatorNodeId,
      description: firstStatus.description,
      kind: "app-status",
      state: firstStatus.state,
      statusId: firstStatus.statusId,
      statusNodeId: firstStatus.statusNodeId,
      statusUrl: firstStatus.statusUrl,
      targetSha,
    }, targetSha),
    serverDates: Object.freeze({
      statusFirst: first.serverDate,
      statusHistory: historyDate,
      statusSecond: second.serverDate,
    }),
  });
}

function rulesStable(left, right) {
  return JSON.stringify(left.rules) === JSON.stringify(right.rules) &&
    JSON.stringify(left.bodySha256) === JSON.stringify(right.bodySha256);
}

async function proveIncidentSourceInCurrentMain(apiUrl, token, incidentSha, workflowSha, notBefore) {
  const response = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/compare/${incidentSha}...${workflowSha}`,
    "cleanup incident workflow-source ancestry",
  );
  if (Date.parse(response.serverDate) < Date.parse(notBefore)) {
    fail("cleanup incident workflow-source ancestry Date regressed");
  }
  const comparison = record(response.body, "cleanup incident workflow-source comparison");
  const base = record(comparison.base_commit, "cleanup incident workflow-source base");
  const mergeBase = record(
    comparison.merge_base_commit,
    "cleanup incident workflow-source merge base",
  );
  const commits = Array.isArray(comparison.commits) ? comparison.commits : [];
  const terminal = commits.length === 0
    ? undefined
    : record(commits.at(-1), "cleanup incident workflow-source terminal commit");
  if (
    base.sha !== incidentSha || mergeBase.sha !== incidentSha ||
    !((comparison.status === "identical" && incidentSha === workflowSha && commits.length === 0) ||
      (comparison.status === "ahead" && incidentSha !== workflowSha && terminal?.sha === workflowSha))
  ) {
    fail("cleanup incident workflow source is not in exact current main history");
  }
  return response.serverDate;
}

export async function createCleanupPreflight(environment) {
  rejectCredentialMix(environment, "read-only");
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  const token = string(environment.GH_TOKEN, "cleanup GH_TOKEN");
  const workflowSha = exactSha(environment.GITHUB_WORKFLOW_SHA, "cleanup workflow SHA");
  const currentRunId = positiveInteger(Number(environment.GITHUB_RUN_ID), "cleanup run id");
  const expectedProductionSha = exactSha(environment.EXPECTED_PRODUCTION_SHA, "cleanup expected production SHA");
  const expectedTargetSha = exactSha(environment.EXPECTED_TARGET_SHA, "cleanup expected target SHA");
  const incidentRunId = positiveInteger(Number(environment.INCIDENT_RUN_ID), "cleanup incident run id");
  const incidentRunAttempt = positiveInteger(
    Number(environment.INCIDENT_RUN_ATTEMPT),
    "cleanup incident attempt",
  );
  const productionWorkflowId = positiveInteger(
    Number(environment.EXPECTED_PRODUCTION_WORKFLOW_ID),
    "cleanup production workflow id",
  );
  const canaryWorkflowId = positiveInteger(
    Number(environment.EXPECTED_CANARY_WORKFLOW_ID),
    "cleanup canary workflow id",
  );
  const cleanupWorkflowId = positiveInteger(
    Number(environment.EXPECTED_CLEANUP_WORKFLOW_ID),
    "cleanup workflow id",
  );
  const verifiedTag = string(environment.VERIFIED_TAG, "cleanup verified tag");
  if (
    environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_SHA !== workflowSha ||
    environment.GITHUB_WORKFLOW !== EXPECTED_WORKFLOW_NAME ||
    environment.GITHUB_WORKFLOW_REF !== `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@refs/heads/main` ||
    environment.GITHUB_RUN_ATTEMPT !== "1" || !STABLE_TAG.test(verifiedTag)
  ) {
    fail("cleanup execution is not one exact current-main workflow dispatch");
  }
  const initialValue = environment.CLEANUP_INITIAL_PREFLIGHT_RECEIPT;
  const initial = typeof initialValue === "string" && initialValue.length > 0
    ? decodeCleanupPreflightReceipt(initialValue)
    : undefined;
  const expected = Object.freeze({
    expectedProductionSha,
    expectedTargetSha,
    verifiedTag,
    workflowSha,
  });
  const firstCoordinate = await readCoordinate(apiUrl, token, expected);
  const firstRules = await readRules(apiUrl, token, firstCoordinate.completedAt);
  const snapshotAt = Object.values(firstRules.serverDates).sort().at(-1);
  const inventory = await readCredentialInventory(apiUrl, token, {
    canaryWorkflowId,
    cleanupWorkflowId,
    currentRunId,
    incidentRunAttempt,
    incidentRunId,
    notBefore: snapshotAt,
    productionWorkflowId,
    expectedTargetSha,
    since: initial?.inventory.since,
    verifiedTag,
    workflowSha,
  });
  if (
    inventory.incident.workflowPath !== PRODUCTION_WORKFLOW_PATH ||
    inventory.incident.workflowId !== productionWorkflowId
  ) {
    fail("cleanup incident does not bind the production workflow");
  }
  const incidentSourceAt = await proveIncidentSourceInCurrentMain(
    apiUrl,
    token,
    inventory.incident.headSha,
    workflowSha,
    inventory.inventoryAt,
  );
  const authority = await readAuthorityPredecessor(
    apiUrl,
    token,
    expectedTargetSha,
    incidentSourceAt,
  );
  const secondCoordinate = await readCoordinate(apiUrl, token, {
    ...expected,
    notBefore: authority.serverDates.statusSecond,
  });
  const secondRules = await readRules(apiUrl, token, secondCoordinate.completedAt);
  const completedAt = Object.values(secondRules.serverDates).sort().at(-1);
  if (
    JSON.stringify(firstCoordinate.coordinate) !== JSON.stringify(secondCoordinate.coordinate) ||
    !rulesStable(firstRules, secondRules) ||
    Date.parse(secondCoordinate.completedAt) < Date.parse(authority.serverDates.statusSecond) ||
    Object.values(secondRules.serverDates).some((date) =>
      Date.parse(date) < Date.parse(secondCoordinate.completedAt))
  ) {
    fail("cleanup coordinate or rules changed across admission");
  }
  const predecessorAt = authority.predecessor.kind === "app-status"
    ? Date.parse(authority.predecessor.createdAt)
    : 0;
  const freezeAnchorAt = initial?.inventory.freezeAnchorAt ?? new Date(Math.max(
    Date.parse(inventory.baseFreezeAnchorAt),
    predecessorAt,
  )).toISOString();
  const quarantineUntil = new Date(Date.parse(freezeAnchorAt) + QUARANTINE_MILLISECONDS).toISOString();
  return normalizePreflight({
    coordinate: secondCoordinate.coordinate,
    currentRun: inventory.currentRun,
    incident: inventory.incident,
    inventory: {
      ...inventory.inventory,
      freezeAnchorAt,
    },
    predecessor: authority.predecessor,
    quarantineUntil,
    repository: EXPECTED_REPOSITORY,
    rules: secondRules,
    schema: "message-like-me-release-authority-cleanup-preflight-v2",
    serverDates: {
      completedAt,
      incidentSourceAt,
      inventoryAt: inventory.inventoryAt,
      snapshotAt,
      statusFirst: authority.serverDates.statusFirst,
      statusHistory: authority.serverDates.statusHistory,
      statusSecond: authority.serverDates.statusSecond,
    },
  });
}

function exactRevocation(value) {
  const receipt = record(value, "cleanup App-token revocation");
  exactKeys(receipt, [
    "converged", "deletionServerDate", "lastObservationServerDate", "observationCount",
    "propagationObserved", "stableDenials",
  ], "cleanup App-token revocation");
  const deletion = receiptTimestamp(receipt.deletionServerDate, "cleanup deletion Date");
  const last = receiptTimestamp(receipt.lastObservationServerDate, "cleanup final denial Date");
  if (
    receipt.converged !== true || receipt.stableDenials !== 2 ||
    !Number.isSafeInteger(receipt.observationCount) || receipt.observationCount < 2 ||
    receipt.observationCount > RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS.length ||
    typeof receipt.propagationObserved !== "boolean" ||
    (receipt.propagationObserved === false && receipt.observationCount !== 2) ||
    (receipt.propagationObserved === true && receipt.observationCount < 3) ||
    last.milliseconds < deletion.milliseconds
  ) {
    fail("cleanup App-token revocation is not conclusive");
  }
  return Object.freeze({
    converged: true,
    deletionServerDate: deletion.timestamp,
    lastObservationServerDate: last.timestamp,
    observationCount: receipt.observationCount,
    propagationObserved: receipt.propagationObserved,
    stableDenials: 2,
  });
}

function parseApp(value) {
  const app = record(value, "cleanup App receipt");
  exactKeys(app, [
    "appId", "appSlug", "clientId", "expiresAt", "installationId", "repositoryId",
  ], "cleanup App receipt");
  if (
    app.appId !== EXPECTED_APP_ID || app.appSlug !== EXPECTED_APP_SLUG ||
    app.installationId !== EXPECTED_INSTALLATION_ID || app.repositoryId !== EXPECTED_REPOSITORY_ID
  ) {
    fail("cleanup App receipt is not the exact status-only App");
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    clientId: string(app.clientId, "cleanup App client id"),
    expiresAt: secondTimestamp(app.expiresAt, "cleanup App token expiry"),
    installationId: EXPECTED_INSTALLATION_ID,
  });
}

function normalizeStatusResponse(value, serverDate, app, targetSha) {
  const status = record(value, "cleanup terminal status response");
  const creator = record(status.creator, "cleanup terminal status creator");
  const created = secondTimestamp(status.created_at, "cleanup terminal status created_at");
  const observed = receiptTimestamp(serverDate, "cleanup terminal status Date");
  const statusNodeId = string(status.node_id, "cleanup terminal status node id");
  const creatorNodeId = string(creator.node_id, "cleanup terminal creator node id");
  if (
    status.context !== AUTHORITY_CONTEXT || status.state !== "error" ||
    status.description !== AUTHORITY_DESCRIPTION || status.target_url !== null ||
    status.updated_at !== status.created_at ||
    status.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    creator.login !== `${EXPECTED_APP_SLUG}[bot]` || creator.type !== "Bot" || creator.site_admin !== false ||
    statusNodeId.length < 1 || statusNodeId.length > 512 ||
    creatorNodeId.length < 1 || creatorNodeId.length > 512 ||
    observed.milliseconds < created.milliseconds || observed.milliseconds >= app.expiresAt.milliseconds ||
    observed.milliseconds - created.milliseconds > 15_000
  ) {
    fail("cleanup terminal status response is not exact");
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    context: AUTHORITY_CONTEXT,
    createdAt: created.timestamp,
    creator: Object.freeze({
      id: positiveInteger(creator.id, "cleanup creator id"),
      login: creator.login,
      nodeId: creatorNodeId,
      siteAdmin: false,
      type: "Bot",
    }),
    description: AUTHORITY_DESCRIPTION,
    installationId: EXPECTED_INSTALLATION_ID,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate: observed.timestamp,
    state: "error",
    statusId: positiveInteger(status.id, "cleanup terminal status id"),
    statusNodeId,
    statusUrl: status.url,
    targetSha,
  });
}

function verifyCombined(value, serverDate, status) {
  const combined = record(value, "cleanup terminal combined status");
  if (
    combined.sha !== status.targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${status.targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${status.targetSha}/status` ||
    !Array.isArray(combined.statuses) || !Number.isSafeInteger(combined.total_count) ||
    combined.total_count < 1 || combined.total_count > 100 ||
    combined.total_count !== combined.statuses.length
  ) {
    fail("cleanup terminal combined status is not exact");
  }
  parseCombinedRepository(combined.repository);
  const matches = combined.statuses.filter((item) => isRecord(item) && item.context === AUTHORITY_CONTEXT);
  if (matches.length !== 1) fail("cleanup terminal combined authority is not unique");
  const match = record(matches[0], "cleanup terminal combined authority");
  if (
    match.id !== status.statusId || match.node_id !== status.statusNodeId ||
    match.state !== "error" || match.description !== status.description || match.target_url !== null ||
    match.created_at !== status.createdAt || match.updated_at !== status.createdAt ||
    match.url !== status.statusUrl
  ) {
    fail("cleanup terminal combined authority does not bind the posted status");
  }
  const observed = receiptTimestamp(serverDate, "cleanup combined status Date");
  if (observed.milliseconds < Date.parse(status.serverDate)) {
    fail("cleanup combined status predates the terminal POST");
  }
  return Object.freeze({
    context: AUTHORITY_CONTEXT,
    serverDate: observed.timestamp,
    state: "error",
    statusCount: combined.statuses.length,
    targetSha: status.targetSha,
    terminalStatusId: status.statusId,
    terminalStatusNodeId: status.statusNodeId,
  });
}

function normalizeAppEvidence(value) {
  const app = record(value, "cleanup terminal App evidence");
  exactKeys(app, [
    "appId", "appSlug", "clientId", "expiresAt", "installationId",
  ], "cleanup terminal App evidence");
  if (
    app.appId !== EXPECTED_APP_ID || app.appSlug !== EXPECTED_APP_SLUG ||
    app.installationId !== EXPECTED_INSTALLATION_ID
  ) {
    fail("cleanup terminal App evidence is not exact");
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    clientId: string(app.clientId, "cleanup terminal App client id"),
    expiresAt: secondTimestamp(app.expiresAt, "cleanup terminal App expiry").timestamp,
    installationId: EXPECTED_INSTALLATION_ID,
  });
}

function normalizeTerminalStatusEvidence(value, targetSha) {
  const status = record(value, "cleanup terminal status evidence");
  exactKeys(status, [
    "appId", "appSlug", "context", "createdAt", "creator", "description",
    "installationId", "repository", "repositoryId", "serverDate", "state",
    "statusId", "statusNodeId", "statusUrl", "targetSha",
  ], "cleanup terminal status evidence");
  const creator = record(status.creator, "cleanup terminal status creator");
  exactKeys(creator, [
    "id", "login", "nodeId", "siteAdmin", "type",
  ], "cleanup terminal status creator");
  const nodeId = string(status.statusNodeId, "cleanup terminal status node id");
  const creatorNodeId = string(creator.nodeId, "cleanup terminal creator node id");
  if (
    status.appId !== EXPECTED_APP_ID || status.appSlug !== EXPECTED_APP_SLUG ||
    status.context !== AUTHORITY_CONTEXT || status.description !== AUTHORITY_DESCRIPTION ||
    status.installationId !== EXPECTED_INSTALLATION_ID ||
    status.repository !== EXPECTED_REPOSITORY || status.repositoryId !== EXPECTED_REPOSITORY_ID ||
    status.state !== "error" || status.targetSha !== targetSha ||
    status.statusUrl !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    creator.login !== `${EXPECTED_APP_SLUG}[bot]` || creator.type !== "Bot" ||
    creator.siteAdmin !== false || nodeId.length < 1 || nodeId.length > 512 ||
    creatorNodeId.length < 1 || creatorNodeId.length > 512
  ) {
    fail("cleanup terminal status evidence is not exact");
  }
  const createdAt = secondTimestamp(status.createdAt, "cleanup terminal status createdAt").timestamp;
  const serverDate = receiptTimestamp(status.serverDate, "cleanup terminal status Date").timestamp;
  if (
    Date.parse(serverDate) < Date.parse(createdAt) ||
    Date.parse(serverDate) - Date.parse(createdAt) > 15_000
  ) {
    fail("cleanup terminal status Date is outside its POST window");
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    context: AUTHORITY_CONTEXT,
    createdAt,
    creator: Object.freeze({
      id: positiveInteger(creator.id, "cleanup terminal creator id"),
      login: creator.login,
      nodeId: creatorNodeId,
      siteAdmin: false,
      type: "Bot",
    }),
    description: AUTHORITY_DESCRIPTION,
    installationId: EXPECTED_INSTALLATION_ID,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate,
    state: "error",
    statusId: positiveInteger(status.statusId, "cleanup terminal status id"),
    statusNodeId: nodeId,
    statusUrl: status.statusUrl,
    targetSha,
  });
}

function normalizeTerminalReadback(value, status) {
  const readback = record(value, "cleanup terminal readback evidence");
  exactKeys(readback, [
    "context", "serverDate", "state", "statusCount", "targetSha",
    "terminalStatusId", "terminalStatusNodeId",
  ], "cleanup terminal readback evidence");
  if (
    readback.context !== AUTHORITY_CONTEXT || readback.state !== "error" ||
    readback.targetSha !== status.targetSha || readback.terminalStatusId !== status.statusId ||
    readback.terminalStatusNodeId !== status.statusNodeId ||
    !Number.isSafeInteger(readback.statusCount) || readback.statusCount < 1 || readback.statusCount > 100
  ) {
    fail("cleanup terminal readback evidence is not exact");
  }
  const serverDate = receiptTimestamp(readback.serverDate, "cleanup terminal readback Date").timestamp;
  if (Date.parse(serverDate) < Date.parse(status.serverDate)) {
    fail("cleanup terminal readback predates its POST");
  }
  return Object.freeze({
    context: AUTHORITY_CONTEXT,
    serverDate,
    state: "error",
    statusCount: readback.statusCount,
    targetSha: status.targetSha,
    terminalStatusId: status.statusId,
    terminalStatusNodeId: status.statusNodeId,
  });
}

function normalizeTerminalReceipt(value) {
  const receipt = record(value, "cleanup terminal receipt");
  exactKeys(receipt, [
    "app", "context", "initialSha256", "predecessorSha256", "preflightSha256",
    "readback", "repository", "repositoryId", "revocation", "schema", "status",
    "targetSha",
  ], "cleanup terminal receipt");
  const targetSha = exactSha(receipt.targetSha, "cleanup terminal target SHA");
  const app = normalizeAppEvidence(receipt.app);
  const status = normalizeTerminalStatusEvidence(receipt.status, targetSha);
  const readback = normalizeTerminalReadback(receipt.readback, status);
  const revocation = exactRevocation(receipt.revocation);
  if (
    receipt.context !== AUTHORITY_CONTEXT || receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.repositoryId !== EXPECTED_REPOSITORY_ID ||
    receipt.schema !== "message-like-me-release-authority-cleanup-terminal-v2" ||
    Date.parse(status.serverDate) >= Date.parse(app.expiresAt) ||
    Date.parse(revocation.deletionServerDate) < Date.parse(readback.serverDate) ||
    Date.parse(revocation.lastObservationServerDate) >= Date.parse(app.expiresAt)
  ) {
    fail("cleanup terminal receipt has the wrong boundary");
  }
  return Object.freeze({
    app,
    context: AUTHORITY_CONTEXT,
    initialSha256: exactSha256(receipt.initialSha256, "cleanup initial preflight digest"),
    predecessorSha256: exactSha256(receipt.predecessorSha256, "cleanup predecessor digest"),
    preflightSha256: exactSha256(receipt.preflightSha256, "cleanup preflight digest"),
    readback,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    revocation,
    schema: "message-like-me-release-authority-cleanup-terminal-v2",
    status,
    targetSha,
  });
}

export function encodeCleanupTerminalReceipt(value) {
  return encodeReceipt(value, normalizeTerminalReceipt, "cleanup terminal receipt");
}

export function decodeCleanupTerminalReceipt(value) {
  return decodeReceipt(value, normalizeTerminalReceipt, "cleanup terminal receipt");
}

export async function terminalizeCleanupAuthority(environment) {
  rejectCredentialMix(environment, "app");
  const initial = decodeCleanupPreflightReceipt(environment.CLEANUP_INITIAL_PREFLIGHT_RECEIPT);
  const preflight = decodeCleanupPreflightReceipt(environment.CLEANUP_PREFLIGHT_RECEIPT);
  if (
    JSON.stringify(stablePreflight(initial)) !== JSON.stringify(stablePreflight(preflight))
  ) {
    fail("cleanup post-approval preflight does not bind the initial admission");
  }
  requireLaterPreflight(initial, preflight, "cleanup post-approval preflight");
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  let revocation;
  const transaction = await withReleaseAppTokenFromEnvironment(
    { ...environment, TARGET: preflight.coordinate.targetSha },
    async (token, appValue) => {
      const app = parseApp(appValue);
      const posted = await requestJson(
        apiUrl,
        token,
        `/repos/${EXPECTED_REPOSITORY}/statuses/${preflight.coordinate.targetSha}`,
        "cleanup terminal status POST",
        {
          body: JSON.stringify({
            context: AUTHORITY_CONTEXT,
            description: AUTHORITY_DESCRIPTION,
            state: "error",
            target_url: null,
          }),
          method: "POST",
        },
      );
      const status = normalizeStatusResponse(
        posted.body,
        posted.serverDate,
        app,
        preflight.coordinate.targetSha,
      );
      if (
        Date.parse(status.serverDate) < Date.parse(preflight.serverDates.completedAt) ||
        (preflight.predecessor.kind === "app-status" && (
          status.statusId === preflight.predecessor.statusId ||
          status.statusNodeId === preflight.predecessor.statusNodeId ||
          Date.parse(status.createdAt) <= Date.parse(preflight.predecessor.createdAt)
        ))
      ) {
        fail("cleanup terminal status is not distinct and causal after admission");
      }
      const combined = await requestJson(
        apiUrl,
        token,
        `/repos/${EXPECTED_REPOSITORY}/commits/${preflight.coordinate.targetSha}/status?per_page=100`,
        "cleanup terminal status readback",
      );
      return Object.freeze({
        app: Object.freeze({
          appId: app.appId,
          appSlug: app.appSlug,
          clientId: app.clientId,
          expiresAt: app.expiresAt.timestamp,
          installationId: app.installationId,
        }),
        readback: verifyCombined(combined.body, combined.serverDate, status),
        status,
      });
    },
    (receipt) => { revocation = receipt; },
  );
  return normalizeTerminalReceipt(Object.freeze({
    app: transaction.app,
    context: AUTHORITY_CONTEXT,
    initialSha256: digest(initial),
    predecessorSha256: digest(preflight.predecessor),
    preflightSha256: digest(preflight),
    readback: transaction.readback,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    revocation,
    schema: "message-like-me-release-authority-cleanup-terminal-v2",
    status: transaction.status,
    targetSha: preflight.coordinate.targetSha,
  }));
}

function normalizePostflight(value) {
  const receipt = record(value, "cleanup postflight receipt");
  exactKeys(receipt, [
    "admittedSha256", "admittedSource", "classification", "observation", "schema",
    "terminalSha256",
  ], "cleanup postflight receipt");
  if (receipt.schema !== "message-like-me-release-authority-cleanup-postflight-v2") {
    fail("cleanup postflight receipt has the wrong schema");
  }
  const observation = normalizePreflight(receipt.observation);
  const observedTerminal = observation.predecessor.kind === "app-status" &&
    observation.predecessor.state === "error";
  if (
    !["initial-fallback", "revalidated"].includes(receipt.admittedSource) ||
    !["terminal-bound", "terminal-observed-unbound", "terminal-not-observed"].includes(
      receipt.classification,
    ) ||
    !(
      receipt.terminalSha256 === null ||
      (typeof receipt.terminalSha256 === "string" && SHA256.test(receipt.terminalSha256))
    ) ||
    (receipt.classification === "terminal-bound") !== (receipt.terminalSha256 !== null) ||
    (receipt.classification === "terminal-observed-unbound") !==
      (receipt.terminalSha256 === null && observedTerminal) ||
    (receipt.classification === "terminal-not-observed") !==
      (receipt.terminalSha256 === null && !observedTerminal)
  ) {
    fail("cleanup postflight classification is not exact");
  }
  return Object.freeze({
    admittedSha256: exactSha256(receipt.admittedSha256, "cleanup admitted digest"),
    admittedSource: receipt.admittedSource,
    classification: receipt.classification,
    observation,
    schema: "message-like-me-release-authority-cleanup-postflight-v2",
    terminalSha256: receipt.terminalSha256,
  });
}

export function encodeCleanupPostflightReceipt(value) {
  return encodeReceipt(value, normalizePostflight, "cleanup postflight receipt");
}

export function decodeCleanupPostflightReceipt(value) {
  return decodeReceipt(value, normalizePostflight, "cleanup postflight receipt");
}

function stablePostflightBoundary(value) {
  const { predecessor: _predecessor, ...stable } = stablePreflight(value);
  return stable;
}

function selectCleanupAdmission(environment) {
  const initial = decodeCleanupPreflightReceipt(environment.CLEANUP_INITIAL_PREFLIGHT_RECEIPT);
  const candidate = environment.CLEANUP_REVALIDATED_PREFLIGHT_RECEIPT;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return Object.freeze({ admitted: initial, initial, source: "initial-fallback" });
  }
  const admitted = decodeCleanupPreflightReceipt(candidate);
  if (
    JSON.stringify(stablePreflight(initial)) !== JSON.stringify(stablePreflight(admitted))
  ) {
    fail("cleanup revalidated admission does not bind the initial preflight");
  }
  requireLaterPreflight(initial, admitted, "cleanup revalidated admission");
  return Object.freeze({ admitted, initial, source: "revalidated" });
}

function predecessorMatchesTerminal(predecessor, terminal) {
  return predecessor.kind === "app-status" && predecessor.state === "error" &&
    predecessor.statusId === terminal.status.statusId &&
    predecessor.statusNodeId === terminal.status.statusNodeId &&
    predecessor.createdAt === terminal.status.createdAt &&
    predecessor.creatorId === terminal.status.creator.id &&
    predecessor.creatorLogin === terminal.status.creator.login &&
    predecessor.creatorNodeId === terminal.status.creator.nodeId &&
    predecessor.targetSha === terminal.targetSha;
}

function combinedMatchesTerminal(predecessor, terminal) {
  return predecessor.kind === "status" && predecessor.state === "error" &&
    predecessor.statusId === terminal.status.statusId &&
    predecessor.statusNodeId === terminal.status.statusNodeId &&
    predecessor.createdAt === terminal.status.createdAt &&
    predecessor.targetSha === terminal.targetSha;
}

export async function createCleanupPostflight(environment) {
  const selected = selectCleanupAdmission(environment);
  const admitted = selected.admitted;
  const observation = await createCleanupPreflight(environment);
  if (
    JSON.stringify(stablePostflightBoundary(admitted)) !==
      JSON.stringify(stablePostflightBoundary(observation))
  ) {
    fail("cleanup postflight does not preserve the admitted coordinate");
  }
  requireLaterPreflight(admitted, observation, "cleanup postflight");
  const terminalValue = environment.CLEANUP_TERMINAL_RECEIPT;
  let classification = observation.predecessor.kind === "app-status" &&
    observation.predecessor.state === "error"
    ? "terminal-observed-unbound"
    : "terminal-not-observed";
  let terminalSha256 = null;
  if (typeof terminalValue === "string" && terminalValue.length > 0) {
    const terminal = decodeCleanupTerminalReceipt(terminalValue);
    if (
      terminal.initialSha256 !== digest(selected.initial) ||
      terminal.preflightSha256 !== digest(admitted) ||
      terminal.predecessorSha256 !== digest(admitted.predecessor) ||
      terminal.targetSha !== admitted.coordinate.targetSha ||
      !predecessorMatchesTerminal(observation.predecessor, terminal) ||
      Date.parse(observation.serverDates.statusFirst) <
        Date.parse(terminal.revocation.lastObservationServerDate)
    ) {
      fail("cleanup postflight does not bind the exact terminal receipt");
    }
    classification = "terminal-bound";
    terminalSha256 = digest(terminal);
  }
  return normalizePostflight(Object.freeze({
    admittedSha256: digest(admitted),
    admittedSource: selected.source,
    classification,
    observation,
    schema: "message-like-me-release-authority-cleanup-postflight-v2",
    terminalSha256,
  }));
}

export async function finalizeCleanupAuthority(environment) {
  rejectCredentialMix(environment, "read-only");
  const selected = selectCleanupAdmission(environment);
  const admitted = selected.admitted;
  const postflight = decodeCleanupPostflightReceipt(environment.CLEANUP_POSTFLIGHT_RECEIPT);
  const terminalValue = environment.CLEANUP_TERMINAL_RECEIPT;
  const terminal = typeof terminalValue === "string" && terminalValue.length > 0
    ? decodeCleanupTerminalReceipt(terminalValue)
    : null;
  if (
    postflight.admittedSha256 !== digest(admitted) ||
    postflight.admittedSource !== selected.source ||
    JSON.stringify(stablePostflightBoundary(postflight.observation)) !==
      JSON.stringify(stablePostflightBoundary(admitted)) ||
    (terminal === null) !== (postflight.classification !== "terminal-bound") ||
    (terminal !== null && (
      postflight.terminalSha256 !== digest(terminal) ||
      terminal.initialSha256 !== digest(selected.initial) ||
      terminal.preflightSha256 !== digest(admitted) ||
      terminal.predecessorSha256 !== digest(admitted.predecessor)
    ))
  ) {
    fail("cleanup final evidence does not bind its admitted boundary");
  }
  if (terminal === null || postflight.classification !== "terminal-bound") {
    fail("cleanup terminal status is unavailable for the final boundary");
  }
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  const token = string(environment.GH_TOKEN, "cleanup GH_TOKEN");
  const observationNotBefore = new Date(
    Math.max(...allPreflightApiDates(postflight.observation)),
  ).toISOString();
  const combinedResponse = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/commits/${terminal.targetSha}/status?per_page=100`,
    "cleanup final terminal status",
  );
  if (Date.parse(combinedResponse.serverDate) < Date.parse(observationNotBefore)) {
    fail("cleanup final terminal status predates postflight");
  }
  const combined = parseCombinedStatus(combinedResponse.body, terminal.targetSha);
  if (!combinedMatchesTerminal(combined, terminal)) {
    fail("cleanup final terminal status does not bind the posted authority");
  }
  const finalRules = await readRules(apiUrl, token, combinedResponse.serverDate);
  if (!rulesStable(admitted.rules, finalRules)) {
    fail("cleanup final rules changed after terminalization");
  }
  const finalRulesDate = new Date(
    Math.max(...Object.values(finalRules.serverDates).map((date) => Date.parse(date))),
  ).toISOString();
  const finalRefResponse = await requestJson(
    apiUrl,
    token,
    `/repos/${EXPECTED_REPOSITORY}/git/ref/heads/website-production`,
    "cleanup final production ref",
  );
  if (Date.parse(finalRefResponse.serverDate) < Date.parse(finalRulesDate)) {
    fail("cleanup final production-ref Date regressed");
  }
  const finalRefSha = parseCommitRef(
    finalRefResponse.body,
    PRODUCTION_REF,
    "cleanup final production ref",
  );
  if (finalRefSha !== admitted.coordinate.expectedProductionSha) {
    fail("cleanup final production ref changed");
  }
  const finalBoundary = Object.freeze({
    productionRef: Object.freeze({
      serverDate: finalRefResponse.serverDate,
      sha: finalRefSha,
    }),
    rules: finalRules,
    terminalStatus: Object.freeze({
      createdAt: combined.createdAt,
      serverDate: combinedResponse.serverDate,
      state: "error",
      statusId: combined.statusId,
      statusNodeId: combined.statusNodeId,
      targetSha: terminal.targetSha,
    }),
  });
  return Object.freeze({
    complete: true,
    finalBoundary,
    initial: selected.initial,
    postflight,
    revalidated: selected.source === "revalidated" ? admitted : null,
    schema: "message-like-me-release-authority-cleanup-final-v2",
    terminal,
  });
}

function normalizeIncompleteFinalReceipt(value) {
  const receipt = record(value, "cleanup incomplete final receipt");
  exactKeys(receipt, [
    "complete", "evidence", "failureSha256", "productionRefReadback",
    "readbackFailureSha256", "repository", "runAttempt", "runId", "schema", "workflowSha",
  ], "cleanup incomplete final receipt");
  if (
    receipt.complete !== false || receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.runAttempt !== 1 ||
    receipt.schema !== "message-like-me-release-authority-cleanup-incomplete-v2"
  ) {
    fail("cleanup incomplete final receipt has the wrong boundary");
  }
  let productionRefReadback = null;
  if (receipt.productionRefReadback !== null) {
    const readback = record(receipt.productionRefReadback, "cleanup incomplete production ref");
    exactKeys(readback, [
      "expectedSha", "preserved", "serverDate", "sha",
    ], "cleanup incomplete production ref");
    const expectedSha = exactSha(readback.expectedSha, "cleanup incomplete expected production SHA");
    const sha = exactSha(readback.sha, "cleanup incomplete production SHA");
    if (readback.preserved !== (sha === expectedSha)) {
      fail("cleanup incomplete production-ref classification is not exact");
    }
    productionRefReadback = Object.freeze({
      expectedSha,
      preserved: readback.preserved,
      serverDate: receiptTimestamp(
        readback.serverDate,
        "cleanup incomplete production-ref Date",
      ).timestamp,
      sha,
    });
  }
  const readbackFailureSha256 = receipt.readbackFailureSha256;
  if (
    (productionRefReadback === null) !== (typeof readbackFailureSha256 === "string") ||
    (typeof readbackFailureSha256 === "string" && !SHA256.test(readbackFailureSha256))
  ) {
    fail("cleanup incomplete production-ref evidence is inconsistent");
  }
  const evidence = normalizeIncompleteEvidence(receipt.evidence);
  return Object.freeze({
    complete: false,
    evidence,
    failureSha256: exactSha256(receipt.failureSha256, "cleanup final failure digest"),
    productionRefReadback,
    readbackFailureSha256,
    repository: EXPECTED_REPOSITORY,
    runAttempt: 1,
    runId: positiveInteger(receipt.runId, "cleanup incomplete run id"),
    schema: "message-like-me-release-authority-cleanup-incomplete-v2",
    workflowSha: exactSha(receipt.workflowSha, "cleanup incomplete workflow SHA"),
  });
}

function normalizeIncompleteEvidenceEntry(value, label, normalize) {
  const entry = record(value, `cleanup incomplete ${label} evidence`);
  exactKeys(entry, ["failureSha256", "receipt"], `cleanup incomplete ${label} evidence`);
  const normalizedReceipt = entry.receipt === null ? null : normalize(entry.receipt);
  const failureSha256 = entry.failureSha256 === null
    ? null
    : exactSha256(entry.failureSha256, `cleanup incomplete ${label} failure digest`);
  if (normalizedReceipt !== null && failureSha256 !== null) {
    fail(`cleanup incomplete ${label} evidence is contradictory`);
  }
  return Object.freeze({ failureSha256, receipt: normalizedReceipt });
}

function normalizeIncompleteEvidence(value) {
  const evidence = record(value, "cleanup incomplete retained evidence");
  exactKeys(evidence, ["initial", "postflight", "revalidated", "terminal"],
    "cleanup incomplete retained evidence");
  return Object.freeze({
    initial: normalizeIncompleteEvidenceEntry(evidence.initial, "initial", normalizePreflight),
    postflight: normalizeIncompleteEvidenceEntry(evidence.postflight, "postflight", normalizePostflight),
    revalidated: normalizeIncompleteEvidenceEntry(
      evidence.revalidated,
      "revalidated",
      normalizePreflight,
    ),
    terminal: normalizeIncompleteEvidenceEntry(evidence.terminal, "terminal", normalizeTerminalReceipt),
  });
}

function sanitizedFailureDigest(error) {
  const name = error instanceof Error ? error.name : "NonError";
  const message = error instanceof Error ? error.message : String(error);
  return digest(Object.freeze({ message: message.slice(0, 1024), name }));
}

function captureIncompleteEvidence(value, decode) {
  if (typeof value !== "string" || value.length === 0) {
    return Object.freeze({ failureSha256: null, receipt: null });
  }
  try {
    return Object.freeze({ failureSha256: null, receipt: decode(value) });
  } catch (error) {
    return Object.freeze({ failureSha256: sanitizedFailureDigest(error), receipt: null });
  }
}

export async function createCleanupIncompleteFinalReceipt(environment, error) {
  rejectCredentialMix(environment, "read-only");
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  const token = string(environment.GH_TOKEN, "cleanup GH_TOKEN");
  const workflowSha = exactSha(environment.GITHUB_WORKFLOW_SHA, "cleanup workflow SHA");
  const runId = positiveInteger(Number(environment.GITHUB_RUN_ID), "cleanup run id");
  const expectedProductionSha = exactSha(
    environment.EXPECTED_PRODUCTION_SHA,
    "cleanup expected production SHA",
  );
  if (
    environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_SHA !== workflowSha ||
    environment.GITHUB_WORKFLOW !== EXPECTED_WORKFLOW_NAME ||
    environment.GITHUB_WORKFLOW_REF !== `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@refs/heads/main` ||
    environment.GITHUB_RUN_ATTEMPT !== "1"
  ) {
    fail("cleanup incomplete receipt is not one exact current-main workflow dispatch");
  }
  let productionRefReadback = null;
  let readbackFailureSha256 = null;
  try {
    const response = await requestJson(
      apiUrl,
      token,
      `/repos/${EXPECTED_REPOSITORY}/git/ref/heads/website-production`,
      "cleanup incomplete production ref",
    );
    const sha = parseCommitRef(
      response.body,
      PRODUCTION_REF,
      "cleanup incomplete production ref",
    );
    productionRefReadback = Object.freeze({
      expectedSha: expectedProductionSha,
      preserved: sha === expectedProductionSha,
      serverDate: response.serverDate,
      sha,
    });
  } catch (readbackError) {
    readbackFailureSha256 = sanitizedFailureDigest(readbackError);
  }
  return normalizeIncompleteFinalReceipt(Object.freeze({
    complete: false,
    evidence: Object.freeze({
      initial: captureIncompleteEvidence(
        environment.CLEANUP_INITIAL_PREFLIGHT_RECEIPT,
        decodeCleanupPreflightReceipt,
      ),
      postflight: captureIncompleteEvidence(
        environment.CLEANUP_POSTFLIGHT_RECEIPT,
        decodeCleanupPostflightReceipt,
      ),
      revalidated: captureIncompleteEvidence(
        environment.CLEANUP_REVALIDATED_PREFLIGHT_RECEIPT,
        decodeCleanupPreflightReceipt,
      ),
      terminal: captureIncompleteEvidence(
        environment.CLEANUP_TERMINAL_RECEIPT,
        decodeCleanupTerminalReceipt,
      ),
    }),
    failureSha256: sanitizedFailureDigest(error),
    productionRefReadback,
    readbackFailureSha256,
    repository: EXPECTED_REPOSITORY,
    runAttempt: 1,
    runId,
    schema: "message-like-me-release-authority-cleanup-incomplete-v2",
    workflowSha,
  }));
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || output.length === 0) fail("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8" });
}

function persistFinalReceipt(receipt, encoded) {
  const receiptSha256 = digest(receipt);
  writeOutput("receipt", encoded);
  writeOutput("receipt_sha256", receiptSha256);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summary === "string" && summary.length > 0) {
    appendFileSync(
      summary,
      `\n- Canonical authority-cleanup receipt SHA-256: \`${receiptSha256}\`\n- Canonical authority-cleanup receipt: \`${encoded}\`\n`,
      { encoding: "utf8" },
    );
  }
  process.stdout.write(`::notice::Authority-cleanup receipt SHA-256 ${receiptSha256}\n`);
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !["preflight", "terminalize", "postflight", "final"].includes(command)) {
    fail("Usage: release-authority-cleanup.mjs preflight|terminalize|postflight|final");
  }
  let receipt;
  let encoded;
  if (command === "preflight") {
    receipt = await createCleanupPreflight(process.env);
    encoded = encodeCleanupPreflightReceipt(receipt);
    writeOutput("target_sha", receipt.coordinate.targetSha);
  } else if (command === "terminalize") {
    receipt = await terminalizeCleanupAuthority(process.env);
    encoded = encodeCleanupTerminalReceipt(receipt);
  } else if (command === "postflight") {
    receipt = await createCleanupPostflight(process.env);
    encoded = encodeCleanupPostflightReceipt(receipt);
  } else {
    try {
      receipt = await finalizeCleanupAuthority(process.env);
    } catch (error) {
      receipt = await createCleanupIncompleteFinalReceipt(process.env, error);
    }
    encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
    if (encoded.length > MAX_FINAL_RECEIPT_BYTES) fail("cleanup final receipt exceeds its byte bound");
    persistFinalReceipt(receipt, encoded);
    if (receipt.complete !== true) {
      fail("cleanup terminalization is indeterminate; the durable final receipt is incomplete");
    }
    return;
  }
  writeOutput("receipt", encoded);
  writeOutput("receipt_sha256", digest(receipt));
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}
