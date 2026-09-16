import type {
  ReleaseAuthorityAttestationReceipt,
  ReleaseAuthorityConsumptionReceipt,
  ReleaseAuthorityStatusReadbackReceipt,
} from "./release-status-attester.mjs";

export interface ProductionAuthorityRevocationReceipt {
  readonly converged: true;
  readonly deletionServerDate: string;
  readonly lastObservationServerDate: string;
  readonly observationCount: number;
  readonly propagationObserved: boolean;
  readonly stableDenials: 2;
}

export interface ProductionAuthorityRulesReceipt {
  readonly bodySha256: Readonly<{
    authority: string;
    effective: string;
    lifecycle: string;
  }>;
  readonly rules: Readonly<{
    authority: Readonly<{
      doNotEnforceOnCreate: false;
      integrationId: 4830612;
      name: "Message Like Me production status authority";
      rulesetId: 22290922;
      strict: false;
    }>;
    lifecycle: Readonly<{
      name: "Immutable website-production lifecycle";
      rulesetId: 21821875;
    }>;
  }>;
  readonly serverDates: Readonly<{
    authority: string;
    effective: string;
    lifecycle: string;
  }>;
}

interface ProductionAuthorityBase<Phase extends string, Schema extends string> {
  readonly context: "message-like-me/website-production-authority";
  readonly phase: Phase;
  readonly productionRef: "refs/heads/website-production";
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly schema: Schema;
  readonly targetSha: string;
}

export interface ProductionAuthorityAttestedReceipt
  extends ProductionAuthorityBase<
    "attested",
    "message-like-me-production-authority-attested-v1"
  > {
  readonly revocation: ProductionAuthorityRevocationReceipt;
  readonly status: ReleaseAuthorityAttestationReceipt;
}

export interface ProductionAuthorityConsumedReceipt
  extends ProductionAuthorityBase<
    "consumed",
    "message-like-me-production-authority-consumed-v1"
  > {
  readonly attestationSha256: string | null;
  readonly promotionSha256: string | null;
  readonly readback: ReleaseAuthorityStatusReadbackReceipt;
  readonly revocation: ProductionAuthorityRevocationReceipt;
  readonly status: ReleaseAuthorityConsumptionReceipt;
}

export type ProductionAuthorityPhaseReceipt =
  | ProductionAuthorityAttestedReceipt
  | ProductionAuthorityConsumedReceipt;

export interface ProductionAuthorityApiReceipt {
  readonly body: unknown;
  readonly serverDate: string;
}

export interface ProductionAuthorityRulesApiClosure {
  readonly authority: ProductionAuthorityApiReceipt;
  readonly effective: ProductionAuthorityApiReceipt;
  readonly lifecycle: ProductionAuthorityApiReceipt;
}

export interface ProductionAuthorityFinalApi {
  getCombinedStatus(targetSha: string): Promise<unknown>;
  getRef(): Promise<unknown>;
  getRules(): Promise<ProductionAuthorityRulesApiClosure>;
}

export interface ProductionAuthorityFinalReceipt {
  readonly attestation: ProductionAuthorityAttestedReceipt;
  readonly consumption: ProductionAuthorityConsumedReceipt;
  readonly denial: unknown;
  readonly finalRef: unknown;
  readonly postStatusRef: unknown;
  readonly precondition: ProductionAuthorityConsumedReceipt;
  readonly promotion: unknown;
  readonly rules: ProductionAuthorityRulesReceipt;
  readonly schema: "message-like-me-production-authority-final-v3";
  readonly terminalStatus: Readonly<{
    serverDate: string;
    statusId: number;
    statusNodeId: string;
  }>;
}

export function encodeProductionAuthorityPhaseReceipt(value: unknown): string;
export function decodeProductionAuthorityPhaseReceipt(
  value: unknown,
): Readonly<ProductionAuthorityPhaseReceipt>;
export function productionAuthorityReceiptDigest(value: unknown): string;

export function createProductionAuthorityAttestedReceipt(
  targetSha: unknown,
  status: ReleaseAuthorityAttestationReceipt,
  revocation: ProductionAuthorityRevocationReceipt,
): Readonly<ProductionAuthorityAttestedReceipt>;

export function createProductionAuthorityConsumedReceipt(
  targetSha: unknown,
  attestationReceipt: ProductionAuthorityAttestedReceipt | undefined,
  promotionReceiptSha256: unknown | undefined,
  terminal: Readonly<{
    consumption: ReleaseAuthorityConsumptionReceipt;
    readback: ReleaseAuthorityStatusReadbackReceipt;
  }>,
  revocation: ProductionAuthorityRevocationReceipt,
): Readonly<ProductionAuthorityConsumedReceipt>;

export function parseCurrentProductionAuthoritySuccess(
  value: unknown,
  serverDate: unknown,
  attestationReceipt: ProductionAuthorityAttestedReceipt,
): Readonly<{
  serverDate: string;
  statusId: number;
  statusNodeId: string;
  targetSha: string;
}>;

export function parseProductionAuthorityRules(value: unknown): Readonly<
  ProductionAuthorityRulesReceipt["rules"]
>;
export function parseProductionAuthorityRulesApiClosure(
  value: unknown,
  label?: string,
): Readonly<ProductionAuthorityRulesReceipt>;
export function normalizeProductionAuthorityRulesReceipt(
  value: unknown,
): Readonly<ProductionAuthorityRulesReceipt>;

export function finalizeProductionAuthority(input: Readonly<{
  api: ProductionAuthorityFinalApi;
  attestationReceipt: ProductionAuthorityAttestedReceipt;
  consumptionReceipt: ProductionAuthorityConsumedReceipt;
  denialReceipt: unknown;
  preconditionReceipt: ProductionAuthorityConsumedReceipt;
  promotion: Readonly<{
    authority: Readonly<{
      attestationSha256: string;
      statusId: number;
      statusNodeId: string;
      statusReadbackAt: string;
    }>;
    baselineDigest: string;
    boundaryAt: string;
    denialSha256: string;
    mode: "advanced";
    previousSha: string;
    promotedAt: string;
    productionRef: "refs/heads/website-production";
    receiptSha256: string;
    releasePublishedAt: string;
    repository: "hraness/textbutler";
    rules: ProductionAuthorityRulesReceipt;
    schema: "message-like-me-provider-promotion-v2";
    verifiedSha: string;
    verifiedTag: string;
    writerPush: Readonly<{
      classification: "fast-forward";
      fromSha: string;
      protectedRef: "refs/heads/website-production";
      summarySha256: string;
      toSha: string;
    }>;
  }>;
}>): Promise<Readonly<ProductionAuthorityFinalReceipt>>;
export type SiteProductionSubject = Readonly<{
  kind: "site";
  sourceSha: string;
  ciRunId: number;
  ciRunAttempt: number;
  buildRunId: number;
  buildRunAttempt: number;
  buildArtifactId: number;
  buildArtifactDigest: string;
  manifestDigest: string;
  buildCompletedAt: string;
  sourceQualifiedAt: string;
}>;
export function parseSiteSubject(value: unknown): SiteProductionSubject;
