#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS,
} from "./release-app-token.mjs";
import {
  RELEASE_AUTHORITY_STATUS_CONTEXT,
  withReleaseAuthorityAttestationFromEnvironment,
  withReleaseAuthorityTerminalStatusFromEnvironment,
} from "./release-status-attester.mjs";

const EXPECTED_REPOSITORY = "hraness/textbutler";
const EXPECTED_REPOSITORY_ID = 1_342_143_606;
const EXPECTED_APP_ID = 4_830_612;
const EXPECTED_APP_SLUG = "mlm-prod-ref-writer-1342143606";
const EXPECTED_INSTALLATION_ID = 159_058_102;
const PRODUCTION_REF = "refs/heads/website-production";
const LIFECYCLE_RULESET_ID = 21_821_875;
const AUTHORITY_RULESET_ID = 22_290_922;
const LIFECYCLE_RULESET_NAME = "Immutable website-production lifecycle";
const AUTHORITY_RULESET_NAME = "Message Like Me production status authority";
const PROMOTION_SCHEMA = "message-like-me-provider-promotion-v2";
const ATTESTED_SCHEMA = "message-like-me-production-authority-attested-v1";
const CONSUMED_SCHEMA = "message-like-me-production-authority-consumed-v1";
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_PHASE_GAP_MILLISECONDS = 2 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
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

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is not a positive integer`);
  return value;
}

function exactKeys(value, keys, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} has unexpected keys`);
  }
}

function sha(value, label) {
  const exact = string(value, label);
  if (!SHA.test(exact)) fail(`${label} is not one lowercase 40-hex commit SHA`);
  return exact;
}

function sha256(value, label) {
  const exact = string(value, label);
  if (!SHA256.test(exact)) fail(`${label} is not one lowercase SHA-256 digest`);
  return exact;
}

