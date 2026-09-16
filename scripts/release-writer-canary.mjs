#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS,
  withReleaseAppTokenFromEnvironment,
} from "./release-app-token.mjs";
import {
  advanceWebsiteProductionCanaryRefFromEnvironment,
  parseWebsiteProductionCanaryRequiredStatusDenial,
  proveWebsiteProductionCanaryStaleLeaseFromEnvironment,
} from "./release-ref-writer.mjs";
import {
  RELEASE_CANARY_STATUS_CONTEXT,
  withReleaseCanaryAttestationFromEnvironment,
  withReleaseCanaryTerminalStatusFromEnvironment,
} from "./release-status-attester.mjs";
import {
  assertCanaryWorkflowAdmissionReceipt,
  ControlEpochAdmissionError,
  verifyCanaryWorkflowAdmission,
  writeControlEpochReview,
} from "./release-workflow-range.mjs";

const EXPECTED_REPOSITORY = "hraness/textbutler";
const EXPECTED_REPOSITORY_ID = 1_342_143_606;
const EXPECTED_APP_ID = 4_830_612;
const EXPECTED_APP_SLUG = "mlm-prod-ref-writer-1342143606";
const EXPECTED_WORKFLOW_ID = 350_746_736;
const CANARY_LIFECYCLE_RULESET_ID = 21_826_586;
const CANARY_AUTHORITY_RULESET_ID = 22_290_941;
const CANARY_LIFECYCLE_RULESET_NAME = "Immutable production-writer canary lifecycle";
const CANARY_AUTHORITY_RULESET_NAME = "Message Like Me writer canary status authority";
const EXPECTED_OWNER = "hraness";
const EXPECTED_WORKFLOW_NAME = "Prove production ref writer canary";
const EXPECTED_WORKFLOW_PATH = ".github/workflows/production-writer-canary.yml";
const EXPECTED_WORKFLOW_RUN_PATH = EXPECTED_WORKFLOW_PATH;
const EXPECTED_WORKFLOW_REF =
  `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@refs/heads/main`;
const MAIN_REF = "refs/heads/main";
const CANARY_REF = "refs/heads/website-production-writer-canary";
const CANARY_RECEIPT_SCHEMA = "message-like-me-production-writer-canary-v1";
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value, label) {
  if (!isRecord(value)) fail(`${label} is not an object`);
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) {
    fail(`${label} is not one exact lowercase 40-hex commit SHA`);
  }
  return value;
}

function exactPositiveInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is not a positive integer`);
    return value;
  }
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value)) {
    fail(`${label} is not a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is not a safe positive integer`);
  return parsed;
}

function exactEnvironmentString(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    fail(`${key} is missing or malformed`);
  }
  return value;
}

function exactApiUrl(value) {
  const url = new URL(expectString(value, "GITHUB_API_URL"));
  if (url.href !== "https://api.github.com/" || url.username !== "" || url.password !== "") {
    fail("GITHUB_API_URL is not the exact GitHub Cloud API origin");
  }
  return url;
}

function exactHttpDate(value, label) {
  if (typeof value !== "string" || !HTTP_DATE.test(value)) {
    fail(`${label} is not one canonical HTTP Date`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== value) {
    fail(`${label} is not one real canonical HTTP Date`);
  }
  return Object.freeze({ milliseconds, timestamp: new Date(milliseconds).toISOString() });
}

function exactReceiptTimestamp(value, label) {
  if (typeof value !== "string") fail(`${label} is not a timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} is not one exact UTC timestamp`);
  }
  return value;
}

function exactSecondTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail(`${label} is not one exact second UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${label} is not one real exact second UTC timestamp`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} is not one lowercase SHA-256 digest`);
  }
  return value;
}

function exactRevocation(value, label) {
  const receipt = expectRecord(value, label);
  const deletionServerDate = exactReceiptTimestamp(
    receipt.deletionServerDate,
    `${label} deletionServerDate`,
  );
  const lastObservationServerDate = exactReceiptTimestamp(
    receipt.lastObservationServerDate,
    `${label} lastObservationServerDate`,
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
    Date.parse(lastObservationServerDate) < Date.parse(deletionServerDate)
  ) {
    fail(`${label} is not a conclusive revocation receipt`);
  }
  return Object.freeze({
    converged: true,
    deletionServerDate,
    lastObservationServerDate,
    observationCount: receipt.observationCount,
    propagationObserved: receipt.propagationObserved,
    stableDenials: 2,
  });
}

function normalizedRulesReceipt(value) {
  const rules = expectRecord(value, "writer canary rules receipt");
  const authority = expectRecord(rules.authority, "writer canary authority rules receipt");
  const lifecycle = expectRecord(rules.lifecycle, "writer canary lifecycle rules receipt");
  if (
    authority.doNotEnforceOnCreate !== false ||
    authority.integrationId !== EXPECTED_APP_ID ||
    authority.name !== CANARY_AUTHORITY_RULESET_NAME ||
    authority.rulesetId !== CANARY_AUTHORITY_RULESET_ID ||
    authority.strict !== false ||
    lifecycle.name !== CANARY_LIFECYCLE_RULESET_NAME ||
    lifecycle.rulesetId !== CANARY_LIFECYCLE_RULESET_ID
  ) {
    fail("writer canary rules receipt is not exact");
  }
  return Object.freeze({
    authority: Object.freeze({
      doNotEnforceOnCreate: false,
      integrationId: EXPECTED_APP_ID,
      name: CANARY_AUTHORITY_RULESET_NAME,
      rulesetId: CANARY_AUTHORITY_RULESET_ID,
      strict: false,
    }),
    lifecycle: Object.freeze({
      name: CANARY_LIFECYCLE_RULESET_NAME,
      rulesetId: CANARY_LIFECYCLE_RULESET_ID,
    }),
  });
}

function parseApiReceipt(value, label) {
  const receipt = expectRecord(value, `${label} API receipt`);
  if (!Object.hasOwn(receipt, "body") || !Object.hasOwn(receipt, "serverDate")) {
    fail(`${label} API receipt has an unexpected shape`);
  }
  return Object.freeze({
    body: receipt.body,
    serverDate: exactHttpDate(receipt.serverDate, `${label} API Date`).timestamp,
  });
}

function exactRulesetDetail(value, expected) {
  const detail = expectRecord(value, `${expected.label} detail`);
  const conditions = expectRecord(detail.conditions, `${expected.label} conditions`);
  const refName = expectRecord(conditions.ref_name, `${expected.label} ref_name`);
  const links = expectRecord(detail._links, `${expected.label} links`);
  const self = expectRecord(links.self, `${expected.label} self link`);
  const html = expectRecord(links.html, `${expected.label} html link`);
  if (
    detail.id !== expected.id ||
    detail.name !== expected.name ||
    detail.target !== "branch" ||
    detail.source_type !== "Repository" ||
    detail.source !== EXPECTED_REPOSITORY ||
    detail.enforcement !== "active" ||
    JSON.stringify(refName.exclude) !== "[]" ||
    JSON.stringify(refName.include) !== JSON.stringify([CANARY_REF]) ||
    (Object.hasOwn(detail, "bypass_actors") && JSON.stringify(detail.bypass_actors) !== "[]") ||
    (Object.hasOwn(detail, "current_user_can_bypass") &&
      detail.current_user_can_bypass !== "never") ||
    self.href !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/rulesets/${String(expected.id)}` ||
    html.href !== `https://github.com/${EXPECTED_REPOSITORY}/rules/${String(expected.id)}`
  ) {
    fail(`${expected.label} detail is not exact`);
  }
  if (!Array.isArray(detail.rules)) fail(`${expected.label} rules are not an array`);
  return detail.rules;
}

