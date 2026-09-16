import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createCleanupIncompleteFinalReceipt,
  createCleanupPostflight,
  createCleanupPreflight,
  decodeCleanupPostflightReceipt,
  decodeCleanupPreflightReceipt,
  decodeCleanupTerminalReceipt,
  encodeCleanupPostflightReceipt,
  encodeCleanupPreflightReceipt,
  encodeCleanupTerminalReceipt,
  finalizeCleanupAuthority,
  terminalizeCleanupAuthority,
  type CleanupEnvironment,
} from "./release-authority-cleanup.mjs";

const repository = "hraness/textbutler";
const repositoryId = 1_342_143_606;
const appId = 4_830_612;
const appSlug = "mlm-prod-ref-writer-1342143606";
const installationId = 159_058_102;
const authorityContext = "message-like-me/website-production-authority";
const admissionDescription = "Exact release authority admitted for one production-ref attempt";
const terminalDescription = "Release authority consumed after the production-ref attempt";
const workflowSha = "a".repeat(40);
const productionSha = "b".repeat(40);
const targetSha = "c".repeat(40);
const tagObjectSha = "d".repeat(40);
const incidentSourceSha = "e".repeat(40);
const tag = "v0.8.1";
const productionWorkflowId = 344_000_001;
const canaryWorkflowId = 344_000_002;
const cleanupWorkflowId = 344_000_003;
const cleanupRunId = 9_001;
const incidentRunId = 8_001;
const appToken = "exact-status-only-installation-token";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ref(refName: string, sha: string, type = "commit") {
  return {
    object: {
      sha,
      type,
      url: type === "tag"
        ? `https://api.github.com/repos/${repository}/git/tags/${sha}`
        : `https://api.github.com/repos/${repository}/git/commits/${sha}`,
    },
    ref: refName,
    url: `https://api.github.com/repos/${repository}/git/${refName}`,
  };
}

function rulesets() {
  const parameters = {
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: authorityContext, integration_id: appId }],
    strict_required_status_checks_policy: false,
  };
  const common = {
    bypass_actors: [],
    current_user_can_bypass: "never",
    enforcement: "active",
    source: repository,
    source_type: "Repository",
    target: "branch",
  };
  const lifecycle = {
    ...common,
    _links: {
      html: { href: `https://github.com/${repository}/rules/21821875` },
      self: { href: `https://api.github.com/repos/${repository}/rulesets/21821875` },
    },
    conditions: { ref_name: { exclude: [], include: ["refs/heads/website-production"] } },
    id: 21_821_875,
    name: "Immutable website-production lifecycle",
    rules: [{ type: "creation" }, { type: "deletion" }, { type: "non_fast_forward" }],
  };
  const authority = {
    ...common,
    _links: {
      html: { href: `https://github.com/${repository}/rules/22290922` },
      self: { href: `https://api.github.com/repos/${repository}/rulesets/22290922` },
    },
    conditions: { ref_name: { exclude: [], include: ["refs/heads/website-production"] } },
    id: 22_290_922,
    name: "Message Like Me production status authority",
    rules: [{ parameters, type: "required_status_checks" }],
  };
  const effective = [
    { ruleset_id: 21_821_875, ruleset_source: repository, ruleset_source_type: "Repository", type: "creation" },
    { ruleset_id: 21_821_875, ruleset_source: repository, ruleset_source_type: "Repository", type: "deletion" },
    { ruleset_id: 21_821_875, ruleset_source: repository, ruleset_source_type: "Repository", type: "non_fast_forward" },
    { parameters, ruleset_id: 22_290_922, ruleset_source: repository, ruleset_source_type: "Repository", type: "required_status_checks" },
  ];
  return { authority, effective, lifecycle };
}

type AuthorityState = "absent" | "error" | "success";
type HarnessOptions = Readonly<{
  duplicateCurrentRun?: boolean;
  duplicateStatus?: boolean;
  missingCurrentRun?: boolean;
  missingStatusHistory?: boolean;
  nonterminalPeer?: boolean;
  predecessor?: AuthorityState;
  statusDrift?: boolean;
  workflowStateDrift?: boolean;
  wrongIncidentTitle?: boolean;
}>;

