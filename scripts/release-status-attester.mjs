import { withReleaseAppTokenFromEnvironment } from "./release-app-token.mjs";

const EXPECTED_REPOSITORY = "hraness/textbutler";
const EXPECTED_REPOSITORY_ID = 1_342_143_606;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STATUS_RESPONSE_AGE_MILLISECONDS = 15_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const SHA = /^[0-9a-f]{40}$/u;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const CLIENT_ID = /^[A-Za-z0-9._-]{6,128}$/u;
const GRAPHQL_ID = /^[\x21-\x7e]{1,512}$/u;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const SECOND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const RECEIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const RELEASE_AUTHORITY_STATUS_CONTEXT =
  "message-like-me/website-production-authority";
export const RELEASE_CANARY_STATUS_CONTEXT =
  "message-like-me/website-production-writer-canary-authority";

const STATUS_CONTRACTS = Object.freeze({
  [RELEASE_AUTHORITY_STATUS_CONTEXT]: Object.freeze({
    error: Object.freeze({
      description: "Release authority consumed after the production-ref attempt",
      state: "error",
    }),
    success: Object.freeze({
      description: "Exact release authority admitted for one production-ref attempt",
      state: "success",
    }),
  }),
  [RELEASE_CANARY_STATUS_CONTEXT]: Object.freeze({
    error: Object.freeze({
      description: "Canary authority consumed after the canary-ref attempt",
      state: "error",
    }),
    success: Object.freeze({
      description: "Exact canary authority admitted for one canary-ref attempt",
      state: "success",
    }),
  }),
});

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

function expectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function expectRequiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
}

function expectPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is not a positive integer`);
  return value;
}

function exactTargetSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) {
    fail("release authority TARGET is not one exact lowercase 40-hex commit SHA");
  }
  return value;
}

function parseSecondTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!SECOND_TIMESTAMP.test(timestamp)) fail(`${label} is not one exact second UTC timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().replace(".000Z", "Z") !== timestamp
  ) {
    fail(`${label} is not a real canonical timestamp`);
  }
  return Object.freeze({ milliseconds, timestamp });
}

function parseHttpDate(value, label) {
  const date = expectString(value, label);
  if (!HTTP_DATE.test(date)) fail(`${label} is not one canonical HTTP Date`);
  const milliseconds = Date.parse(date);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== date) {
    fail(`${label} is not a real canonical HTTP Date`);
  }
  return Object.freeze({
    milliseconds,
    timestamp: new Date(milliseconds).toISOString(),
  });
}

function parseReceiptTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!RECEIPT_TIMESTAMP.test(timestamp)) fail(`${label} is not one exact receipt timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    fail(`${label} is not a real exact receipt timestamp`);
  }
  return Object.freeze({ milliseconds, timestamp });
}

function exactAppIdentity(value) {
  const identity = expectRecord(value, "release App token receipt");
  expectRequiredKeys(
    identity,
    ["appId", "appSlug", "clientId", "expiresAt", "installationId", "repositoryId"],
    "release App token receipt",
  );
  const appSlug = expectString(identity.appSlug, "release App token receipt appSlug");
  const clientId = expectString(identity.clientId, "release App token receipt clientId");
  if (!APP_SLUG.test(appSlug)) fail("release App token receipt appSlug is malformed");
  if (!CLIENT_ID.test(clientId)) fail("release App token receipt clientId is malformed");
  if (identity.repositoryId !== EXPECTED_REPOSITORY_ID) {
    fail("release App token receipt is not scoped to the exact Message Like Me repository");
  }
  const expiresAt = parseSecondTimestamp(
    identity.expiresAt,
    "release App token receipt expiresAt",
  );
  return Object.freeze({
    appId: expectPositiveInteger(identity.appId, "release App token receipt appId"),
    appSlug,
    clientId,
    expiresAt: expiresAt.timestamp,
    expiresMilliseconds: expiresAt.milliseconds,
    installationId: expectPositiveInteger(
      identity.installationId,
      "release App token receipt installationId",
    ),
    repositoryId: EXPECTED_REPOSITORY_ID,
  });
}

function exactStatusContext(value) {
  if (
    value !== RELEASE_AUTHORITY_STATUS_CONTEXT &&
    value !== RELEASE_CANARY_STATUS_CONTEXT
  ) {
    fail("release status context is not one exact production or canary authority");
  }
  return value;
}

function exactStatusContract(state, context) {
  if (state !== "success" && state !== "error") {
    fail("release authority status state is not exact success or terminal error");
  }
  return STATUS_CONTRACTS[exactStatusContext(context)][state];
}

function exactApiUrl(value) {
  const url = new URL(expectString(value, "GITHUB_API_URL"));
  if (
    url.href !== "https://api.github.com/" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail("GITHUB_API_URL is not the exact GitHub Cloud API origin");
  }
  return url;
}

function releaseStatusRequest(targetSha, state, context) {
  const target = exactTargetSha(targetSha);
  const exactContext = exactStatusContext(context);
  const contract = exactStatusContract(state, exactContext);
  return Object.freeze({
    body: Object.freeze({
      context: exactContext,
      description: contract.description,
      state: contract.state,
      target_url: null,
    }),
    endpoint: `/repos/${EXPECTED_REPOSITORY}/statuses/${target}`,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    targetSha: target,
  });
}

export function releaseAuthorityStatusRequest(targetSha, state) {
  return releaseStatusRequest(targetSha, state, RELEASE_AUTHORITY_STATUS_CONTEXT);
}

export function releaseCanaryStatusRequest(targetSha, state) {
  return releaseStatusRequest(targetSha, state, RELEASE_CANARY_STATUS_CONTEXT);
}

function parseCreator(value, appSlug) {
  const creator = expectRecord(value, "release authority status creator");
  expectRequiredKeys(
    creator,
    ["id", "login", "node_id", "site_admin", "type"],
    "release authority status creator",
  );
  const nodeId = expectString(creator.node_id, "release authority status creator node_id");
  if (
    creator.login !== `${appSlug}[bot]` ||
    creator.type !== "Bot" ||
    creator.site_admin !== false ||
    !GRAPHQL_ID.test(nodeId)
  ) {
    fail("release authority status creator is not the exact release App bot");
  }
  return Object.freeze({
    id: expectPositiveInteger(creator.id, "release authority status creator id"),
    login: creator.login,
    nodeId,
  });
}

function assertServerDateWithinToken(server, app, label) {
  if (server.milliseconds >= app.expiresMilliseconds) {
    fail(`${label} is not before the exact App token expiry`);
  }
}

function parseReleaseStatusResponse(value, serverDate, input, context) {
  const request = releaseStatusRequest(input.targetSha, input.state, context);
  const app = exactAppIdentity(input.app);
  const response = expectRecord(value, "release authority status response");
  expectRequiredKeys(
    response,
    [
      "context",
      "created_at",
      "creator",
      "description",
      "id",
      "node_id",
      "state",
      "target_url",
      "updated_at",
      "url",
    ],
    "release authority status response",
  );
  const id = expectPositiveInteger(response.id, "release authority status id");
  const nodeId = expectString(response.node_id, "release authority status node_id");
  if (!GRAPHQL_ID.test(nodeId)) fail("release authority status node_id is malformed");
  if (
    response.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${request.targetSha}` ||
    response.state !== request.body.state ||
    response.description !== request.body.description ||
    response.target_url !== null ||
    response.context !== request.body.context
  ) {
    fail("release authority status response does not bind the exact request");
  }
  const created = parseSecondTimestamp(
    response.created_at,
    "release authority status created_at",
  );
  const updated = parseSecondTimestamp(
    response.updated_at,
    "release authority status updated_at",
  );
  if (updated.milliseconds !== created.milliseconds) {
    fail("new release authority status was updated after creation");
  }
  const server = parseHttpDate(serverDate, "release authority status response Date");
  assertServerDateWithinToken(server, app, "release authority status response Date");
  const responseAge = server.milliseconds - created.milliseconds;
  if (responseAge < 0 || responseAge > MAX_STATUS_RESPONSE_AGE_MILLISECONDS) {
    fail("release authority status is outside its authenticated GitHub response-time bound");
  }
  return Object.freeze({
    appId: app.appId,
    appSlug: app.appSlug,
    context: request.body.context,
    createdAt: created.timestamp,
    creator: parseCreator(response.creator, app.appSlug),
    description: request.body.description,
    installationId: app.installationId,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate: server.timestamp,
    state: request.body.state,
    statusId: id,
    statusNodeId: nodeId,
    statusUrl: response.url,
    targetSha: request.targetSha,
  });
}