export function parseWriterCanaryRules(value) {
  const closure = expectRecord(value, "writer canary rules closure");
  const effective = closure.effective;
  if (!Array.isArray(effective) || effective.length !== 4) {
    fail("writer canary effective rules are not the exact four-rule closure");
  }
  const lifecycleTypes = new Set(["creation", "deletion", "non_fast_forward"]);
  let authority;
  for (const item of effective) {
    const rule = expectRecord(item, "writer canary effective rule");
    if (
      lifecycleTypes.has(rule.type) &&
      rule.ruleset_id === CANARY_LIFECYCLE_RULESET_ID &&
      rule.ruleset_source_type === "Repository" &&
      rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      lifecycleTypes.delete(rule.type);
      continue;
    }
    if (
      rule.type === "required_status_checks" &&
      rule.ruleset_id === CANARY_AUTHORITY_RULESET_ID &&
      rule.ruleset_source_type === "Repository" &&
      rule.ruleset_source === EXPECTED_REPOSITORY
    ) {
      if (authority !== undefined) fail("writer canary has duplicate authority rules");
      const parameters = expectRecord(rule.parameters, "writer canary authority parameters");
      const checks = parameters.required_status_checks;
      if (
        parameters.do_not_enforce_on_create !== false ||
        parameters.strict_required_status_checks_policy !== false ||
        !Array.isArray(checks) ||
        checks.length !== 1
      ) {
        fail("writer canary authority parameters are not exact");
      }
      const check = expectRecord(checks[0], "writer canary required status check");
      if (
        check.context !== RELEASE_CANARY_STATUS_CONTEXT ||
        check.integration_id !== EXPECTED_APP_ID
      ) {
        fail("writer canary required status check is not bound to the exact App context");
      }
      authority = Object.freeze({
        doNotEnforceOnCreate: false,
        integrationId: EXPECTED_APP_ID,
        name: CANARY_AUTHORITY_RULESET_NAME,
        rulesetId: CANARY_AUTHORITY_RULESET_ID,
        strict: false,
      });
      continue;
    }
    fail("writer canary effective rules contain an unknown rule");
  }
  if (lifecycleTypes.size !== 0 || authority === undefined) {
    fail("writer canary effective rules omit a required lifecycle or authority rule");
  }

  const lifecycleRules = exactRulesetDetail(closure.lifecycle, {
    id: CANARY_LIFECYCLE_RULESET_ID,
    label: "writer canary lifecycle ruleset",
    name: CANARY_LIFECYCLE_RULESET_NAME,
  });
  if (
    lifecycleRules.length !== 3 ||
    JSON.stringify(lifecycleRules.map((rule) => expectRecord(
      rule,
      "writer canary lifecycle rule",
    ).type)) !== JSON.stringify(["creation", "deletion", "non_fast_forward"])
  ) {
    fail("writer canary lifecycle ruleset has unexpected rules");
  }
  const authorityRules = exactRulesetDetail(closure.authority, {
    id: CANARY_AUTHORITY_RULESET_ID,
    label: "writer canary authority ruleset",
    name: CANARY_AUTHORITY_RULESET_NAME,
  });
  if (authorityRules.length !== 1) {
    fail("writer canary authority ruleset does not have one rule");
  }
  const authorityRule = expectRecord(authorityRules[0], "writer canary authority detail rule");
  const authorityParameters = expectRecord(
    authorityRule.parameters,
    "writer canary authority detail parameters",
  );
  if (
    authorityRule.type !== "required_status_checks" ||
    authorityParameters.do_not_enforce_on_create !== false ||
    authorityParameters.strict_required_status_checks_policy !== false ||
    !Array.isArray(authorityParameters.required_status_checks) ||
    authorityParameters.required_status_checks.length !== 1
  ) {
    fail("writer canary authority detail rule is not exact");
  }
  const detailedCheck = expectRecord(
    authorityParameters.required_status_checks[0],
    "writer canary authority detail status check",
  );
  if (
    detailedCheck.context !== RELEASE_CANARY_STATUS_CONTEXT ||
    detailedCheck.integration_id !== EXPECTED_APP_ID
  ) {
    fail("writer canary authority detail status check is not exact");
  }
  return Object.freeze({
    authority,
    lifecycle: Object.freeze({
      name: CANARY_LIFECYCLE_RULESET_NAME,
      rulesetId: CANARY_LIFECYCLE_RULESET_ID,
    }),
  });
}

function parseWriterCanaryRulesApiClosure(value, label) {
  const closure = expectRecord(value, `${label} API closure`);
  const effective = parseApiReceipt(closure.effective, `${label} effective rules`);
  const lifecycle = parseApiReceipt(closure.lifecycle, `${label} lifecycle ruleset`);
  const authority = parseApiReceipt(closure.authority, `${label} authority ruleset`);
  const rules = parseWriterCanaryRules({
    authority: authority.body,
    effective: effective.body,
    lifecycle: lifecycle.body,
  });
  return Object.freeze({
    bodySha256: Object.freeze({
      authority: receiptDigest(authority.body),
      effective: receiptDigest(effective.body),
      lifecycle: receiptDigest(lifecycle.body),
    }),
    rules,
    serverDates: Object.freeze({
      authority: authority.serverDate,
      effective: effective.serverDate,
      lifecycle: lifecycle.serverDate,
    }),
  });
}

export function parseWriterCanaryEnvironment(environment) {
  const controlEpochDigest = environment.CONTROL_EPOCH_DIGEST;
  if (controlEpochDigest !== undefined && typeof controlEpochDigest !== "string") {
    fail("CONTROL_EPOCH_DIGEST is malformed");
  }
  const repositoryId = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_REPOSITORY_ID"),
    "GITHUB_REPOSITORY_ID",
  );
  const runAttempt = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT",
  );
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== MAIN_REF ||
    environment.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY ||
    repositoryId !== EXPECTED_REPOSITORY_ID ||
    environment.GITHUB_REPOSITORY_OWNER !== EXPECTED_OWNER ||
    environment.GITHUB_WORKFLOW !== EXPECTED_WORKFLOW_NAME ||
    environment.GITHUB_WORKFLOW_REF !== EXPECTED_WORKFLOW_REF ||
    runAttempt !== 1
  ) {
    fail("writer canary is not one attempt of the checked current-main workflow");
  }
  const workflowSha = exactSha(environment.GITHUB_SHA, "writer canary GITHUB_SHA");
  if (environment.GITHUB_WORKFLOW_SHA !== workflowSha) {
    fail("writer canary workflow source is not its exact event SHA");
  }
  return Object.freeze({
    apiUrl: exactApiUrl(environment.GITHUB_API_URL),
    controlEpochDigest: controlEpochDigest === "" ? undefined : controlEpochDigest,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: 1,
    runId: exactPositiveInteger(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    workflowSha,
  });
}

export function parseWriterCanaryRef(value, expectedRef) {
  const response = expectRecord(value, "writer canary ref response");
  const object = expectRecord(response.object, "writer canary ref object");
  if (
    response.ref !== expectedRef ||
    object.type !== "commit" ||
    !SHA.test(object.sha) ||
    object.url !==
      `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/commits/${object.sha}` ||
    response.url !==
      `https://api.github.com/repos/${EXPECTED_REPOSITORY}/git/${expectedRef}`
  ) {
    fail(`writer canary ref response does not bind ${expectedRef}`);
  }
  return object.sha;
}

export function parseWriterCanaryRun(value, expected) {
  const run = expectRecord(value, "writer canary run response");
  const repository = expectRecord(run.repository, "writer canary run repository");
  const workflowId = exactPositiveInteger(run.workflow_id, "writer canary workflow_id");
  if (
    run.id !== expected.runId ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== expected.workflowSha ||
    run.path !== EXPECTED_WORKFLOW_RUN_PATH ||
    workflowId !== EXPECTED_WORKFLOW_ID ||
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY
  ) {
    fail("writer canary run does not bind the checked current-main workflow");
  }
  return Object.freeze({
    runAttempt: 1,
    runId: expected.runId,
    workflowId: EXPECTED_WORKFLOW_ID,
  });
}

function exactLocalHead(workingDirectory) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  if (result.status !== 0 || !SHA.test(result.stdout.trim()) || result.stdout !== `${result.stdout.trim()}\n`) {
    fail("writer canary checkout has no exact HEAD commit");
  }
  return result.stdout.trim();
}