function workflowMetadata(
  id: number,
  name: string,
  path: string,
  state: "active" | "disabled_manually",
) {
  return {
    html_url: `https://github.com/${repository}/blob/main/${path}`,
    id,
    name,
    path,
    state,
    updated_at: "2026-09-05T01:00:00.000Z",
    url: `https://api.github.com/repos/${repository}/actions/workflows/${id}`,
  };
}

function run(input: Readonly<{
  attempt?: number;
  conclusion: string | null;
  createdAt?: string;
  displayTitle: string;
  event: "workflow_dispatch" | "workflow_run";
  headSha: string;
  id: number;
  name: string;
  path: string;
  status: string;
  updatedAt?: string;
  workflowId: number;
}>) {
  const createdAt = input.createdAt ?? "2026-09-05T01:10:00Z";
  const updatedAt = input.updatedAt ?? "2026-09-05T01:20:00Z";
  return {
    conclusion: input.conclusion,
    created_at: createdAt,
    display_title: input.displayTitle,
    event: input.event,
    head_branch: "main",
    head_sha: input.headSha,
    html_url: `https://github.com/${repository}/actions/runs/${input.id}`,
    id: input.id,
    name: input.name,
    path: input.path,
    repository: { full_name: repository, id: repositoryId },
    run_attempt: input.attempt ?? 1,
    run_started_at: createdAt,
    status: input.status,
    updated_at: updatedAt,
    url: `https://api.github.com/repos/${repository}/actions/runs/${input.id}`,
    workflow_id: input.workflowId,
  };
}

function creator() {
  return {
    id: 77,
    login: `${appSlug}[bot]`,
    node_id: "MDM6Qm90Nzc=",
    site_admin: false,
    type: "Bot",
  };
}

function statusBody(state: Exclude<AuthorityState, "absent">, id: number, createdAt: string) {
  return {
    context: authorityContext,
    created_at: createdAt,
    creator: creator(),
    description: state === "success" ? admissionDescription : terminalDescription,
    id,
    node_id: `SC_cleanup_${id}`,
    state,
    target_url: null,
    updated_at: createdAt,
    url: `https://api.github.com/repos/${repository}/statuses/${targetSha}`,
  };
}

function combinedStatus(statuses: readonly unknown[]) {
  return {
    commit_url: `https://api.github.com/repos/${repository}/commits/${targetSha}`,
    repository: {
      full_name: repository,
      id: repositoryId,
      name: "textbutler",
      owner: { login: "hraness", type: "Organization" },
    },
    sha: targetSha,
    state: "failure",
    statuses,
    total_count: statuses.length,
    url: `https://api.github.com/repos/${repository}/commits/${targetSha}/status`,
  };
}

function jsonResponse(body: unknown, date: string, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    headers: {
      Date: date,
      ...(status === 204 ? { "Content-Length": "0" } : { "Content-Type": "application/json" }),
    },
    status,
  });
}