export function parseReleaseAuthorityStatusResponse(value, serverDate, input) {
  return parseReleaseStatusResponse(
    value,
    serverDate,
    input,
    RELEASE_AUTHORITY_STATUS_CONTEXT,
  );
}

export function parseReleaseCanaryStatusResponse(value, serverDate, input) {
  return parseReleaseStatusResponse(
    value,
    serverDate,
    input,
    RELEASE_CANARY_STATUS_CONTEXT,
  );
}

function parseCombinedRepository(value) {
  const repository = expectRecord(value, "combined release authority status repository");
  const owner = expectRecord(
    repository.owner,
    "combined release authority status repository owner",
  );
  if (
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.name !== "textbutler" ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    owner.login !== "hraness" ||
    owner.type !== "Organization"
  ) {
    fail("combined release authority status repository is not exact Message Like Me");
  }
}

function parseTerminalConsumptionReceipt(value, app, targetSha, context) {
  const exactContext = exactStatusContext(context);
  const contract = exactStatusContract("error", exactContext);
  const receipt = expectRecord(value, "release authority consumption receipt");
  expectRequiredKeys(
    receipt,
    [
      "appId",
      "appSlug",
      "context",
      "createdAt",
      "creator",
      "description",
      "installationId",
      "repository",
      "repositoryId",
      "serverDate",
      "state",
      "statusId",
      "statusNodeId",
      "statusUrl",
      "targetSha",
    ],
    "release authority consumption receipt",
  );
  const creator = expectRecord(receipt.creator, "release authority consumption creator");
  expectRequiredKeys(
    creator,
    ["id", "login", "nodeId"],
    "release authority consumption creator",
  );
  const creatorNodeId = expectString(
    creator.nodeId,
    "release authority consumption creator nodeId",
  );
  const statusNodeId = expectString(
    receipt.statusNodeId,
    "release authority consumption statusNodeId",
  );
  if (!GRAPHQL_ID.test(creatorNodeId) || !GRAPHQL_ID.test(statusNodeId)) {
    fail("release authority consumption receipt has a malformed GraphQL identity");
  }
  if (
    receipt.appId !== app.appId ||
    receipt.appSlug !== app.appSlug ||
    receipt.installationId !== app.installationId ||
    receipt.repository !== EXPECTED_REPOSITORY ||
    receipt.repositoryId !== EXPECTED_REPOSITORY_ID ||
    receipt.context !== exactContext ||
    receipt.description !== contract.description ||
    receipt.state !== "error" ||
    receipt.targetSha !== targetSha ||
    receipt.statusUrl !==
      `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    creator.login !== `${app.appSlug}[bot]`
  ) {
    fail("release authority consumption receipt is not the exact App terminal status");
  }
  return Object.freeze({
    appId: app.appId,
    appSlug: app.appSlug,
    context: exactContext,
    createdAt: parseSecondTimestamp(
      receipt.createdAt,
      "release authority consumption createdAt",
    ).timestamp,
    creator: Object.freeze({
      id: expectPositiveInteger(
        creator.id,
        "release authority consumption creator id",
      ),
      login: creator.login,
      nodeId: creatorNodeId,
    }),
    description: contract.description,
    installationId: app.installationId,
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    serverDate: parseReceiptTimestamp(
      receipt.serverDate,
      "release authority consumption serverDate",
    ),
    state: "error",
    statusId: expectPositiveInteger(
      receipt.statusId,
      "release authority consumption statusId",
    ),
    statusNodeId,
    statusUrl: receipt.statusUrl,
    targetSha,
  });
}

function parseCombinedTerminalStatus(value, targetSha, context) {
  const request = releaseStatusRequest(targetSha, "error", context);
  const status = expectRecord(value, "combined release authority terminal status");
  expectRequiredKeys(
    status,
    [
      "context",
      "created_at",
      "description",
      "id",
      "node_id",
      "state",
      "target_url",
      "updated_at",
      "url",
    ],
    "combined release authority terminal status",
  );
  const nodeId = expectString(
    status.node_id,
    "combined release authority terminal status node_id",
  );
  if (!GRAPHQL_ID.test(nodeId)) {
    fail("combined release authority terminal status node_id is malformed");
  }
  if (
    status.url !==
      `https://api.github.com/repos/${EXPECTED_REPOSITORY}/statuses/${targetSha}` ||
    status.state !== request.body.state ||
    status.description !== request.body.description ||
    status.target_url !== null ||
    status.context !== request.body.context
  ) {
    fail("combined release authority terminal status does not bind the exact request");
  }
  const created = parseSecondTimestamp(
    status.created_at,
    "combined release authority terminal status created_at",
  );
  const updated = parseSecondTimestamp(
    status.updated_at,
    "combined release authority terminal status updated_at",
  );
  if (updated.milliseconds !== created.milliseconds) {
    fail("combined release authority terminal status was updated after creation");
  }
  return Object.freeze({
    context: request.body.context,
    createdAt: created.timestamp,
    description: request.body.description,
    state: "error",
    statusId: expectPositiveInteger(
      status.id,
      "combined release authority terminal status id",
    ),
    statusNodeId: nodeId,
    statusUrl: status.url,
    targetSha,
  });
}

