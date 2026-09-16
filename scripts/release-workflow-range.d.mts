export type WorkflowRangeGitResult = Readonly<{
  exitCode: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
}>;

export type WorkflowRangeGitRunner = (
  arguments_: readonly string[],
) => WorkflowRangeGitResult;

type WorkflowRangeReceiptFields = Readonly<{
  newCommitCount: number;
  newCommitDigest: string;
  previousSha: string;
  verifiedSha: string;
  workflowTreeOid: string;
}>;

export type ProductionWorkflowRangeReceipt = WorkflowRangeReceiptFields & Readonly<{
  productionRef: "refs/heads/website-production";
  schema: "message-like-me-workflow-range-v1";
}>;

export type CanaryWorkflowRangeReceipt = WorkflowRangeReceiptFields & Readonly<{
  productionRef: "refs/heads/website-production-writer-canary";
  schema: "message-like-me-canary-workflow-range-v1";
}>;

export type WorkflowRangeReceipt =
  | ProductionWorkflowRangeReceipt
  | CanaryWorkflowRangeReceipt;

export type ControlEpochInventoryEntry = Readonly<{
  commitSha: string;
  workflowTreeOid: string;
}>;

export type ControlEpochChange = Readonly<{
  commitSha: string;
  previousWorkflowTreeOid: string;
  workflowTreeOid: string;
}>;

type ControlEpochReceiptFields = Readonly<{
  changes: readonly ControlEpochChange[];
  digest: string;
  inventory: readonly ControlEpochInventoryEntry[];
  previousSha: string;
  repository: "hraness/textbutler";
  repositoryId: 1342143606;
  tag: string;
  targetSha: string;
  workflowSha: string;
}>;

export type ProductionControlEpochReceipt = ControlEpochReceiptFields & Readonly<{
  domain: "message-like-me/control-epoch/production/v2";
  protectedRef: "refs/heads/website-production";
  schema: "message-like-me-production-control-epoch-v2";
}>;

export type CanaryControlEpochReceipt = ControlEpochReceiptFields & Readonly<{
  domain: "message-like-me/control-epoch/canary/v2";
  protectedRef: "refs/heads/website-production-writer-canary";
  schema: "message-like-me-canary-control-epoch-v2";
  tag: "no-tag";
}>;

export type SiteControlEpochReceipt = Omit<ControlEpochReceiptFields, "tag"> & Readonly<{
  domain: "textbutler/control-epoch/site/v1";
  protectedRef: "refs/heads/website-production";
  schema: "textbutler-site-control-epoch-v1";
  tag: null;
}>;
export type ControlEpochReceipt = ProductionControlEpochReceipt | CanaryControlEpochReceipt | SiteControlEpochReceipt;
export type ProductionWorkflowAdmissionReceipt = ProductionWorkflowRangeReceipt | ProductionControlEpochReceipt;
export type CanaryWorkflowAdmissionReceipt = CanaryWorkflowRangeReceipt | CanaryControlEpochReceipt;
export type SiteWorkflowAdmissionReceipt = ProductionWorkflowRangeReceipt | SiteControlEpochReceipt;
export type WorkflowAdmissionReceipt = ProductionWorkflowAdmissionReceipt | CanaryWorkflowAdmissionReceipt | SiteWorkflowAdmissionReceipt;

export const CONTROL_EPOCH_CANARY_NO_TAG: "no-tag";

export const MAXIMUM_WORKFLOW_RANGE_COMMITS: 250;

export function verifyWorkflowRange(input: Readonly<{
  previousSha: string;
  runner?: WorkflowRangeGitRunner;
  verifiedSha: string;
  workingDirectory?: string;
}>): ProductionWorkflowRangeReceipt;

export function verifyCanaryWorkflowRange(input: Readonly<{
  previousSha: string;
  runner?: WorkflowRangeGitRunner;
  verifiedSha: string;
  workingDirectory?: string;
}>): CanaryWorkflowRangeReceipt;

export function assertWorkflowRangeReceipt(
  value: unknown,
  expected: Readonly<{
    previousSha: string;
    verifiedSha: string;
  }>,
): ProductionWorkflowRangeReceipt;

export function assertCanaryWorkflowRangeReceipt(
  value: unknown,
  expected: Readonly<{ previousSha: string; verifiedSha: string }>,
): CanaryWorkflowRangeReceipt;

export function encodeWorkflowRangeReceipt(value: unknown): string;
export function decodeWorkflowRangeReceipt(value: unknown): WorkflowRangeReceipt;