function environment(overrides: Readonly<Record<string, string>> = {}): CleanupEnvironment {
  return Object.freeze({
    EXPECTED_CANARY_WORKFLOW_ID: String(canaryWorkflowId),
    EXPECTED_CLEANUP_WORKFLOW_ID: String(cleanupWorkflowId),
    EXPECTED_PRODUCTION_SHA: productionSha,
    EXPECTED_PRODUCTION_WORKFLOW_ID: String(productionWorkflowId),
    EXPECTED_TARGET_SHA: targetSha,
    GH_TOKEN: "read-only-github-token",
    GITHUB_ACTIONS: "true",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: String(cleanupRunId),
    GITHUB_SHA: workflowSha,
    GITHUB_WORKFLOW: "Terminalize release authority",
    GITHUB_WORKFLOW_REF:
      `${repository}/.github/workflows/release-authority-cleanup.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: workflowSha,
    INCIDENT_RUN_ATTEMPT: "2",
    INCIDENT_RUN_ID: String(incidentRunId),
    VERIFIED_TAG: tag,
    ...overrides,
  });
}

function createHarness(options: HarnessOptions = {}) {
  let currentAuthority: AuthorityState = options.predecessor ?? "absent";
  let authorityId = currentAuthority === "absent" ? 0 : 610;
  let authorityCreatedAt = "2026-09-05T01:30:00Z";
  let combinedReads = 0;
  let requestIndex = 0;
  const calls: Readonly<{ method: string; url: string }>[] = [];
  const rules = rulesets();

  const productionAttempt1 = run({
    attempt: 1,
    conclusion: "success",
    displayTitle: `Promote release target ${targetSha}`,
    event: "workflow_run",
    headSha: incidentSourceSha,
    id: incidentRunId,
    name: `Promote release target ${targetSha}`,
    path: ".github/workflows/website-production.yml",
    status: "completed",
    updatedAt: "2026-09-05T01:15:00Z",
    workflowId: productionWorkflowId,
  });
  const productionAttempt2 = run({
    attempt: 2,
    conclusion: "failure",
    displayTitle: options.wrongIncidentTitle === true
      ? `Promote release target ${"e".repeat(40)}`
      : `Promote release target ${targetSha}`,
    event: "workflow_run",
    headSha: incidentSourceSha,
    id: incidentRunId,
    name: `Promote release target ${targetSha}`,
    path: ".github/workflows/website-production.yml",
    status: "completed",
    updatedAt: "2026-09-05T01:20:00Z",
    workflowId: productionWorkflowId,
  });
  const canaryRun = run({
    conclusion: options.nonterminalPeer === true ? null : "success",
    displayTitle: "Prove production ref writer canary target",
    event: "workflow_dispatch",
    headSha: workflowSha,
    id: 8_002,
    name: `Prove writer canary target ${workflowSha}`,
    path: ".github/workflows/production-writer-canary.yml",
    status: options.nonterminalPeer === true ? "queued" : "completed",
    workflowId: canaryWorkflowId,
  });
  const cleanupRun = run({
    conclusion: null,
    createdAt: "2026-09-05T03:55:00Z",
    displayTitle: `Terminalize release authority target ${targetSha}`,
    event: "workflow_dispatch",
    headSha: workflowSha,
    id: cleanupRunId,
    name: `Terminalize release authority target ${targetSha}`,
    path: ".github/workflows/release-authority-cleanup.yml",
    status: "in_progress",
    updatedAt: "2026-09-05T03:56:00Z",
    workflowId: cleanupWorkflowId,
  });

  function nextDate() {
    const value = new Date(Date.parse("2026-09-05T04:00:00Z") + requestIndex * 1_000);
    requestIndex += 1;
    return value.toUTCString();
  }

  function currentStatus(): ReturnType<typeof statusBody> | null {
    return currentAuthority === "absent"
      ? null
      : statusBody(currentAuthority, authorityId, authorityCreatedAt);
  }

  const fetchImplementation = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.href });
    const date = nextDate();
    expect(url.origin).toBe("https://api.github.com");

    if (url.pathname === "/app" && method === "GET") {
      return jsonResponse({
        client_id: "Iv1.mlmCleanupStatusOnly",
        id: appId,
        owner: { login: "hraness", type: "Organization" },
        permissions: { metadata: "read", statuses: "write" },
        slug: appSlug,
      }, date);
    }
    if (url.pathname === `/app/installations/${installationId}` && method === "GET") {
      return jsonResponse({
        account: { login: "hraness", type: "Organization" },
        app_id: appId,
        app_slug: appSlug,
        id: installationId,
        permissions: { metadata: "read", statuses: "write" },
        repository_selection: "selected",
        target_type: "Organization",
      }, date);
    }
    if (url.pathname === `/app/installations/${installationId}/access_tokens` && method === "POST") {
      expect(JSON.parse(String(init?.body))).toEqual({
        permissions: { metadata: "read", statuses: "write" },
        repository_ids: [repositoryId],
      });
      const expiresAt = new Date(Date.parse(date) + 60 * 60 * 1_000).toISOString().replace(".000Z", "Z");
      return jsonResponse({
        expires_at: expiresAt,
        permissions: { metadata: "read", statuses: "write" },
        repositories: [{
          full_name: repository,
          id: repositoryId,
          name: "textbutler",
          owner: { login: "hraness" },
        }],
        repository_selection: "selected",
        token: appToken,
      }, date, 201);
    }
    if (url.pathname === "/installation/token" && method === "DELETE") {
      return jsonResponse(null, date, 204);
    }
    if (url.pathname === "/installation/repositories" && method === "GET") {
      return jsonResponse({ message: "Bad credentials" }, date, 401);
    }
    if (url.pathname === `/repos/${repository}/statuses/${targetSha}` && method === "POST") {
      expect(init?.headers).not.toHaveProperty("X-GitHub-Token");
      expect(JSON.parse(String(init?.body))).toEqual({
        context: authorityContext,
        description: terminalDescription,
        state: "error",
        target_url: null,
      });
      authorityId += 1;
      currentAuthority = "error";
      authorityCreatedAt = new Date(Date.parse(date)).toISOString().replace(".000Z", "Z");
      const response = jsonResponse(statusBody("error", authorityId, authorityCreatedAt), date, 201);
      response.headers.set(
        "Location",
        `https://api.github.com/repos/${repository}/statuses/${targetSha}`,
      );
      return response;
    }

    if (url.pathname === `/repos/${repository}`) {
      return jsonResponse({ default_branch: "main", full_name: repository, id: repositoryId }, date);
    }
    if (url.pathname === `/repos/${repository}/git/ref/heads/main`) {
      return jsonResponse(ref("refs/heads/main", workflowSha), date);
    }
    if (url.pathname === `/repos/${repository}/git/ref/heads/website-production`) {
      return jsonResponse(ref("refs/heads/website-production", productionSha), date);
    }
    if (url.pathname === `/repos/${repository}/git/ref/tags/${tag}`) {
      return jsonResponse(ref(`refs/tags/${tag}`, tagObjectSha, "tag"), date);
    }
    if (url.pathname === `/repos/${repository}/releases/tags/${tag}`) {
      return jsonResponse({
        assets: [
          {
            browser_download_url: `https://github.com/${repository}/releases/download/${tag}/hraness-message-like-me-0.8.1.tgz`,
            digest: `sha256:${"2".repeat(64)}`,
            id: 502,
            name: "hraness-message-like-me-0.8.1.tgz",
            size: 20,
            state: "uploaded",
          },
          {
            browser_download_url: `https://github.com/${repository}/releases/download/${tag}/SHA256SUMS`,
            digest: `sha256:${"1".repeat(64)}`,
            id: 501,
            name: "SHA256SUMS",
            size: 10,
            state: "uploaded",
          },
        ],
        draft: false,
        id: 401,
        immutable: true,
        prerelease: false,
        published_at: "2026-09-04T23:00:00Z",
        tag_name: tag,
      }, date);
    }
    if (url.pathname === `/repos/${repository}/git/tags/${tagObjectSha}`) {
      return jsonResponse({
        object: {
          sha: targetSha,
          type: "commit",
          url: `https://api.github.com/repos/${repository}/git/commits/${targetSha}`,
        },
        sha: tagObjectSha,
        tag,
        url: `https://api.github.com/repos/${repository}/git/tags/${tagObjectSha}`,
      }, date);
    }
    if (url.pathname === `/repos/${repository}/compare/${targetSha}...${workflowSha}`) {
      return jsonResponse({
        base_commit: { sha: targetSha },
        commits: [{ sha: workflowSha }],
        merge_base_commit: { sha: targetSha },
        status: "ahead",
      }, date);
    }
    if (url.pathname === `/repos/${repository}/compare/${incidentSourceSha}...${workflowSha}`) {
      return jsonResponse({
        base_commit: { sha: incidentSourceSha },
        commits: [{ sha: workflowSha }],
        merge_base_commit: { sha: incidentSourceSha },
        status: "ahead",
      }, date);
    }
    if (url.pathname === `/repos/${repository}/rules/branches/website-production`) {
      return jsonResponse(rules.effective, date);
    }
    if (url.pathname === `/repos/${repository}/rulesets/21821875`) {
      return jsonResponse(rules.lifecycle, date);
    }
    if (url.pathname === `/repos/${repository}/rulesets/22290922`) {
      return jsonResponse(rules.authority, date);
    }

    const workflowMetadataMatch = url.pathname.match(
      new RegExp(`^/repos/${repository}/actions/workflows/(\\d+)$`, "u"),
    );
    if (workflowMetadataMatch !== null) {
      const id = Number(workflowMetadataMatch[1]);
      if (id === productionWorkflowId) {
        const body = workflowMetadata(
          id,
          "Promote website production",
          ".github/workflows/website-production.yml",
          options.workflowStateDrift === true ? "active" : "disabled_manually",
        );
        return jsonResponse(body, date);
      }
      if (id === canaryWorkflowId) {
        return jsonResponse(workflowMetadata(
          id,
          "Prove production ref writer canary",
          ".github/workflows/production-writer-canary.yml",
          "disabled_manually",
        ), date);
      }
      if (id === cleanupWorkflowId) {
        return jsonResponse(workflowMetadata(
          id,
          "Terminalize release authority",
          ".github/workflows/release-authority-cleanup.yml",
          "active",
        ), date);
      }
    }
    const workflowRunsMatch = url.pathname.match(
      new RegExp(`^/repos/${repository}/actions/workflows/(\\d+)/runs$`, "u"),
    );
    if (workflowRunsMatch !== null) {
      const id = Number(workflowRunsMatch[1]);
      if (id === productionWorkflowId) {
        return jsonResponse({ total_count: 1, workflow_runs: [productionAttempt2] }, date);
      }
      if (id === canaryWorkflowId) {
        return jsonResponse({ total_count: 1, workflow_runs: [canaryRun] }, date);
      }
      const runs = options.missingCurrentRun === true
        ? []
        : options.duplicateCurrentRun === true
          ? [cleanupRun, cleanupRun]
          : [cleanupRun];
      return jsonResponse({ total_count: runs.length, workflow_runs: runs }, date);
    }
    const attemptMatch = url.pathname.match(
      new RegExp(`^/repos/${repository}/actions/runs/(\\d+)/attempts/(\\d+)$`, "u"),
    );
    if (attemptMatch !== null) {
      const id = Number(attemptMatch[1]);
      const attempt = Number(attemptMatch[2]);
      if (id === incidentRunId) return jsonResponse(attempt === 1 ? productionAttempt1 : productionAttempt2, date);
      if (id === canaryRun.id) return jsonResponse(canaryRun, date);
      if (id === cleanupRunId) return jsonResponse(cleanupRun, date);
    }

    if (url.pathname === `/repos/${repository}/commits/${targetSha}/status`) {
      combinedReads += 1;
      const current = currentStatus();
      if (options.statusDrift === true && combinedReads === 2 && current !== null) {
        return jsonResponse(combinedStatus([statusBody("error", current.id + 1, "2026-09-05T01:31:00Z")]), date);
      }
      const statuses = current === null ? [] : [current];
      if (options.duplicateStatus === true && current !== null) statuses.push({ ...current, id: current.id + 1 });
      return jsonResponse(combinedStatus(statuses), date);
    }
    if (url.pathname === `/repos/${repository}/commits/${targetSha}/statuses`) {
      const current = currentStatus();
      return jsonResponse(
        options.missingStatusHistory === true || current === null ? [] : [current],
        date,
      );
    }
    throw new Error(`Unexpected cleanup request: ${method} ${url.href}`);
  };

  return {
    calls,
    fetch: fetchImplementation as typeof fetch,
    setAuthority(
      state: AuthorityState,
      evidence: Readonly<{ createdAt?: string; id?: number }> = {},
    ) {
      currentAuthority = state;
      if (state !== "absent" && authorityId === 0) authorityId = 610;
      authorityId = evidence.id ?? authorityId;
      authorityCreatedAt = evidence.createdAt ?? authorityCreatedAt;
    },
  };
}