function parseReleaseCombinedStatusResponse(value, serverDate, input, context) {
  const exactContext = exactStatusContext(context);
  const targetSha = exactTargetSha(input.targetSha);
  const app = exactAppIdentity(input.app);
  const consumption = parseTerminalConsumptionReceipt(
    input.consumption,
    app,
    targetSha,
    exactContext,
  );
  const combined = expectRecord(value, "combined release authority status response");
  expectRequiredKeys(
    combined,
    ["commit_url", "repository", "sha", "state", "statuses", "total_count", "url"],
    "combined release authority status response",
  );
  if (
    combined.sha !== targetSha ||
    combined.state !== "failure" ||
    combined.commit_url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}` ||
    combined.url !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status`
  ) {
    fail("combined release authority status does not bind the exact failed target");
  }
  parseCombinedRepository(combined.repository);
  const statuses = expectArray(combined.statuses, "combined release authority statuses");
  if (
    !Number.isSafeInteger(combined.total_count) ||
    combined.total_count < 1 ||
    combined.total_count > 100 ||
    combined.total_count !== statuses.length
  ) {
    fail("combined release authority status is not one complete bounded status set");
  }
  const ids = new Set();
  const nodeIds = new Set();
  const matching = [];
  for (const [index, item] of statuses.entries()) {
    const status = expectRecord(item, `combined release authority status ${String(index)}`);
    const id = expectPositiveInteger(status.id, `combined release authority status ${String(index)} id`);
    const nodeId = expectString(
      status.node_id,
      `combined release authority status ${String(index)} node_id`,
    );
    if (!GRAPHQL_ID.test(nodeId)) {
      fail(`combined release authority status ${String(index)} node_id is malformed`);
    }
    if (ids.has(id) || nodeIds.has(nodeId)) {
      fail("combined release authority statuses contain a duplicate identity");
    }
    ids.add(id);
    nodeIds.add(nodeId);
    if (status.context === exactContext) matching.push(status);
  }
  if (matching.length !== 1) {
    fail("combined release authority status has no unique newest authority context");
  }
  const readback = parseCombinedTerminalStatus(matching[0], targetSha, exactContext);
  const server = parseHttpDate(serverDate, "combined release authority status response Date");
  assertServerDateWithinToken(server, app, "combined release authority status response Date");
  const consumedServer = consumption.serverDate;
  if (
    server.milliseconds < consumedServer.milliseconds ||
    server.milliseconds - consumedServer.milliseconds > MAX_STATUS_RESPONSE_AGE_MILLISECONDS
  ) {
    fail("combined release authority status Date does not closely follow consumption");
  }
  const exactReceiptKeys = [
    "context",
    "createdAt",
    "description",
    "state",
    "statusId",
    "statusNodeId",
    "statusUrl",
    "targetSha",
  ];
  for (const key of exactReceiptKeys) {
    if (JSON.stringify(readback[key]) !== JSON.stringify(consumption[key])) {
      fail("combined release authority status does not prove the exact terminal consumption");
    }
  }
  return Object.freeze({
    context: exactContext,
    serverDate: server.timestamp,
    state: "failure",
    statusCount: statuses.length,
    targetSha,
    terminalStatusId: readback.statusId,
    terminalStatusNodeId: readback.statusNodeId,
  });
}