type ControlEpochDescriptionFields = Readonly<{
  currentMainSha: string;
  previousSha: string;
  repository: "hraness/textbutler";
  repositoryId: number | string;
  runner?: WorkflowRangeGitRunner;
  targetSha?: string;
  verifiedSha?: string;
  workflowSha: string;
  workingDirectory?: string;
}>;

type ProductionControlEpochDescriptionInput = ControlEpochDescriptionFields & Readonly<{
  mode: "production";
  protectedRef: "refs/heads/website-production";
  tag: string;
}>;

type CanaryControlEpochDescriptionInput = ControlEpochDescriptionFields & Readonly<{
  mode: "canary";
  protectedRef: "refs/heads/website-production-writer-canary";
  tag: "no-tag";
}>;

type ControlEpochAdmissionBoundary = Readonly<{
  controlEpochDigest?: string | undefined;
  currentMainSha: string;
  eventName?: string;
  eventRef?: string;
  eventSha?: string;
  githubActions?: string;
  previousSha: string;
  protectedRef?: "refs/heads/website-production" | "refs/heads/website-production-writer-canary";
  repository: "hraness/textbutler";
  repositoryId: number | string;
  runAttempt?: number | string;
  runner?: WorkflowRangeGitRunner;
  tag?: string;
  targetSha?: string;
  verifiedSha?: string;
  workflowSha: string;
  workingDirectory?: string;
}>;

export function controlEpochDigest(value: unknown): string;
export function verifySiteWorkflowAdmission(input: ControlEpochAdmissionBoundary): SiteWorkflowAdmissionReceipt;
export function assertSiteWorkflowAdmissionReceipt(value: unknown, expected: Readonly<{previousSha: string; targetSha: string}>): SiteWorkflowAdmissionReceipt;
export function describeControlEpoch(input: ControlEpochDescriptionFields & Readonly<{ mode: "site"; protectedRef: "refs/heads/website-production"; tag: null }>): SiteControlEpochReceipt;
export function describeControlEpoch(
  input: ProductionControlEpochDescriptionInput,
): ProductionControlEpochReceipt;
export function describeControlEpoch(
  input: CanaryControlEpochDescriptionInput,
): CanaryControlEpochReceipt;
export function describeControlEpoch(
  input: ControlEpochDescriptionFields & Readonly<{
    mode: string;
    protectedRef: string;
    tag: string;
  }>,
): ControlEpochReceipt;
export function verifyProductionWorkflowAdmission(
  input: ControlEpochAdmissionBoundary & Readonly<{ controlEpochDigest: string }>,
): ProductionControlEpochReceipt;
export function verifyProductionWorkflowAdmission(
  input: ControlEpochAdmissionBoundary,
): ProductionWorkflowAdmissionReceipt;
export function verifyCanaryWorkflowAdmission(
  input: ControlEpochAdmissionBoundary & Readonly<{ controlEpochDigest: string }>,
): CanaryControlEpochReceipt;
export function verifyCanaryWorkflowAdmission(
  input: ControlEpochAdmissionBoundary,
): CanaryWorkflowAdmissionReceipt;
export function assertProductionControlEpochReceipt(
  value: unknown,
  expected: Readonly<{ previousSha: string; tag: string; targetSha?: string; verifiedSha?: string; workflowSha: string }>,
): ProductionControlEpochReceipt;
export function assertCanaryControlEpochReceipt(
  value: unknown,
  expected: Readonly<{ previousSha: string; targetSha?: string; verifiedSha?: string; workflowSha: string }>,
): CanaryControlEpochReceipt;
export function encodeControlEpochReceipt(value: unknown): string;
export function decodeControlEpochReceipt(value: unknown): ControlEpochReceipt;
export function encodeWorkflowAdmissionReceipt(value: unknown): string;
export function decodeWorkflowAdmissionReceipt(value: unknown): WorkflowAdmissionReceipt;
export function assertProductionWorkflowAdmissionReceipt(
  value: unknown,
  expected: Readonly<{ previousSha: string; tag?: string; targetSha?: string; verifiedSha?: string; workflowSha?: string }>,
): ProductionWorkflowAdmissionReceipt;
export function assertCanaryWorkflowAdmissionReceipt(
  value: unknown,
  expected: Readonly<{ previousSha: string; targetSha?: string; verifiedSha?: string; workflowSha?: string }>,
): CanaryWorkflowAdmissionReceipt;
export function writeControlEpochReview(value: unknown): ControlEpochReceipt;

export class ControlEpochAdmissionError extends Error {
  readonly receipt: ControlEpochReceipt;
}
