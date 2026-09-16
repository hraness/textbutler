export interface ReleaseProviderApi {
  getCombinedStatus?(targetSha: string): Promise<unknown>;
  getRef?(): Promise<unknown>;
  getRules?(): Promise<unknown>;
  get?(endpoint: string): Promise<unknown>;
  getWithServerDate?(endpoint: string): Promise<unknown>;
  graphql?(input: Readonly<{
    after?: string;
    name: string;
    owner: string;
    query: string;
  }>): Promise<unknown>;
}

export interface ProductionDeployment {
  readonly createdAt: string;
  readonly createdMilliseconds: number;
  readonly id: number;
  readonly sha: string;
}

export interface DeploymentStatus {
  readonly createdAt: string;
  readonly createdMilliseconds: number;
  readonly id: number;
  readonly nodeId: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly updatedMilliseconds: number;
}

export const releaseRestRequestBudget: Readonly<{
  githubTokenLimit: number;
  headroom: number;
  maxPolls: number;
  pollIntervalMilliseconds: number;
  providerBaseline: number;
  providerOutcome: number;
  providerPromotion: number;
  surroundingRelease: number;
  total: number;
}>;

export const releaseGraphqlRequestBudget: Readonly<{
  githubPointLimit: number;
  headroom: number;
  maxCostPerRequest: number;
  maxPoints: number;
  providerBaseline: number;
  providerOutcome: number;
  totalRequests: number;
}>;

export function parseIncludedGitHubResponse(text: string, label?: string): Readonly<{
  body: unknown;
  serverDate: string;
}>;

export function parseOptionalIncludedGitHubResponse(
  text: string,
  label?: string,
): Readonly<{ found: boolean; value: unknown }>;

export function encodeProviderReceipt(value: unknown): string;
export function decodeProviderReceipt(value: unknown, label?: string): unknown;

export function collectProductionDeployments(
  api: ReleaseProviderApi,
  repository: string,
): Promise<readonly ProductionDeployment[]>;

export function collectDeploymentStatuses(
  api: ReleaseProviderApi,
  repository: string,
  deploymentId: number,
): Promise<readonly DeploymentStatus[]>;

export function assertReleaseTagNewerThanPublished(input: Readonly<{
  api: ReleaseProviderApi;
  repository: string;
  verifiedTag: string;
}>): Promise<void>;

export function exactPublishedRelease(
  value: unknown,
  tag: string,
  label?: string,
): unknown;

export function revalidateReleaseAuthority(input: Readonly<{
  api: ReleaseProviderApi;
  defaultBranch: string;
  eventName: string;
  recoveryWorkflowSha: string;
  repository: string;
  verifiedSha: string;
  verifiedTag: string;
}>): Promise<void>;

export function createProviderBaseline(input: Readonly<{
  api: ReleaseProviderApi;
  repository: string;
  verifiedSha: string;
}>): Promise<unknown>;

export interface ProductionRequiredStatusDenialReceipt {
  readonly baselineDigest: string;
  readonly denial: Readonly<{
    classification: "required-status-errored";
    diagnosticSha256: string;
  }>;
  readonly observedAt: string;
  readonly preconditionSha256: string;
  readonly previousSha: string;
  readonly productionRef: "refs/heads/website-production";
  readonly repository: "hraness/textbutler";
  readonly rules: unknown;
  readonly schema: "message-like-me-production-required-status-denial-v3";
  readonly verifiedSha: string;
  readonly verifiedTag: string;
}

type ProviderPromotionCommon = Readonly<{
  api: ReleaseProviderApi;
  baselineReceipt: unknown;
  defaultBranch: string;
  eventName: string;
  recoveryWorkflowSha: string;
  repository: string;
  verifiedSha: string;
  verifiedTag: string;
}>;

type ProviderAdvancedPromotionAuthority = Readonly<{
  advanceRef(
    repository: string,
    expectedOldSha: string,
    verifiedSha: string,
    verifiedTag: string,
  ): Promise<Readonly<{
    classification: "fast-forward";
    fromSha: string;
    protectedRef: "refs/heads/website-production";
    summarySha256: string;
    toSha: string;
  }>>;
  attestationReceipt: unknown;
  denialReceipt: unknown;
  workflowRangeReceipt: unknown;
}>;

type ProviderAlreadyExactAuthority = Readonly<{
  advanceRef?: undefined;
  attestationReceipt?: undefined;
  denialReceipt?: undefined;
  workflowRangeReceipt?: undefined;
}>;

export function proveProductionRequiredStatusDenial(input: Readonly<{
  api: ReleaseProviderApi;
  baselineReceipt: unknown;
  defaultBranch: string;
  denyRef(
    repository: string,
    expectedOldSha: string,
    verifiedSha: string,
    verifiedTag: string,
  ): Promise<Readonly<{
    classification: "required-status-errored";
    diagnosticSha256: string;
  }>>;
  eventName: string;
  preconditionReceipt: unknown;
  recoveryWorkflowSha: string;
  repository: string;
  verifiedSha: string;
  verifiedTag: string;
  workflowRangeReceipt: unknown;
}>): Promise<Readonly<ProductionRequiredStatusDenialReceipt>>;

export function promoteWebsiteProduction(
  input: ProviderPromotionCommon &
    (ProviderAdvancedPromotionAuthority | ProviderAlreadyExactAuthority),
): Promise<unknown>;

export function waitForProviderOutcome(input: Readonly<{
  api: ReleaseProviderApi;
  baselineReceipt: unknown;
  defaultBranch: string;
  eventName: string;
  maxPolls?: number;
  pollIntervalMilliseconds?: number;
  promotionReceipt: unknown;
  recoveryWorkflowSha: string;
  repository?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  verifiedSha?: string;
  verifiedTag?: string;
}>): Promise<Readonly<{ deploymentId: number; statusId: number }>>;