export async function createWriterCanaryPreflight({
  api,
  environment,
  verifyRange = verifyCanaryWorkflowAdmission,
  workingDirectory = process.cwd(),
}) {
  const coordinate = parseWriterCanaryEnvironment(environment);
  const [mainValue, canaryValue, runValue] = await Promise.all([
    api.getRef(MAIN_REF),
    api.getRef(CANARY_REF),
    api.getRun(coordinate.runId),
  ]);
  const mainReceipt = parseApiReceipt(mainValue, "writer canary main ref");
  const canaryReceipt = parseApiReceipt(canaryValue, "writer canary protected ref");
  const runReceipt = parseApiReceipt(runValue, "writer canary run");
  const targetSha = parseWriterCanaryRef(mainReceipt.body, MAIN_REF);
  const expectedOldSha = parseWriterCanaryRef(canaryReceipt.body, CANARY_REF);
  const run = parseWriterCanaryRun(runReceipt.body, coordinate);
  if (
    targetSha !== coordinate.workflowSha ||
    exactLocalHead(workingDirectory) !== coordinate.workflowSha ||
    expectedOldSha === targetSha
  ) {
    fail("writer canary does not bind one advancing current-main transition");
  }
  let range;
  try {
    range = verifyRange({
      controlEpochDigest: coordinate.controlEpochDigest,
      currentMainSha: targetSha,
      eventName: "workflow_dispatch",
      eventRef: MAIN_REF,
      eventSha: coordinate.workflowSha,
      githubActions: "true",
      previousSha: expectedOldSha,
      protectedRef: CANARY_REF,
      repository: EXPECTED_REPOSITORY,
      repositoryId: EXPECTED_REPOSITORY_ID,
      runAttempt: coordinate.runAttempt,
      targetSha,
      workflowSha: coordinate.workflowSha,
      workingDirectory,
    });
  } catch (error) {
    if (!(error instanceof ControlEpochAdmissionError)) throw error;
    const finalCanaryReceipt = parseApiReceipt(
      await api.getRef(CANARY_REF),
      "writer canary workflow-delta ref readback",
    );
    const finalSha = parseWriterCanaryRef(finalCanaryReceipt.body, CANARY_REF);
    const initialDates = [
      mainReceipt.serverDate,
      canaryReceipt.serverDate,
      runReceipt.serverDate,
    ].map(Date.parse);
    if (finalSha !== expectedOldSha) {
      fail("writer canary workflow-delta rejection did not preserve the exact ref");
    }
    if (initialDates.some((value) => Date.parse(finalCanaryReceipt.serverDate) < value)) {
      fail("writer canary workflow-delta readback predates its admitted coordinate");
    }
    throw new WriterCanaryWorkflowDeltaError(Object.freeze({
      canaryServerDate: canaryReceipt.serverDate,
      controlEpoch: error.receipt,
      context: RELEASE_CANARY_STATUS_CONTEXT,
      expectedOldSha,
      finalSha,
      mainServerDate: mainReceipt.serverDate,
      offendingCommit: error.receipt.changes[0]?.commitSha,
      productionRef: CANARY_REF,
      readbackServerDate: finalCanaryReceipt.serverDate,
      repository: EXPECTED_REPOSITORY,
      repositoryId: EXPECTED_REPOSITORY_ID,
      runAttempt: run.runAttempt,
      runId: run.runId,
      runServerDate: runReceipt.serverDate,
      schema: "message-like-me-production-writer-canary-control-epoch-rejection-v2",
      targetSha,
      workflowId: run.workflowId,
      workflowSha: coordinate.workflowSha,
    }), error.receipt);
  }
  const rulesClosure = parseWriterCanaryRulesApiClosure(
    await api.getRules(),
    "writer canary",
  );
  const initialCoordinateDates = [
    mainReceipt.serverDate,
    canaryReceipt.serverDate,
    runReceipt.serverDate,
  ].map(Date.parse);
  const rulesDates = Object.values(rulesClosure.serverDates).map(Date.parse);
  if (rulesDates.some((value) => initialCoordinateDates.some((initial) => value < initial))) {
    fail("writer canary rules readback predates its admitted coordinate");
  }
  return Object.freeze({
    canaryServerDate: canaryReceipt.serverDate,
    context: RELEASE_CANARY_STATUS_CONTEXT,
    expectedOldSha,
    mainServerDate: mainReceipt.serverDate,
    productionRef: CANARY_REF,
    range,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: run.runAttempt,
    runId: run.runId,
    rules: rulesClosure.rules,
    rulesBodySha256: rulesClosure.bodySha256,
    rulesServerDates: rulesClosure.serverDates,
    schema: CANARY_RECEIPT_SCHEMA,
    targetSha,
    workflowId: run.workflowId,
    runServerDate: runReceipt.serverDate,
    workflowSha: coordinate.workflowSha,
  });
}

export class WriterCanaryWorkflowDeltaError extends Error {
  constructor(receipt, controlEpoch) {
    super("writer canary requires an exact v2 control-epoch digest before key admission");
    this.name = "WriterCanaryWorkflowDeltaError";
    this.controlEpoch = controlEpoch;
    this.receipt = receipt;
  }
}

function normalizedPreflightReceipt(value) {
  const receipt = expectRecord(value, "writer canary preflight receipt");
  const range = assertCanaryWorkflowAdmissionReceipt(receipt.range, {
    previousSha: exactSha(receipt.expectedOldSha, "writer canary expected-old SHA"),
    targetSha: exactSha(receipt.targetSha, "writer canary target SHA"),
    workflowSha: exactSha(receipt.workflowSha, "writer canary workflow SHA"),
  });
  if (
    receipt.schema !== CANARY_RECEIPT_SCHEMA ||
    receipt.context !== RELEASE_CANARY_STATUS_CONTEXT ||
    receipt.productionRef !== CANARY_REF ||
    receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.repositoryId !== EXPECTED_REPOSITORY_ID ||
    receipt.runAttempt !== 1 ||
    receipt.workflowSha !== receipt.targetSha
  ) {
    fail("writer canary preflight receipt has the wrong authority boundary");
  }
  return Object.freeze({
    canaryServerDate: exactReceiptTimestamp(
      receipt.canaryServerDate,
      "writer canary receipt canaryServerDate",
    ),
    context: RELEASE_CANARY_STATUS_CONTEXT,
    expectedOldSha: receipt.expectedOldSha,
    mainServerDate: exactReceiptTimestamp(
      receipt.mainServerDate,
      "writer canary receipt mainServerDate",
    ),
    productionRef: CANARY_REF,
    range,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: 1,
    runId: exactPositiveInteger(receipt.runId, "writer canary receipt runId"),
    rules: normalizedRulesReceipt(receipt.rules),
    rulesBodySha256: Object.freeze({
      authority: exactSha256(
        expectRecord(receipt.rulesBodySha256, "writer canary rules body digests").authority,
        "writer canary authority rules body digest",
      ),
      effective: exactSha256(
        receipt.rulesBodySha256.effective,
        "writer canary effective rules body digest",
      ),
      lifecycle: exactSha256(
        receipt.rulesBodySha256.lifecycle,
        "writer canary lifecycle rules body digest",
      ),
    }),
    rulesServerDates: Object.freeze({
      authority: exactReceiptTimestamp(
        expectRecord(receipt.rulesServerDates, "writer canary rules dates").authority,
        "writer canary receipt authority rules Date",
      ),
      effective: exactReceiptTimestamp(
        receipt.rulesServerDates.effective,
        "writer canary receipt effective rules Date",
      ),
      lifecycle: exactReceiptTimestamp(
        receipt.rulesServerDates.lifecycle,
        "writer canary receipt lifecycle rules Date",
      ),
    }),
    schema: CANARY_RECEIPT_SCHEMA,
    targetSha: receipt.targetSha,
    workflowId: exactPositiveInteger(receipt.workflowId, "writer canary receipt workflowId"),
    runServerDate: exactReceiptTimestamp(
      receipt.runServerDate,
      "writer canary receipt runServerDate",
    ),
    workflowSha: receipt.workflowSha,
  });
}

export function encodeWriterCanaryPreflightReceipt(value) {
  const receipt = normalizedPreflightReceipt(value);
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) {
    fail("writer canary preflight receipt exceeds its byte bound");
  }
  return encoded;
}

export function decodeWriterCanaryPreflightReceipt(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RECEIPT_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("writer canary preflight receipt is missing or malformed");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("writer canary receipt is noncanonical");
    return normalizedPreflightReceipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("writer canary")) throw error;
    fail("writer canary preflight receipt is not canonical JSON");
  }
}

function stablePreflightValue(receipt) {
  const { canaryServerDate: _canary, mainServerDate: _main, rulesServerDates: _rules, runServerDate: _run, ...stable } = receipt;
  return stable;
}

function assertFreshPreflight(admitted, fresh) {
  if (JSON.stringify(stablePreflightValue(admitted)) !== JSON.stringify(stablePreflightValue(fresh))) {
    fail("writer canary preflight changed before protected execution");
  }
  const admittedDates = [
    admitted.canaryServerDate,
    admitted.mainServerDate,
    admitted.rulesServerDates.authority,
    admitted.rulesServerDates.effective,
    admitted.rulesServerDates.lifecycle,
    admitted.runServerDate,
  ].map((value) => Date.parse(value));
  const freshDates = [
    fresh.canaryServerDate,
    fresh.mainServerDate,
    fresh.rulesServerDates.authority,
    fresh.rulesServerDates.effective,
    fresh.rulesServerDates.lifecycle,
    fresh.runServerDate,
  ].map((value) => Date.parse(value));
  const admittedMaximum = Math.max(...admittedDates);
  if (freshDates.some((value) => value < admittedMaximum)) {
    fail("writer canary authenticated API Date regressed before protected execution");
  }
  return fresh;
}

function writerCanaryPreflightDigest(receipt) {
  return receiptDigest(receipt);
}

function writerCanaryPreflightSemanticDigest(receipt) {
  return receiptDigest(stablePreflightValue(receipt));
}

function canaryPhaseBase(admitted, phase, schema) {
  return Object.freeze({
    context: RELEASE_CANARY_STATUS_CONTEXT,
    expectedOldSha: admitted.expectedOldSha,
    phase,
    preflightSha256: writerCanaryPreflightDigest(admitted),
    preflightSemanticSha256: writerCanaryPreflightSemanticDigest(admitted),
    productionRef: CANARY_REF,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: 1,
    runId: admitted.runId,
    schema,
    targetSha: admitted.targetSha,
    workflowId: admitted.workflowId,
    workflowSha: admitted.workflowSha,
  });
}

