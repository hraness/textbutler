import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseTagNewerThanPublished,
  collectDeploymentStatuses,
  collectProductionDeployments,
  createProviderBaseline,
  decodeProviderReceipt,
  encodeProviderReceipt,
  parseIncludedGitHubResponse,
  promoteWebsiteProduction as promoteWebsiteProductionRaw,
  proveProductionRequiredStatusDenial,
  releaseGraphqlRequestBudget,
  releaseRestRequestBudget,
  waitForProviderOutcome as waitForProviderOutcomeRaw,
} from "./release-provider-outcome.mjs";
import {
  createProductionAuthorityAttestedReceipt,
  createProductionAuthorityConsumedReceipt,
  encodeProductionAuthorityPhaseReceipt,
  productionAuthorityReceiptDigest,
} from "./release-production-authority.mjs";
import { controlEpochDigest } from "./release-workflow-range.mjs";
import { qualifyExistingSiteProduction } from "./site-production.mjs";

const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const productionWorkflowUrl = new URL("../.github/workflows/website-production.yml", import.meta.url);
const providerOutcomeHelperUrl = new URL("./release-provider-outcome.mjs", import.meta.url);
const repository = fileURLToPath(new URL("../", import.meta.url));

function workflowStepScript(workflow: string, name: string): string {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) throw new Error(`Workflow step not found: ${name}`);
  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  if (runStart < 0) throw new Error(`Workflow step has no run script: ${name}`);
  const lines = workflow.slice(runStart + runMarker.length).split("\n");
  const script: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      script.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

async function runWorkflowScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["/bin/bash", "-c", script], {
    cwd: repository,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return Object.freeze({ exitCode, stderr, stdout });
}