export function parseReleaseAuthorityCombinedStatusResponse(value, serverDate, input) {
  return parseReleaseCombinedStatusResponse(
    value,
    serverDate,
    input,
    RELEASE_AUTHORITY_STATUS_CONTEXT,
  );
}

export function parseReleaseCanaryCombinedStatusResponse(value, serverDate, input) {
  return parseReleaseCombinedStatusResponse(
    value,
    serverDate,
    input,
    RELEASE_CANARY_STATUS_CONTEXT,
  );
}

async function withReleaseAttestation(options, context) {
  const exactContext = exactStatusContext(context);
  const targetSha = exactTargetSha(options.targetSha);
  const app = exactAppIdentity(options.app);
  const response = await options.postStatus(
    releaseStatusRequest(targetSha, "success", exactContext),
  );
  return parseReleaseStatusResponse(
    response.body,
    response.serverDate,
    { app, state: "success", targetSha },
    exactContext,
  );
}

export function withReleaseAuthorityAttestation(options) {
  return withReleaseAttestation(options, RELEASE_AUTHORITY_STATUS_CONTEXT);
}

export function withReleaseCanaryAttestation(options) {
  return withReleaseAttestation(options, RELEASE_CANARY_STATUS_CONTEXT);
}

async function withReleaseTerminalStatus(options, context) {
  const exactContext = exactStatusContext(context);
  const targetSha = exactTargetSha(options.targetSha);
  const app = exactAppIdentity(options.app);
  const response = await options.postStatus(
    releaseStatusRequest(targetSha, "error", exactContext),
  );
  const consumption = parseReleaseStatusResponse(
    response.body,
    response.serverDate,
    { app, state: "error", targetSha },
    exactContext,
  );
  const combined = await options.readCombinedStatus(targetSha);
  const readback = parseReleaseCombinedStatusResponse(
    combined.body,
    combined.serverDate,
    { app, consumption, targetSha },
    exactContext,
  );
  return Object.freeze({ consumption, readback });
}

export function withReleaseAuthorityTerminalStatus(options) {
  return withReleaseTerminalStatus(options, RELEASE_AUTHORITY_STATUS_CONTEXT);
}

export function withReleaseCanaryTerminalStatus(options) {
  return withReleaseTerminalStatus(options, RELEASE_CANARY_STATUS_CONTEXT);
}