function statusEvidence(value, expectedState, targetSha, label) {
  const receipt = expectRecord(value, label);
  const nodeId = expectString(receipt.statusNodeId, `${label} nodeId`);
  const creator = expectRecord(receipt.creator, `${label} creator`);
  const creatorNodeId = expectString(creator.nodeId, `${label} creator nodeId`);
  const expectedDescription = expectedState === "success"
    ? "Exact canary authority admitted for one canary-ref attempt"
    : "Canary authority consumed after the canary-ref attempt";
  if (
    receipt.appId !== EXPECTED_APP_ID ||
    receipt.appSlug !== EXPECTED_APP_SLUG ||
    receipt.context !== RELEASE_CANARY_STATUS_CONTEXT ||
    receipt.description !== expectedDescription ||
    receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.repositoryId !== EXPECTED_REPOSITORY_ID ||
    receipt.state !== expectedState ||
    receipt.statusUrl !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    receipt.targetSha !== targetSha ||
    nodeId.length === 0 ||
    nodeId.length > 512 ||
    creator.id < 1 ||
    !Number.isSafeInteger(creator.id) ||
    creator.login !== `${EXPECTED_APP_SLUG}[bot]` ||
    creatorNodeId.length === 0 ||
    creatorNodeId.length > 512
  ) {
    fail(`${label} is not exact canary status evidence`);
  }
  return Object.freeze({
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    context: RELEASE_CANARY_STATUS_CONTEXT,
    createdAt: exactSecondTimestamp(receipt.createdAt, `${label} createdAt`),
    creator: Object.freeze({
      id: creator.id,
      login: creator.login,
      nodeId: creatorNodeId,
    }),
    description: expectedDescription,
    installationId: exactPositiveInteger(receipt.installationId, `${label} installationId`),
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate: exactReceiptTimestamp(receipt.serverDate, `${label} serverDate`),
    state: expectedState,
    statusId: exactPositiveInteger(receipt.statusId, `${label} statusId`),
    statusNodeId: nodeId,
    statusUrl: receipt.statusUrl,
    targetSha,
  });
}

function readbackEvidence(value, targetSha, label) {
  const receipt = expectRecord(value, label);
  const nodeId = expectString(receipt.terminalStatusNodeId, `${label} terminal nodeId`);
  if (
    receipt.context !== RELEASE_CANARY_STATUS_CONTEXT ||
    receipt.state !== "failure" ||
    receipt.targetSha !== targetSha ||
    nodeId.length === 0 ||
    nodeId.length > 512
  ) {
    fail(`${label} is not exact canary terminal readback evidence`);
  }
  return Object.freeze({
    context: RELEASE_CANARY_STATUS_CONTEXT,
    serverDate: exactReceiptTimestamp(receipt.serverDate, `${label} serverDate`),
    state: "failure",
    statusCount: exactPositiveInteger(receipt.statusCount, `${label} statusCount`),
    targetSha,
    terminalStatusId: exactPositiveInteger(
      receipt.terminalStatusId,
      `${label} terminalStatusId`,
    ),
    terminalStatusNodeId: nodeId,
  });
}

function writerPushEvidence(value, expectedOldSha, targetSha) {
  const receipt = expectRecord(value, "writer canary push receipt");
  if (
    receipt.classification !== "fast-forward" ||
    receipt.fromSha !== expectedOldSha ||
    receipt.protectedRef !== CANARY_REF ||
    receipt.toSha !== targetSha
  ) {
    fail("writer canary push receipt is not one attributable fast-forward update");
  }
  return Object.freeze({
    classification: "fast-forward",
    fromSha: expectedOldSha,
    protectedRef: CANARY_REF,
    summarySha256: exactSha256(receipt.summarySha256, "writer canary push summary digest"),
    toSha: targetSha,
  });
}

function rulesEvidenceFromPreflight(preflight) {
  return Object.freeze({
    bodySha256: preflight.rulesBodySha256,
    rules: preflight.rules,
    serverDates: preflight.rulesServerDates,
  });
}

function normalizePhaseRulesEvidence(value, label) {
  const evidence = expectRecord(value, label);
  const bodySha256 = expectRecord(evidence.bodySha256, `${label} body digests`);
  const serverDates = expectRecord(evidence.serverDates, `${label} server Dates`);
  return Object.freeze({
    bodySha256: Object.freeze({
      authority: exactSha256(bodySha256.authority, `${label} authority digest`),
      effective: exactSha256(bodySha256.effective, `${label} effective digest`),
      lifecycle: exactSha256(bodySha256.lifecycle, `${label} lifecycle digest`),
    }),
    rules: normalizedRulesReceipt(evidence.rules),
    serverDates: Object.freeze({
      authority: exactReceiptTimestamp(serverDates.authority, `${label} authority Date`),
      effective: exactReceiptTimestamp(serverDates.effective, `${label} effective Date`),
      lifecycle: exactReceiptTimestamp(serverDates.lifecycle, `${label} lifecycle Date`),
    }),
  });
}

function assertNonRegressingDates(values, label) {
  const milliseconds = values.map((value) => Date.parse(value));
  if (milliseconds.some((value, index) => index > 0 && value < milliseconds[index - 1])) {
    fail(`${label} has a regressing authenticated Date`);
  }
  return milliseconds;
}

function normalizedPhaseBase(receipt, phase, schema) {
  if (
    receipt.phase !== phase ||
    receipt.schema !== schema ||
    receipt.context !== RELEASE_CANARY_STATUS_CONTEXT ||
    receipt.productionRef !== CANARY_REF ||
    receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.repositoryId !== EXPECTED_REPOSITORY_ID ||
    receipt.runAttempt !== 1 ||
    receipt.workflowSha !== receipt.targetSha
  ) {
    fail(`writer canary ${phase} receipt has the wrong authority boundary`);
  }
  return Object.freeze({
    context: RELEASE_CANARY_STATUS_CONTEXT,
    expectedOldSha: exactSha(receipt.expectedOldSha, `${phase} expected-old SHA`),
    phase,
    preflightSemanticSha256: exactSha256(
      receipt.preflightSemanticSha256,
      `${phase} preflight semantic digest`,
    ),
    preflightSha256: exactSha256(receipt.preflightSha256, `${phase} preflight digest`),
    productionRef: CANARY_REF,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: 1,
    runId: exactPositiveInteger(receipt.runId, `${phase} runId`),
    schema,
    targetSha: exactSha(receipt.targetSha, `${phase} target SHA`),
    workflowId: exactPositiveInteger(receipt.workflowId, `${phase} workflowId`),
    workflowSha: exactSha(receipt.workflowSha, `${phase} workflow SHA`),
  });
}