function timestamp(value, label, expression) {
  const exact = string(value, label);
  if (!expression.test(exact)) fail(`${label} is not canonical`);
  const milliseconds = Date.parse(exact);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not a real timestamp`);
  return Object.freeze({ milliseconds, value: new Date(milliseconds).toISOString() });
}

function receiptTimestamp(value, label) {
  const parsed = timestamp(value, label, RECEIPT_TIMESTAMP);
  if (parsed.value !== value) fail(`${label} is not one exact millisecond UTC timestamp`);
  return parsed;
}

function secondTimestamp(value, label) {
  const parsed = timestamp(value, label, SECOND_TIMESTAMP);
  if (parsed.value.replace(".000Z", "Z") !== value) {
    fail(`${label} is not one exact second UTC timestamp`);
  }
  return Object.freeze({ milliseconds: parsed.milliseconds, value });
}

function httpDate(value, label) {
  const exact = string(value, label);
  if (!HTTP_DATE.test(exact)) fail(`${label} is not one canonical HTTP Date`);
  const milliseconds = Date.parse(exact);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== exact) {
    fail(`${label} is not one real HTTP Date`);
  }
  return Object.freeze({ milliseconds, value: new Date(milliseconds).toISOString() });
}

function apiServerDate(value, label) {
  return typeof value === "string" && HTTP_DATE.test(value)
    ? httpDate(value, label)
    : receiptTimestamp(value, label);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactRevocation(value, label) {
  const receipt = record(value, label);
  exactKeys(receipt, [
    "converged",
    "deletionServerDate",
    "lastObservationServerDate",
    "observationCount",
    "propagationObserved",
    "stableDenials",
  ], label);
  const deletion = receiptTimestamp(receipt.deletionServerDate, `${label} deletion Date`);
  const last = receiptTimestamp(
    receipt.lastObservationServerDate,
    `${label} final observation Date`,
  );
  if (
    receipt.converged !== true ||
    !Number.isSafeInteger(receipt.observationCount) ||
    receipt.observationCount < 2 ||
    receipt.observationCount > RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS.length ||
    typeof receipt.propagationObserved !== "boolean" ||
    (receipt.propagationObserved === false && receipt.observationCount !== 2) ||
    (receipt.propagationObserved === true && receipt.observationCount < 3) ||
    receipt.stableDenials !== 2 ||
    last.milliseconds < deletion.milliseconds
  ) {
    fail(`${label} is not one conclusive App-token revocation`);
  }
  return Object.freeze({
    converged: true,
    deletionServerDate: deletion.value,
    lastObservationServerDate: last.value,
    observationCount: receipt.observationCount,
    propagationObserved: receipt.propagationObserved,
    stableDenials: 2,
  });
}

function statusEvidence(value, expectedState, targetSha, label) {
  const status = record(value, label);
  exactKeys(status, [
    "appId", "appSlug", "context", "createdAt", "creator", "description",
    "installationId", "repository", "repositoryId", "serverDate", "state",
    "statusId", "statusNodeId", "statusUrl", "targetSha",
  ], label);
  const creator = record(status.creator, `${label} creator`);
  exactKeys(creator, ["id", "login", "nodeId"], `${label} creator`);
  const expectedDescription = expectedState === "success"
    ? "Exact release authority admitted for one production-ref attempt"
    : "Release authority consumed after the production-ref attempt";
  const created = secondTimestamp(status.createdAt, `${label} createdAt`);
  const server = receiptTimestamp(status.serverDate, `${label} serverDate`);
  if (
    status.appId !== EXPECTED_APP_ID ||
    status.appSlug !== EXPECTED_APP_SLUG ||
    status.context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    status.description !== expectedDescription ||
    status.installationId !== EXPECTED_INSTALLATION_ID ||
    status.repository !== EXPECTED_REPOSITORY ||
    status.repositoryId !== EXPECTED_REPOSITORY_ID ||
    status.state !== expectedState ||
    status.statusUrl !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    status.targetSha !== targetSha ||
    creator.login !== `${EXPECTED_APP_SLUG}[bot]` ||
    server.milliseconds < created.milliseconds ||
    server.milliseconds - created.milliseconds > 15_000
  ) {
    fail(`${label} is not exact production authority evidence`);
  }
  const nodeId = string(status.statusNodeId, `${label} status node id`);
  const creatorNodeId = string(creator.nodeId, `${label} creator node id`);
  if (nodeId.length < 1 || nodeId.length > 512 || creatorNodeId.length < 1 || creatorNodeId.length > 512) {
    fail(`${label} has a malformed GraphQL identity`);
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    context: RELEASE_AUTHORITY_STATUS_CONTEXT,
    createdAt: created.value,
    creator: Object.freeze({
      id: positiveInteger(creator.id, `${label} creator id`),
      login: creator.login,
      nodeId: creatorNodeId,
    }),
    description: expectedDescription,
    installationId: EXPECTED_INSTALLATION_ID,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate: server.value,
    state: expectedState,
    statusId: positiveInteger(status.statusId, `${label} status id`),
    statusNodeId: nodeId,
    statusUrl: status.statusUrl,
    targetSha,
  });
}

function terminalReadbackEvidence(value, targetSha, label) {
  const readback = record(value, label);
  exactKeys(readback, [
    "context", "serverDate", "state", "statusCount", "targetSha",
    "terminalStatusId", "terminalStatusNodeId",
  ], label);
  const nodeId = string(readback.terminalStatusNodeId, `${label} node id`);
  if (
    readback.context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    readback.state !== "failure" ||
    readback.targetSha !== targetSha ||
    nodeId.length < 1 ||
    nodeId.length > 512
  ) {
    fail(`${label} is not an exact terminal production status readback`);
  }
  return Object.freeze({
    context: RELEASE_AUTHORITY_STATUS_CONTEXT,
    serverDate: receiptTimestamp(readback.serverDate, `${label} Date`).value,
    state: "failure",
    statusCount: positiveInteger(readback.statusCount, `${label} status count`),
    targetSha,
    terminalStatusId: positiveInteger(readback.terminalStatusId, `${label} status id`),
    terminalStatusNodeId: nodeId,
  });
}

function normalizePhase(value) {
  const phase = record(value, "production authority phase receipt");
  const targetSha = sha(phase.targetSha, "production authority target SHA");
  if (
    phase.context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    phase.productionRef !== PRODUCTION_REF ||
    phase.repository !== EXPECTED_REPOSITORY ||
    phase.repositoryId !== EXPECTED_REPOSITORY_ID
  ) {
    fail("production authority phase receipt has the wrong boundary");
  }
  if (phase.phase === "attested") {
    exactKeys(phase, [
      "context", "phase", "productionRef", "repository", "repositoryId", "revocation",
      "schema", "status", "targetSha",
    ], "production authority attested receipt");
    if (phase.schema !== ATTESTED_SCHEMA) fail("production authority attested schema is wrong");
    const normalized = Object.freeze({
      context: RELEASE_AUTHORITY_STATUS_CONTEXT,
      phase: "attested",
      productionRef: PRODUCTION_REF,
      repository: EXPECTED_REPOSITORY,
      repositoryId: EXPECTED_REPOSITORY_ID,
      revocation: exactRevocation(phase.revocation, "production authority attestation revocation"),
      schema: ATTESTED_SCHEMA,
      status: statusEvidence(phase.status, "success", targetSha, "production authority attestation"),
      targetSha,
    });
    if (Date.parse(normalized.revocation.deletionServerDate) < Date.parse(normalized.status.serverDate)) {
      fail("production authority attestation revocation predates the status");
    }
    return normalized;
  }
  if (phase.phase === "consumed") {
    exactKeys(phase, [
      "attestationSha256", "context", "phase", "productionRef", "promotionSha256",
      "readback", "repository", "repositoryId", "revocation", "schema", "status", "targetSha",
    ], "production authority consumed receipt");
    if (phase.schema !== CONSUMED_SCHEMA) fail("production authority consumed schema is wrong");
    const normalized = Object.freeze({
      attestationSha256: phase.attestationSha256 === null
        ? null
        : sha256(phase.attestationSha256, "production authority attestation digest"),
      context: RELEASE_AUTHORITY_STATUS_CONTEXT,
      phase: "consumed",
      productionRef: PRODUCTION_REF,
      promotionSha256: phase.promotionSha256 === null
        ? null
        : sha256(phase.promotionSha256, "production authority promotion digest"),
      readback: terminalReadbackEvidence(
        phase.readback,
        targetSha,
        "production authority terminal readback",
      ),
      repository: EXPECTED_REPOSITORY,
      repositoryId: EXPECTED_REPOSITORY_ID,
      revocation: exactRevocation(phase.revocation, "production authority consumption revocation"),
      schema: CONSUMED_SCHEMA,
      status: statusEvidence(phase.status, "error", targetSha, "production authority consumption"),
      targetSha,
    });
    const dates = [
      normalized.status.serverDate,
      normalized.readback.serverDate,
      normalized.revocation.deletionServerDate,
      normalized.revocation.lastObservationServerDate,
    ].map(Date.parse);
    if (dates.some((entry, index) => index > 0 && entry < dates[index - 1])) {
      fail("production authority consumption dates regress");
    }
    return normalized;
  }
  fail("production authority phase receipt has an unknown phase");
}

export function encodeProductionAuthorityPhaseReceipt(value) {
  const encoded = Buffer.from(JSON.stringify(normalizePhase(value)), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) {
    fail("production authority phase receipt exceeds its byte bound");
  }
  return encoded;
}

export function decodeProductionAuthorityPhaseReceipt(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RECEIPT_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("production authority phase receipt is missing or malformed");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("production authority receipt is noncanonical");
    return normalizePhase(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("production authority")) throw error;
    fail("production authority phase receipt is not canonical JSON");
  }
}

export function productionAuthorityReceiptDigest(value) {
  return digest(normalizePhase(value));
}

export function createProductionAuthorityAttestedReceipt(targetSha, status, revocation) {
  const target = sha(targetSha, "production authority target SHA");
  return normalizePhase(Object.freeze({
    context: RELEASE_AUTHORITY_STATUS_CONTEXT,
    phase: "attested",
    productionRef: PRODUCTION_REF,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    revocation,
    schema: ATTESTED_SCHEMA,
    status,
    targetSha: target,
  }));
}

export function createProductionAuthorityConsumedReceipt(
  targetSha,
  attestationReceipt,
  promotionReceipt,
  terminal,
  revocation,
) {
  const attested = attestationReceipt === undefined
    ? undefined
    : normalizePhase(attestationReceipt);
  if (attested !== undefined && (attested.phase !== "attested" || attested.targetSha !== targetSha)) {
    fail("production authority consumption does not bind the attestation target");
  }
  return normalizePhase(Object.freeze({
    attestationSha256: attested === undefined ? null : digest(attested),
    context: RELEASE_AUTHORITY_STATUS_CONTEXT,
    phase: "consumed",
    productionRef: PRODUCTION_REF,
    promotionSha256: promotionReceipt === undefined
      ? null
      : sha256(promotionReceipt, "production promotion receipt digest"),
    readback: terminal.readback,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    revocation,
    schema: CONSUMED_SCHEMA,
    status: terminal.consumption,
    targetSha,
  }));
}

function parseCombinedRepository(value) {
  const repository = record(value, "production combined status repository");
  const owner = record(repository.owner, "production combined status owner");
  if (
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    repository.name !== "textbutler" ||
    owner.login !== "hraness" ||
    owner.type !== "Organization"
  ) {
    fail("production combined status repository is not exact Message Like Me");
  }
}

export function parseCurrentProductionAuthoritySuccess(value, serverDate, attestationReceipt) {
  const attested = normalizePhase(attestationReceipt);
  if (attested.phase !== "attested") fail("current production authority has no attestation");
  const combined = record(value, "current production combined status");
  const targetSha = attested.targetSha;
  if (
    combined.sha !== targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status` ||
    !Array.isArray(combined.statuses) ||
    !Number.isSafeInteger(combined.total_count) ||
    combined.total_count < 1 ||
    combined.total_count > 100 ||
    combined.total_count !== combined.statuses.length
  ) {
    fail("current production combined status does not bind the exact target");
  }
  parseCombinedRepository(combined.repository);
  const matching = combined.statuses.filter((item) => isRecord(item) &&
    item.context === RELEASE_AUTHORITY_STATUS_CONTEXT);
  if (matching.length !== 1) fail("current production authority status is not unique");
  const status = record(matching[0], "current production authority status");
  const expected = attested.status;
  if (
    status.id !== expected.statusId ||
    status.node_id !== expected.statusNodeId ||
    status.context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    status.state !== "success" ||
    status.description !== expected.description ||
    status.target_url !== null ||
    status.created_at !== expected.createdAt ||
    status.updated_at !== expected.createdAt ||
    status.url !== expected.statusUrl
  ) {
    fail("current production authority does not bind the exact App attestation");
  }
  const observed = apiServerDate(serverDate, "current production authority response Date");
  const attestedDate = receiptTimestamp(expected.serverDate, "production attestation Date");
  const revokedDate = receiptTimestamp(
    attested.revocation.lastObservationServerDate,
    "production attestation final revocation Date",
  );
  if (
    observed.milliseconds < revokedDate.milliseconds ||
    observed.milliseconds - attestedDate.milliseconds > MAX_PHASE_GAP_MILLISECONDS
  ) {
    fail("current production authority readback is not a fresh post-revocation observation");
  }
  return Object.freeze({
    serverDate: observed.value,
    statusId: expected.statusId,
    statusNodeId: expected.statusNodeId,
    targetSha,
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
    detail.id !== expected.id ||
    detail.name !== expected.name ||
    detail.target !== "branch" ||
    detail.source_type !== "Repository" ||
    detail.source !== EXPECTED_REPOSITORY ||
    detail.enforcement !== "active" ||
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

export function parseProductionAuthorityRules(value) {
  const closure = record(value, "production authority rules closure");
  if (!Array.isArray(closure.effective) || closure.effective.length !== 4) {
    fail("production authority effective rules are not the exact four-rule closure");
  }
  const lifecycleTypes = new Set(["creation", "deletion", "non_fast_forward"]);
  let authorityFound = false;
  for (const item of closure.effective) {
    const rule = record(item, "production authority effective rule");
    if (
      lifecycleTypes.has(rule.type) &&
      rule.ruleset_id === LIFECYCLE_RULESET_ID &&
      rule.ruleset_source_type === "Repository" &&
      rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      lifecycleTypes.delete(rule.type);
      continue;
    }
    if (
      rule.type === "required_status_checks" &&
      rule.ruleset_id === AUTHORITY_RULESET_ID &&
      rule.ruleset_source_type === "Repository" &&
      rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      const parameters = record(rule.parameters, "production authority parameters");
      const checks = parameters.required_status_checks;
      if (
        authorityFound ||
        parameters.do_not_enforce_on_create !== false ||
        parameters.strict_required_status_checks_policy !== false ||
        !Array.isArray(checks) ||
        checks.length !== 1 ||
        !isRecord(checks[0]) ||
        checks[0].context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
        checks[0].integration_id !== EXPECTED_APP_ID
      ) {
        fail("production authority effective status rule is not exact");
      }
      authorityFound = true;
      continue;
    }
    fail("production authority effective rules contain an unknown rule");
  }
  if (lifecycleTypes.size !== 0 || !authorityFound) {
    fail("production authority rules omit a lifecycle or status rule");
  }
  const lifecycle = exactRulesetDetail(closure.lifecycle, {
    id: LIFECYCLE_RULESET_ID,
    label: "production lifecycle ruleset",
    name: LIFECYCLE_RULESET_NAME,
  });
  if (
    lifecycle.length !== 3 ||
    JSON.stringify(lifecycle.map((item) => record(item, "production lifecycle rule").type)) !==
      JSON.stringify(["creation", "deletion", "non_fast_forward"])
  ) {
    fail("production lifecycle ruleset has unexpected rules");
  }
  const authority = exactRulesetDetail(closure.authority, {
    id: AUTHORITY_RULESET_ID,
    label: "production authority ruleset",
    name: AUTHORITY_RULESET_NAME,
  });
  if (authority.length !== 1) fail("production authority ruleset does not have one rule");
  const rule = record(authority[0], "production authority detail rule");
  const parameters = record(rule.parameters, "production authority detail parameters");
  const checks = parameters.required_status_checks;
  if (
    rule.type !== "required_status_checks" ||
    parameters.do_not_enforce_on_create !== false ||
    parameters.strict_required_status_checks_policy !== false ||
    !Array.isArray(checks) ||
    checks.length !== 1 ||
    !isRecord(checks[0]) ||
    checks[0].context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    checks[0].integration_id !== EXPECTED_APP_ID
  ) {
    fail("production authority detail status rule is not exact");
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

function parseApiReceipt(value, label) {
  const receipt = record(value, `${label} API receipt`);
  if (!Object.hasOwn(receipt, "body") || !Object.hasOwn(receipt, "serverDate")) {
    fail(`${label} API receipt has an unexpected shape`);
  }
  return Object.freeze({
    body: receipt.body,
    serverDate: apiServerDate(receipt.serverDate, `${label} Date`).value,
  });
}

export function parseProductionAuthorityRulesApiClosure(value, label = "production authority") {
  const closure = record(value, `${label} rules API closure`);
  const effective = parseApiReceipt(closure.effective, `${label} effective rules`);
  const lifecycle = parseApiReceipt(closure.lifecycle, `${label} lifecycle rules`);
  const authority = parseApiReceipt(closure.authority, `${label} authority rules`);
  return Object.freeze({
    bodySha256: Object.freeze({
      authority: digest(authority.body),
      effective: digest(effective.body),
      lifecycle: digest(lifecycle.body),
    }),
    rules: parseProductionAuthorityRules({
      authority: authority.body,
      effective: effective.body,
      lifecycle: lifecycle.body,
    }),
    serverDates: Object.freeze({
      authority: authority.serverDate,
      effective: effective.serverDate,
      lifecycle: lifecycle.serverDate,
    }),
  });
}

export function normalizeProductionAuthorityRulesReceipt(value) {
  const receipt = record(value, "production authority normalized rules receipt");
  const bodySha256 = record(receipt.bodySha256, "production authority rules body digests");
  const serverDates = record(receipt.serverDates, "production authority rules server Dates");
  const expectedRules = Object.freeze({
    authority: Object.freeze({
      doNotEnforceOnCreate: false,
      integrationId: EXPECTED_APP_ID,
      name: AUTHORITY_RULESET_NAME,
      rulesetId: AUTHORITY_RULESET_ID,
      strict: false,
    }),
    lifecycle: Object.freeze({
      name: LIFECYCLE_RULESET_NAME,
      rulesetId: LIFECYCLE_RULESET_ID,
    }),
  });
  if (JSON.stringify(receipt.rules) !== JSON.stringify(expectedRules)) {
    fail("production authority normalized rules are not exact");
  }
  return Object.freeze({
    bodySha256: Object.freeze({
      authority: sha256(bodySha256.authority, "production authority rules digest"),
      effective: sha256(bodySha256.effective, "production effective rules digest"),
      lifecycle: sha256(bodySha256.lifecycle, "production lifecycle rules digest"),
    }),
    rules: expectedRules,
    serverDates: Object.freeze({
      authority: receiptTimestamp(serverDates.authority, "production authority rules Date").value,
      effective: receiptTimestamp(serverDates.effective, "production effective rules Date").value,
      lifecycle: receiptTimestamp(serverDates.lifecycle, "production lifecycle rules Date").value,
    }),
  });
}

function normalizeProductionDenialReceipt(value) {
  const receipt = record(value, "production writer denial receipt");
  const site = receipt.schema === "textbutler-site-required-status-denial-v1";
  exactKeys(receipt, [
    "baselineDigest", "denial", "observedAt", "preconditionSha256", "previousSha",
    "productionRef", "repository", "rules", "schema", "verifiedSha", site ? "subject" : "verifiedTag",
  ], "production writer denial receipt");
  const denial = record(receipt.denial, "production writer denial");
  exactKeys(denial, ["classification", "diagnosticSha256"], "production writer denial");
  const subject = site ? parseSiteSubject(receipt.subject) : undefined;
  const verifiedTag = site ? undefined : string(receipt.verifiedTag, "production denial verified tag");
  if (
    (!site && receipt.schema !== "message-like-me-production-required-status-denial-v3") ||
    receipt.productionRef !== PRODUCTION_REF ||
    receipt.repository !== EXPECTED_REPOSITORY ||
    denial.classification !== "required-status-errored" ||
    (site ? subject.sourceSha !== receipt.verifiedSha : !STABLE_TAG.test(verifiedTag))
  ) {
    fail("production writer denial receipt has the wrong boundary");
  }
  return Object.freeze({
    baselineDigest: sha256(receipt.baselineDigest, "production denial baseline digest"),
    denial: Object.freeze({
      classification: "required-status-errored",
      diagnosticSha256: sha256(
        denial.diagnosticSha256,
        "production denial diagnostic digest",
      ),
    }),
    observedAt: receiptTimestamp(receipt.observedAt, "production denial observedAt").value,
    preconditionSha256: sha256(
      receipt.preconditionSha256,
      "production denial precondition digest",
    ),
    previousSha: sha(receipt.previousSha, "production denial previous SHA"),
    productionRef: PRODUCTION_REF,
    repository: EXPECTED_REPOSITORY,
    rules: normalizeProductionAuthorityRulesReceipt(receipt.rules),
    schema: receipt.schema,
    verifiedSha: sha(receipt.verifiedSha, "production denial verified SHA"),
    ...(site ? { subject } : { verifiedTag }),
  });
}

function normalizeProductionPromotionReceipt(value) {
  const receipt = record(value, "production promotion receipt");
  const site = receipt.schema === "textbutler-site-provider-promotion-v1";
  exactKeys(receipt, [
    "authority", "baselineDigest", "boundaryAt", "denialSha256", "mode",
    "previousSha", "promotedAt", "productionRef", "receiptSha256",
    ...(site ? [] : ["releasePublishedAt"]), "repository", "rules", "schema", "verifiedSha",
    site ? "subject" : "verifiedTag", "writerPush",
  ], "production promotion receipt");
  if (
    (!site && receipt.schema !== PROMOTION_SCHEMA) ||
    receipt.mode !== "advanced" ||
    receipt.productionRef !== PRODUCTION_REF ||
    receipt.repository !== EXPECTED_REPOSITORY
  ) {
    fail("production promotion receipt has the wrong boundary");
  }
  const authority = record(receipt.authority, "production promotion authority");
  exactKeys(authority, [
    "attestationSha256", "statusId", "statusNodeId", "statusReadbackAt",
  ], "production promotion authority");
  const statusNodeId = string(
    authority.statusNodeId,
    "production promotion authority status node ID",
  );
  if (statusNodeId.length < 1 || statusNodeId.length > 512) {
    fail("production promotion authority status node ID is malformed");
  }
  const writerPush = record(receipt.writerPush, "production promotion writer push");
  exactKeys(writerPush, [
    "classification", "fromSha", "protectedRef", "summarySha256", "toSha",
  ], "production promotion writer push");
  const previousSha = sha(receipt.previousSha, "production promotion previous SHA");
  const verifiedSha = sha(receipt.verifiedSha, "production promotion verified SHA");
  if (
    writerPush.classification !== "fast-forward" ||
    writerPush.fromSha !== previousSha ||
    writerPush.protectedRef !== PRODUCTION_REF ||
    writerPush.toSha !== verifiedSha
  ) {
    fail("production promotion writer push is not one exact leased update");
  }
  const boundaryAt = receiptTimestamp(
    receipt.boundaryAt,
    "production promotion boundaryAt",
  ).value;
  const promotedAt = receiptTimestamp(
    receipt.promotedAt,
    "production promotion promotedAt",
  ).value;
  const statusReadbackAt = receiptTimestamp(
    authority.statusReadbackAt,
    "production promotion authority statusReadbackAt",
  ).value;
  const subject = site ? parseSiteSubject(receipt.subject) : undefined;
  if (site && subject.sourceSha !== verifiedSha) fail("site promotion subject does not match its target");
  const releasePublishedAt = site ? undefined : secondTimestamp(receipt.releasePublishedAt, "production promotion releasePublishedAt").value;
  if (
    Date.parse(boundaryAt) <= Date.parse(site ? subject.buildCompletedAt : releasePublishedAt) ||
    Date.parse(promotedAt) < Date.parse(statusReadbackAt)
  ) {
    fail("production promotion dates do not bind the release and authority");
  }
  const normalized = Object.freeze({
    authority: Object.freeze({
      attestationSha256: sha256(
        authority.attestationSha256,
        "production promotion attestation digest",
      ),
      statusId: positiveInteger(authority.statusId, "production promotion status ID"),
      statusNodeId,
      statusReadbackAt,
    }),
    baselineDigest: sha256(receipt.baselineDigest, "production promotion baseline digest"),
    boundaryAt,
    denialSha256: sha256(receipt.denialSha256, "production promotion denial digest"),
    mode: "advanced",
    previousSha,
    promotedAt,
    productionRef: PRODUCTION_REF,
    ...(site ? { subject } : { releasePublishedAt }),
    repository: EXPECTED_REPOSITORY,
    rules: normalizeProductionAuthorityRulesReceipt(receipt.rules),
    schema: receipt.schema,
    verifiedSha,
    ...(site ? {} : { verifiedTag: (() => {
      const tag = string(receipt.verifiedTag, "production promotion verified tag");
      if (!STABLE_TAG.test(tag)) fail("production promotion verified tag is invalid");
      return tag;
    })() }),
    writerPush: Object.freeze({
      classification: "fast-forward",
      fromSha: previousSha,
      protectedRef: PRODUCTION_REF,
      summarySha256: sha256(
        writerPush.summarySha256,
        "production promotion writer summary digest",
      ),
      toSha: verifiedSha,
    }),
  });
  const receiptSha256 = sha256(
    receipt.receiptSha256,
    "production promotion receipt digest",
  );
  if (digest(normalized) !== receiptSha256) {
    fail("production promotion receipt digest does not bind its full evidence");
  }
  return Object.freeze({ ...normalized, receiptSha256 });
}

function parseExactTerminalCombinedStatus(value, consumed) {
  const combined = record(value, "production terminal combined status");
  const targetSha = consumed.targetSha;
  if (
    combined.state !== "failure" ||
    combined.sha !== targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status` ||
    !Array.isArray(combined.statuses) ||
    !Number.isSafeInteger(combined.total_count) ||
    combined.total_count < 1 ||
    combined.total_count > 100 ||
    combined.total_count !== combined.statuses.length
  ) {
    fail("production terminal status does not bind the exact target");
  }
  parseCombinedRepository(combined.repository);
  const matching = combined.statuses.filter((item) => isRecord(item) &&
    item.context === RELEASE_AUTHORITY_STATUS_CONTEXT);
  const expected = consumed.status;
  if (matching.length !== 1) fail("production terminal authority status is not unique");
  const status = record(matching[0], "production terminal authority status");
  if (
    status.id !== expected.statusId ||
    status.node_id !== expected.statusNodeId ||
    status.context !== RELEASE_AUTHORITY_STATUS_CONTEXT ||
    status.state !== "error" ||
    status.description !== expected.description ||
    status.target_url !== null ||
    status.created_at !== expected.createdAt ||
    status.updated_at !== expected.createdAt ||
    status.url !== expected.statusUrl
  ) {
    fail("production terminal status is not the exact consumed authority");
  }
}

export function parseSiteSubject(value) {
  const item = record(value, "site subject");
  exactKeys(item, ["kind", "sourceSha", "ciRunId", "ciRunAttempt", "buildRunId", "buildRunAttempt",
    "buildArtifactId", "buildArtifactDigest", "manifestDigest", "buildCompletedAt", "sourceQualifiedAt"], "site subject");
  if (item.kind !== "site" || typeof item.buildArtifactDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(item.buildArtifactDigest)) fail("site subject identity is invalid");
  return Object.freeze({
    kind: "site",
    sourceSha: sha(item.sourceSha, "site subject source"),
    ciRunId: positiveInteger(item.ciRunId, "site CI run"),
    ciRunAttempt: positiveInteger(item.ciRunAttempt, "site CI attempt"),
    buildRunId: positiveInteger(item.buildRunId, "site build run"),
    buildRunAttempt: positiveInteger(item.buildRunAttempt, "site build attempt"),
    buildArtifactId: positiveInteger(item.buildArtifactId, "site artifact"),
    buildArtifactDigest: item.buildArtifactDigest,
    manifestDigest: sha256(item.manifestDigest, "site manifest digest"),
    buildCompletedAt: receiptTimestamp(item.buildCompletedAt, "site build completion").value,
    sourceQualifiedAt: receiptTimestamp(item.sourceQualifiedAt, "site source CI completion").value,
  });
}

function siteSubjectMismatch(left, right) {
  return JSON.stringify(parseSiteSubject(left)) !== JSON.stringify(parseSiteSubject(right));
}

export async function finalizeProductionAuthority({
  api,
  attestationReceipt,
  consumptionReceipt,
  denialReceipt,
  preconditionReceipt,
  promotion,
}) {
  const precondition = normalizePhase(preconditionReceipt);
  const denial = normalizeProductionDenialReceipt(denialReceipt);
  const attested = normalizePhase(attestationReceipt);
  const consumed = normalizePhase(consumptionReceipt);
  const admittedPromotion = normalizeProductionPromotionReceipt(promotion);
  if (
    precondition.phase !== "consumed" ||
    precondition.attestationSha256 !== null ||
    precondition.promotionSha256 !== null ||
    precondition.targetSha !== attested.targetSha ||
    denial.preconditionSha256 !== digest(precondition) ||
    denial.verifiedSha !== attested.targetSha ||
    denial.observedAt > attested.status.serverDate ||
    attested.phase !== "attested" ||
    consumed.phase !== "consumed" ||
    consumed.targetSha !== attested.targetSha ||
    consumed.attestationSha256 !== digest(attested) ||
    consumed.promotionSha256 !== admittedPromotion.receiptSha256 ||
    admittedPromotion.verifiedSha !== attested.targetSha ||
    admittedPromotion.authority.attestationSha256 !== digest(attested) ||
    admittedPromotion.authority.statusId !== attested.status.statusId ||
    admittedPromotion.authority.statusNodeId !== attested.status.statusNodeId ||
    admittedPromotion.denialSha256 !== digest(denial) ||
    admittedPromotion.baselineDigest !== denial.baselineDigest ||
    admittedPromotion.previousSha !== denial.previousSha ||
    (admittedPromotion.subject?.kind === "site"
      ? siteSubjectMismatch(admittedPromotion.subject, denial.subject)
      : admittedPromotion.verifiedTag !== denial.verifiedTag || denial.subject !== undefined)
  ) {
    fail("production authority phases do not bind one exact promotion");
  }
  const preconditionDates = [
    precondition.status.serverDate,
    precondition.readback.serverDate,
    precondition.revocation.deletionServerDate,
    precondition.revocation.lastObservationServerDate,
  ].map(Date.parse);
  const denialRuleDates = Object.values(denial.rules.serverDates).map(Date.parse);
  const promotionRuleDates = Object.values(
    admittedPromotion.rules.serverDates,
  ).map(Date.parse);
  if (
    JSON.stringify(denial.rules.rules) !== JSON.stringify(admittedPromotion.rules.rules) ||
    JSON.stringify(denial.rules.bodySha256) !==
      JSON.stringify(admittedPromotion.rules.bodySha256)
  ) {
    fail("production denial and promotion rules do not bind one exact policy");
  }
  if (
    denialRuleDates.some((entry) => entry < preconditionDates.at(-1)) ||
    Date.parse(denial.observedAt) < Math.max(...denialRuleDates) ||
    Date.parse(attested.status.serverDate) < Date.parse(denial.observedAt) ||
    promotionRuleDates.some((entry) =>
      entry < Date.parse(attested.revocation.lastObservationServerDate))
  ) {
    fail("production precondition/denial/attestation dates regress");
  }
  const causalDates = [
    ...preconditionDates,
    Math.max(...denialRuleDates),
    Date.parse(denial.observedAt),
    Date.parse(attested.status.serverDate),
    attested.revocation.deletionServerDate,
    attested.revocation.lastObservationServerDate,
    Math.max(...promotionRuleDates),
    Date.parse(admittedPromotion.authority.statusReadbackAt),
    Date.parse(admittedPromotion.promotedAt),
    Date.parse(consumed.status.serverDate),
    Date.parse(consumed.readback.serverDate),
    Date.parse(consumed.revocation.deletionServerDate),
    Date.parse(consumed.revocation.lastObservationServerDate),
  ].map((entry) => typeof entry === "number" ? entry : Date.parse(entry));
  if (causalDates.some((entry, index) => index > 0 && entry < causalDates[index - 1])) {
    fail("production authority status/write/consumption dates regress");
  }
  const postStatusRef = parseApiReceipt(await api.getRef(), "production post-status ref");
  if (postStatusRef.body !== attested.targetSha || Date.parse(postStatusRef.serverDate) < causalDates.at(-1)) {
    fail("production post-status ref is not the exact promoted target");
  }
  const terminalStatus = parseApiReceipt(
    await api.getCombinedStatus(attested.targetSha),
    "production terminal status",
  );
  parseExactTerminalCombinedStatus(terminalStatus.body, consumed);
  if (Date.parse(terminalStatus.serverDate) < Date.parse(postStatusRef.serverDate)) {
    fail("production terminal status Date predates the ref readback");
  }
  const rules = parseProductionAuthorityRulesApiClosure(
    await api.getRules(),
    "production terminal",
  );
  const admittedRules = admittedPromotion.rules;
  if (
    JSON.stringify(rules.rules) !== JSON.stringify(admittedRules.rules) ||
    JSON.stringify(rules.bodySha256) !== JSON.stringify(admittedRules.bodySha256)
  ) {
    fail("production authority rules changed across the protected update");
  }
  const ruleDates = Object.values(rules.serverDates).map(Date.parse);
  if (ruleDates.some((entry) => entry < Date.parse(terminalStatus.serverDate))) {
    fail("production terminal rules predate terminal status");
  }
  const finalRef = parseApiReceipt(await api.getRef(), "production final ref");
  if (
    finalRef.body !== attested.targetSha ||
    ruleDates.some((entry) => Date.parse(finalRef.serverDate) < entry)
  ) {
    fail("production final ref does not bind the exact target after rules readback");
  }
  return Object.freeze({
    attestation: attested,
    consumption: consumed,
    denial,
    finalRef,
    postStatusRef,
    precondition,
    promotion: admittedPromotion,
    rules,
    schema: admittedPromotion.subject?.kind === "site" ? "textbutler-site-authority-final-v1" : "message-like-me-production-authority-final-v3",
    terminalStatus: Object.freeze({
      serverDate: terminalStatus.serverDate,
      statusId: consumed.status.statusId,
      statusNodeId: consumed.status.statusNodeId,
    }),
  });
}

function assertAppOnlyEnvironment(environment) {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "MLM_RELEASE_REF_TOKEN"]) {
    if (typeof environment[key] === "string" && environment[key].length > 0) {
      fail(`production App-only process received forbidden ${key}`);
    }
  }
  if (environment.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    fail("production App-only process is not bound to Message Like Me");
  }
  return sha(environment.TARGET, "production App-only TARGET");
}

async function liveAttest(environment) {
  const targetSha = assertAppOnlyEnvironment(environment);
  let revocation;
  const status = await withReleaseAuthorityAttestationFromEnvironment(
    environment,
    (receipt) => { revocation = receipt; },
  );
  return createProductionAuthorityAttestedReceipt(targetSha, status, revocation);
}

async function liveConsume(environment) {
  const targetSha = assertAppOnlyEnvironment(environment);
  let revocation;
  const terminal = await withReleaseAuthorityTerminalStatusFromEnvironment(
    environment,
    (receipt) => { revocation = receipt; },
  );
  let attested;
  if (typeof environment.AUTHORITY_ATTESTATION_RECEIPT === "string" &&
      environment.AUTHORITY_ATTESTATION_RECEIPT.length > 0) {
    try {
      attested = decodeProductionAuthorityPhaseReceipt(
        environment.AUTHORITY_ATTESTATION_RECEIPT,
      );
    } catch {
      attested = undefined;
    }
  }
  let promotionDigest;
  if (typeof environment.PROMOTION_RECEIPT_SHA256 === "string" &&
      SHA256.test(environment.PROMOTION_RECEIPT_SHA256)) {
    promotionDigest = environment.PROMOTION_RECEIPT_SHA256;
  }
  return createProductionAuthorityConsumedReceipt(
    targetSha,
    attested,
    promotionDigest,
    terminal,
    revocation,
  );
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || output.length === 0) fail("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8" });
}

function encodeBoundedJsonReceipt(value, label) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) {
    fail(`${label} exceeds its byte bound`);
  }
  return encoded;
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || (command !== "attest" && command !== "consume")) {
    fail("Usage: release-production-authority.mjs attest|consume");
  }
  const receipt = command === "attest"
    ? await liveAttest(process.env)
    : await liveConsume(process.env);
  const encoded = encodeProductionAuthorityPhaseReceipt(receipt);
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