function installHarness(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  globalThis.fetch = harness.fetch;
  return harness;
}

function encodedWithExtraKey(encoded: string): string {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  value.unexpected = true;
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function encodedWithIncident(
  encoded: string,
  replacement: Readonly<Record<string, unknown>>,
): string {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    incident: Record<string, unknown>;
  };
  value.incident = { ...value.incident, ...replacement };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("release authority cleanup", () => {
  test("admits a complete 36-day credential inventory and the newest exact target-bound failed attempt", async () => {
    const harness = installHarness();
    const receipt = await createCleanupPreflight(environment());

    expect(receipt.schema).toBe("message-like-me-release-authority-cleanup-preflight-v2");
    expect(receipt.coordinate).toMatchObject({
      expectedProductionSha: productionSha,
      targetSha,
      verifiedTag: tag,
      workflowSha,
    });
    expect(receipt.coordinate.release.assets.map((asset) => asset.name)).toEqual([
      "SHA256SUMS",
      "hraness-message-like-me-0.8.1.tgz",
    ]);
    expect(receipt.incident).toMatchObject({
      displayTitle: `Promote release target ${targetSha}`,
      runAttempt: 2,
      runId: incidentRunId,
      workflowId: productionWorkflowId,
    });
    expect(receipt.inventory.attemptCount).toBe(4);
    expect(receipt.inventory.workflowRunCounts).toEqual({ canary: 1, cleanup: 1, production: 1 });
    expect(receipt.inventory.workflowStates).toEqual({
      canary: "disabled_manually",
      cleanup: "active",
      production: "disabled_manually",
    });
    expect(Date.parse(receipt.serverDates.snapshotAt) - Date.parse(receipt.inventory.since))
      .toBe(36 * 24 * 60 * 60 * 1_000);
    expect(harness.calls.filter((call) => call.url.includes(`/actions/runs/${incidentRunId}/attempts/`)))
      .toHaveLength(2);
    expect(decodeCleanupPreflightReceipt(encodeCleanupPreflightReceipt(receipt))).toEqual(receipt);
  });

  test.each(["absent", "success", "error"] as const)(
    "sandwiches and binds an exact %s authority predecessor independently of aggregate state",
    async (predecessor) => {
      installHarness({ predecessor });
      const receipt = await createCleanupPreflight(environment());
      if (predecessor === "absent") {
        expect(receipt.predecessor).toEqual({ kind: "absent" });
      } else {
        expect(receipt.predecessor).toMatchObject({
          creatorLogin: `${appSlug}[bot]`,
          kind: "app-status",
          state: predecessor,
          targetSha,
        });
      }
    },
  );

  test("preserves the stable admission across a later complete revalidation", async () => {
    installHarness();
    const initial = await createCleanupPreflight(environment());
    const revalidated = await createCleanupPreflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: encodeCleanupPreflightReceipt(initial),
    }));

    expect(revalidated.coordinate).toEqual(initial.coordinate);
    expect(revalidated.inventory.digest).toBe(initial.inventory.digest);
    expect(revalidated.inventory.freezeAnchorAt).toBe(initial.inventory.freezeAnchorAt);
    expect(revalidated.serverDates.completedAt > initial.serverDates.completedAt).toBeTrue();
  });

  test.each([
    [{ wrongIncidentTitle: true }, "no failed production incident"],
    [{ nonterminalPeer: true }, "another credential-capable workflow attempt is nonterminal"],
    [{ workflowStateDrift: true }, "production workflow metadata is not exact"],
    [{ missingCurrentRun: true }, "current run is not in the complete credential inventory"],
    [{ duplicateCurrentRun: true }, "credential attempt inventory contains duplicates"],
    [{ predecessor: "success", missingStatusHistory: true }, "authority ID is absent or duplicated"],
    [{ predecessor: "success", duplicateStatus: true }, "combined authority status is not unique"],
    [{ predecessor: "success", statusDrift: true }, "current authority changed"],
  ] as const)("fails closed on inventory or current-status drift %#", async (options, message) => {
    installHarness(options);
    await expect(createCleanupPreflight(environment())).rejects.toThrow(message);
  });

  test("rejects malformed and extra-key receipts canonically", async () => {
    installHarness();
    const encoded = encodeCleanupPreflightReceipt(await createCleanupPreflight(environment()));
    expect(() => decodeCleanupPreflightReceipt(encodedWithExtraKey(encoded))).toThrow("unexpected keys");
    expect(() => decodeCleanupPreflightReceipt(`${encoded}=`)).toThrow("missing or malformed");
    expect(() => decodeCleanupPreflightReceipt(Buffer.from("{}", "utf8").toString("base64url")))
      .toThrow("unexpected keys");
  });

  test.each([
    [{ workflowId: canaryWorkflowId }, "production workflow coordinate"],
    [{ workflowPath: ".github/workflows/production-writer-canary.yml" }, "production workflow coordinate"],
    [{ event: "push" }, "production workflow coordinate"],
    [{ displayTitle: `Promote release target ${workflowSha}` }, "production workflow coordinate"],
    [{ event: "workflow_dispatch", displayTitle: `Promote release tag v0.8.0` }, "production workflow coordinate"],
  ] as const)("rejects a persisted incident outside its exact production coordinate %#", async (
    replacement,
    message,
  ) => {
    installHarness();
    const encoded = encodeCleanupPreflightReceipt(await createCleanupPreflight(environment()));
    expect(() => decodeCleanupPreflightReceipt(encodedWithIncident(encoded, replacement)))
      .toThrow(message);
  });

  test("accepts GitHub's 201 creation Location, proves terminal readback, and records App-token revocation", async () => {
    const harness = installHarness();
    const initial = await createCleanupPreflight(environment());
    const initialEncoded = encodeCleanupPreflightReceipt(initial);
    const admitted = await createCleanupPreflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
    }));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const terminal = await terminalizeCleanupAuthority(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
      CLEANUP_PREFLIGHT_RECEIPT: encodeCleanupPreflightReceipt(admitted),
      GH_TOKEN: "",
      GITHUB_REPOSITORY_ID: String(repositoryId),
      GITHUB_REPOSITORY_OWNER: "hraness",
      MLM_RELEASE_APP_CLIENT_ID: "Iv1.mlmCleanupStatusOnly",
      MLM_RELEASE_APP_ID: String(appId),
      MLM_RELEASE_APP_INSTALLATION_ID: String(installationId),
      MLM_RELEASE_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      MLM_RELEASE_APP_SLUG: appSlug,
    }));

    expect(terminal.status).toMatchObject({
      context: authorityContext,
      state: "error",
      targetSha,
    });
    expect(terminal.readback).toMatchObject({
      state: "error",
      terminalStatusId: terminal.status.statusId,
      terminalStatusNodeId: terminal.status.statusNodeId,
    });
    expect(terminal.revocation).toMatchObject({ converged: true, stableDenials: 2 });
    expect(harness.calls.filter((call) => call.method === "POST" && call.url.endsWith(`/statuses/${targetSha}`)))
      .toHaveLength(1);
    expect(harness.calls.filter((call) => call.method === "DELETE" && call.url.endsWith("/installation/token")))
      .toHaveLength(1);
    expect(decodeCleanupTerminalReceipt(encodeCleanupTerminalReceipt(terminal))).toEqual(terminal);
  }, 10_000);

  test("binds postflight and final evidence to terminal status, unchanged rules, and preserved production ref", async () => {
    const harness = installHarness();
    const initial = await createCleanupPreflight(environment());
    const initialEncoded = encodeCleanupPreflightReceipt(initial);
    const admitted = await createCleanupPreflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
    }));
    harness.setAuthority("error", { createdAt: "2026-09-05T04:00:50Z", id: 610 });
    const terminal = {
      app: {
        appId,
        appSlug,
        clientId: "Iv1.mlmCleanupStatusOnly",
        expiresAt: "2026-09-05T05:00:00Z",
        installationId,
      },
      context: authorityContext,
      initialSha256: Bun.CryptoHasher.hash("sha256", JSON.stringify(initial), "hex"),
      predecessorSha256: Bun.CryptoHasher.hash("sha256", JSON.stringify(admitted.predecessor), "hex"),
      preflightSha256: Bun.CryptoHasher.hash("sha256", JSON.stringify(admitted), "hex"),
      readback: {
        context: authorityContext,
        serverDate: "2026-09-05T04:00:50.000Z",
        state: "error",
        statusCount: 1,
        targetSha,
        terminalStatusId: 610,
        terminalStatusNodeId: "SC_cleanup_610",
      },
      repository,
      repositoryId,
      revocation: {
        converged: true,
        deletionServerDate: "2026-09-05T04:00:51.000Z",
        lastObservationServerDate: "2026-09-05T04:00:52.000Z",
        observationCount: 2,
        propagationObserved: false,
        stableDenials: 2,
      },
      schema: "message-like-me-release-authority-cleanup-terminal-v2",
      status: {
        appId,
        appSlug,
        context: authorityContext,
        createdAt: "2026-09-05T04:00:50Z",
        creator: {
          id: 77,
          login: `${appSlug}[bot]`,
          nodeId: "MDM6Qm90Nzc=",
          siteAdmin: false,
          type: "Bot",
        },
        description: terminalDescription,
        installationId,
        repository,
        repositoryId,
        serverDate: "2026-09-05T04:00:50.000Z",
        state: "error",
        statusId: 610,
        statusNodeId: "SC_cleanup_610",
        statusUrl: `https://api.github.com/repos/${repository}/statuses/${targetSha}`,
        targetSha,
      },
      targetSha,
    } as const;
    const terminalEncoded = encodeCleanupTerminalReceipt(terminal);
    const postflight = await createCleanupPostflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
      CLEANUP_REVALIDATED_PREFLIGHT_RECEIPT: encodeCleanupPreflightReceipt(admitted),
      CLEANUP_TERMINAL_RECEIPT: terminalEncoded,
    }));
    expect(postflight.classification).toBe("terminal-bound");
    expect(decodeCleanupPostflightReceipt(encodeCleanupPostflightReceipt(postflight))).toEqual(postflight);

    const final = await finalizeCleanupAuthority(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
      CLEANUP_POSTFLIGHT_RECEIPT: encodeCleanupPostflightReceipt(postflight),
      CLEANUP_REVALIDATED_PREFLIGHT_RECEIPT: encodeCleanupPreflightReceipt(admitted),
      CLEANUP_TERMINAL_RECEIPT: terminalEncoded,
    }));
    expect(final.complete).toBeTrue();
    expect(final.finalBoundary.productionRef).toMatchObject({ sha: productionSha });
    expect(final.finalBoundary.terminalStatus).toMatchObject({
      state: "error",
      statusId: 610,
      targetSha,
    });
  });

  test("distinguishes an observed unbound terminal error from no terminal observation", async () => {
    const harness = installHarness();
    const initial = await createCleanupPreflight(environment());
    const initialEncoded = encodeCleanupPreflightReceipt(initial);
    const missing = await createCleanupPostflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
    }));
    expect(missing.classification).toBe("terminal-not-observed");

    harness.setAuthority("error", {
      createdAt: "2026-09-05T04:01:00Z",
      id: 711,
    });
    const observed = await createCleanupPostflight(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
    }));
    expect(observed.classification).toBe("terminal-observed-unbound");
    expect(observed.observation.predecessor).toMatchObject({
      kind: "app-status",
      state: "error",
      statusId: 711,
    });
  });

  test("produces durable incomplete evidence while preserving the production ref", async () => {
    const harness = installHarness();
    const initial = await createCleanupPreflight(environment());
    const initialEncoded = encodeCleanupPreflightReceipt(initial);
    const receipt = await createCleanupIncompleteFinalReceipt(environment({
      CLEANUP_INITIAL_PREFLIGHT_RECEIPT: initialEncoded,
      CLEANUP_TERMINAL_RECEIPT: "not-canonical-base64url",
    }), new Error("terminal missing"));
    expect(receipt).toMatchObject({
      complete: false,
      evidence: {
        initial: { failureSha256: null, receipt: initial },
        postflight: { failureSha256: null, receipt: null },
        revalidated: { failureSha256: null, receipt: null },
        terminal: { receipt: null },
      },
      productionRefReadback: {
        expectedSha: productionSha,
        preserved: true,
        sha: productionSha,
      },
      repository,
      runAttempt: 1,
      runId: cleanupRunId,
      workflowSha,
    });
    expect(receipt.evidence.terminal.failureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.failureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.calls.at(-1)?.url).toEndWith("/git/ref/heads/website-production");
  });

  test("keeps cleanup statically isolated from success authority and ref mutation", async () => {
    const [source, workflow] = await Promise.all([
      readFile(new URL("./release-authority-cleanup.mjs", import.meta.url), "utf8"),
      readFile(new URL("../.github/workflows/release-authority-cleanup.yml", import.meta.url), "utf8"),
    ]);
    expect(source).not.toContain("release-ref-writer");
    expect(source).not.toContain('state: "success"');
    expect(source).not.toMatch(/method:\s*"PATCH"|method:\s*"PUT"/u);
    expect(source).toContain('state: "error"');
    expect(workflow).toContain("run-name: Terminalize release authority target ${{ inputs.expected_target_sha }}");
    expect(workflow).toContain("group: website-production-promotion");
    expect(workflow).toContain("if: ${{ always() && needs.preflight.result == 'success' }}");
    expect(workflow.match(/if: \$\{\{ always\(\) \}\}/gu)).toHaveLength(3);
    expect(workflow.match(
      /if: \$\{\{ always\(\) && steps\.pin\.outcome == 'success' \}\}/gu,
    )).toHaveLength(2);
    expect(workflow).not.toContain("release-ref-writer.mjs");
    expect(workflow).not.toMatch(/git push|gh api.*(?:PATCH|PUT)/u);
  });
});