function normalizeWriterCanaryPhaseReceipt(value) {
  const receipt = expectRecord(value, "writer canary phase receipt");
  const phase = expectString(receipt.phase, "writer canary phase");
  let normalized;
  if (phase === "terminalized") {
    const schema = "message-like-me-production-writer-canary-terminalized-v1";
    const base = normalizedPhaseBase(receipt, phase, schema);
    const denial = expectRecord(receipt.appRefDenial, "writer canary App ref denial");
    if (denial.appId !== EXPECTED_APP_ID || denial.status !== 403) {
      fail("writer canary App ref denial is not exact");
    }
    normalized = Object.freeze({
      ...base,
      appRefDenial: Object.freeze({
        appId: EXPECTED_APP_ID,
        installationId: exactPositiveInteger(
          denial.installationId,
          "writer canary App denial installationId",
        ),
        rateLimitRemaining: exactPositiveInteger(
          denial.rateLimitRemaining,
          "writer canary App denial rate limit",
        ),
        serverDate: exactReceiptTimestamp(
          denial.serverDate,
          "writer canary App denial serverDate",
        ),
        status: 403,
      }),
      appRevocation: exactRevocation(receipt.appRevocation, "writer canary App denial revocation"),
      status: statusEvidence(receipt.status, "error", base.targetSha, "writer canary precondition status"),
      statusReadback: readbackEvidence(
        receipt.statusReadback,
        base.targetSha,
        "writer canary precondition readback",
      ),
      statusRevocation: exactRevocation(
        receipt.statusRevocation,
        "writer canary precondition revocation",
      ),
    });
    assertNonRegressingDates([
      normalized.appRefDenial.serverDate,
      normalized.appRevocation.deletionServerDate,
      normalized.appRevocation.lastObservationServerDate,
      normalized.status.serverDate,
      normalized.statusReadback.serverDate,
      normalized.statusRevocation.deletionServerDate,
      normalized.statusRevocation.lastObservationServerDate,
    ], "writer canary terminalized phase");
  } else if (phase === "writer-denied") {
    const schema = "message-like-me-production-writer-canary-writer-denied-v3";
    const base = normalizedPhaseBase(receipt, phase, schema);
    const denial = expectRecord(receipt.denial, "writer canary writer denial");
    const refReadback = expectRecord(receipt.refReadback, "writer canary denial ref readback");
    if (denial.classification !== "required-status-errored") {
      fail("writer canary writer denial classification is not exact");
    }
    normalized = Object.freeze({
      ...base,
      denial: Object.freeze({
        classification: "required-status-errored",
        diagnosticSha256: exactSha256(
          denial.diagnosticSha256,
          "writer canary writer denial digest",
        ),
      }),
      refReadback: Object.freeze({
        serverDate: exactReceiptTimestamp(
          refReadback.serverDate,
          "writer canary denial readback Date",
        ),
        sha: exactSha(refReadback.sha, "writer canary denial readback SHA"),
      }),
      rules: normalizePhaseRulesEvidence(
        receipt.rules,
        "writer canary denial rules",
      ),
    });
    if (
      normalized.refReadback.sha !== base.expectedOldSha ||
      Object.values(normalized.rules.serverDates).some((value) =>
        Date.parse(normalized.refReadback.serverDate) < Date.parse(value))
    ) {
      fail("writer canary writer denial did not preserve the exact ref");
    }
  } else if (phase === "attested") {
    const schema = "message-like-me-production-writer-canary-attested-v1";
    const base = normalizedPhaseBase(receipt, phase, schema);
    normalized = Object.freeze({
      ...base,
      status: statusEvidence(receipt.status, "success", base.targetSha, "writer canary attestation"),
      statusRevocation: exactRevocation(
        receipt.statusRevocation,
        "writer canary attestation revocation",
      ),
    });
    assertNonRegressingDates([
      normalized.status.serverDate,
      normalized.statusRevocation.deletionServerDate,
      normalized.statusRevocation.lastObservationServerDate,
    ], "writer canary attested phase");
  } else if (phase === "advanced") {
    const schema = "message-like-me-production-writer-canary-advanced-v1";
    const base = normalizedPhaseBase(receipt, phase, schema);
    const refReadback = expectRecord(receipt.refReadback, "writer canary final ref readback");
    const staleLease = expectRecord(receipt.staleLease, "writer canary stale lease");
    const staleReadback = expectRecord(receipt.staleReadback, "writer canary stale ref readback");
    const statusReadback = expectRecord(
      receipt.statusReadback,
      "writer canary success status readback",
    );
    if (staleLease.classification !== "stale-info") {
      fail("writer canary stale lease classification is not exact");
    }
    normalized = Object.freeze({
      ...base,
      refReadback: Object.freeze({
        serverDate: exactReceiptTimestamp(refReadback.serverDate, "writer canary final ref Date"),
        sha: exactSha(refReadback.sha, "writer canary final ref SHA"),
      }),
      rules: normalizePhaseRulesEvidence(
        receipt.rules,
        "writer canary advance rules",
      ),
      staleLease: Object.freeze({
        classification: "stale-info",
        diagnosticSha256: exactSha256(
          staleLease.diagnosticSha256,
          "writer canary stale lease digest",
        ),
      }),
      staleReadback: Object.freeze({
        serverDate: exactReceiptTimestamp(
          staleReadback.serverDate,
          "writer canary stale readback Date",
        ),
        sha: exactSha(staleReadback.sha, "writer canary stale readback SHA"),
      }),
      statusReadback: Object.freeze({
        serverDate: exactReceiptTimestamp(
          statusReadback.serverDate,
          "writer canary success status readback Date",
        ),
        statusId: exactPositiveInteger(
          statusReadback.statusId,
          "writer canary success status readback id",
        ),
        statusNodeId: expectString(
          statusReadback.statusNodeId,
          "writer canary success status readback node id",
        ),
      }),
      writerPush: writerPushEvidence(
        receipt.writerPush,
        base.expectedOldSha,
        base.targetSha,
      ),
    });
    if (
      normalized.refReadback.sha !== base.targetSha ||
      normalized.staleReadback.sha !== base.targetSha ||
      Object.values(normalized.rules.serverDates).some((value) =>
        Date.parse(normalized.statusReadback.serverDate) < Date.parse(value)) ||
      Date.parse(normalized.staleReadback.serverDate) < Date.parse(normalized.refReadback.serverDate) ||
      Date.parse(normalized.refReadback.serverDate) < Date.parse(normalized.statusReadback.serverDate)
    ) {
      fail("writer canary advance or stale lease did not preserve the exact target");
    }
  } else if (phase === "consumed") {
    const schema = "message-like-me-production-writer-canary-consumed-v1";
    const base = normalizedPhaseBase(receipt, phase, schema);
    normalized = Object.freeze({
      ...base,
      status: statusEvidence(receipt.status, "error", base.targetSha, "writer canary consumption"),
      statusReadback: readbackEvidence(
        receipt.statusReadback,
        base.targetSha,
        "writer canary consumption readback",
      ),
      statusRevocation: exactRevocation(
        receipt.statusRevocation,
        "writer canary consumption revocation",
      ),
    });
    assertNonRegressingDates([
      normalized.status.serverDate,
      normalized.statusReadback.serverDate,
      normalized.statusRevocation.deletionServerDate,
      normalized.statusRevocation.lastObservationServerDate,
    ], "writer canary consumed phase");
  } else {
    fail("writer canary phase receipt has an unknown phase");
  }
  return normalized;
}

export function encodeWriterCanaryPhaseReceipt(value) {
  const receipt = normalizeWriterCanaryPhaseReceipt(value);
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) {
    fail("writer canary phase receipt exceeds its byte bound");
  }
  return encoded;
}

export function decodeWriterCanaryPhaseReceipt(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RECEIPT_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("writer canary phase receipt is missing or malformed");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("writer canary phase receipt is noncanonical");
    return normalizeWriterCanaryPhaseReceipt(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("writer canary")) throw error;
    fail("writer canary phase receipt is not canonical JSON");
  }
}

async function expectRequiredStatusDenied(operation) {
  try {
    await operation();
  } catch (error) {
    return parseWebsiteProductionCanaryRequiredStatusDenial(error);
  }
  fail("writer token without canary status unexpectedly succeeded");
}