async function readBoundedBytes(response, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      fail(`${label} declared a malformed response length`);
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      fail(`${label} declared an invalid response length`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail(`${label} returned malformed bytes`);
      chunks.push(result.value);
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        fail(`${label} exceeded its response bound`);
      }
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

function requestHeaders(token, hasBody, noCache = false) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    ...(noCache ? { "Cache-Control": "no-cache" } : {}),
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "message-like-me-release-attester",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function responseWasRedirected(response) {
  return response.redirected !== false;
}

function responseCarriesRedirect(response) {
  return responseWasRedirected(response) || response.headers.get("location") !== null;
}

async function postStatusWithFetch(apiUrl, token, request) {
  const response = await fetch(new URL(request.endpoint, apiUrl), {
    body: JSON.stringify(request.body),
    headers: requestHeaders(token, true),
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  // GitHub's successful 201 Created response may carry Location as resource
  // metadata. Fetch's redirected bit, together with redirect: "error", is the
  // redirect boundary for this creation request.
  if (responseWasRedirected(response)) fail("release authority status POST redirected");
  if (response.status !== 201) {
    await readBoundedBytes(response, "release authority status error response");
    fail(`release authority status POST returned HTTP ${String(response.status)}`);
  }
  const serverDate = response.headers.get("date");
  return Object.freeze({
    body: await readBoundedJson(response, "release authority status response"),
    serverDate,
  });
}

async function readCombinedStatusWithFetch(apiUrl, token, targetSha) {
  const endpoint = new URL(
    `/repos/${EXPECTED_REPOSITORY}/commits/${targetSha}/status`,
    apiUrl,
  );
  endpoint.searchParams.set("per_page", "100");
  const response = await fetch(endpoint, {
    headers: requestHeaders(token, false, true),
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (responseCarriesRedirect(response)) fail("combined release authority status GET redirected");
  if (response.status !== 200) {
    await readBoundedBytes(response, "combined release authority status error response");
    fail(`combined release authority status GET returned HTTP ${String(response.status)}`);
  }
  const serverDate = response.headers.get("date");
  return Object.freeze({
    body: await readBoundedJson(response, "combined release authority status response"),
    serverDate,
  });
}

export function withReleaseAuthorityAttestationFromEnvironment(environment, onRevoked) {
  return withReleaseAttestationFromEnvironment(
    environment,
    onRevoked,
    RELEASE_AUTHORITY_STATUS_CONTEXT,
  );
}

export function withReleaseCanaryAttestationFromEnvironment(environment, onRevoked) {
  return withReleaseAttestationFromEnvironment(
    environment,
    onRevoked,
    RELEASE_CANARY_STATUS_CONTEXT,
  );
}

export function withReleaseAuthorityTerminalStatusFromEnvironment(environment, onRevoked) {
  return withReleaseTerminalStatusFromEnvironment(
    environment,
    onRevoked,
    RELEASE_AUTHORITY_STATUS_CONTEXT,
  );
}

export function withReleaseCanaryTerminalStatusFromEnvironment(environment, onRevoked) {
  return withReleaseTerminalStatusFromEnvironment(
    environment,
    onRevoked,
    RELEASE_CANARY_STATUS_CONTEXT,
  );
}

function withReleaseAttestationFromEnvironment(environment, onRevoked, context) {
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  const targetSha = exactTargetSha(environment.TARGET);
  return withReleaseAppTokenFromEnvironment(
    environment,
    (token, app) => withReleaseAttestation({
      app,
      postStatus: (request) => postStatusWithFetch(apiUrl, token, request),
      targetSha,
    }, context),
    onRevoked,
  );
}


function withReleaseTerminalStatusFromEnvironment(environment, onRevoked, context) {
  const apiUrl = exactApiUrl(environment.GITHUB_API_URL);
  const targetSha = exactTargetSha(environment.TARGET);
  return withReleaseAppTokenFromEnvironment(
    environment,
    (token, app) => withReleaseTerminalStatus({
      app,
      postStatus: (request) => postStatusWithFetch(apiUrl, token, request),
      readCombinedStatus: (target) => readCombinedStatusWithFetch(apiUrl, token, target),
      targetSha,
    }, context),
    onRevoked,
  );
}