async function runProviderCommand(
  command: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["node", fileURLToPath(providerOutcomeHelperUrl), command], {
    cwd: repository,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return Object.freeze({ exitCode, stderr, stdout });
}

const providerRepository = "hraness/textbutler";
const providerPreviousSha = "1".repeat(40);
const providerTag = "v0.8.0";
const tagResolutionFixture = JSON.parse(await readFile(
  new URL("./fixtures/github-v0.8.0-tag-resolution.json", import.meta.url),
  "utf8",
)) as Readonly<{
  resolvedCommit: Readonly<Record<string, ProviderJson> & { sha: string }>;
  tagRef: Readonly<{
    object: Readonly<{ sha: string; type: string; url: string }>;
    ref: string;
  }>;
}>;
const providerVerifiedSha = tagResolutionFixture.resolvedCommit.sha;
const providerTagObjectSha = tagResolutionFixture.tagRef.object.sha;
// Preserve the archived pre-rename receipt and model the canonical API response
// separately with unchanged immutable tag-object identity.
const canonicalTagRef = {
  ...tagResolutionFixture.tagRef,
  url: `https://api.github.com/repos/${providerRepository}/git/refs/tags/${providerTag}`,
  object: {
    ...tagResolutionFixture.tagRef.object,
    url: `https://api.github.com/repos/${providerRepository}/git/tags/${providerTagObjectSha}`,
  },
};
const providerReleasePublishedAt = "2026-08-29T14:00:00Z";
const providerBaselineServerDate = "2026-08-29T15:00:00.000Z";
const providerPromotionServerDate = "2026-08-29T15:01:00.000Z";
const providerCurrentMainSha = "3".repeat(40);
type ProviderRevocationReceipt = Readonly<{
  converged: true;
  deletionServerDate: string;
  lastObservationServerDate: string;
  observationCount: number;
  propagationObserved: boolean;
  stableDenials: 2;
}>;
const providerRevocationReceipt: ProviderRevocationReceipt = Object.freeze({
  converged: true as const,
  deletionServerDate: providerPromotionServerDate,
  lastObservationServerDate: providerPromotionServerDate,
  observationCount: 2,
  propagationObserved: false,
  stableDenials: 2 as const,
});
const providerAuthority = Object.freeze({
  repository: providerRepository,
  verifiedSha: providerVerifiedSha,
  verifiedTag: providerTag,
});
const providerWorkflowRangeReceipt = Object.freeze({
  newCommitCount: 1,
  newCommitDigest: "4".repeat(64),
  previousSha: providerPreviousSha,
  productionRef: "refs/heads/website-production",
  schema: "message-like-me-workflow-range-v1",
  verifiedSha: providerVerifiedSha,
  workflowTreeOid: "5".repeat(40),
});

function providerProductionControlEpochReceipt(overrides: Readonly<{
  digest?: string;
  tag?: string;
  workflowSha?: string;
}> = {}) {
  const workflowSha = overrides.workflowSha ?? providerVerifiedSha;
  const inventory = workflowSha === providerVerifiedSha
    ? [
      { commitSha: providerPreviousSha, workflowTreeOid: "5".repeat(40) },
      { commitSha: providerVerifiedSha, workflowTreeOid: "6".repeat(40) },
    ]
    : [
      { commitSha: providerPreviousSha, workflowTreeOid: "5".repeat(40) },
      { commitSha: providerVerifiedSha, workflowTreeOid: "6".repeat(40) },
      { commitSha: workflowSha, workflowTreeOid: "7".repeat(40) },
    ];
  const changes = inventory.slice(1).map((entry, index) => ({
    commitSha: entry.commitSha,
    previousWorkflowTreeOid: inventory[index]!.workflowTreeOid,
    workflowTreeOid: entry.workflowTreeOid,
  }));
  const unsigned = {
    changes,
    domain: "message-like-me/control-epoch/production/v2",
    inventory,
    previousSha: providerPreviousSha,
    protectedRef: "refs/heads/website-production",
    repository: providerRepository,
    repositoryId: 1_342_143_606,
    schema: "message-like-me-production-control-epoch-v2",
    tag: overrides.tag ?? providerTag,
    targetSha: providerVerifiedSha,
    workflowSha,
  };
  return Object.freeze({
    ...unsigned,
    digest: overrides.digest ?? controlEpochDigest(unsigned),
  });
}

const productionAuthorityContext =
  "message-like-me/website-production-authority" as const;

function providerProductionStatus<State extends "error" | "success">(
  state: State,
  id: number,
  createdAt = "2026-08-29T15:01:00Z",
) {
  return Object.freeze({
    appId: 4_830_612 as const,
    appSlug: "mlm-prod-ref-writer-1342143606" as const,
    context: productionAuthorityContext,
    createdAt,
    creator: Object.freeze({
      id: 123,
      login: "mlm-prod-ref-writer-1342143606[bot]",
      nodeId: "MDM6Qm90MTIz",
    }),
    description: state === "success"
      ? "Exact release authority admitted for one production-ref attempt"
      : "Release authority consumed after the production-ref attempt",
    installationId: 159_058_102 as const,
    repository: providerRepository as "hraness/textbutler",
    repositoryId: 1_342_143_606 as const,
    serverDate: createdAt.replace("Z", ".000Z"),
    state,
    statusId: id,
    statusNodeId: `SC_status_${String(id)}`,
    statusUrl: `https://api.github.com/repos/${providerRepository}/statuses/${providerVerifiedSha}`,
    targetSha: providerVerifiedSha,
  });
}

const providerAttestationStatus = providerProductionStatus("success", 9_001);

function providerProductionCombinedStatus(status: ReturnType<typeof providerProductionStatus> = providerAttestationStatus): ProviderJson {
  return {
    commit_url: `https://api.github.com/repos/${providerRepository}/commits/${providerVerifiedSha}`,
    repository: {
      full_name: providerRepository,
      id: 1_342_143_606,
      name: "textbutler",
      owner: { login: "hraness", type: "Organization" },
    },
    sha: providerVerifiedSha,
    state: status.state === "success" ? "success" : "failure",
    statuses: [{
      context: status.context,
      created_at: status.createdAt,
      description: status.description,
      id: status.statusId,
      node_id: status.statusNodeId,
      state: status.state,
      target_url: null,
      updated_at: status.createdAt,
      url: status.statusUrl,
    }],
    total_count: 1,
    url: `https://api.github.com/repos/${providerRepository}/commits/${providerVerifiedSha}/status`,
  };
}

function providerRulesetBase(id: number, name: string, rules: readonly ProviderJson[]): ProviderJson {
  return {
    _links: {
      html: { href: `https://github.com/${providerRepository}/rules/${String(id)}` },
      self: { href: `https://api.github.com/repos/${providerRepository}/rulesets/${String(id)}` },
    },
    bypass_actors: [],
    conditions: {
      ref_name: { exclude: [], include: ["refs/heads/website-production"] },
    },
    current_user_can_bypass: "never",
    enforcement: "active",
    id,
    name,
    rules,
    source: providerRepository,
    source_type: "Repository",
    target: "branch",
  };
}

function providerAuthorityRule(): ProviderJson {
  return {
    parameters: {
      do_not_enforce_on_create: false,
      required_status_checks: [{
        context: productionAuthorityContext,
        integration_id: 4_830_612,
      }],
      strict_required_status_checks_policy: false,
    },
    type: "required_status_checks",
  };
}

function providerProductionRules() {
  const lifecycle = ["creation", "deletion", "non_fast_forward"].map((type) => ({
    ruleset_id: 21_821_875,
    ruleset_source: providerRepository,
    ruleset_source_type: "Repository",
    type,
  }));
  const authority = {
    ...providerAuthorityRule() as Readonly<Record<string, ProviderJson>>,
    ruleset_id: 22_290_922,
    ruleset_source: providerRepository,
    ruleset_source_type: "Repository",
  };
  const receipt = (body: ProviderJson) => ({
    body,
    serverDate: providerPromotionServerDate,
  });
  return Object.freeze({
    authority: receipt(providerRulesetBase(
      22_290_922,
      "Message Like Me production status authority",
      [providerAuthorityRule()],
    )),
    effective: receipt([...lifecycle, authority]),
    lifecycle: receipt(providerRulesetBase(
      21_821_875,
      "Immutable website-production lifecycle",
      ["creation", "deletion", "non_fast_forward"].map((type) => ({ type })),
    )),
  });
}

function providerAuthorityPhases(baseline: unknown) {
  const preconditionStatus = providerProductionStatus(
    "error",
    9_000,
    "2026-08-29T15:00:00Z",
  );
  const precondition = createProductionAuthorityConsumedReceipt(
    providerVerifiedSha,
    undefined,
    undefined,
    {
      consumption: preconditionStatus,
      readback: {
        context: productionAuthorityContext,
        serverDate: "2026-08-29T15:00:01.000Z",
        state: "failure" as const,
        statusCount: 1,
        targetSha: providerVerifiedSha,
        terminalStatusId: preconditionStatus.statusId,
        terminalStatusNodeId: preconditionStatus.statusNodeId,
      },
    },
    {
      ...providerRevocationReceipt,
      deletionServerDate: "2026-08-29T15:00:02.000Z",
      lastObservationServerDate: "2026-08-29T15:00:03.000Z",
    },
  );
  const attestation = createProductionAuthorityAttestedReceipt(
    providerVerifiedSha,
    providerAttestationStatus,
    providerRevocationReceipt,
  );
  const rules = providerProductionRules();
  const normalize = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  const denial = Object.freeze({
    baselineDigest: normalize(baseline),
    denial: Object.freeze({
      classification: "required-status-errored" as const,
      diagnosticSha256: "d".repeat(64),
    }),
    observedAt: providerPromotionServerDate,
    preconditionSha256: productionAuthorityReceiptDigest(precondition),
    previousSha: providerPreviousSha,
    productionRef: "refs/heads/website-production" as const,
    repository: providerRepository,
    rules: Object.freeze({
      bodySha256: Object.freeze({
        authority: normalize(rules.authority.body),
        effective: normalize(rules.effective.body),
        lifecycle: normalize(rules.lifecycle.body),
      }),
      rules: Object.freeze({
        authority: Object.freeze({
          doNotEnforceOnCreate: false as const,
          integrationId: 4_830_612 as const,
          name: "Message Like Me production status authority" as const,
          rulesetId: 22_290_922 as const,
          strict: false as const,
        }),
        lifecycle: Object.freeze({
          name: "Immutable website-production lifecycle" as const,
          rulesetId: 21_821_875 as const,
        }),
      }),
      serverDates: Object.freeze({
        authority: providerPromotionServerDate,
        effective: providerPromotionServerDate,
        lifecycle: providerPromotionServerDate,
      }),
    }),
    schema: "message-like-me-production-required-status-denial-v3" as const,
    verifiedSha: providerVerifiedSha,
    verifiedTag: providerTag,
  });
  return Object.freeze({ attestation, denial, precondition });
}

type ProviderOutcomeInput = Parameters<typeof waitForProviderOutcomeRaw>[0];
type AuthorityDefaults = "defaultBranch" | "eventName" | "recoveryWorkflowSha";
type ProviderPromotionTestInput = Readonly<{
  api: ProviderApiFixture;
  baselineReceipt: unknown;
  defaultBranch?: string;
  eventName?: string;
  recoveryWorkflowSha?: string;
  repository?: string;
  verifiedSha?: string;
  verifiedTag?: string;
  workflowRangeReceipt?: unknown;
}>;

const waitForProviderOutcome = (
  options: Omit<ProviderOutcomeInput, AuthorityDefaults> &
    Partial<Pick<ProviderOutcomeInput, AuthorityDefaults>>,
): ReturnType<typeof waitForProviderOutcomeRaw> => waitForProviderOutcomeRaw({
  defaultBranch: "main",
  eventName: "workflow_dispatch",
  recoveryWorkflowSha: providerVerifiedSha,
  ...providerAuthority,
  ...options,
});

const promoteWebsiteProduction = (
  options: ProviderPromotionTestInput,
): ReturnType<typeof promoteWebsiteProductionRaw> => {
  const common = {
    api: options.api,
    baselineReceipt: options.baselineReceipt,
    defaultBranch: options.defaultBranch ?? "main",
    eventName: options.eventName ?? "workflow_dispatch",
    recoveryWorkflowSha: options.recoveryWorkflowSha ?? providerVerifiedSha,
    repository: options.repository ?? providerRepository,
    verifiedSha: options.verifiedSha ?? providerVerifiedSha,
    verifiedTag: options.verifiedTag ?? providerTag,
  };
  const baseline = options.baselineReceipt as Readonly<Record<string, unknown>>;
  if (baseline.refSha === providerVerifiedSha) {
    return promoteWebsiteProductionRaw(common);
  }
  const authority = providerAuthorityPhases(options.baselineReceipt);
  return promoteWebsiteProductionRaw({
    ...common,
    advanceRef: new ProviderRefWriterFixture(options.api).advanceRef,
    attestationReceipt: encodeProductionAuthorityPhaseReceipt(authority.attestation),
    denialReceipt: authority.denial,
    workflowRangeReceipt: options.workflowRangeReceipt ?? providerWorkflowRangeReceipt,
  });
};

type ProviderJson = undefined | null | boolean | number | string | readonly ProviderJson[] | {
  readonly [key: string]: ProviderJson;
};

function providerDeployment(
  id: number,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  return {
    created_at: createdAt,
    creator: { id: 35613825, login: "vercel[bot]", type: "Bot" },
    environment: "Production",
    id,
    original_environment: "Production",
    ref: "ignored-provider-ref",
    sha: providerVerifiedSha,
    statuses_url: `https://api.github.com/repos/${providerRepository}/deployments/${String(id)}/statuses`,
    task: "deploy",
    ...overrides,
  };
}

function providerGraphqlDeployment(
  id: number,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  const vercelUrl = `https://messagelikeme-${String(id)}-hraness.vercel.app`;
  const defaultLatestStatus: ProviderJson = {
    createdAt,
    creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
    environment: "Production",
    environmentUrl: vercelUrl,
    id: `status-${String(id)}`,
    logUrl: vercelUrl,
    state: "SUCCESS",
    updatedAt: createdAt,
  };
  const latestStatus = Object.hasOwn(overrides, "latestStatus")
    ? overrides.latestStatus
    : defaultLatestStatus;
  const { latestStatus: _latestStatus, ...restOverrides } = overrides;
  return {
    commitOid: providerVerifiedSha,
    createdAt,
    creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
    databaseId: id,
    environment: "Production",
    latestStatus,
    originalEnvironment: "Production",
    state: "ACTIVE",
    task: "deploy",
    updatedAt: createdAt,
    ...restOverrides,
  };
}

function graphqlDeploymentFromRest(
  value: ProviderJson,
  restStatuses: readonly ProviderJson[] = [],
): ProviderJson {
  const deployment = value as Readonly<Record<string, ProviderJson>>;
  const creator = deployment.creator as Readonly<Record<string, ProviderJson>>;
  const derivedStatuses = restStatuses.map((value) => {
    const status = value as Readonly<Record<string, ProviderJson>>;
    const statusCreator = status.creator as Readonly<Record<string, ProviderJson>>;
    return {
      createdAt: status.created_at,
      creator: {
        __typename: statusCreator.type,
        databaseId: statusCreator.id,
        login: statusCreator.login === "vercel[bot]" ? "vercel" : statusCreator.login,
      },
      environment: status.environment,
      environmentUrl: status.environment_url,
      id: status.node_id,
      logUrl: status.log_url,
      state: typeof status.state === "string" ? status.state.toUpperCase() : status.state,
      updatedAt: status.updated_at,
    } satisfies ProviderJson;
  });
  const derivedLatestStatus = derivedStatuses[0];
  const statusState = (derivedLatestStatus as Readonly<Record<string, ProviderJson>> | undefined)
    ?.state;
  const derivedState = statusState === "SUCCESS" ? "ACTIVE" : statusState;
  const latestStatus = deployment.graphql_latest_status ?? derivedLatestStatus ??
    (providerGraphqlDeployment(
      deployment.id as number,
      deployment.created_at as string,
    ) as Readonly<Record<string, ProviderJson>>).latestStatus;
  return providerGraphqlDeployment(
    deployment.id as number,
    deployment.created_at as string,
    {
      commitOid: deployment.sha,
      creator: {
        __typename: creator.type,
        databaseId: creator.id,
        login: creator.login === "vercel[bot]" ? "vercel" : creator.login,
      },
      environment: deployment.environment,
      latestStatus,
      originalEnvironment: deployment.original_environment,
      state: deployment.graphql_state ?? derivedState ?? "ACTIVE",
      task: deployment.task,
      updatedAt:
        deployment.graphql_updated_at ??
        (derivedLatestStatus as Readonly<Record<string, ProviderJson>> | undefined)?.updatedAt ??
        deployment.created_at,
    },
  );
}

function providerGraphqlResponse(
  nodes: readonly ProviderJson[],
  {
    cost = 1,
    endCursor = null,
    hasNextPage = false,
    remaining = 999,
    resetAt = "2026-08-29T16:00:00Z",
    totalCount = nodes.length,
  }: Readonly<{
    cost?: number;
    endCursor?: ProviderJson;
    hasNextPage?: boolean;
    remaining?: number;
    resetAt?: string;
    totalCount?: number;
  }> = {},
): ProviderJson {
  return {
    data: {
      rateLimit: { cost, remaining, resetAt },
      repository: {
        deployments: {
          nodes,
          pageInfo: { endCursor, hasNextPage },
          totalCount,
        },
      },
    },
  };
}

function providerStatus(
  id: number,
  state: string,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
  deploymentId = 10,
): ProviderJson {
  const vercelUrl = `https://messagelikeme-${String(deploymentId)}-hraness.vercel.app`;
  return {
    created_at: createdAt,
    creator: { id: 35613825, login: "vercel[bot]", type: "Bot" },
    deployment_url: `https://api.github.com/repos/${providerRepository}/deployments/${String(deploymentId)}`,
    environment: "Production",
    environment_url: vercelUrl,
    id,
    log_url: vercelUrl,
    node_id: `status-${String(id)}`,
    state,
    target_url: vercelUrl,
    updated_at: createdAt,
    ...overrides,
  };
}

function providerRef(sha: string, branch = "website-production"): ProviderJson {
  return { object: { sha, type: "commit" }, ref: `refs/heads/${branch}` };
}

function providerAnnotatedTagObject(
  commit = providerVerifiedSha,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  return {
    object: { sha: commit, type: "commit" },
    sha: providerTagObjectSha,
    tag: providerTag,
    ...overrides,
  };
}

function providerRelease(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return {
    assets: [],
    draft: false,
    immutable: true,
    prerelease: false,
    published_at: providerReleasePublishedAt,
    tag_name: providerTag,
    ...overrides,
  };
}

function providerLatest(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return { tag_name: providerTag, ...overrides };
}

function providerCompare(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return {
    ahead_by: 1,
    base_commit: { sha: providerPreviousSha },
    behind_by: 0,
    commits: [{ sha: providerVerifiedSha }],
    merge_base_commit: { sha: providerPreviousSha },
    status: "ahead",
    ...overrides,
  };
}

function providerReviewedMainCompare(
  base: string,
  head: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  return {
    ahead_by: 1,
    base_commit: { sha: base },
    behind_by: 0,
    commits: [{ sha: head }],
    merge_base_commit: { sha: base },
    status: "ahead",
    ...overrides,
  };
}

class ProviderApiFixture {
  readonly calls: string[] = [];
  readonly graphqlCalls: string[] = [];
  readonly includedCalls: string[] = [];
  readonly deploymentDetailSnapshots: readonly ProviderJson[];
  readonly defaultBranchSnapshots: readonly string[];
  readonly defaultBranchShaSnapshots: readonly string[];
  readonly deploymentSnapshots: ProviderJson[][];
  readonly graphqlResponses: readonly ProviderJson[];
  readonly graphqlSnapshots: ProviderJson[][] | undefined;
  readonly latestSnapshots: readonly ProviderJson[];
  readonly serverDates: readonly string[];
  readonly statusSnapshots: Map<number, ProviderJson[][]>;
  compare: ProviderJson = providerCompare();
  compareHook: (() => void) | undefined;
  readonly reviewedCompare: ProviderJson | undefined;
  deploymentDetailError: Error | undefined;
  refSha: string;
  readonly refSnapshots: readonly string[];
  readonly refValues: readonly ProviderJson[];
  readonly releaseSnapshots: readonly ProviderJson[];
  readonly tagSnapshots: readonly string[];
  latest: ProviderJson = providerLatest();
  release: ProviderJson = providerRelease();

  #deploymentDetailRead = 0;
  #defaultBranchRead = 0;
  #defaultBranchShaRead = 0;
  #deploymentRead = -1;
  #deploymentSnapshot: ProviderJson[] = [];
  #graphqlRead = -1;
  #graphqlResponseRead = 0;
  #graphqlSnapshot: ProviderJson[] = [];
  #refRead = 0;
  #releaseRead = 0;
  #latestRead = 0;
  #serverDateRead = 0;
  #statusReads = new Map<number, number>();
  #statusCurrent = new Map<number, ProviderJson[]>();
  #tagRead = 0;

  constructor({
    deploymentDetails = [],
    defaultBranchSnapshots = [],
    defaultBranchShaSnapshots = [],
    deployments = [[]],
    graphqlDeployments,
    graphqlResponses = [],
    latestSnapshots = [],
    refSnapshots = [],
    refSha = providerPreviousSha,
    refValues = [],
    releaseSnapshots = [],
    reviewedCompare,
    serverDates = [providerPromotionServerDate],
    statuses = new Map<number, ProviderJson[][]>(),
    tagSnapshots = [],
  }: Readonly<{
    deploymentDetails?: readonly ProviderJson[];
    defaultBranchSnapshots?: readonly string[];
    defaultBranchShaSnapshots?: readonly string[];
    deployments?: ProviderJson[][];
    graphqlDeployments?: ProviderJson[][];
    graphqlResponses?: readonly ProviderJson[];
    latestSnapshots?: readonly ProviderJson[];
    refSnapshots?: readonly string[];
    refSha?: string;
    refValues?: readonly ProviderJson[];
    releaseSnapshots?: readonly ProviderJson[];
    reviewedCompare?: ProviderJson;
    serverDates?: readonly string[];
    statuses?: Map<number, ProviderJson[][]>;
    tagSnapshots?: readonly string[];
  }> = {}) {
    this.deploymentDetailSnapshots = deploymentDetails;
    this.defaultBranchSnapshots = defaultBranchSnapshots;
    this.defaultBranchShaSnapshots = defaultBranchShaSnapshots;
    this.deploymentSnapshots = deployments;
    this.graphqlResponses = graphqlResponses;
    this.graphqlSnapshots = graphqlDeployments;
    this.latestSnapshots = latestSnapshots;
    this.refSha = refSha;
    this.refSnapshots = refSnapshots;
    this.refValues = refValues;
    this.releaseSnapshots = releaseSnapshots;
    this.reviewedCompare = reviewedCompare;
    this.serverDates = serverDates;
    this.statusSnapshots = statuses;
    this.tagSnapshots = tagSnapshots;
  }

  async graphql(input: Readonly<{
    after?: string;
    name: string;
    owner: string;
    query: string;
  }>): Promise<ProviderJson> {
    expect(input.owner).toBe("hraness");
    expect(input.name).toBe("textbutler");
    expect(input.query).toContain("query MessageLikeMeProductionDeployments");
    this.graphqlCalls.push(`after=${input.after ?? ""}`);
    const response = this.graphqlResponses[
      Math.min(this.#graphqlResponseRead, this.graphqlResponses.length - 1)
    ];
    if (response !== undefined) {
      this.#graphqlResponseRead += 1;
      return response;
    }
    const page = input.after === undefined
      ? 1
      : Number(/^cursor-([1-4])$/u.exec(input.after)?.[1] ?? "0") + 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 5) {
      throw new Error(`Unexpected GraphQL cursor ${input.after ?? ""}`);
    }
    if (page === 1) {
      this.#graphqlRead += 1;
      const read = Math.min(this.#graphqlRead, this.deploymentSnapshots.length - 1);
      this.#deploymentSnapshot = this.deploymentSnapshots[read] ?? [];
      this.#graphqlSnapshot = this.graphqlSnapshots?.[
        Math.min(this.#graphqlRead, this.graphqlSnapshots.length - 1)
      ] ?? this.#deploymentSnapshot.map((deployment) => {
        const raw = deployment as Readonly<Record<string, ProviderJson>>;
        const id = raw.id as number;
        const statusRead = this.#statusReads.get(id) ?? 0;
        const snapshots = this.statusSnapshots.get(id) ?? [];
        const currentStatuses = snapshots[Math.min(statusRead, snapshots.length - 1)] ?? [];
        return graphqlDeploymentFromRest(deployment, currentStatuses);
      });
    }
    const start = (page - 1) * 100;
    const nodes = this.#graphqlSnapshot.slice(start, page * 100);
    const hasNextPage = this.#graphqlSnapshot.length > page * 100;
    return providerGraphqlResponse(nodes, {
      endCursor: hasNextPage ? `cursor-${String(page)}` : `end-${String(page)}`,
      hasNextPage,
      remaining: 999 - this.graphqlCalls.length,
      totalCount: this.#graphqlSnapshot.length,
    });
  }

  async get(endpoint: string): Promise<ProviderJson> {
    this.calls.push(`GET ${endpoint}`);
    if (endpoint === `/repos/${providerRepository}`) {
      const branch = this.defaultBranchSnapshots[
        Math.min(this.#defaultBranchRead, this.defaultBranchSnapshots.length - 1)
      ];
      this.#defaultBranchRead += 1;
      return { default_branch: branch ?? "main" };
    }
    if (endpoint === `/repos/${providerRepository}/git/ref/heads/main`) {
      const sha = this.defaultBranchShaSnapshots[
        Math.min(this.#defaultBranchShaRead, this.defaultBranchShaSnapshots.length - 1)
      ];
      this.#defaultBranchShaRead += 1;
      return providerRef(sha ?? providerVerifiedSha, "main");
    }
    if (endpoint === `/repos/${providerRepository}/git/ref/heads/website-production`) {
      const value = this.refValues[Math.min(this.#refRead, this.refValues.length - 1)];
      const snapshot = this.refSnapshots[Math.min(this.#refRead, this.refSnapshots.length - 1)];
      this.#refRead += 1;
      if (value !== undefined) return value;
      return providerRef(snapshot ?? this.refSha);
    }
    if (endpoint === `/repos/${providerRepository}/releases/tags/${providerTag}`) {
      const snapshot = this.releaseSnapshots[
        Math.min(this.#releaseRead, this.releaseSnapshots.length - 1)
      ];
      this.#releaseRead += 1;
      if (snapshot !== undefined) return snapshot;
      return this.release;
    }
    if (endpoint === `/repos/${providerRepository}/releases/latest`) {
      const snapshot = this.latestSnapshots[
        Math.min(this.#latestRead, this.latestSnapshots.length - 1)
      ];
      this.#latestRead += 1;
      return snapshot ?? this.latest;
    }
    if (endpoint === `/repos/${providerRepository}/git/ref/tags/${providerTag}`) {
      return canonicalTagRef as ProviderJson;
    }
    if (endpoint === `/repos/${providerRepository}/git/tags/${providerTagObjectSha}`) {
      const snapshot = this.tagSnapshots[Math.min(this.#tagRead, this.tagSnapshots.length - 1)];
      this.#tagRead += 1;
      return providerAnnotatedTagObject(snapshot ?? providerVerifiedSha);
    }
    if (
      endpoint ===
      `/repos/${providerRepository}/compare/${providerPreviousSha}...${providerVerifiedSha}`
    ) {
      this.compareHook?.();
      return this.compare;
    }
    const reviewedComparison = new RegExp(
      `^/repos/${providerRepository}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`,
      "u",
    ).exec(endpoint);
    if (reviewedComparison !== null) {
      const base = reviewedComparison[1] as string;
      const head = reviewedComparison[2] as string;
      return this.reviewedCompare ?? providerReviewedMainCompare(base, head);
    }
    const deploymentPage = new RegExp(
      `^/repos/${providerRepository}/deployments\\?environment=Production&task=deploy&per_page=100&page=([1-6])$`,
      "u",
    ).exec(endpoint);
    if (deploymentPage !== null) {
      const page = Number(deploymentPage[1]);
      if (page === 1) {
        this.#deploymentRead += 1;
        this.#deploymentSnapshot =
          this.deploymentSnapshots[Math.min(this.#deploymentRead, this.deploymentSnapshots.length - 1)] ?? [];
      }
      return this.#deploymentSnapshot.slice((page - 1) * 100, page * 100);
    }
    const deploymentDetail = new RegExp(
      `^/repos/${providerRepository}/deployments/([1-9][0-9]*)$`,
      "u",
    ).exec(endpoint);
    if (deploymentDetail !== null) {
      if (this.deploymentDetailError !== undefined) throw this.deploymentDetailError;
      const deploymentId = Number(deploymentDetail[1]);
      const snapshot = this.deploymentDetailSnapshots[
        Math.min(this.#deploymentDetailRead, this.deploymentDetailSnapshots.length - 1)
      ];
      this.#deploymentDetailRead += 1;
      if (snapshot !== undefined) return snapshot;
      const found = this.#deploymentSnapshot.find((deployment) =>
        (deployment as Readonly<Record<string, ProviderJson>>).id === deploymentId);
      if (found !== undefined) return found;
      throw new Error(`Deployment ${String(deploymentId)} disappeared`);
    }
    const statusPage = new RegExp(
      `^/repos/${providerRepository}/deployments/([1-9][0-9]*)/statuses\\?per_page=100&page=([1-6])$`,
      "u",
    ).exec(endpoint);
    if (statusPage !== null) {
      const deploymentId = Number(statusPage[1]);
      const page = Number(statusPage[2]);
      if (page === 1) {
        const read = (this.#statusReads.get(deploymentId) ?? -1) + 1;
        this.#statusReads.set(deploymentId, read);
        const snapshots = this.statusSnapshots.get(deploymentId) ?? [[]];
        this.#statusCurrent.set(
          deploymentId,
          snapshots[Math.min(read, snapshots.length - 1)] ?? [],
        );
      }
      const statuses = this.#statusCurrent.get(deploymentId) ?? [];
      return statuses.slice((page - 1) * 100, page * 100);
    }
    if (
      endpoint ===
      `/repos/${providerRepository}/commits/${providerVerifiedSha}/status?per_page=100`
    ) {
      this.calls.push("GET PRODUCTION AUTHORITY STATUS");
      return providerProductionCombinedStatus();
    }
    throw new Error(`Unexpected provider GET ${endpoint}`);
  }

  async getWithServerDate(endpoint: string): Promise<ProviderJson> {
    this.includedCalls.push(endpoint);
    const body = await this.get(endpoint);
    const serverDate = this.serverDates[
      Math.min(this.#serverDateRead, this.serverDates.length - 1)
    ];
    this.#serverDateRead += 1;
    return { body, serverDate: serverDate ?? providerPromotionServerDate };
  }

  async getCombinedStatus(_targetSha: string): Promise<ProviderJson> {
    this.calls.push("GET PRODUCTION AUTHORITY STATUS");
    return {
      body: providerProductionCombinedStatus(),
      serverDate: providerPromotionServerDate,
    };
  }

  async getRules(): Promise<ReturnType<typeof providerProductionRules>> {
    this.calls.push("GET PRODUCTION RULES");
    return providerProductionRules();
  }

}

class ProviderRefWriterFixture {
  advanceError: Error | undefined;

  constructor(readonly readApi: ProviderApiFixture) {}

  readonly advanceRef = async (
    repository: string,
    expectedOldSha: string,
    verifiedSha: string,
    verifiedTag: string,
  ) => {
    this.readApi.calls.push(
      `GIT PUSH ${repository} ${expectedOldSha} ${verifiedSha} ${verifiedTag}`,
    );
    expect(repository).toBe(providerRepository);
    expect(expectedOldSha).toBe(providerPreviousSha);
    expect(verifiedSha).toBe(providerVerifiedSha);
    expect(verifiedTag).toBe(providerTag);
    if (this.advanceError !== undefined) throw this.advanceError;
    this.readApi.refSha = providerVerifiedSha;
    return Object.freeze({
      classification: "fast-forward" as const,
      fromSha: expectedOldSha,
      protectedRef: "refs/heads/website-production" as const,
      summarySha256: "f".repeat(64),
      toSha: verifiedSha,
    });
  };
}

function terminalBaselineStatus(
  deploymentId = 10,
  createdAt = "2026-08-29T13:01:00Z",
): Map<number, ProviderJson[][]> {
  return new Map([
    [deploymentId, [[providerStatus(100, "success", createdAt, {}, deploymentId)]]],
  ]);
}

async function providerReceipts(mode: "advanced" | "already-exact"): Promise<Readonly<{
  baseline: ProviderJson;
  baselineDeployment: ProviderJson;
  promotion: ProviderJson;
  promotionCalls: readonly string[];
}>> {
  const baselineDeployment = providerDeployment(
    10,
    mode === "already-exact" ? "2026-08-29T14:05:00Z" : "2026-08-29T13:00:00Z",
    mode === "already-exact" ? {} : { sha: providerPreviousSha },
  );
  const baselineApi = new ProviderApiFixture({
    deployments: [[baselineDeployment]],
    refSha: mode === "already-exact" ? providerVerifiedSha : providerPreviousSha,
    serverDates: [providerBaselineServerDate, providerBaselineServerDate],
    statuses: terminalBaselineStatus(
      10,
      mode === "already-exact" ? "2026-08-29T14:06:00Z" : "2026-08-29T13:01:00Z",
    ),
  });
  const baseline = await createProviderBaseline({
    api: baselineApi,
    repository: providerRepository,
    verifiedSha: providerVerifiedSha,
  }) as ProviderJson;
  const promotionApi = new ProviderApiFixture({
    deployments: [[baselineDeployment]],
    refSha: mode === "already-exact" ? providerVerifiedSha : providerPreviousSha,
    serverDates: [providerPromotionServerDate],
    statuses: terminalBaselineStatus(
      10,
      mode === "already-exact" ? "2026-08-29T14:06:00Z" : "2026-08-29T13:01:00Z",
    ),
  });
  const promotion = await promoteWebsiteProduction({
    api: promotionApi,
    baselineReceipt: baseline,
    repository: providerRepository,
    verifiedSha: providerVerifiedSha,
    verifiedTag: providerTag,
  }) as ProviderJson;
  return Object.freeze({
    baseline,
    baselineDeployment,
    promotion,
    promotionCalls: Object.freeze([...promotionApi.calls]),
  });
}


test("already-exact site recovery accepts a deployment after CI but before the retry artifact, without package lookups", async () => {
  const subject = { kind: "site" as const, sourceSha: providerVerifiedSha, ciRunId: 10, ciRunAttempt: 1,
    buildRunId: 20, buildRunAttempt: 1, buildArtifactId: 30, buildArtifactDigest: `sha256:${"a".repeat(64)}`,
    manifestDigest: "b".repeat(64), buildCompletedAt: "2026-08-29T15:00:00.000Z", sourceQualifiedAt: "2026-08-29T14:00:00.000Z" };
  const identity = { id: 1342143606, full_name: providerRepository };
  const ci = { id: 10, run_attempt: 1, workflow_id: 7, path: ".github/workflows/ci.yml", name: "CI", event: "push",
    head_branch: "main", head_sha: providerVerifiedSha, status: "completed", conclusion: "success", repository: identity, head_repository: identity };
  const terminal = providerProductionStatus("error", 42, "2026-08-29T14:08:00Z");
  const common: Record<string, unknown> = {
    [`/repos/${providerRepository}`]: { ...identity, default_branch: "main" },
    [`/repos/${providerRepository}/actions/workflows/ci.yml`]: { id: 7, path: ci.path, name: "CI", state: "active" },
    [`/repos/${providerRepository}/actions/runs/10`]: ci,
    [`/repos/${providerRepository}/actions/runs/10/attempts/1`]: ci,
    [`/repos/${providerRepository}/actions/runs/10/attempts/1/jobs?per_page=100`]: { total_count: 2, jobs: ["Standalone package", "macOS synthetic Messages and Contacts fixtures"].map(name => ({ name, run_id: 10, run_attempt: 1, head_sha: providerVerifiedSha, status: "completed", conclusion: "success", completed_at: "2026-08-29T14:00:00Z" })) },
    [`/repos/${providerRepository}/actions/artifacts/30`]: { id: 30, name: "textbutler-site-build", expired: false, digest: subject.buildArtifactDigest, size_in_bytes: 1000, created_at: "2026-08-29T15:00:00Z", workflow_run: { id: 20, head_sha: providerVerifiedSha } },
    [`/repos/${providerRepository}/actions/runs/20/attempts/1`]: { id: 20, run_attempt: 1, workflow_id: 8, path: ".github/workflows/website-production.yml", event: "workflow_dispatch", head_branch: "main", head_sha: providerVerifiedSha, status: "in_progress", conclusion: null, repository: identity, head_repository: identity },
    [`/repos/${providerRepository}/actions/workflows/website-production.yml`]: { id: 8, path: ".github/workflows/website-production.yml", name: "Promote website production", state: "active" },
    [`/repos/${providerRepository}/commits/${providerVerifiedSha}/status?per_page=100`]: providerProductionCombinedStatus(terminal),
    [`/repos/${providerRepository}/commits/${providerVerifiedSha}/statuses?per_page=100`]: [{ id: terminal.statusId, node_id: terminal.statusNodeId, context: productionAuthorityContext, state: "error", creator: { id: 123, node_id: "BOT_123", login: "mlm-prod-ref-writer-1342143606[bot]", type: "Bot" } }],
    "/users/mlm-prod-ref-writer-1342143606%5Bbot%5D": { id: 123, node_id: "BOT_123", login: "mlm-prod-ref-writer-1342143606[bot]", type: "Bot" },
  };
  for (const scenario of ["valid", "pre-ci", "wrong-source", "wrong-provider"] as const) {
    const createdAt = scenario === "pre-ci" ? "2026-08-29T13:05:00Z" : "2026-08-29T14:05:00Z";
    const deployment = providerDeployment(10, createdAt, scenario === "wrong-source" ? { sha: providerPreviousSha } : scenario === "wrong-provider" ? { creator: { id: 1, login: "other", type: "Bot" } } : {});
    const inner = new ProviderApiFixture({ deployments: [[deployment]], refSha: providerVerifiedSha,
      serverDates: ["2026-08-29T15:01:00.000Z"], statuses: terminalBaselineStatus(10, createdAt) });
    const api = { graphql: inner.graphql.bind(inner), getWithServerDate: inner.getWithServerDate.bind(inner), getRules: inner.getRules.bind(inner),
      get: async (path: string) => {
        if (path.includes("/releases/") || path.includes("/git/tags/")) throw new Error("site recovery must not query a package release");
        if (Object.hasOwn(common, path)) return common[path];
        return inner.get(path);
      } };
    let baseline;
    try { baseline = await createProviderBaseline({ api: api as never, repository: providerRepository, verifiedSha: providerVerifiedSha }); }
    catch (error) { if (scenario === "wrong-provider") continue; throw error; }
    const result = qualifyExistingSiteProduction({ api, subject, baselineReceipt: baseline, maxPolls: 1, pollIntervalMilliseconds: 0, sleep: async () => {} });
    if (scenario === "valid") await expect(result).resolves.toEqual({ deploymentId: 10, statusId: 100 });
    else await expect(result).rejects.toThrow();
  }
});

describe("release-bound site control", () => {
  test("decodes the workflow-admission receipt only on the executable promote path", async () => {
    const malformedWorkflowRangeReceipt = "***";
    const authority = await runProviderCommand("revalidate-authority", {
      DEFAULT_BRANCH: "main",
      EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "not-one-coordinate",
      PROMOTION_EXPECTED_MODE: "advanced",
      RECOVERY_WORKFLOW_SHA: providerVerifiedSha,
      VERIFIED_SHA: providerVerifiedSha,
      VERIFIED_TAG: providerTag,
      WORKFLOW_RANGE_RECEIPT: malformedWorkflowRangeReceipt,
    });
    expect(authority.exitCode).not.toBe(0);
    expect(authority.stdout).toBe("");
    expect(authority.stderr).toContain("repository is not one owner/name coordinate");
    expect(authority.stderr).not.toContain("expectedMode");
    expect(authority.stderr).not.toContain("Encoded workflow-range receipt");

    const baselineReceipt = encodeProviderReceipt(Object.freeze({
      completedAt: providerBaselineServerDate,
      deploymentFingerprint: "6".repeat(64),
      deploymentIds: Object.freeze([]),
      lowerBound: providerBaselineServerDate,
      productionRef: "refs/heads/website-production",
      refSha: providerPreviousSha,
      repository: providerRepository,
      schema: "message-like-me-provider-baseline-v1",
      verifiedSha: providerVerifiedSha,
    }));
    const promotion = await runProviderCommand("promote", {
      AUTHORITY_ATTESTATION_RECEIPT: encodeProductionAuthorityPhaseReceipt(
        providerAuthorityPhases(decodeProviderReceipt(baselineReceipt)).attestation,
      ),
      AUTHORITY_DENIAL_RECEIPT: encodeProviderReceipt(
        providerAuthorityPhases(decodeProviderReceipt(baselineReceipt)).denial,
      ),
      BASELINE_RECEIPT: baselineReceipt,
      DEFAULT_BRANCH: "main",
      EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: providerRepository,
      GH_TOKEN: "read-token",
      MLM_RELEASE_REF_TOKEN: "writer-token",
      PROMOTION_EXPECTED_MODE: "advanced",
      RECOVERY_WORKFLOW_SHA: providerVerifiedSha,
      VERIFIED_SHA: providerVerifiedSha,
      VERIFIED_TAG: providerTag,
      WORKFLOW_RANGE_RECEIPT: malformedWorkflowRangeReceipt,
    });
    expect(promotion.exitCode).not.toBe(0);
    expect(promotion.stdout).toBe("");
    expect(promotion.stderr).toContain("Encoded workflow admission receipt is missing or malformed");
    expect(promotion.stderr).not.toContain("expectedMode is not defined");
  });

  test("accepts only one exact stable tag push in the Release workflow", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Resolve release request");
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-release-request-"));
    const output = join(directory, "github-output.txt");

    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("ref: refs/tags/${{ steps.request.outputs.tag }}");

    try {
      const runCase = async (
        overrides: Readonly<Record<string, string>>,
      ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
        await rm(output, { force: true });
        return runWorkflowScript(script, {
          EVENT_NAME: "push",
          EVENT_REF: "refs/tags/v0.8.0",
          EVENT_REF_NAME: "v0.8.0",
          EVENT_REF_TYPE: "tag",
          GITHUB_OUTPUT: output,
          ...overrides,
        });
      };

      const pushed = await runCase({});
      expect(pushed.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe("tag=v0.8.0\n");

      for (const rejectedEnvironment of [
        { EVENT_REF: "refs/heads/main", EVENT_REF_NAME: "main", EVENT_REF_TYPE: "branch" },
        { EVENT_REF_NAME: "v0.8.0\npoison", EVENT_REF: "refs/tags/v0.8.0\npoison" },
        { EVENT_NAME: "schedule" },
      ] as const) {
        const rejected = await runCase(rejectedEnvironment);
        expect(rejected.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("binds successful Release attempts to a reviewed-main workflow source", async () => {
    const workflow = await readFile(productionWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Bind request to reviewed main ancestry");
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-site-request-"));
    const bin = join(directory, "bin");
    const output = join(directory, "github-output.txt");
    const gh = join(bin, "gh");
    const workflowSha = "2".repeat(40);
    const releaseSha = "1".repeat(40);

    await mkdir(bin);
    await writeFile(gh, `#!/bin/sh
set -eu
if [ "$1" != "api" ]; then exit 90; fi
case "$2|$4" in
  "/repos/hraness/textbutler|.default_branch") printf '%s\\n' "$STUB_DEFAULT_BRANCH" ;;
  "/repos/hraness/textbutler/git/ref/heads/main|.object.sha") printf '%s\\n' "$STUB_MAIN_SHA" ;;
  *) exit 91 ;;
esac
`, "utf8");
    await chmod(gh, 0o700);

    const baseline = Object.freeze({
      DEFAULT_BRANCH: "main",
      EVENT_NAME: "workflow_run",
      EVENT_REF: "refs/heads/main",
      EVENT_REPOSITORY: providerRepository,
      EVENT_SHA: workflowSha,
      EXPECTED_RELEASE_WORKFLOW_ID: "12345",
      GITHUB_RUN_ATTEMPT_EXACT: "1",
      GH_TOKEN: "read-only-test-token",
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: providerRepository,
      INPUT_CONTROL_EPOCH_DIGEST: "",
      INPUT_RELEASE_TAG: "",
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_DEFAULT_BRANCH: "main",
      STUB_MAIN_SHA: workflowSha,
      UPSTREAM_CONCLUSION: "success",
      UPSTREAM_EVENT: "push",
      UPSTREAM_HEAD_BRANCH: "v0.8.0",
      UPSTREAM_HEAD_REPOSITORY: providerRepository,
      UPSTREAM_HEAD_SHA: releaseSha,
      UPSTREAM_PATH: ".github/workflows/release.yml",
      UPSTREAM_RUN_ATTEMPT: "2",
      UPSTREAM_RUN_ID: "67890",
      UPSTREAM_WORKFLOW_ID: "12345",
      UPSTREAM_WORKFLOW_NAME: "Release",
    });
    const runCase = async (
      overrides: Readonly<Record<string, string>>,
    ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
      await rm(output, { force: true });
      return runWorkflowScript(script, { ...baseline, ...overrides });
    };

    try {
      const workflowRun = await runCase({});
      expect(workflowRun.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `control_epoch_digest=\nrelease_run_attempt=2\nrelease_run_id=67890\nrequested_tag=v0.8.0\nupstream_sha=${releaseSha}\nworkflow_sha=${workflowSha}\n`,
      );

      const recovery = await runCase({
        EVENT_NAME: "workflow_dispatch",
        INPUT_RELEASE_TAG: "v0.8.0",
        UPSTREAM_CONCLUSION: "",
        UPSTREAM_EVENT: "",
        UPSTREAM_HEAD_BRANCH: "",
        UPSTREAM_HEAD_REPOSITORY: "",
        UPSTREAM_HEAD_SHA: "",
        UPSTREAM_PATH: "",
        UPSTREAM_RUN_ATTEMPT: "",
        UPSTREAM_RUN_ID: "",
        UPSTREAM_WORKFLOW_ID: "",
        UPSTREAM_WORKFLOW_NAME: "",
      });
      expect(recovery.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `control_epoch_digest=\nrelease_run_attempt=\nrelease_run_id=\nrequested_tag=v0.8.0\nupstream_sha=\nworkflow_sha=${workflowSha}\n`,
      );

      const controlDigest = "a".repeat(64);
      const control = await runCase({
        EVENT_NAME: "workflow_dispatch",
        INPUT_CONTROL_EPOCH_DIGEST: controlDigest,
        INPUT_RELEASE_TAG: "v0.8.0",
      });
      expect(control.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `control_epoch_digest=${controlDigest}\nrelease_run_attempt=\nrelease_run_id=\nrequested_tag=v0.8.0\nupstream_sha=\nworkflow_sha=${workflowSha}\n`,
      );
      for (const malformedDigest of [
        controlDigest.toUpperCase(),
        "a".repeat(63),
        `${controlDigest}\npoison`,
      ]) {
        const malformedControl = await runCase({
          EVENT_NAME: "workflow_dispatch",
          INPUT_CONTROL_EPOCH_DIGEST: malformedDigest,
          INPUT_RELEASE_TAG: "v0.8.0",
        });
        expect(malformedControl.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
      const automaticControl = await runCase({ INPUT_CONTROL_EPOCH_DIGEST: controlDigest });
      expect(automaticControl.exitCode).not.toBe(0);
      expect(await Bun.file(output).exists()).toBe(false);
      const retriedControl = await runCase({
        EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ATTEMPT_EXACT: "2",
        INPUT_CONTROL_EPOCH_DIGEST: controlDigest,
        INPUT_RELEASE_TAG: "v0.8.0",
      });
      expect(retriedControl.exitCode).not.toBe(0);
      expect(await Bun.file(output).exists()).toBe(false);

      for (const rejectedEnvironment of [
        { DEFAULT_BRANCH: "trunk" },
        { EVENT_REF: "refs/tags/v0.8.0" },
        { EVENT_REPOSITORY: "attacker/message-like-me" },
        { EVENT_SHA: "3".repeat(40) },
        { EXPECTED_RELEASE_WORKFLOW_ID: "" },
        { UPSTREAM_WORKFLOW_ID: "54321" },
        { UPSTREAM_WORKFLOW_NAME: "Release copy" },
        { UPSTREAM_PATH: ".github/workflows/copied-release.yml" },
        { UPSTREAM_EVENT: "workflow_dispatch" },
        { UPSTREAM_RUN_ATTEMPT: "0" },
        { UPSTREAM_RUN_ID: "0" },
        { UPSTREAM_CONCLUSION: "failure" },
        { UPSTREAM_HEAD_REPOSITORY: "attacker/message-like-me" },
        { UPSTREAM_HEAD_SHA: "not-a-commit" },
        { UPSTREAM_HEAD_BRANCH: "main" },
        { STUB_DEFAULT_BRANCH: "trunk" },
        { STUB_MAIN_SHA: "3".repeat(40) },
      ] as const) {
        const rejected = await runCase(rejectedEnvironment);
        expect(rejected.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("selects exactly one bounded ASCII promotion receipt", async () => {
    const workflow = await readFile(productionWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Bind exactly one promotion path");
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-promotion-select-"));
    const output = join(directory, "github-output.txt");
    const runCase = async (
      overrides: Readonly<Record<string, string>>,
    ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
      await rm(output, { force: true });
      return runWorkflowScript(script, {
        ADVANCE_REQUIRED: "true",
        ADVANCE_RESULT: "success",
        ADVANCED_RECEIPT: "valid_receipt-1",
        EXISTING_RESULT: "skipped",
        EXISTING_RECEIPT: "",
        GITHUB_OUTPUT: output,
        ...overrides,
      });
    };

    try {
      const advanced = await runCase({});
      expect(advanced.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe("receipt=valid_receipt-1\n");

      const maximum = "A".repeat(65_536);
      const exactBound = await runCase({ ADVANCED_RECEIPT: maximum });
      expect(exactBound.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(`receipt=${maximum}\n`);

      const existing = await runCase({
        ADVANCE_REQUIRED: "false",
        ADVANCE_RESULT: "skipped",
        ADVANCED_RECEIPT: "",
        EXISTING_RESULT: "success",
        EXISTING_RECEIPT: "existing_receipt-1",
      });
      expect(existing.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe("receipt=existing_receipt-1\n");

      for (const rejectedEnvironment of [
        { ADVANCED_RECEIPT: "" },
        { ADVANCED_RECEIPT: "A".repeat(65_537) },
        { ADVANCED_RECEIPT: "not/base64url" },
        { EXISTING_RECEIPT: "unexpected" },
        { ADVANCE_RESULT: "failure" },
        { ADVANCE_REQUIRED: "unknown" },
      ] as const) {
        const rejected = await runCase(rejectedEnvironment);
        expect(rejected.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("separates exact npm and GitHub publication from the privileged site writer", async () => {
    const [releaseWorkflow, productionWorkflow] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(productionWorkflowUrl, "utf8"),
    ]);

    expect(releaseWorkflow).toContain('tags:\n      - "v*"');
    expect(releaseWorkflow).not.toContain("workflow_dispatch:");
    expect(releaseWorkflow).not.toContain("create-github-app-token");
    expect(releaseWorkflow).not.toContain("production-ref-writer-key");
    expect(releaseWorkflow).not.toContain("release-provider-outcome.mjs promote");
    const job = (workflow: string, name: string): string => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      if (start < 0) throw new Error(`Workflow job not found: ${name}`);
      const nextJob = /\n  [a-z][a-z_]*:\n/gu;
      nextJob.lastIndex = start + `\n  ${name}:\n`.length;
      const next = nextJob.exec(workflow)?.index ?? -1;
      return workflow.slice(start, next < 0 ? undefined : next);
    };
    const githubWriter = job(releaseWorkflow, "publish_github");
    const npmPreflight = job(releaseWorkflow, "pre_npm");
    const npmWriter = job(releaseWorkflow, "publish_npm");
    const finalAdmission = job(releaseWorkflow, "admit");
    expect(releaseWorkflow.indexOf("\n  publish_github:\n"))
      .toBeLessThan(releaseWorkflow.indexOf("\n  pre_npm:\n"));
    expect(releaseWorkflow.indexOf("\n  pre_npm:\n"))
      .toBeLessThan(releaseWorkflow.indexOf("\n  publish_npm:\n"));
    expect(releaseWorkflow.indexOf("\n  publish_npm:\n"))
      .toBeLessThan(releaseWorkflow.indexOf("\n  admit:\n"));
    expect(githubWriter).toContain("contents: write");
    expect(githubWriter).not.toContain("id-token: write");
    expect(githubWriter).not.toContain("bun install");
    expect(githubWriter).toContain("publish-github-release.ts");
    expect(npmPreflight).toContain("Prove immutable Latest GitHub Release exact-byte parity");
    expect(npmPreflight).toContain("check-npm-retry-state.ts");
    expect(npmWriter).toContain("contents: none");
    expect(npmWriter).toContain("id-token: write");
    expect(npmWriter).not.toContain("actions/checkout@");
    expect(npmWriter).not.toContain("bun install");
    expect(npmWriter).toContain("artifact-ids: ${{ needs.verify.outputs.writer_artifact_id }}");
    expect(npmWriter).toContain("publish-npm-release.ts artifacts/*.tgz");
    expect(finalAdmission).toContain("contents: read");
    expect(finalAdmission).not.toContain("contents: write");
    expect(finalAdmission).not.toContain("id-token: write");
    expect(finalAdmission).toContain("check-public-release.ts");

    expect(productionWorkflow).toContain("workflow_run:");
    expect(productionWorkflow).toContain("workflow_dispatch:");
    expect(productionWorkflow).toContain("environment: { name: production-ref-writer-key, deployment: false }");
    expect(productionWorkflow).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(productionWorkflow).toContain("check-public-release.ts");
    expect(productionWorkflow).toContain("release-provider-outcome.mjs promote");
    expect(productionWorkflow).not.toContain("--method POST");
    expect(productionWorkflow).not.toContain('"/repos/$GITHUB_REPOSITORY/releases"');

    const appPreflight = job(productionWorkflow, "advance_production_ref_preflight");
    const appWriter = job(productionWorkflow, "write_production_ref");
    const appPostflight = job(productionWorkflow, "advance_production_ref");
    expect(appPreflight).toContain("check-public-release.ts");
    expect(appPreflight).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(appPreflight).toContain("release-workflow-range.mjs");
    expect(appPreflight).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY");
    expect(appWriter).toContain("environment: { name: production-ref-writer-key, deployment: false }");
    expect(appWriter).toContain("Pin the complete production authority TCB to reviewed hashes");
    expect(appWriter).toMatch(/APP_TOKEN_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toMatch(/PROVIDER_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toMatch(/REF_AUTHORITY_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toMatch(/REF_WRITER_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toMatch(/STATUS_ATTESTER_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toMatch(/WORKFLOW_RANGE_SHA256: [0-9a-f]{64}/u);
    expect(appWriter).toContain("Re-prove the complete workflow-control range before reading the key");
    expect(appWriter).toContain("WORKFLOW_RANGE_RECEIPT:");
    expect(appWriter).not.toContain("setup-bun");
    expect(appWriter).not.toContain("bun install");
    expect(appWriter).toContain("MLM_RELEASE_APP_PRIVATE_KEY:");
    expect(appWriter).toContain("MLM_RELEASE_REF_TOKEN:");
    expect(appPostflight).toContain("check-public-release.ts");
    expect(appPostflight).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(appPostflight).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY");
  });

  test("uses workflow dispatch only to recover an existing immutable release", async () => {
    const workflow = await readFile(productionWorkflowUrl, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("release_tag:");
    expect(workflow).toContain('case "$EVENT_NAME" in');
    expect(workflow).toContain("workflow_run)");
    expect(workflow).toContain("workflow_dispatch)");
    expect(workflow).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(workflow).not.toContain("release-provider-outcome.mjs release-order");
    expect(workflow).not.toContain("inspect-release-response");
    expect(workflow).not.toContain("generate_release_notes");
    expect(workflow).not.toContain("make_latest");
  });

  test("keeps provider verification read-only, terminal, and release-authoritative", async () => {
    const [workflow, helper] = await Promise.all([
      readFile(productionWorkflowUrl, "utf8"),
      readFile(providerOutcomeHelperUrl, "utf8"),
    ]);
    const job = (name: string): string => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      if (start < 0) throw new Error(`Workflow job not found: ${name}`);
      const nextJob = /\n  [a-z][a-z_]*:\n/gu;
      nextJob.lastIndex = start + `\n  ${name}:\n`.length;
      const next = nextJob.exec(workflow)?.index ?? -1;
      return workflow.slice(start, next < 0 ? undefined : next);
    };
    const baselineJob = job("provider_baseline");
    const preflightJob = job("advance_production_ref_preflight");
    const writerJob = job("write_production_ref");
    const postflightJob = job("advance_production_ref");
    const existingJob = job("confirm_existing_production_ref");
    const selectJob = job("select_promotion");
    const postPromotionJob = job("post_promotion_admission");
    const providerJob = job("provider_outcome");
    const finalPublicJob = job("final_public_admission");
    const permissions = (jobText: string): readonly string[] => {
      const match = /\n    permissions:\n((?:      [a-z-]+: (?:read|write)\n)+)/u.exec(jobText);
      if (match?.[1] === undefined) throw new Error("Workflow job has no exact permission block");
      return match[1].trim().split("\n").map((line) => line.trim()).sort();
    };

    for (const exactNodeJob of [
      baselineJob,
      preflightJob,
      postflightJob,
      existingJob,
      providerJob,
    ]) {
      expect(exactNodeJob).toContain(
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      );
      expect(exactNodeJob).toContain("node-version: \"24.19.0\"");
      expect(exactNodeJob).not.toContain("package-manager-cache:");
    }

    expect(workflow.indexOf("\n  provider_baseline:\n"))
      .toBeLessThan(workflow.indexOf("\n  advance_production_ref_preflight:\n"));
    expect(workflow.indexOf("\n  advance_production_ref_preflight:\n"))
      .toBeLessThan(workflow.indexOf("\n  write_production_ref:\n"));
    expect(workflow.indexOf("\n  write_production_ref:\n"))
      .toBeLessThan(workflow.indexOf("\n  advance_production_ref:\n"));
    expect(workflow.indexOf("\n  advance_production_ref:\n"))
      .toBeLessThan(workflow.indexOf("\n  select_promotion:\n"));
    expect(workflow.indexOf("\n  confirm_existing_production_ref:\n"))
      .toBeLessThan(workflow.indexOf("\n  select_promotion:\n"));
    expect(workflow.indexOf("\n  select_promotion:\n"))
      .toBeLessThan(workflow.indexOf("\n  provider_outcome:\n"));
    expect(baselineJob).toContain("- verify");
    expect(baselineJob).toContain("- public_admission");
    expect(permissions(baselineJob)).toEqual(["contents: read", "deployments: read"]);
    expect(baselineJob).not.toContain("contents: write");
    expect(baselineJob).toContain("release-provider-outcome.mjs baseline");
    expect(baselineJob).toContain("advance_required:");
    expect(baselineJob).toContain("ref_sha:");
    expect(preflightJob).toContain("- provider_baseline");
    expect(permissions(preflightJob)).toEqual(["contents: read"]);
    expect(preflightJob).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(preflightJob).toContain("release-workflow-range.mjs");
    expect(preflightJob).toContain("check-public-release.ts");
    expect(preflightJob).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY:");
    expect(permissions(writerJob)).toEqual(["contents: write", "statuses: read"]);
    expect(writerJob).toContain("PROMOTION_EXPECTED_MODE: advanced");
    expect(writerJob).toContain("MLM_RELEASE_APP_PRIVATE_KEY:");
    expect(writerJob).toContain("MLM_RELEASE_REF_TOKEN:");
    expect(writerJob).toContain("release-ref-authority.ts promotion");
    expect(writerJob).toContain("release-workflow-range.mjs");
    expect(writerJob).toContain("WORKFLOW_RANGE_RECEIPT:");
    expect(writerJob).toContain("release-provider-outcome.mjs promote");
    expect(writerJob).not.toContain("setup-bun");
    expect(writerJob).not.toContain("bun install");
    expect(writerJob).not.toContain("release-provider-outcome.mjs wait");
    expect(writerJob).toContain("STATUS_ATTESTER_SHA256:");
    expect(postflightJob).toContain("- write_production_ref");
    expect(permissions(postflightJob)).toEqual(["contents: read", "statuses: read"]);
    expect(postflightJob).toContain("release-provider-outcome.mjs revalidate-authority");
    expect(postflightJob).toContain("check-public-release.ts");
    expect(postflightJob).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY:");
    expect(existingJob).toContain("PROMOTION_EXPECTED_MODE: already-exact");
    expect(existingJob).not.toContain("environment:");
    expect(existingJob).not.toContain("MLM_RELEASE_APP_");
    expect(existingJob).toContain("release-provider-outcome.mjs promote");
    expect(selectJob).toContain("Bind exactly one promotion path");
    expect(selectJob).toContain("ADVANCE_RESULT");
    expect(selectJob).toContain("EXISTING_RESULT");
    expect(postPromotionJob).toContain(
      "${{ always() &&\n          !cancelled() &&\n          needs.verify.result == 'success' &&\n          needs.select_promotion.result == 'success' }}",
    );
    expect(providerJob).toContain("- select_promotion");
    expect(providerJob).toContain(
      "${{ always() &&\n          !cancelled() &&\n          needs.verify.result == 'success' &&\n          needs.provider_baseline.result == 'success' &&\n          needs.select_promotion.result == 'success' &&\n          needs.post_promotion_admission.result == 'success' }}",
    );
    expect(providerJob).toContain("timeout-minutes: 40");
    expect(permissions(providerJob)).toEqual(["contents: read", "deployments: read"]);
    expect(providerJob).not.toContain("contents: write");
    expect(providerJob).not.toContain("continue-on-error");
    expect(providerJob).toContain("release-provider-outcome.mjs wait");
    expect(providerJob).toContain("needs.select_promotion.outputs.receipt");
    expect(providerJob).toContain("VERIFIED_SHA: ${{ needs.verify.outputs.verified_sha }}");
    expect(providerJob).toContain("VERIFIED_TAG: ${{ needs.verify.outputs.verified_tag }}");
    expect(providerJob).toContain("DEFAULT_BRANCH: main");
    expect(providerJob).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(providerJob).toContain(
      "RECOVERY_WORKFLOW_SHA: ${{ needs.verify.outputs.workflow_sha }}",
    );
    expect(finalPublicJob).toContain("if: ${{ always() && !cancelled() && (github.event_name != 'workflow_dispatch' || inputs.site_sha == '') }}");
    expect(finalPublicJob).not.toContain("continue-on-error");
    expect(finalPublicJob.indexOf("Bind the complete terminal admission chain"))
      .toBeLessThan(finalPublicJob.indexOf("actions/checkout@"));
    const terminalAdmissionScript = workflowStepScript(
      workflow,
      "Bind the complete terminal admission chain",
    );
    for (const verifyResult of ["success", "skipped", "failure", "cancelled", ""] as const) {
      for (const providerResult of ["success", "skipped", "failure", "cancelled", ""] as const) {
        const result = await runWorkflowScript(terminalAdmissionScript, {
          PROVIDER_OUTCOME_RESULT: providerResult,
          VERIFY_RESULT: verifyResult,
        });
        expect(result.exitCode).toBe(verifyResult === "success" && providerResult === "success" ? 0 : 1);
      }
    }
    expect(helper).toContain("defaultBranch: process.env.DEFAULT_BRANCH");
    expect(helper).toContain("eventName: process.env.EVENT_NAME");
    expect(helper).toContain("recoveryWorkflowSha: process.env.RECOVERY_WORKFLOW_SHA");
    expect(workflow.match(
      /ref: \$\{\{ needs\.verify\.outputs\.workflow_sha \}\}/gu,
    )).toHaveLength(9);
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("projectSettings");
    expect(workflow).not.toContain("redeploy");
    expect(helper).not.toContain("--jq");
    expect(helper).not.toContain("@tsv");
    expect(helper).toContain("MAX_ITEMS = 500");
    expect(helper).toContain("MAX_GRAPHQL_DEPLOYMENT_PAGES = 5");
    expect(helper).toContain("MAX_GRAPHQL_COST_PER_REQUEST = 2");
    expect(helper).toContain("rateLimit { cost remaining resetAt }");
    expect(helper).toContain("totalCount");
    expect(helper).toContain("MAX_PROVIDER_POLLS = 15");
    expect(helper).toContain("PROVIDER_POLL_INTERVAL_MILLISECONDS = 60_000");
    expect(helper).not.toContain("Date.now");
    expect(helper).toContain('this.#runRaw([\n      "--include",');
    expect(helper).toContain('spawnSync("/usr/bin/gh"');
    expect(workflow).not.toContain("release-provider-outcome.mjs release-order");
    expect(workflow).not.toContain("gh api --paginate");
    expect(helper).toContain('mode = "already-exact"');
    expect(helper).toContain('mode = "advanced"');
    expect(helper).toContain("35613825");
    expect(helper).toContain("await advanceRef(coordinate, prePatchRef.sha, sha, tag)");
    expect(helper).toContain("proveProductionRequiredStatusDenial");
    expect(helper).not.toContain("authorizeWithRevocation");
    expect(helper).not.toContain("writerApi.advanceRef");
    expect(helper).toContain("/git/ref/heads/website-production");
    expect(helper).not.toContain("/git/refs/heads/website-production");
    expect(helper).not.toContain("matching-refs");
    expect(helper).not.toContain("api.post");
    expect(helper).not.toContain('["--method", "POST"');
    expect(releaseRestRequestBudget).toEqual({
      githubTokenLimit: 1_000,
      headroom: 789,
      maxPolls: 15,
      pollIntervalMilliseconds: 60_000,
      providerBaseline: 2,
      providerOutcome: 164,
      providerPromotion: 30,
      surroundingRelease: 15,
      total: 211,
    });
    expect(releaseGraphqlRequestBudget).toEqual({
      githubPointLimit: 1_000,
      headroom: 810,
      maxCostPerRequest: 2,
      maxPoints: 190,
      providerBaseline: 10,
      providerOutcome: 85,
      totalRequests: 95,
    });
    expect(releaseRestRequestBudget.total).toBeLessThan(250);
    expect(releaseGraphqlRequestBudget.maxPoints).toBeLessThan(200);
  });

  test("parses one authenticated GitHub server Date response", () => {
    const body = JSON.stringify(providerRef(providerPreviousSha));
    expect(parseIncludedGitHubResponse(
      `HTTP/2.0 200 OK\r\ndate: Sat, 29 Aug 2026 15:01:00 GMT\r\ncontent-type: application/json\r\n\r\n${body}\n`,
    )).toEqual({
      body: providerRef(providerPreviousSha),
      serverDate: providerPromotionServerDate,
    });

    for (const response of [
      `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${body}`,
      `HTTP/2.0 200 OK\ndate: Sat, 29 Aug 2026 15:01:00 GMT\ndate: Sat, 29 Aug 2026 15:01:01 GMT\n\n${body}`,
      `HTTP/2.0 404 Not Found\ndate: Sat, 29 Aug 2026 15:01:00 GMT\n\n${body}`,
      `HTTP/2.0 200 OK\ndate: Fri, 29 Aug 2026 15:01:00 GMT\n\n${body}`,
      "HTTP/2.0 200 OK\ndate: Sat, 29 Aug 2026 15:01:00 GMT\n\nnot-json",
      body,
    ] as const) {
      expect(() => parseIncludedGitHubResponse(response)).toThrow();
    }

    const oversizedBody = `"${"x".repeat(8 * 1024 * 1024)}"`;
    expect(() => parseIncludedGitHubResponse(
      `HTTP/2.0 200 OK\r\ndate: Sat, 29 Aug 2026 15:01:00 GMT\r\n\r\n${oversizedBody}`,
    )).toThrow("exceeds the bounded response size");

    const canonicalReceipt = encodeProviderReceipt({ a: 1 });
    expect(decodeProviderReceipt(canonicalReceipt)).toEqual({ a: 1 });
    expect(() => decodeProviderReceipt(
      Buffer.from('{ "a": 1 }', "utf8").toString("base64url"),
    )).toThrow("does not contain canonical JSON");
    expect(() => decodeProviderReceipt("A".repeat(64 * 1024 + 1)))
      .toThrow("is not bounded canonical base64url");
  });

  test("bounds the published stable-release ordering scan", async () => {
    const publishedRelease = (
      id: number,
      tagName: string,
      overrides: Readonly<Record<string, ProviderJson>> = {},
    ): ProviderJson => ({
      draft: false,
      id,
      prerelease: false,
      tag_name: tagName,
      ...overrides,
    });
    const releaseApi = (releases: readonly ProviderJson[]) => {
      const calls: string[] = [];
      return {
        calls,
        async get(endpoint: string): Promise<ProviderJson> {
          calls.push(endpoint);
          const match = new RegExp(
            `^/repos/${providerRepository}/releases\\?per_page=100&page=([1-6])$`,
            "u",
          ).exec(endpoint);
          if (match === null) throw new Error(`Unexpected release GET ${endpoint}`);
          const page = Number(match[1]);
          return releases.slice((page - 1) * 100, page * 100);
        },
      };
    };

    const accepted = releaseApi([
      publishedRelease(1, "v0.7.9"),
      publishedRelease(2, "v9.0.0", { draft: true }),
      publishedRelease(3, "v9.0.0", { prerelease: true }),
      publishedRelease(4, "nightly"),
    ]);
    await expect(assertReleaseTagNewerThanPublished({
      api: accepted,
      repository: providerRepository,
      verifiedTag: providerTag,
    })).resolves.toBeUndefined();
    expect(accepted.calls).toHaveLength(6);

    for (const current of ["v0.8.0", "v0.9.0"] as const) {
      await expect(assertReleaseTagNewerThanPublished({
        api: releaseApi([publishedRelease(1, current)]),
        repository: providerRepository,
        verifiedTag: providerTag,
      })).rejects.toThrow(`is not newer than ${current}`);
    }

    const overCap = Array.from(
      { length: 501 },
      (_, index) => publishedRelease(index + 1, "nightly"),
    );
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi(overCap),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("exceed the 500-item audit cap");
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([null]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("is not an object");
  });

  test("exhausts bounded deployment and status pages without trusting API order", async () => {
    const at = (index: number): string =>
      new Date(Date.parse("2026-08-29T13:59:59Z") - index * 1_000)
        .toISOString()
        .replace(".000Z", "Z");
    for (const count of [0, 100, 101, 500] as const) {
      const deployments = Array.from(
        { length: count },
        (_, index) => providerDeployment(10_000 - index, at(index)),
      );
      if (count === 101) {
        deployments[99] = providerDeployment(1, "2026-08-29T12:00:00Z");
        deployments[100] = providerDeployment(20_000, "2026-08-29T12:00:00Z");
      }
      const api = new ProviderApiFixture({ deployments: [deployments] });
      const parsed = await collectProductionDeployments(api, providerRepository);
      expect(parsed).toHaveLength(count);
      expect(api.graphqlCalls).toHaveLength(Math.max(1, Math.ceil(count / 100)));
      if (count === 101) expect(parsed.findIndex((item: { id: number }) => item.id === 20_000))
        .toBeLessThan(parsed.findIndex((item: { id: number }) => item.id === 1));
    }

    const overCap = Array.from(
      { length: 501 },
      (_, index) => providerDeployment(20_000 - index, at(index)),
    );
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [overCap] }),
        providerRepository,
      ),
    ).rejects.toThrow("exceed the 500-item GraphQL audit cap");

    const duplicate = [
      providerDeployment(20, "2026-08-29T13:00:00Z"),
      providerDeployment(20, "2026-08-29T12:00:00Z"),
    ];
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [duplicate] }),
        providerRepository,
      ),
    ).rejects.toThrow("duplicate id");
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [[null]] }),
        providerRepository,
      ),
    ).rejects.toThrow("is not an object");
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({
          deployments: [[providerDeployment(21, "2026-08-29T13:00:00Z", { sha: null })]],
        }),
        providerRepository,
      ),
    ).rejects.toThrow("is not a string");

    for (const count of [0, 100, 101, 500] as const) {
      const statuses = Array.from(
        { length: count },
        (_, index) => providerStatus(30_000 - index, "pending", at(index)),
      );
      if (count === 101) {
        statuses[99] = providerStatus(2, "pending", "2026-08-29T12:00:00Z");
        statuses[100] = providerStatus(40_000, "pending", "2026-08-29T12:00:00Z");
      }
      const api = new ProviderApiFixture({ statuses: new Map([[10, [statuses]]]) });
      const parsed = await collectDeploymentStatuses(api, providerRepository, 10);
      expect(parsed).toHaveLength(count);
      expect(api.calls.filter((call) => call.includes("/statuses?"))).toHaveLength(6);
      if (count === 101) expect(parsed.findIndex((item: { id: number }) => item.id === 40_000))
        .toBeLessThan(parsed.findIndex((item: { id: number }) => item.id === 2));
    }

    const statusOverCap = Array.from(
      { length: 501 },
      (_, index) => providerStatus(50_000 - index, "pending", at(index)),
    );
    await expect(
      collectDeploymentStatuses(
        new ProviderApiFixture({ statuses: new Map([[10, [statusOverCap]]]) }),
        providerRepository,
        10,
      ),
    ).rejects.toThrow("exceeds the 500-item audit cap");

    await expect(collectDeploymentStatuses(
      new ProviderApiFixture({
        statuses: new Map([[10, [[
          providerStatus(9, "pending", "2026-08-29T13:00:00Z"),
          providerStatus(9, "success", "2026-08-29T12:00:00Z"),
        ]]]]),
      }),
      providerRepository,
      10,
    )).rejects.toThrow("duplicate id");
    await expect(collectDeploymentStatuses(
      new ProviderApiFixture({ statuses: new Map([[10, [[null]]]]) }),
      providerRepository,
      10,
    )).rejects.toThrow("is not an object");

    const oneGraphNode = providerGraphqlDeployment(80_000, "2026-08-29T12:00:00Z");
    for (const response of [
      providerGraphqlResponse([oneGraphNode], { endCursor: null, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { totalCount: 2 }),
      providerGraphqlResponse([], { endCursor: "cursor-1", hasNextPage: true, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { cost: 3, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { remaining: -1, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { totalCount: 501 }),
    ] as const) {
      await expect(collectProductionDeployments(
        new ProviderApiFixture({ graphqlResponses: [response] }),
        providerRepository,
      )).rejects.toThrow();
    }
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [providerGraphqlResponse([oneGraphNode], {
          endCursor: "opaque+/=cursor",
          hasNextPage: true,
          remaining: 8,
          totalCount: 2,
        }), providerGraphqlResponse([
          providerGraphqlDeployment(80_001, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "done+/=cursor",
          remaining: 7,
          totalCount: 3,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("totalCount changed");

    const graphPageOne = providerGraphqlResponse(
      [providerGraphqlDeployment(80_010, "2026-08-29T12:00:00Z")],
      {
        endCursor: "cursor-repeat",
        hasNextPage: true,
        remaining: 10,
        totalCount: 2,
      },
    );
    const graphPageTwo = providerGraphqlResponse(
      [providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z")],
      {
        endCursor: "cursor-repeat",
        hasNextPage: true,
        remaining: 9,
        totalCount: 2,
      },
    );
    await expect(collectProductionDeployments(
      new ProviderApiFixture({ graphqlResponses: [graphPageOne, graphPageTwo] }),
      providerRepository,
    )).rejects.toThrow("cursor repeated");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [graphPageOne, providerGraphqlResponse([
          providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "cursor-finished",
          remaining: 9,
          resetAt: "2026-08-29T17:00:00Z",
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("crossed a GraphQL rate-limit reset");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [graphPageOne, providerGraphqlResponse([
          providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "cursor-finished",
          remaining: 10,
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("remaining points did not decrease monotonically");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [providerGraphqlResponse([
          providerGraphqlDeployment(80_012, "2026-08-29T12:00:02Z"),
        ], {
          endCursor: "cursor-1",
          hasNextPage: true,
          remaining: 7,
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("insufficient GraphQL points");
    await expect(collectProductionDeployments({
      async graphql(): Promise<ProviderJson> {
        throw new Error("simulated provider API failure");
      },
    }, providerRepository)).rejects.toThrow("simulated provider API failure");
  });

  test("stabilizes the baseline and admits already-exact recovery", async () => {
    const baselineDeployment = providerDeployment(
      10,
      "2026-08-29T13:00:00Z",
      { sha: providerPreviousSha },
    );
    const baselineApi = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    const baseline = await createProviderBaseline({
      api: baselineApi,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as Readonly<Record<string, unknown>>;
    expect(baseline.schema).toBe("message-like-me-provider-baseline-v1");
    expect(baseline.refSha).toBe(providerPreviousSha);
    expect(baseline.deploymentIds).toEqual([10]);
    expect(baseline.deploymentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(baselineApi.calls).toHaveLength(2);
    expect(baselineApi.graphqlCalls).toHaveLength(2);
    expect(baselineApi.includedCalls).toEqual([
      `/repos/${providerRepository}/git/ref/heads/website-production`,
      `/repos/${providerRepository}/git/ref/heads/website-production`,
    ]);

    for (const refValue of [
      null,
      { object: { sha: providerPreviousSha, type: "commit" }, ref: "refs/heads/other" },
      { object: { sha: providerPreviousSha, type: "tag" }, ref: "refs/heads/website-production" },
      { object: { sha: "A".repeat(40), type: "commit" }, ref: "refs/heads/website-production" },
    ] as const) {
      await expect(createProviderBaseline({
        api: new ProviderApiFixture({ refValues: [refValue] }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      })).rejects.toThrow();
    }

    const advanced = await providerReceipts("advanced");
    expect((advanced.promotion as Readonly<Record<string, unknown>>).mode).toBe("advanced");
    expect(advanced.promotionCalls.filter((call) => call.startsWith("GIT PUSH "))).toEqual([
      `GIT PUSH ${providerRepository} ${providerPreviousSha} ${providerVerifiedSha} ${providerTag}`,
    ]);
    expect(advanced.promotionCalls.some((call) => call.includes("/deployments"))).toBe(false);
    const recovered = await providerReceipts("already-exact");
    expect((recovered.promotion as Readonly<Record<string, unknown>>).mode).toBe("already-exact");
    expect(recovered.promotionCalls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);
    const externalBootstrapRecovery = await promoteWebsiteProductionRaw({
      api: new ProviderApiFixture({
        refSha: providerVerifiedSha,
        serverDates: [providerPromotionServerDate],
      }),
      baselineReceipt: recovered.baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    });
    expect(externalBootstrapRecovery).toMatchObject({ mode: "already-exact" });

    const concurrent = providerDeployment(11, "2026-08-29T15:01:00Z");
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[concurrent]],
        statuses: terminalBaselineStatus(11, "2026-08-29T15:01:01Z"),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("overlaps the baseline lower bound");

    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[baselineDeployment], [providerDeployment(11, "2026-08-29T14:59:00Z"), baselineDeployment]],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("inventory changed during the baseline");

    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[
          baselineDeployment,
        ], [
          providerDeployment(10, "2026-08-29T13:00:00Z"),
        ]],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("inventory changed during the baseline");

    const relevantBaselineDeployment = providerDeployment(10, "2026-08-29T13:00:00Z");
    const baselineGraph = providerGraphqlDeployment(10, "2026-08-29T13:00:00Z");
    for (const malformedGraph of [
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: null,
        state: "ACTIVE",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          state: "PENDING",
        },
        state: "PENDING",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          state: "FAILURE",
        },
        state: "ACTIVE",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        creator: { __typename: "Bot", databaseId: 35613825, login: "vercel[bot]" },
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          environmentUrl: "https://other-10-hraness.vercel.app",
          logUrl: "https://other-10-hraness.vercel.app",
        },
      }),
    ] as const) {
      await expect(createProviderBaseline({
        api: new ProviderApiFixture({ graphqlDeployments: [[malformedGraph]] }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      })).rejects.toThrow();
    }
    const duplicateGraphStatus = providerGraphqlDeployment(11, "2026-08-29T12:59:00Z", {
      latestStatus: (baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus,
      updatedAt: "2026-08-29T13:00:00Z",
    });
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        graphqlDeployments: [[baselineGraph, duplicateGraphStatus]],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("duplicate latest status id");
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[relevantBaselineDeployment]],
        serverDates: [providerBaselineServerDate, "2026-08-29T14:59:59.000Z"],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("GitHub server Date regressed");

    const auditedDeployments = Array.from(
      { length: 500 },
      (_, index) => providerDeployment(
        1_000 + index,
        new Date(Date.parse("2026-08-28T13:00:00Z") + index * 1_000)
          .toISOString()
          .replace(".000Z", "Z"),
        { sha: index % 2 === 0 ? providerVerifiedSha : providerPreviousSha },
      ),
    );
    const maxBaselineApi = new ProviderApiFixture({
      deployments: [auditedDeployments],
      serverDates: [providerBaselineServerDate, providerBaselineServerDate],
    });
    const maxBaseline = await createProviderBaseline({
      api: maxBaselineApi,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as ProviderJson;
    expect((maxBaseline as Readonly<{ deploymentIds: readonly unknown[] }>).deploymentIds)
      .toHaveLength(500);
    const encodedMaxBaseline = encodeProviderReceipt(maxBaseline);
    expect(Buffer.byteLength(encodedMaxBaseline, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(maxBaselineApi.calls).toHaveLength(releaseRestRequestBudget.providerBaseline);
    expect(maxBaselineApi.graphqlCalls).toHaveLength(releaseGraphqlRequestBudget.providerBaseline);
    const maxPromotionApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: Array.from({ length: 6 }, () => providerCurrentMainSha),
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
    });
    const maxPromotion = await promoteWebsiteProduction({
      api: maxPromotionApi,
      baselineReceipt: maxBaseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerCurrentMainSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;
    expect(maxPromotion).toMatchObject({ mode: "advanced" });
    expect(maxPromotionApi.calls).toHaveLength(releaseRestRequestBudget.providerPromotion);

    const budgetBaseline = await createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [auditedDeployments.slice(0, 499)],
        serverDates: [providerBaselineServerDate, providerBaselineServerDate],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as ProviderJson;
    const budgetPromotion = await promoteWebsiteProduction({
      api: new ProviderApiFixture({
        refSha: providerPreviousSha,
        serverDates: [providerPromotionServerDate],
      }),
      baselineReceipt: budgetBaseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;

    const budgetCandidate = providerDeployment(20_000, "2026-08-29T15:02:00Z");
    const budgetPending = providerStatus(
      200_000,
      "pending",
      "2026-08-29T15:02:30Z",
      {},
      20_000,
    );
    const budgetSuccess = providerStatus(
      200_001,
      "success",
      "2026-08-29T15:03:00Z",
      {},
      20_000,
    );
    const candidateSnapshots = [
      ...Array.from({ length: releaseRestRequestBudget.maxPolls - 2 }, () => [budgetPending]),
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
    ];
    const budgetApi = new ProviderApiFixture({
      deployments: [[budgetCandidate, ...auditedDeployments.slice(0, 499)]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [20_000, candidateSnapshots],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: budgetApi,
      baselineReceipt: budgetBaseline,
      maxPolls: releaseRestRequestBudget.maxPolls,
      pollIntervalMilliseconds: 0,
      promotionReceipt: budgetPromotion,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20_000, statusId: 200_001 });
    expect(budgetApi.calls).toHaveLength(releaseRestRequestBudget.providerOutcome);
    expect(budgetApi.graphqlCalls).toHaveLength(releaseGraphqlRequestBudget.providerOutcome);

    const auditedBaseline = auditedDeployments.slice(0, 499);
    const lateCandidateInventory = [budgetCandidate, ...auditedBaseline];
    const lateCandidateApi = new ProviderApiFixture({
      deployments: [
        ...Array.from(
          { length: releaseRestRequestBudget.maxPolls - 1 },
          () => auditedBaseline,
        ),
        lateCandidateInventory,
        lateCandidateInventory,
        lateCandidateInventory,
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([[20_000, [
        [budgetSuccess],
        [budgetSuccess],
        [budgetSuccess],
      ]]]),
    });
    await expect(waitForProviderOutcome({
      api: lateCandidateApi,
      baselineReceipt: budgetBaseline,
      maxPolls: releaseRestRequestBudget.maxPolls,
      pollIntervalMilliseconds: 0,
      promotionReceipt: budgetPromotion,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20_000, statusId: 200_001 });
    expect(lateCandidateApi.graphqlCalls).toHaveLength(
      releaseGraphqlRequestBudget.providerOutcome,
    );
  });

  test("proves required-status-errored denial before the exact attested write", async () => {
    const baselineDeployment = providerDeployment(10, "2026-08-29T13:00:00Z", {
      sha: providerPreviousSha,
    });
    const baseline = await createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[baselineDeployment]],
        refSha: providerPreviousSha,
        serverDates: [providerBaselineServerDate],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    });
    const phases = providerAuthorityPhases(baseline);
    const denialApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: Array.from({ length: 8 }, () => providerVerifiedSha),
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(),
    });
    const denial = await proveProductionRequiredStatusDenial({
      api: denialApi,
      baselineReceipt: baseline,
      defaultBranch: "main",
      denyRef: async (coordinate, expectedOldSha, verifiedSha, verifiedTag) => {
        expect({ coordinate, expectedOldSha, verifiedSha, verifiedTag }).toEqual({
          coordinate: providerRepository,
          expectedOldSha: providerPreviousSha,
          verifiedSha: providerVerifiedSha,
          verifiedTag: providerTag,
        });
        return {
          classification: "required-status-errored" as const,
          diagnosticSha256: "d".repeat(64),
        };
      },
      eventName: "workflow_dispatch",
      preconditionReceipt: encodeProductionAuthorityPhaseReceipt(phases.precondition),
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: providerWorkflowRangeReceipt,
    });
    expect(denial).toMatchObject({
      previousSha: providerPreviousSha,
      schema: "message-like-me-production-required-status-denial-v3",
      verifiedSha: providerVerifiedSha,
    });

    const promotionApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: Array.from({ length: 8 }, () => providerVerifiedSha),
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(),
    });
    const promotion = await promoteWebsiteProductionRaw({
      advanceRef: new ProviderRefWriterFixture(promotionApi).advanceRef,
      api: promotionApi,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(phases.attestation),
      baselineReceipt: baseline,
      denialReceipt: denial,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: providerWorkflowRangeReceipt,
    }) as Readonly<Record<string, unknown>>;
    expect(promotion).toMatchObject({
      authority: {
        statusId: providerAttestationStatus.statusId,
        statusNodeId: providerAttestationStatus.statusNodeId,
      },
      mode: "advanced",
      verifiedSha: providerVerifiedSha,
    });
    const rulesIndex = promotionApi.calls.lastIndexOf("GET PRODUCTION RULES");
    const statusIndex = promotionApi.calls.lastIndexOf("GET PRODUCTION AUTHORITY STATUS");
    const pushIndex = promotionApi.calls.findIndex((call) => call.startsWith("GIT PUSH "));
    expect(rulesIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(rulesIndex);
    expect(pushIndex).toBeGreaterThan(statusIndex);

    const controlEpoch = providerProductionControlEpochReceipt();
    const controlDenialApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: Array.from({ length: 8 }, () => providerVerifiedSha),
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(),
    });
    const controlDenial = await proveProductionRequiredStatusDenial({
      api: controlDenialApi,
      baselineReceipt: baseline,
      defaultBranch: "main",
      denyRef: async () => ({
        classification: "required-status-errored" as const,
        diagnosticSha256: "e".repeat(64),
      }),
      eventName: "workflow_dispatch",
      preconditionReceipt: encodeProductionAuthorityPhaseReceipt(phases.precondition),
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: controlEpoch,
    });
    const controlPromotionApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: Array.from({ length: 8 }, () => providerVerifiedSha),
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProductionRaw({
      advanceRef: new ProviderRefWriterFixture(controlPromotionApi).advanceRef,
      api: controlPromotionApi,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(phases.attestation),
      baselineReceipt: baseline,
      denialReceipt: controlDenial,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: controlEpoch,
    })).resolves.toMatchObject({ mode: "advanced", verifiedSha: providerVerifiedSha });
    expect(controlPromotionApi.calls.filter((call) => call.startsWith("GIT PUSH "))).toEqual([
      `GIT PUSH ${providerRepository} ${providerPreviousSha} ${providerVerifiedSha} ${providerTag}`,
    ]);

    for (const rejectedReceipt of [
      providerProductionControlEpochReceipt({ workflowSha: "8".repeat(40) }),
      providerProductionControlEpochReceipt({ tag: "v9.9.9" }),
      providerProductionControlEpochReceipt({ digest: "0".repeat(64) }),
    ]) {
      let writerCalls = 0;
      await expect(promoteWebsiteProductionRaw({
        advanceRef: async () => {
          writerCalls += 1;
          throw new Error("control receipt rejection must precede the writer");
        },
        api: new ProviderApiFixture({
          deployments: [[baselineDeployment]],
          refSha: providerPreviousSha,
          statuses: terminalBaselineStatus(),
        }),
        attestationReceipt: encodeProductionAuthorityPhaseReceipt(phases.attestation),
        baselineReceipt: baseline,
        denialReceipt: controlDenial,
        defaultBranch: "main",
        eventName: "workflow_dispatch",
        recoveryWorkflowSha: providerVerifiedSha,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
        workflowRangeReceipt: rejectedReceipt,
      })).rejects.toThrow();
      expect(writerCalls).toBe(0);
    }
  });

  test("fails promotion closed on comparison, ref, and lease races", async () => {
    const { baseline, baselineDeployment } = await providerReceipts("advanced");
    const authority = providerAuthorityPhases(baseline);
    const rejectedRange = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProductionRaw({
      advanceRef: async () => {
        throw new Error("workflow-range rejection must precede token minting");
      },
      api: rejectedRange,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(authority.attestation),
      baselineReceipt: baseline,
      denialReceipt: authority.denial,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: {
        ...providerWorkflowRangeReceipt,
        previousSha: "9".repeat(40),
      },
    })).rejects.toThrow("does not bind the leased production transition");
    expect(rejectedRange.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const malformedDenial = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProductionRaw({
      advanceRef: new ProviderRefWriterFixture(malformedDenial).advanceRef,
      api: malformedDenial,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(authority.attestation),
      baselineReceipt: baseline,
      denialReceipt: { ...authority.denial, previousSha: "9".repeat(40) },
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: providerWorkflowRangeReceipt,
    })).rejects.toThrow("does not bind the required-status denial proof");
    expect(malformedDenial.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const legacyDenial = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProductionRaw({
      advanceRef: new ProviderRefWriterFixture(legacyDenial).advanceRef,
      api: legacyDenial,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(authority.attestation),
      baselineReceipt: baseline,
      denialReceipt: {
        ...authority.denial,
        schema: "message-like-me-production-required-status-denial-v2",
      },
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: providerWorkflowRangeReceipt,
    })).rejects.toThrow("production writer denial receipt has the wrong boundary");
    expect(legacyDenial.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const staleLatest = new ProviderApiFixture({
      latestSnapshots: [providerLatest({ tag_name: "v0.7.9" })],
      refSha: providerPreviousSha,
    });
    await expect(promoteWebsiteProduction({
      api: staleLatest,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("Latest Release is not v0.8.0");
    expect(staleLatest.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    for (const compare of [
      providerCompare({ ahead_by: 0 }),
      providerCompare({ ahead_by: 1.5 }),
      providerCompare({ behind_by: 1 }),
      providerCompare({ status: "diverged" }),
      providerCompare({ base_commit: { sha: "3".repeat(40) } }),
      providerCompare({ merge_base_commit: { sha: "3".repeat(40) } }),
      providerCompare({ commits: [] }),
      providerCompare({ commits: null }),
      providerCompare({ commits: [{ sha: "3".repeat(40) }] }),
      providerCompare({ commits: [{ sha: providerVerifiedSha }, { sha: "3".repeat(40) }] }),
      providerCompare({ commits: [{ sha: providerVerifiedSha }, {}] }),
      null,
    ] as const) {
      const api = new ProviderApiFixture({
        deployments: [[baselineDeployment]],
        statuses: terminalBaselineStatus(),
      });
      api.compare = compare;
      await expect(promoteWebsiteProduction({
        api,
        baselineReceipt: baseline,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
      })).rejects.toThrow();
      expect(api.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);
    }

    const refRace = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSnapshots: [providerPreviousSha, "3".repeat(40)],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: refRace,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("moved before promotion");
    expect(refRace.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const patchFailure = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    const patchFailureWriter = new ProviderRefWriterFixture(patchFailure);
    patchFailureWriter.advanceError = new Error("simulated stale lease");
    await expect(promoteWebsiteProductionRaw({
      advanceRef: patchFailureWriter.advanceRef,
      api: patchFailure,
      attestationReceipt: encodeProductionAuthorityPhaseReceipt(authority.attestation),
      baselineReceipt: baseline,
      denialReceipt: authority.denial,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
      workflowRangeReceipt: providerWorkflowRangeReceipt,
    })).rejects.toThrow("simulated stale lease");

    const movedBeforePatch = new ProviderApiFixture({
      defaultBranchShaSnapshots: ["3".repeat(40)],
      deployments: [[baselineDeployment]],
      reviewedCompare: providerReviewedMainCompare(providerVerifiedSha, "3".repeat(40), {
        status: "diverged",
      }),
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: movedBeforePatch,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: "3".repeat(40),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("is not a reviewed ancestor of current main");
    expect(movedBeforePatch.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const movedAfterPatch = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        providerVerifiedSha,
        providerVerifiedSha,
        providerVerifiedSha,
        providerVerifiedSha,
        "3".repeat(40),
      ],
      deployments: [[baselineDeployment]],
      reviewedCompare: providerReviewedMainCompare(providerVerifiedSha, "3".repeat(40), {
        status: "diverged",
      }),
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: movedAfterPatch,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("release recovery workflow source is not exact current main");
    expect(movedAfterPatch.calls.filter((call) => call.startsWith("GIT PUSH "))).toHaveLength(1);

    const alreadyExact = await providerReceipts("already-exact");
    const alreadyExactSourceDrift = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        providerVerifiedSha,
        providerVerifiedSha,
        providerVerifiedSha,
        "3".repeat(40),
      ],
      refSha: providerVerifiedSha,
      reviewedCompare: providerReviewedMainCompare(providerVerifiedSha, "3".repeat(40), {
        status: "diverged",
      }),
      serverDates: [providerPromotionServerDate],
    });
    await expect(promoteWebsiteProduction({
      api: alreadyExactSourceDrift,
      baselineReceipt: alreadyExact.baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("release recovery workflow source is not exact current main");
    const alreadyExactTerminalRefRead = alreadyExactSourceDrift.calls.lastIndexOf(
      `GET /repos/${providerRepository}/git/ref/heads/website-production`,
    );
    const alreadyExactSourceRead = alreadyExactSourceDrift.calls.lastIndexOf(
      `GET /repos/${providerRepository}`,
    );
    expect(alreadyExactTerminalRefRead).toBeGreaterThanOrEqual(0);
    expect(alreadyExactSourceRead).toBeGreaterThan(alreadyExactTerminalRefRead);
    expect(alreadyExactSourceDrift.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    const postPatchMismatch = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSnapshots: [providerPreviousSha, providerPreviousSha, providerPreviousSha],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: postPatchMismatch,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("after promotion");
    expect(postPatchMismatch.calls.filter((call) => call.startsWith("GIT PUSH "))).toHaveLength(1);

    const missingRef = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refValues: [null],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: missingRef,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("is not an object");
    expect(missingRef.calls.some((call) => call.startsWith("GIT PUSH "))).toBe(false);

    await expect(promoteWebsiteProduction({
      api: new ProviderApiFixture({
        deployments: [[baselineDeployment]],
        serverDates: [providerReleasePublishedAt.replace("Z", ".000Z")],
        statuses: terminalBaselineStatus(),
      }),
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("promotion boundary");

    const readToWriteRace = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      serverDates: ["2026-08-29T15:02:00.000Z"],
      statuses: terminalBaselineStatus(),
    });
    const racePromotion = await promoteWebsiteProduction({
      api: readToWriteRace,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;
    expect((racePromotion as Readonly<Record<string, ProviderJson>>).boundaryAt)
      .toBe("2026-08-29T15:02:00.000Z");
    const prePatchDeployment = providerDeployment(20, "2026-08-29T15:02:00Z");
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture({
        deployments: [[prePatchDeployment, baselineDeployment]],
        refSha: providerVerifiedSha,
        statuses: new Map([
          [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
          [20, [[providerStatus(201, "success", "2026-08-29T15:03:00Z", {}, 20)]]],
        ]),
      }),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: racePromotion,
      sleep: async () => {},
    })).rejects.toThrow("concurrent promotion gap");

  });

  test("waits from pending to one twice-confirmed exact Vercel Production success", async () => {
    const { baseline, baselineDeployment, promotion } = await providerReceipts("advanced");
    const candidate = providerDeployment(20, "2026-08-29T15:02:00Z");
    const candidateAt = "2026-08-29T15:02:00Z";
    const successAt = "2026-08-29T15:03:00Z";
    const pending = providerStatus(200, "pending", "2026-08-29T15:02:30Z", {}, 20);
    const success = providerStatus(201, "success", successAt, {}, 20);
    const api = new ProviderApiFixture({
      deployments: [
        [candidate, baselineDeployment],
        [candidate, baselineDeployment],
        [candidate, baselineDeployment],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [
          [providerStatus(100, "success", "2026-08-29T13:01:00Z")],
          [providerStatus(100, "success", "2026-08-29T13:01:00Z")],
        ]],
        [20, [[pending], [success, pending], [success, pending]]],
      ]),
    });
    const result = await waitForProviderOutcome({
      api,
      baselineReceipt: baseline,
      maxPolls: 4,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    });
    expect(result).toEqual({ deploymentId: 20, statusId: 201 });
    expect(api.graphqlCalls).toHaveLength(5);
    expect(api.calls.filter((call) => call.includes("/deployments/20/statuses?"))).toHaveLength(30);
    expect(api.calls.filter((call) => call === `GET /repos/${providerRepository}/deployments/20`))
      .toHaveLength(4);

    const baselineStatus = providerStatus(100, "success", "2026-08-29T13:01:00Z");
    const baselineGraph = graphqlDeploymentFromRest(baselineDeployment, [baselineStatus]);
    const pendingGraph = graphqlDeploymentFromRest(candidate, [pending]);
    const successGraph = graphqlDeploymentFromRest(candidate, [success, pending]);
    const graphLagApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [
        [pendingGraph, baselineGraph],
        [successGraph, baselineGraph],
        [successGraph, baselineGraph],
        [successGraph, baselineGraph],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[baselineStatus]]],
        [20, [
          [success, pending],
          [success, pending],
          [success, pending],
          [success, pending],
        ]],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: graphLagApi,
      baselineReceipt: baseline,
      maxPolls: 2,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20, statusId: 201 });
    expect(graphLagApi.graphqlCalls).toHaveLength(4);
    expect(graphLagApi.calls.filter(
      (call) => call === `GET /repos/${providerRepository}/releases/latest`,
    )).toHaveLength(4);

    const staleGraphApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [[successGraph, baselineGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[
        providerStatus(202, "pending", "2026-08-29T15:03:01Z", {}, 20),
        success,
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: staleGraphApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("timed out");

    const staleGraphFailureApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [[successGraph, baselineGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[
        providerStatus(202, "failure", "2026-08-29T15:03:01Z", {}, 20),
        success,
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: staleGraphFailureApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("ended in failure");

    const confirmationRegressionApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [
        [successGraph, baselineGraph],
        [pendingGraph, baselineGraph],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[success], [success]]]]),
    });
    await expect(waitForProviderOutcome({
      api: confirmationRegressionApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("regressed during success confirmation");

    for (const state of ["error", "failure", "inactive"] as const) {
      const failed = providerStatus(300, state, successAt, {}, 20);
      const graphFailureApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        graphqlDeployments: [[
          graphqlDeploymentFromRest(candidate, [failed]),
          baselineGraph,
        ]],
        refSha: providerVerifiedSha,
        statuses: new Map([[20, [[success]]]]),
      });
      await expect(waitForProviderOutcome({
        api: graphFailureApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow(`ended in ${state}`);
    }

    const successGraphRecord = successGraph as Readonly<Record<string, ProviderJson>>;
    const successGraphStatus = successGraphRecord.latestStatus as Readonly<
      Record<string, ProviderJson>
    >;
    for (const latestStatus of [
      { ...successGraphStatus, id: "different-status-node" },
      {
        ...successGraphStatus,
        createdAt: "2026-08-29T15:02:59Z",
        updatedAt: "2026-08-29T15:02:59Z",
      },
      {
        ...successGraphStatus,
        creator: { __typename: "Bot", databaseId: 1, login: "vercel" },
      },
      {
        ...successGraphStatus,
        environmentUrl: "https://messagelikeme-other-hraness.vercel.app",
        logUrl: "https://messagelikeme-other-hraness.vercel.app",
      },
    ] as const) {
      const disagreementApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        graphqlDeployments: [[
          providerGraphqlDeployment(20, candidateAt, {
            latestStatus,
            updatedAt: successAt,
          }),
          baselineGraph,
        ]],
        refSha: providerVerifiedSha,
        statuses: new Map([[20, [[success]]]]),
      });
      await expect(waitForProviderOutcome({
        api: disagreementApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow();
    }

    const recovery = await providerReceipts("already-exact");
    const recoveryApi = new ProviderApiFixture({
      deployments: [[recovery.baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[
          providerStatus(100, "success", "2026-08-29T14:06:00Z"),
        ]]],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: recoveryApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 10, statusId: 100 });
  });

  test("rejects provider identity, concurrency, timeout, and final-readback failures", async () => {
    const { baseline, baselineDeployment, promotion } = await providerReceipts("advanced");
    const candidateAt = "2026-08-29T15:02:00Z";
    const successAt = "2026-08-29T15:03:00Z";
    const candidateStatus = (
      id: number,
      state: string,
      createdAt: string,
      overrides: Readonly<Record<string, ProviderJson>> = {},
    ): ProviderJson => providerStatus(id, state, createdAt, overrides, 20);
    const waitCase = (
      candidate: ProviderJson,
      statusSnapshots: ProviderJson[][],
      deployments: ProviderJson[][] = [[candidate, baselineDeployment], [candidate, baselineDeployment]],
      refSnapshots: readonly string[] = [],
      tagSnapshots: readonly string[] = [],
      releaseSnapshots: readonly ProviderJson[] = [],
      latestSnapshots: readonly ProviderJson[] = [],
    ): ProviderApiFixture => new ProviderApiFixture({
      deployments,
      latestSnapshots,
      refSha: providerVerifiedSha,
      refSnapshots,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, statusSnapshots],
      ]),
      tagSnapshots,
      releaseSnapshots,
    });
    const run = (api: ProviderApiFixture, maxPolls = 2): Promise<unknown> =>
      waitForProviderOutcome({
        api,
        baselineReceipt: baseline,
        maxPolls,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      });

    for (const candidate of [
      providerDeployment(20, candidateAt, { sha: "3".repeat(40) }),
      providerDeployment(20, candidateAt, { task: "other" }),
      providerDeployment(20, candidateAt, { environment: "Preview" }),
      providerDeployment(20, candidateAt, { original_environment: null }),
      providerDeployment(20, candidateAt, {
        creator: { id: 1, login: "vercel[bot]", type: "Bot" },
      }),
      providerDeployment(20, candidateAt, {
        creator: { id: 35613825, login: "other[bot]", type: "Bot" },
      }),
      providerDeployment(20, candidateAt, {
        creator: { id: 35613825, login: "vercel[bot]", type: "User" },
      }),
    ] as const) {
      await expect(run(waitCase(candidate, [[candidateStatus(201, "success", successAt)]])))
        .rejects.toThrow("Production deployment");
    }

    const gapCandidate = providerDeployment(20, "2026-08-29T15:01:00Z");
    await expect(run(waitCase(gapCandidate, [[candidateStatus(201, "success", successAt)]])))
      .rejects.toThrow("concurrent promotion gap");

    const competing = [
      providerDeployment(21, "2026-08-29T15:02:01Z"),
      providerDeployment(20, candidateAt),
      baselineDeployment,
    ];
    await expect(run(waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      [competing],
    ))).rejects.toThrow("more than one new Production deployment");

    const noCandidate = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(),
    });
    await expect(run(noCandidate, 2)).rejects.toThrow("timed out");

    const emptyStatuses = waitCase(providerDeployment(20, candidateAt), [[], []]);
    await expect(run(emptyStatuses, 2)).rejects.toThrow("timed out");

    const disappearingStatus = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [],
    ]);
    await expect(run(disappearingStatus, 2)).rejects.toThrow("statuses disappeared");

    const mutatedStatus = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [candidateStatus(200, "success", "2026-08-29T15:02:30Z")],
    ]);
    await expect(run(mutatedStatus, 2)).rejects.toThrow("status 200 changed");
    const mutatedStatusUrl = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z", {
        environment_url: "https://messagelikeme-alt-hraness.vercel.app",
        log_url: "https://messagelikeme-alt-hraness.vercel.app",
        target_url: "https://messagelikeme-alt-hraness.vercel.app",
      })],
    ]);
    await expect(run(mutatedStatusUrl, 2)).rejects.toThrow("status 200 changed");

    for (const state of ["error", "failure", "inactive"] as const) {
      await expect(run(waitCase(
        providerDeployment(20, candidateAt),
        [[candidateStatus(201, state, successAt)]],
      ))).rejects.toThrow(`ended in ${state}`);
    }

    const switched = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(200, "pending", "2026-08-29T15:02:30Z")]],
      [
        [providerDeployment(20, candidateAt), baselineDeployment],
        [providerDeployment(21, "2026-08-29T15:02:01Z"), baselineDeployment],
      ],
    );
    await expect(run(switched)).rejects.toThrow();

    const disappeared = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(200, "pending", "2026-08-29T15:02:30Z")]],
    );
    disappeared.deploymentDetailError = new Error("simulated deployment disappearance");
    await expect(run(disappeared)).rejects.toThrow("simulated deployment disappearance");

    const successRegression = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [
          candidateStatus(202, "pending", "2026-08-29T15:03:01Z"),
          candidateStatus(201, "success", successAt),
        ],
      ],
    );
    await expect(run(successRegression)).rejects.toThrow("success changed");

    const finalStatusInventoryRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
        ],
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
        ],
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
          candidateStatus(199, "queued", "2026-08-29T15:02:10Z"),
        ],
      ],
    );
    await expect(run(finalStatusInventoryRace)).rejects.toThrow("success changed");

    const finalInventoryRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      [
        [providerDeployment(20, candidateAt), baselineDeployment],
        [providerDeployment(20, candidateAt), baselineDeployment],
        [
          providerDeployment(21, "2026-08-29T15:03:01Z"),
          providerDeployment(20, candidateAt),
          baselineDeployment,
        ],
      ],
    );
    await expect(run(finalInventoryRace)).rejects.toThrow();

    const finalRefRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [providerVerifiedSha, providerVerifiedSha, providerVerifiedSha, "3".repeat(40)],
    );
    await expect(run(finalRefRace)).rejects.toThrow("website-production moved");

    const finalTagRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [providerVerifiedSha, providerVerifiedSha, providerVerifiedSha, "3".repeat(40)],
    );
    await expect(run(finalTagRace)).rejects.toThrow(
      "annotated tag v0.8.0 does not bind the exact annotated tag object",
    );

    const finalReleaseRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [],
      [
        providerRelease(),
        providerRelease(),
        providerRelease(),
        providerRelease({ published_at: "2026-08-29T14:00:01Z" }),
      ],
    );
    await expect(run(finalReleaseRace)).rejects.toThrow("publication time changed");

    const wrongStatusBot = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt, {
        creator: { id: 2, login: "vercel[bot]", type: "Bot" },
      })]],
    );
    await expect(run(wrongStatusBot)).rejects.toThrow("pinned Vercel bot");

    const wrongDeploymentStatusesUrl = waitCase(
      providerDeployment(20, candidateAt, {
        statuses_url: `https://api.github.com/repos/${providerRepository}/deployments/21/statuses`,
      }),
      [[candidateStatus(201, "success", successAt)]],
    );
    await expect(run(wrongDeploymentStatusesUrl)).rejects.toThrow("statuses_url");

    const duplicateStatusNodeId = waitCase(
      providerDeployment(20, candidateAt),
      [[
        candidateStatus(201, "success", successAt),
        candidateStatus(200, "pending", "2026-08-29T15:02:30Z", {
          node_id: "status-201",
        }),
      ]],
    );
    await expect(run(duplicateStatusNodeId)).rejects.toThrow("duplicate node id status-201");

    for (const overrides of [
      { deployment_url: `https://api.github.com/repos/${providerRepository}/deployments/21` },
      { environment: "Preview" },
      { environment_url: "http://wrench-20-hraness.vercel.app" },
      { environment_url: "https://messagelikeme-20-hraness.vercel.app/" },
      { log_url: "https://messagelikeme-other-hraness.vercel.app" },
      { target_url: "https://messagelikeme-other-hraness.vercel.app" },
    ] as const) {
      await expect(run(waitCase(
        providerDeployment(20, candidateAt),
        [[candidateStatus(201, "success", successAt, overrides)]],
      ))).rejects.toThrow();
    }

    const tiedStatusSecond = waitCase(providerDeployment(20, candidateAt), [[
      candidateStatus(202, "success", successAt),
      candidateStatus(201, "pending", successAt),
    ]]);
    await expect(run(tiedStatusSecond)).resolves.toEqual({ deploymentId: 20, statusId: 202 });

    const initialLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      undefined,
      [],
      [],
      [],
      [providerLatest({ tag_name: "v0.7.9" })],
    );
    await expect(run(initialLatestRace)).rejects.toThrow("Latest Release is not v0.8.0");

    const decisiveLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      undefined,
      [],
      [],
      [],
      [providerLatest(), providerLatest({ tag_name: "v0.7.9" })],
    );
    await expect(run(decisiveLatestRace)).rejects.toThrow("Latest Release is not v0.8.0");

    const terminalLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [],
      [],
      [
        providerLatest(),
        providerLatest(),
        providerLatest(),
        providerLatest({ tag_name: "v0.7.9" }),
      ],
    );
    await expect(run(terminalLatestRace)).rejects.toThrow("Latest Release is not v0.8.0");

    await expect(waitForProviderOutcomeRaw({
      api: new ProviderApiFixture({ defaultBranchSnapshots: ["main", "release"] }),
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
      ...providerAuthority,
    })).rejects.toThrow("release recovery default branch changed after workflow verification");

    const recoverySourceShaRace = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        providerVerifiedSha,
        providerVerifiedSha,
        providerVerifiedSha,
        "3".repeat(40),
      ],
      deployments: [[providerDeployment(20, candidateAt), baselineDeployment]],
      refSha: providerVerifiedSha,
      reviewedCompare: providerReviewedMainCompare(providerVerifiedSha, "3".repeat(40), {
        status: "diverged",
      }),
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, [
          [candidateStatus(201, "success", successAt)],
          [candidateStatus(201, "success", successAt)],
          [candidateStatus(201, "success", successAt)],
        ]],
      ]),
    });
    await expect(waitForProviderOutcomeRaw({
      api: recoverySourceShaRace,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
      ...providerAuthority,
    })).rejects.toThrow("release recovery workflow source is not exact current main");

    const wrongMode = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
      mode: "already-exact",
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: wrongMode,
      sleep: async () => {},
    })).rejects.toThrow("already-exact promotion contains write authority evidence");
    const tamperedBaseline = {
      ...(baseline as Readonly<Record<string, ProviderJson>>),
      completedAt: "2026-08-29T15:00:00.600Z",
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: tamperedBaseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("does not bind the baseline receipt");

    for (const authority of [
      { repository: "hraness/other", verifiedSha: providerVerifiedSha, verifiedTag: providerTag },
      { repository: providerRepository, verifiedSha: "3".repeat(40), verifiedTag: providerTag },
      { repository: providerRepository, verifiedSha: providerVerifiedSha, verifiedTag: "v9.9.9" },
    ] as const) {
      const api = new ProviderApiFixture();
      await expect(waitForProviderOutcomeRaw({
        api,
        baselineReceipt: baseline,
        defaultBranch: "main",
        eventName: "workflow_dispatch",
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        recoveryWorkflowSha: providerVerifiedSha,
        sleep: async () => {},
        ...authority,
      })).rejects.toThrow("authoritative release inputs");
      expect(api.calls).toHaveLength(0);
    }
  });

  test("fails recovery closed on stale success, latest ties, exact-SHA retry failures, or newer deployments", async () => {
    const recovery = await providerReceipts("already-exact");
    const baselineDeployment = recovery.baselineDeployment;

    const baselineStatusDriftGraph = providerGraphqlDeployment(
      10,
      "2026-08-29T14:05:00Z",
      {
        latestStatus: {
          createdAt: "2026-08-29T14:06:00Z",
          creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
          environment: "Production",
          environmentUrl: "https://messagelikeme-10-hraness.vercel.app",
          id: "status-99",
          logUrl: "https://messagelikeme-10-hraness.vercel.app",
          state: "SUCCESS",
          updatedAt: "2026-08-29T14:06:00Z",
        },
        updatedAt: "2026-08-29T14:06:00Z",
      },
    );
    const baselineStatusDrift = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      graphqlDeployments: [[baselineStatusDriftGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[10, [[
        providerStatus(100, "success", "2026-08-29T14:06:00Z"),
        providerStatus(99, "pending", "2026-08-29T14:05:30Z"),
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: baselineStatusDrift,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("baseline Production deployment disappeared or changed");

    const recoveryReceiptsFor = async (
      deployments: ProviderJson[],
      statuses: Map<number, ProviderJson[][]>,
    ): Promise<Readonly<{ baseline: ProviderJson; promotion: ProviderJson }>> => {
      const baseline = await createProviderBaseline({
        api: new ProviderApiFixture({
          deployments: [deployments],
          refSha: providerVerifiedSha,
          serverDates: [providerBaselineServerDate, providerBaselineServerDate],
          statuses,
        }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      }) as ProviderJson;
      const promotion = await promoteWebsiteProduction({
        api: new ProviderApiFixture({
          deployments: [deployments],
          refSha: providerVerifiedSha,
          serverDates: [providerPromotionServerDate],
          statuses,
        }),
        baselineReceipt: baseline,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
      }) as ProviderJson;
      return Object.freeze({ baseline, promotion });
    };

    const staleDeployment = providerDeployment(10, "2026-08-29T13:59:59Z");
    const staleStatuses = terminalBaselineStatus(10, "2026-08-29T14:00:01Z");
    const stale = await recoveryReceiptsFor([staleDeployment], staleStatuses);
    const staleApi = new ProviderApiFixture({
      deployments: [[staleDeployment]],
      refSha: providerVerifiedSha,
      statuses: staleStatuses,
    });
    await expect(waitForProviderOutcome({
      api: staleApi,
      baselineReceipt: stale.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: stale.promotion,
      sleep: async () => {},
    })).rejects.toThrow("does not postdate the immutable Release");

    const tiedOlderId = providerDeployment(10, "2026-08-29T14:05:00Z");
    const tiedNewerId = providerDeployment(11, "2026-08-29T14:05:00Z");
    const tiedStatuses = new Map<number, ProviderJson[][]>([
      [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
      [11, [[providerStatus(101, "success", "2026-08-29T14:06:00Z", {}, 11)]]],
    ]);
    const tiedReceipts = await recoveryReceiptsFor(
      [tiedOlderId, tiedNewerId],
      tiedStatuses,
    );
    const tiedApi = new ProviderApiFixture({
      deployments: [[tiedOlderId, tiedNewerId]],
      refSha: providerVerifiedSha,
      statuses: tiedStatuses,
    });
    await expect(waitForProviderOutcome({
      api: tiedApi,
      baselineReceipt: tiedReceipts.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: tiedReceipts.promotion,
      sleep: async () => {},
    })).rejects.toThrow("latest exact-SHA Production deployment is ambiguous at second precision");

    const olderVerified = providerDeployment(10, "2026-08-29T14:05:00Z");
    const newerWrongSha = providerDeployment(11, "2026-08-29T14:07:00Z", {
      sha: providerPreviousSha,
    });
    const wrongNewestStatuses = new Map<number, ProviderJson[][]>([
      [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
      [11, [[providerStatus(101, "success", "2026-08-29T14:08:00Z", {}, 11)]]],
    ]);
    const wrongNewestReceipts = await recoveryReceiptsFor(
      [olderVerified, newerWrongSha],
      wrongNewestStatuses,
    );
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture({
        deployments: [[olderVerified, newerWrongSha]],
        refSha: providerVerifiedSha,
        statuses: wrongNewestStatuses,
      }),
      baselineReceipt: wrongNewestReceipts.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: wrongNewestReceipts.promotion,
      sleep: async () => {},
    })).rejects.toThrow("successfully binds another SHA");

    for (const terminalState of ["failure", "error", "inactive"] as const) {
      const newerWrongTerminal = providerDeployment(11, "2026-08-29T14:07:00Z", {
        sha: providerPreviousSha,
      });
      const wrongTerminalStatuses = new Map<number, ProviderJson[][]>([
        [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
        [11, [[providerStatus(101, terminalState, "2026-08-29T14:08:00Z", {}, 11)]]],
      ]);
      const wrongTerminalReceipts = await recoveryReceiptsFor(
        [olderVerified, newerWrongTerminal],
        wrongTerminalStatuses,
      );
      await expect(waitForProviderOutcome({
        api: new ProviderApiFixture({
          deployments: [[olderVerified, newerWrongTerminal]],
          refSha: providerVerifiedSha,
          statuses: wrongTerminalStatuses,
        }),
        baselineReceipt: wrongTerminalReceipts.baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: wrongTerminalReceipts.promotion,
        sleep: async () => {},
      })).resolves.toEqual({ deploymentId: 10, statusId: 100 });
    }

    for (const terminalState of ["failure", "error", "inactive"] as const) {
      const newerExactTerminal = providerDeployment(11, "2026-08-29T14:07:00Z");
      const exactTerminalStatuses = new Map<number, ProviderJson[][]>([
        [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
        [11, [[providerStatus(101, terminalState, "2026-08-29T14:08:00Z", {}, 11)]]],
      ]);
      const exactTerminalReceipts = await recoveryReceiptsFor(
        [olderVerified, newerExactTerminal],
        exactTerminalStatuses,
      );
      await expect(waitForProviderOutcome({
        api: new ProviderApiFixture({
          deployments: [[olderVerified, newerExactTerminal]],
          refSha: providerVerifiedSha,
          statuses: exactTerminalStatuses,
        }),
        baselineReceipt: exactTerminalReceipts.baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: exactTerminalReceipts.promotion,
        sleep: async () => {},
      })).rejects.toThrow(`candidate Production deployment ended in ${terminalState}`);
    }

    const concurrentApi = new ProviderApiFixture({
      deployments: [[
        providerDeployment(11, "2026-08-29T14:07:00Z"),
        baselineDeployment,
      ]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(10, "2026-08-29T14:06:00Z"),
    });
    await expect(waitForProviderOutcome({
      api: concurrentApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("concurrent Production deployment");

    const malformedApi = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(10, "2026-08-29T14:06:00Z"),
    });
    malformedApi.release = {
      ...(providerRelease() as Readonly<Record<string, ProviderJson>>),
      published_at: null,
    };
    await expect(waitForProviderOutcome({
      api: malformedApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("published_at");
  });

});