async function readBoundedBytes(response, label) {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
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
    return bytes;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function readBoundedJson(response, label) {
  const bytes = await readBoundedBytes(response, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} did not return bounded UTF-8 JSON`);
  } finally {
    bytes.fill(0);
  }
}

function githubHeaders(token, hasBody = false) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-cache",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "message-like-me-writer-canary",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

class GitHubCanaryApi {
  constructor(apiUrl, token) {
    this.apiUrl = apiUrl;
    this.token = token;
  }

  async request(path, label) {
    const response = await fetch(new URL(path, this.apiUrl), {
      headers: githubHeaders(this.token),
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
    if (response.redirected !== false || response.headers.get("location") !== null) {
      fail(`${label} redirected`);
    }
    if (response.status !== 200) {
      await readBoundedBytes(response, `${label} error response`);
      fail(`${label} returned HTTP ${String(response.status)}`);
    }
    const serverDate = response.headers.get("date");
    exactHttpDate(serverDate, `${label} Date`);
    return Object.freeze({
      body: await readBoundedJson(response, label),
      serverDate,
    });
  }

  getRef(ref) {
    return this.request(
      `/repos/${EXPECTED_REPOSITORY}/git/ref/${ref.replace("refs/", "")}`,
      `writer canary ${ref}`,
    );
  }

  async getRefSha(ref) {
    const receipt = parseApiReceipt(await this.getRef(ref), `writer canary ${ref}`);
    return Object.freeze({
      serverDate: receipt.serverDate,
      sha: parseWriterCanaryRef(receipt.body, ref),
    });
  }

  getRun(runId) {
    return this.request(
      `/repos/${EXPECTED_REPOSITORY}/actions/runs/${String(runId)}`,
      "writer canary run",
    );
  }

  getCombinedStatus(targetSha) {
    return this.request(
      `/repos/${EXPECTED_REPOSITORY}/commits/${exactSha(targetSha, "writer canary status target")}/status?per_page=100`,
      "writer canary combined status",
    );
  }

  async getRules() {
    const [effective, lifecycle, authority] = await Promise.all([
      this.request(
        `/repos/${EXPECTED_REPOSITORY}/rules/branches/website-production-writer-canary`,
        "writer canary effective rules",
      ),
      this.request(
        `/repos/${EXPECTED_REPOSITORY}/rulesets/${String(CANARY_LIFECYCLE_RULESET_ID)}`,
        "writer canary lifecycle ruleset",
      ),
      this.request(
        `/repos/${EXPECTED_REPOSITORY}/rulesets/${String(CANARY_AUTHORITY_RULESET_ID)}`,
        "writer canary authority ruleset",
      ),
    ]);
    return Object.freeze({ authority, effective, lifecycle });
  }
}

async function proveStatusOnlyAppRefDenied(environment, fresh) {
  let revocation;
  const result = await withReleaseAppTokenFromEnvironment(
    environment,
    async (token, app) => {
      const endpoint = new URL(
        `/repos/${EXPECTED_REPOSITORY}/git/refs/heads/website-production-writer-canary`,
        exactApiUrl(environment.GITHUB_API_URL),
      );
      const response = await fetch(endpoint, {
        body: JSON.stringify({ force: false, sha: fresh.targetSha }),
        headers: githubHeaders(token, true),
        method: "PATCH",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });
      if (response.redirected !== false || response.headers.get("location") !== null) {
        fail("status-only App ref-denial probe redirected");
      }
      if (response.status !== 403) {
        await readBoundedBytes(response, "status-only App ref-denial response");
        fail(`status-only App ref-denial probe returned HTTP ${String(response.status)}`);
      }
      const body = expectRecord(
        await readBoundedJson(response, "status-only App ref-denial response"),
        "status-only App ref-denial response",
      );
      const remaining = exactPositiveInteger(
        response.headers.get("x-ratelimit-remaining"),
        "status-only App ref-denial x-ratelimit-remaining",
      );
      const server = exactHttpDate(
        response.headers.get("date"),
        "status-only App ref-denial Date",
      );
      if (
        body.message !== "Resource not accessible by integration" ||
        body.status !== "403" ||
        typeof body.documentation_url !== "string" ||
        !body.documentation_url.startsWith("https://docs.github.com/rest/") ||
        server.milliseconds >= Date.parse(app.expiresAt)
      ) {
        fail("status-only App ref denial is not the exact non-rate-limit capability denial");
      }
      return Object.freeze({
        app,
        denied: true,
        rateLimitRemaining: remaining,
        serverDate: server.timestamp,
        status: 403,
      });
    },
    async (receipt) => {
      revocation = receipt;
    },
  );
  if (result.denied !== true || revocation?.converged !== true) {
    fail("status-only App ref-denial probe did not revoke conclusively");
  }
  return Object.freeze({ ...result, revocation });
}

function assertAppOnlyProcess(environment) {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "MLM_RELEASE_REF_TOKEN"]) {
    if (typeof environment[key] === "string" && environment[key].length > 0) {
      fail(`writer canary App-only process unexpectedly received ${key}`);
    }
  }
}

function assertWriterOnlyProcess(environment) {
  for (const key of Object.keys(environment)) {
    if (key.startsWith("MLM_RELEASE_APP_") && environment[key] !== undefined) {
      fail(`writer canary writer-only process unexpectedly received ${key}`);
    }
  }
}

function admittedCanaryFromEnvironment(environment) {
  const admitted = decodeWriterCanaryPreflightReceipt(
    exactEnvironmentString(environment, "CANARY_PREFLIGHT_RECEIPT"),
  );
  const coordinate = parseWriterCanaryEnvironment(environment);
  if (
    admitted.runId !== coordinate.runId ||
    admitted.targetSha !== coordinate.workflowSha ||
    exactLocalHead(process.cwd()) !== coordinate.workflowSha
  ) {
    fail("writer canary phase does not bind its admitted current-main checkout");
  }
  return admitted;
}

function phaseReceipt(admitted, phase, payload) {
  const version = phase === "writer-denied" ? "v3" : "v1";
  const schema = `message-like-me-production-writer-canary-${phase}-${version}`;
  return normalizeWriterCanaryPhaseReceipt(Object.freeze({
    ...canaryPhaseBase(admitted, phase, schema),
    ...payload,
  }));
}

export async function terminalizeWriterCanary({ admitted, proveAppRefDenied, terminalizeStatus }) {
  const appRefDenial = await proveAppRefDenied(admitted);
  const terminalized = await terminalizeStatus(admitted);
  return phaseReceipt(admitted, "terminalized", {
    appRefDenial: Object.freeze({
      appId: appRefDenial.app.appId,
      installationId: appRefDenial.app.installationId,
      rateLimitRemaining: appRefDenial.rateLimitRemaining,
      serverDate: appRefDenial.serverDate,
      status: appRefDenial.status,
    }),
    appRevocation: appRefDenial.revocation,
    status: terminalized.consumption,
    statusReadback: terminalized.readback,
    statusRevocation: terminalized.revocation,
  });
}

export async function denyWriterCanaryWithoutSuccess({ admitted, advanceRef, api, environment, verifyRange, workingDirectory }) {
  const fresh = assertFreshPreflight(admitted, await createWriterCanaryPreflight({
    api,
    environment,
    verifyRange,
    workingDirectory,
  }));
  const denial = await expectRequiredStatusDenied(() => advanceRef(fresh));
  const refReadback = await api.getRefSha(CANARY_REF);
  return phaseReceipt(admitted, "writer-denied", {
    denial,
    refReadback,
    rules: rulesEvidenceFromPreflight(fresh),
  });
}

export async function attestWriterCanary({ admitted, attestStatus }) {
  const result = await attestStatus(admitted);
  return phaseReceipt(admitted, "attested", {
    status: result.status,
    statusRevocation: result.revocation,
  });
}

function parseCurrentCanarySuccess(value, admitted, attestation) {
  const combined = expectRecord(value, "writer canary combined success status");
  const repository = expectRecord(combined.repository, "writer canary combined repository");
  if (
    combined.sha !== admitted.targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${admitted.targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${admitted.targetSha}/status` ||
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    !Array.isArray(combined.statuses) ||
    combined.statuses.length < 1 ||
    combined.statuses.length > 100 ||
    combined.total_count !== combined.statuses.length
  ) {
    fail("writer canary combined success status does not bind the exact target");
  }
  const matching = combined.statuses.filter((item) => isRecord(item) &&
    item.context === RELEASE_CANARY_STATUS_CONTEXT);
  if (matching.length !== 1) fail("writer canary has no unique newest success authority");
  const status = matching[0];
  if (
    status.id !== attestation.status.statusId ||
    status.node_id !== attestation.status.statusNodeId ||
    status.state !== "success" ||
    status.description !== "Exact canary authority admitted for one canary-ref attempt" ||
    status.target_url !== null ||
    status.created_at !== attestation.status.createdAt ||
    status.updated_at !== attestation.status.createdAt ||
    status.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${admitted.targetSha}`
  ) {
    fail("writer canary newest success does not bind the exact App attestation receipt");
  }
  return Object.freeze({
    statusId: attestation.status.statusId,
    statusNodeId: attestation.status.statusNodeId,
  });
}

function parseCurrentCanaryTerminal(value, admitted, consumed, serverDate) {
  const combined = expectRecord(value, "writer canary terminal combined status");
  const repository = expectRecord(combined.repository, "writer canary terminal repository");
  if (
    combined.sha !== admitted.targetSha ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${admitted.targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${admitted.targetSha}/status` ||
    repository.id !== EXPECTED_REPOSITORY_ID || repository.full_name !== EXPECTED_REPOSITORY ||
    !Array.isArray(combined.statuses) || combined.statuses.length < 1 ||
    combined.statuses.length > 100 || combined.total_count !== combined.statuses.length
  ) {
    fail("writer canary terminal combined status does not bind the exact target");
  }
  const matching = combined.statuses.filter((item) => isRecord(item) &&
    item.context === RELEASE_CANARY_STATUS_CONTEXT);
  if (matching.length !== 1) fail("writer canary has no unique terminal authority");
  const status = matching[0];
  if (
    status.id !== consumed.status.statusId ||
    status.node_id !== consumed.status.statusNodeId ||
    status.state !== "error" || status.description !== consumed.status.description ||
    status.target_url !== null || status.created_at !== consumed.status.createdAt ||
    status.updated_at !== consumed.status.createdAt || status.url !== consumed.status.statusUrl
  ) {
    fail("writer canary terminal authority is not the exact consumed status");
  }
  const observed = exactReceiptTimestamp(serverDate, "writer canary terminal status Date");
  if (Date.parse(observed) < Date.parse(consumed.statusRevocation.lastObservationServerDate)) {
    fail("writer canary terminal status predates consumption revocation");
  }
  return Object.freeze({
    serverDate: observed,
    statusId: consumed.status.statusId,
    statusNodeId: consumed.status.statusNodeId,
    targetSha: admitted.targetSha,
  });
}

export async function advanceWriterCanary({ admitted, advanceRef, api, attestationReceipt, environment, proveStaleLease, verifyRange, workingDirectory }) {
  const attestation = decodeWriterCanaryPhaseReceipt(attestationReceipt);
  if (
    attestation.phase !== "attested" ||
    attestation.preflightSha256 !== writerCanaryPreflightDigest(admitted)
  ) {
    fail("writer canary advance has no exact attestation receipt");
  }
  const fresh = assertFreshPreflight(admitted, await createWriterCanaryPreflight({
    api,
    environment,
    verifyRange,
    workingDirectory,
  }));
  const statusReceipt = parseApiReceipt(
    await api.getCombinedStatus(fresh.targetSha),
    "writer canary current success status",
  );
  const currentStatus = parseCurrentCanarySuccess(
    statusReceipt.body,
    admitted,
    attestation,
  );
  const freshRuleMaximum = Math.max(
    ...Object.values(fresh.rulesServerDates).map((value) => Date.parse(value)),
  );
  if (
    Date.parse(statusReceipt.serverDate) < freshRuleMaximum ||
    Date.parse(statusReceipt.serverDate) <
      Date.parse(attestation.statusRevocation.lastObservationServerDate)
  ) {
    fail("writer canary success status is not a causal post-revocation authority");
  }
  const writerPush = await advanceRef(fresh);
  const refReadback = await api.getRefSha(CANARY_REF);
  const staleLease = await proveStaleLease(fresh);
  const staleReadback = await api.getRefSha(CANARY_REF);
  return phaseReceipt(admitted, "advanced", {
    refReadback,
    rules: rulesEvidenceFromPreflight(fresh),
    staleLease,
    staleReadback,
    statusReadback: Object.freeze({
      ...currentStatus,
      serverDate: statusReceipt.serverDate,
    }),
    writerPush,
  });
}

export async function consumeWriterCanary({ admitted, terminalizeStatus }) {
  const consumed = await terminalizeStatus(admitted);
  return phaseReceipt(admitted, "consumed", {
    status: consumed.consumption,
    statusReadback: consumed.readback,
    statusRevocation: consumed.revocation,
  });
}

async function livePreflight(environment) {
  const coordinate = parseWriterCanaryEnvironment(environment);
  const token = exactEnvironmentString(environment, "GH_TOKEN");
  const api = new GitHubCanaryApi(coordinate.apiUrl, token);
  return createWriterCanaryPreflight({ api, environment });
}

async function createCanaryAttestationFromEnvironment(environment, admitted) {
  assertAppOnlyProcess(environment);
  let revocation;
  const status = await withReleaseCanaryAttestationFromEnvironment(
    { ...environment, TARGET: admitted.targetSha },
    async (receipt) => {
      revocation = receipt;
    },
  );
  return Object.freeze({
    revocation: exactRevocation(revocation, "writer canary attestation revocation"),
    status,
  });
}

function writerApiFromEnvironment(environment) {
  assertWriterOnlyProcess(environment);
  const coordinate = parseWriterCanaryEnvironment(environment);
  const token = exactEnvironmentString(environment, "GH_TOKEN");
  return new GitHubCanaryApi(coordinate.apiUrl, token);
}

function advanceCanaryFromWriterEnvironment(environment, fresh) {
  assertWriterOnlyProcess(environment);
  const refToken = exactEnvironmentString(environment, "MLM_RELEASE_REF_TOKEN");
  return Promise.resolve(advanceWebsiteProductionCanaryRefFromEnvironment({
      environment: Object.freeze({
        MLM_RELEASE_REF_TOKEN: refToken,
      }),
      expectedOldSha: fresh.expectedOldSha,
      repository: EXPECTED_REPOSITORY,
      targetSha: fresh.targetSha,
      workflowSha: fresh.workflowSha,
    }));
}

function staleCanaryFromWriterEnvironment(environment, fresh) {
  assertWriterOnlyProcess(environment);
  const refToken = exactEnvironmentString(environment, "MLM_RELEASE_REF_TOKEN");
  return Promise.resolve(proveWebsiteProductionCanaryStaleLeaseFromEnvironment({
    currentSha: fresh.targetSha,
    environment: Object.freeze({ MLM_RELEASE_REF_TOKEN: refToken }),
    repository: EXPECTED_REPOSITORY,
    staleExpectedSha: fresh.expectedOldSha,
  }));
}

async function terminalStatusFromAppEnvironment(environment, admitted) {
  assertAppOnlyProcess(environment);
  let revocation;
  const transaction = await withReleaseCanaryTerminalStatusFromEnvironment(
    { ...environment, TARGET: admitted.targetSha },
    async (receipt) => {
      revocation = receipt;
    },
  );
  return Object.freeze({
    ...transaction,
    revocation: exactRevocation(revocation, "writer canary terminal revocation"),
  });
}

async function liveTerminalize(environment) {
  assertAppOnlyProcess(environment);
  const admitted = admittedCanaryFromEnvironment(environment);
  return terminalizeWriterCanary({
    admitted,
    proveAppRefDenied: (fresh) => proveStatusOnlyAppRefDenied(environment, fresh),
    terminalizeStatus: (fresh) => terminalStatusFromAppEnvironment(environment, fresh),
  });
}

async function liveWriterDenial(environment) {
  const admitted = admittedCanaryFromEnvironment(environment);
  const api = writerApiFromEnvironment(environment);
  return denyWriterCanaryWithoutSuccess({
    admitted,
    advanceRef: (fresh) => advanceCanaryFromWriterEnvironment(environment, fresh),
    api,
    environment,
  });
}

async function liveRevalidate(environment) {
  const admitted = admittedCanaryFromEnvironment(environment);
  const api = writerApiFromEnvironment(environment);
  const fresh = await createWriterCanaryPreflight({ api, environment });
  assertFreshPreflight(admitted, fresh);
  if (fresh.range.schema === "message-like-me-canary-control-epoch-v2") {
    writeControlEpochReview(fresh.range);
  }
  return Object.freeze({
    admittedPreflightSha256: writerCanaryPreflightDigest(admitted),
    admittedPreflightSemanticSha256: writerCanaryPreflightSemanticDigest(admitted),
    fresh,
    schema: "message-like-me-production-writer-canary-revalidation-v1",
  });
}

async function liveAttest(environment) {
  const admitted = admittedCanaryFromEnvironment(environment);
  return attestWriterCanary({
    admitted,
    attestStatus: (fresh) => createCanaryAttestationFromEnvironment(environment, fresh),
  });
}

async function liveWriterAdvance(environment) {
  const admitted = admittedCanaryFromEnvironment(environment);
  const api = writerApiFromEnvironment(environment);
  return advanceWriterCanary({
    admitted,
    advanceRef: (fresh) => advanceCanaryFromWriterEnvironment(environment, fresh),
    api,
    attestationReceipt: exactEnvironmentString(environment, "CANARY_ATTESTATION_RECEIPT"),
    environment,
    proveStaleLease: (fresh) => staleCanaryFromWriterEnvironment(environment, fresh),
  });
}

async function liveConsume(environment) {
  const admitted = admittedCanaryFromEnvironment(environment);
  return consumeWriterCanary({
    admitted,
    terminalizeStatus: (fresh) => terminalStatusFromAppEnvironment(environment, fresh),
  });
}

export async function finalizeWriterCanary({ admitted, api, phases }) {
  const normalizedPhases = Object.freeze({
    advanced: normalizeWriterCanaryPhaseReceipt(phases.advanced),
    attested: normalizeWriterCanaryPhaseReceipt(phases.attested),
    consumed: normalizeWriterCanaryPhaseReceipt(phases.consumed),
    terminalized: normalizeWriterCanaryPhaseReceipt(phases.terminalized),
    writerDenied: normalizeWriterCanaryPhaseReceipt(phases.writerDenied),
  });
  const expectedPhases = Object.freeze({
    advanced: "advanced",
    attested: "attested",
    consumed: "consumed",
    terminalized: "terminalized",
    writerDenied: "writer-denied",
  });
  const digest = writerCanaryPreflightDigest(admitted);
  const semanticDigest = writerCanaryPreflightSemanticDigest(admitted);
  for (const [name, phase] of Object.entries(normalizedPhases)) {
    if (
      phase.phase !== expectedPhases[name] ||
      phase.preflightSha256 !== digest ||
      phase.preflightSemanticSha256 !== semanticDigest
    ) {
      fail(`writer canary final receipt has the wrong ${name} phase`);
    }
  }
  const denialRuleDates = Object.values(normalizedPhases.writerDenied.rules.serverDates)
    .map(Date.parse);
  const advanceRuleDates = Object.values(normalizedPhases.advanced.rules.serverDates)
    .map(Date.parse);
  const terminalizedEnd = Date.parse(
    normalizedPhases.terminalized.statusRevocation.lastObservationServerDate,
  );
  const attestedEnd = Date.parse(
    normalizedPhases.attested.statusRevocation.lastObservationServerDate,
  );
  const admittedRuleEvidence = Object.freeze({
    bodySha256: admitted.rulesBodySha256,
    rules: admitted.rules,
  });
  for (const [label, evidence] of [
    ["denial", normalizedPhases.writerDenied.rules],
    ["advance", normalizedPhases.advanced.rules],
  ]) {
    if (JSON.stringify({ bodySha256: evidence.bodySha256, rules: evidence.rules }) !==
      JSON.stringify(admittedRuleEvidence)) {
      fail(`writer canary ${label} rules changed after admission`);
    }
  }
  if (
    denialRuleDates.some((value) => value < terminalizedEnd) ||
    advanceRuleDates.some((value) => value < attestedEnd)
  ) {
    fail("writer canary protected rules reads do not causally bracket the writer phases");
  }
  const causalDateValues = [
    normalizedPhases.terminalized.appRefDenial.serverDate,
    normalizedPhases.terminalized.appRevocation.deletionServerDate,
    normalizedPhases.terminalized.appRevocation.lastObservationServerDate,
    normalizedPhases.terminalized.status.serverDate,
    normalizedPhases.terminalized.statusReadback.serverDate,
    normalizedPhases.terminalized.statusRevocation.deletionServerDate,
    normalizedPhases.terminalized.statusRevocation.lastObservationServerDate,
    new Date(Math.max(...denialRuleDates)).toISOString(),
    normalizedPhases.writerDenied.refReadback.serverDate,
    normalizedPhases.attested.status.serverDate,
    normalizedPhases.attested.statusRevocation.deletionServerDate,
    normalizedPhases.attested.statusRevocation.lastObservationServerDate,
    new Date(Math.max(...advanceRuleDates)).toISOString(),
    normalizedPhases.advanced.statusReadback.serverDate,
    normalizedPhases.advanced.refReadback.serverDate,
    normalizedPhases.advanced.staleReadback.serverDate,
    normalizedPhases.consumed.status.serverDate,
    normalizedPhases.consumed.statusReadback.serverDate,
    normalizedPhases.consumed.statusRevocation.deletionServerDate,
    normalizedPhases.consumed.statusRevocation.lastObservationServerDate,
  ];
  const causalDates = assertNonRegressingDates(
    causalDateValues,
    "writer canary final status/write/consumption chain",
  );
  const admittedDates = [
    admitted.canaryServerDate,
    admitted.mainServerDate,
    admitted.runServerDate,
    admitted.rulesServerDates.authority,
    admitted.rulesServerDates.effective,
    admitted.rulesServerDates.lifecycle,
  ].map(Date.parse);
  if (admittedDates.some((value) => causalDates[0] < value)) {
    fail("writer canary protected execution predates its admitted preflight");
  }
  if (normalizedPhases.attested.status.statusId === normalizedPhases.consumed.status.statusId) {
    fail("writer canary final evidence reused one status identity");
  }
  if (
    normalizedPhases.advanced.statusReadback.statusId !==
      normalizedPhases.attested.status.statusId ||
    normalizedPhases.advanced.statusReadback.statusNodeId !==
      normalizedPhases.attested.status.statusNodeId ||
    normalizedPhases.terminalized.statusReadback.terminalStatusId !==
      normalizedPhases.terminalized.status.statusId ||
    normalizedPhases.terminalized.statusReadback.terminalStatusNodeId !==
      normalizedPhases.terminalized.status.statusNodeId ||
    normalizedPhases.consumed.statusReadback.terminalStatusId !==
      normalizedPhases.consumed.status.statusId ||
    normalizedPhases.consumed.statusReadback.terminalStatusNodeId !==
      normalizedPhases.consumed.status.statusNodeId
  ) {
    fail("writer canary final evidence does not bind exact status identities");
  }
  const terminalStatusResponse = parseApiReceipt(
    await api.getCombinedStatus(admitted.targetSha),
    "writer canary terminal status",
  );
  const terminalStatus = parseCurrentCanaryTerminal(
    terminalStatusResponse.body,
    admitted,
    normalizedPhases.consumed,
    terminalStatusResponse.serverDate,
  );
  const postStatusRef = await api.getRefSha(CANARY_REF);
  if (
    postStatusRef.sha !== admitted.targetSha ||
    Date.parse(postStatusRef.serverDate) < Date.parse(terminalStatus.serverDate)
  ) {
    fail("writer canary post-status ref readback is not the exact target");
  }
  const terminalRules = parseWriterCanaryRulesApiClosure(
    await api.getRules(),
    "writer canary terminal",
  );
  const terminalRuleDates = Object.values(terminalRules.serverDates).map((value) =>
    Date.parse(value));
  if (
    JSON.stringify({ bodySha256: terminalRules.bodySha256, rules: terminalRules.rules }) !==
      JSON.stringify(admittedRuleEvidence) ||
    terminalRuleDates.some((value) => value < Date.parse(postStatusRef.serverDate))
  ) {
    fail("writer canary terminal rules readback predates the post-status ref");
  }
  const finalRef = await api.getRefSha(CANARY_REF);
  if (
    finalRef.sha !== admitted.targetSha ||
    terminalRuleDates.some((value) => Date.parse(finalRef.serverDate) < value)
  ) {
    fail("writer canary final readback is not the exact current-main target");
  }
  return Object.freeze({
    context: RELEASE_CANARY_STATUS_CONTEXT,
    admittedPreflight: admitted,
    finalRef,
    phases: normalizedPhases,
    postStatusRef,
    preflightSha256: digest,
    preflightSemanticSha256: semanticDigest,
    productionRef: CANARY_REF,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    runAttempt: 1,
    runId: admitted.runId,
    schema: "message-like-me-production-writer-canary-final-v3",
    targetSha: admitted.targetSha,
    terminalStatus,
    terminalRules,
    workflowId: admitted.workflowId,
    workflowSha: admitted.workflowSha,
  });
}

async function liveFinal(environment) {
  assertWriterOnlyProcess(environment);
  const admitted = admittedCanaryFromEnvironment(environment);
  const phases = Object.freeze({
    advanced: decodeWriterCanaryPhaseReceipt(
      exactEnvironmentString(environment, "CANARY_ADVANCE_RECEIPT"),
    ),
    attested: decodeWriterCanaryPhaseReceipt(
      exactEnvironmentString(environment, "CANARY_ATTESTATION_RECEIPT"),
    ),
    consumed: decodeWriterCanaryPhaseReceipt(
      exactEnvironmentString(environment, "CANARY_CONSUMPTION_RECEIPT"),
    ),
    terminalized: decodeWriterCanaryPhaseReceipt(
      exactEnvironmentString(environment, "CANARY_TERMINAL_RECEIPT"),
    ),
    writerDenied: decodeWriterCanaryPhaseReceipt(
      exactEnvironmentString(environment, "CANARY_DENIAL_RECEIPT"),
    ),
  });
  const api = writerApiFromEnvironment(environment);
  return finalizeWriterCanary({ admitted, api, phases });
}

function receiptDigest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function encodeBoundedReceipt(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES) {
    fail("writer canary result receipt exceeds its byte bound");
  }
  return encoded;
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output === "string" && output.length > 0) {
    appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8" });
  } else {
    process.stdout.write(`${name}=${value}\n`);
  }
}

function persistReceipt(value) {
  const encoded = encodeBoundedReceipt(value);
  const digest = receiptDigest(value);
  writeOutput("receipt", encoded);
  writeOutput("receipt_sha256", digest);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summary === "string" && summary.length > 0) {
    appendFileSync(
      summary,
      `\n- Canonical canary receipt SHA-256: \`${digest}\`\n- Canonical canary receipt: \`${encoded}\`\n`,
      { encoding: "utf8" },
    );
  }
  process.stdout.write(`::notice::Writer canary receipt SHA-256 ${digest}\n`);
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  const commands = new Set([
    "preflight",
    "revalidate",
    "terminalize",
    "deny",
    "attest",
    "advance",
    "consume",
    "final",
  ]);
  if (!commands.has(command) || extra.length > 0) {
    fail("Usage: release-writer-canary.mjs preflight|revalidate|terminalize|deny|attest|advance|consume|final");
  }
  if (command === "preflight") {
    const receipt = await livePreflight(process.env);
    if (receipt.range.schema === "message-like-me-canary-control-epoch-v2") {
      writeControlEpochReview(receipt.range);
    }
    writeOutput("expected_old_sha", receipt.expectedOldSha);
    writeOutput("target_sha", receipt.targetSha);
    writeOutput("receipt", encodeWriterCanaryPreflightReceipt(receipt));
    return;
  }
  const operation = {
    advance: liveWriterAdvance,
    attest: liveAttest,
    consume: liveConsume,
    deny: liveWriterDenial,
    final: liveFinal,
    revalidate: liveRevalidate,
    terminalize: liveTerminalize,
  }[command];
  persistReceipt(await operation(process.env));
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    if (error instanceof WriterCanaryWorkflowDeltaError) {
      writeControlEpochReview(error.controlEpoch);
      persistReceipt(error.receipt);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}
