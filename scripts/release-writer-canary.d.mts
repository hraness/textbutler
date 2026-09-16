import type {
  CanaryControlEpochReceipt,
  CanaryWorkflowAdmissionReceipt,
} from "./release-workflow-range.mjs";

export type GitHubApiReceipt = Readonly<{ body: unknown; serverDate: string }>;

export interface WriterCanaryRulesReceipt {
  readonly authority: Readonly<{
    doNotEnforceOnCreate: false;
    integrationId: 4830612;
    name: "Message Like Me writer canary status authority";
    rulesetId: 22290941;
    strict: false;
  }>;
  readonly lifecycle: Readonly<{
    name: "Immutable production-writer canary lifecycle";
    rulesetId: 21826586;
  }>;
}

export interface WriterCanaryPreflightReceipt {
  readonly canaryServerDate: string;
  readonly context: "message-like-me/website-production-writer-canary-authority";
  readonly expectedOldSha: string;
  readonly mainServerDate: string;
  readonly productionRef: "refs/heads/website-production-writer-canary";
  readonly range: CanaryWorkflowAdmissionReceipt;
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly rules: WriterCanaryRulesReceipt;
  readonly rulesBodySha256: Readonly<{ authority: string; effective: string; lifecycle: string }>;
  readonly rulesServerDates: Readonly<{ authority: string; effective: string; lifecycle: string }>;
  readonly runAttempt: 1;
  readonly runId: number;
  readonly runServerDate: string;
  readonly schema: "message-like-me-production-writer-canary-v1";
  readonly targetSha: string;
  readonly workflowId: number;
  readonly workflowSha: string;
}

interface WriterCanaryPhaseBase<Phase extends string, Schema extends string> {
  readonly context: "message-like-me/website-production-writer-canary-authority";
  readonly expectedOldSha: string;
  readonly phase: Phase;
  readonly preflightSemanticSha256: string;
  readonly preflightSha256: string;
  readonly productionRef: "refs/heads/website-production-writer-canary";
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly runAttempt: 1;
  readonly runId: number;
  readonly schema: Schema;
  readonly targetSha: string;
  readonly workflowId: number;
  readonly workflowSha: string;
}

export interface WriterCanaryRevocationReceipt {
  readonly converged: true;
  readonly deletionServerDate: string;
  readonly lastObservationServerDate: string;
  readonly observationCount: number;
  readonly propagationObserved: boolean;
  readonly stableDenials: 2;
}

export interface WriterCanaryStatusEvidence<
  State extends "error" | "success" = "error" | "success",
> {
  readonly appId: 4830612;
  readonly appSlug: "mlm-prod-ref-writer-1342143606";
  readonly context: "message-like-me/website-production-writer-canary-authority";
  readonly createdAt: string;
  readonly creator: Readonly<{ id: number; login: string; nodeId: string }>;
  readonly description: string;
  readonly installationId: number;
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly serverDate: string;
  readonly state: State;
  readonly statusId: number;
  readonly statusNodeId: string;
  readonly statusUrl: string;
  readonly targetSha: string;
}

export interface WriterCanaryStatusCandidate<
  State extends "error" | "success" = "error" | "success",
> {
  readonly appId: number;
  readonly appSlug: string;
  readonly context: string;
  readonly createdAt: string;
  readonly creator: Readonly<{ id: number; login: string; nodeId: string }>;
  readonly description: string;
  readonly installationId: number;
  readonly repository: string;
  readonly repositoryId: number;
  readonly serverDate: string;
  readonly state: State;
  readonly statusId: number;
  readonly statusNodeId: string;
  readonly statusUrl: string;
  readonly targetSha: string;
}

export interface WriterCanaryTerminalReadback {
  readonly context: "message-like-me/website-production-writer-canary-authority";
  readonly serverDate: string;
  readonly state: "failure";
  readonly statusCount: number;
  readonly targetSha: string;
  readonly terminalStatusId: number;
  readonly terminalStatusNodeId: string;
}

export interface WriterCanaryRefReadback {
  readonly serverDate: string;
  readonly sha: string;
}

export interface WriterCanarySuccessStatusReadback {
  readonly serverDate: string;
  readonly statusId: number;
  readonly statusNodeId: string;
}

export interface WriterCanaryRefPushReceipt {
  readonly classification: "fast-forward";
  readonly fromSha: string;
  readonly protectedRef: "refs/heads/website-production-writer-canary";
  readonly summarySha256: string;
  readonly toSha: string;
}

export interface WriterCanaryStaleLeaseReceipt {
  readonly classification: "stale-info";
  readonly diagnosticSha256: string;
}

export interface WriterCanaryAppRefDenialResult {
  readonly app: Readonly<{ appId: number; installationId: number }>;
  readonly rateLimitRemaining: number;
  readonly revocation: WriterCanaryRevocationReceipt;
  readonly serverDate: string;
  readonly status: 403;
}

export interface WriterCanaryAttestationResult {
  readonly revocation: WriterCanaryRevocationReceipt;
  readonly status: WriterCanaryStatusEvidence<"success">;
}

export interface WriterCanaryTerminalStatusResult {
  readonly consumption: WriterCanaryStatusEvidence<"error">;
  readonly readback: WriterCanaryTerminalReadback;
  readonly revocation: WriterCanaryRevocationReceipt;
}

export interface WriterCanaryRulesApiClosureReceipt {
  readonly bodySha256: Readonly<{
    authority: string;
    effective: string;
    lifecycle: string;
  }>;
  readonly rules: WriterCanaryRulesReceipt;
  readonly serverDates: Readonly<{
    authority: string;
    effective: string;
    lifecycle: string;
  }>;
}

export interface WriterCanaryTerminalizedReceipt extends WriterCanaryPhaseBase<"terminalized", "message-like-me-production-writer-canary-terminalized-v1"> {
  readonly appRefDenial: Readonly<{ appId: 4830612; installationId: number; rateLimitRemaining: number; serverDate: string; status: 403 }>;
  readonly appRevocation: WriterCanaryRevocationReceipt;
  readonly status: WriterCanaryStatusEvidence<"error">;
  readonly statusReadback: WriterCanaryTerminalReadback;
  readonly statusRevocation: WriterCanaryRevocationReceipt;
}

export interface WriterCanaryWriterDeniedReceipt extends WriterCanaryPhaseBase<"writer-denied", "message-like-me-production-writer-canary-writer-denied-v3"> {
  readonly denial: Readonly<{ classification: "required-status-errored"; diagnosticSha256: string }>;
  readonly refReadback: WriterCanaryRefReadback;
  readonly rules: WriterCanaryRulesApiClosureReceipt;
}

export interface WriterCanaryAttestedReceipt extends WriterCanaryPhaseBase<"attested", "message-like-me-production-writer-canary-attested-v1"> {
  readonly status: WriterCanaryStatusEvidence<"success">;
  readonly statusRevocation: WriterCanaryRevocationReceipt;
}

export interface WriterCanaryAdvancedReceipt extends WriterCanaryPhaseBase<"advanced", "message-like-me-production-writer-canary-advanced-v1"> {
  readonly refReadback: WriterCanaryRefReadback;
  readonly rules: WriterCanaryRulesApiClosureReceipt;
  readonly staleLease: WriterCanaryStaleLeaseReceipt;
  readonly staleReadback: WriterCanaryRefReadback;
  readonly statusReadback: WriterCanarySuccessStatusReadback;
  readonly writerPush: WriterCanaryRefPushReceipt;
}

export interface WriterCanaryConsumedReceipt extends WriterCanaryPhaseBase<"consumed", "message-like-me-production-writer-canary-consumed-v1"> {
  readonly status: WriterCanaryStatusEvidence<"error">;
  readonly statusReadback: WriterCanaryTerminalReadback;
  readonly statusRevocation: WriterCanaryRevocationReceipt;
}

export type WriterCanaryPhaseReceipt = WriterCanaryAdvancedReceipt | WriterCanaryAttestedReceipt | WriterCanaryConsumedReceipt | WriterCanaryTerminalizedReceipt | WriterCanaryWriterDeniedReceipt;

export interface WriterCanaryPreflightApi {
  getRef(ref: string): Promise<GitHubApiReceipt>;
  getRules(): Promise<Readonly<{ authority: GitHubApiReceipt; effective: GitHubApiReceipt; lifecycle: GitHubApiReceipt }>>;
  getRun(runId: number): Promise<GitHubApiReceipt>;
}

export interface WriterCanaryRefApi extends WriterCanaryPreflightApi {
  getRefSha(ref: string): Promise<Readonly<{ serverDate: string; sha: string }>>;
}

export interface WriterCanaryStatusApi extends WriterCanaryRefApi {
  getCombinedStatus(targetSha: string): Promise<GitHubApiReceipt>;
}

export interface WriterCanaryAdvanceApi extends WriterCanaryStatusApi {}

export interface WriterCanaryFinalPhases {
  readonly advanced: WriterCanaryAdvancedReceipt;
  readonly attested: WriterCanaryAttestedReceipt;
  readonly consumed: WriterCanaryConsumedReceipt;
  readonly terminalized: WriterCanaryTerminalizedReceipt;
  readonly writerDenied: WriterCanaryWriterDeniedReceipt;
}

export interface WriterCanaryFinalReceipt {
  readonly admittedPreflight: WriterCanaryPreflightReceipt;
  readonly context: "message-like-me/website-production-writer-canary-authority";
  readonly finalRef: WriterCanaryRefReadback;
  readonly phases: WriterCanaryFinalPhases;
  readonly postStatusRef: WriterCanaryRefReadback;
  readonly preflightSemanticSha256: string;
  readonly preflightSha256: string;
  readonly productionRef: "refs/heads/website-production-writer-canary";
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly runAttempt: 1;
  readonly runId: number;
  readonly schema: "message-like-me-production-writer-canary-final-v3";
  readonly targetSha: string;
  readonly terminalStatus: Readonly<{
    serverDate: string;
    statusId: number;
    statusNodeId: string;
    targetSha: string;
  }>;
  readonly terminalRules: WriterCanaryRulesApiClosureReceipt;
  readonly workflowId: number;
  readonly workflowSha: string;
}

export class WriterCanaryWorkflowDeltaError extends Error {
  readonly controlEpoch: CanaryControlEpochReceipt;
  readonly receipt: Readonly<Record<string, unknown>>;
}

export function parseWriterCanaryRules(value: unknown): Readonly<WriterCanaryRulesReceipt>;
export function parseWriterCanaryEnvironment(environment: Readonly<Record<string, unknown>>): Readonly<{ apiUrl: URL; controlEpochDigest?: string; repository: "hraness/textbutler"; repositoryId: 1342143606; runAttempt: 1; runId: number; workflowSha: string }>;
export function parseWriterCanaryRef(value: unknown, expectedRef: string): string;
export function parseWriterCanaryRun(value: unknown, expected: Readonly<{ runId: number; workflowSha: string }>): Readonly<{ runAttempt: 1; runId: number; workflowId: number }>;

type VerifyRange = (input: Readonly<{
  controlEpochDigest?: string;
  currentMainSha: string;
  eventName: "workflow_dispatch";
  eventRef: "refs/heads/main";
  eventSha: string;
  githubActions: "true";
  previousSha: string;
  protectedRef: "refs/heads/website-production-writer-canary";
  repository: "hraness/textbutler";
  repositoryId: 1342143606;
  runAttempt: 1;
  targetSha: string;
  workflowSha: string;
  workingDirectory: string;
}>) => CanaryWorkflowAdmissionReceipt;

export function createWriterCanaryPreflight(input: Readonly<{ api: WriterCanaryPreflightApi; environment: Readonly<Record<string, unknown>>; verifyRange?: VerifyRange; workingDirectory?: string }>): Promise<Readonly<WriterCanaryPreflightReceipt>>;
export function encodeWriterCanaryPreflightReceipt(value: unknown): string;
export function decodeWriterCanaryPreflightReceipt(value: unknown): Readonly<WriterCanaryPreflightReceipt>;
export function encodeWriterCanaryPhaseReceipt(value: unknown): string;
export function decodeWriterCanaryPhaseReceipt(value: unknown): Readonly<WriterCanaryPhaseReceipt>;

export function terminalizeWriterCanary(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  proveAppRefDenied(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryAppRefDenialResult>>;
  terminalizeStatus(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryTerminalStatusResult>>;
}>): Promise<Readonly<WriterCanaryTerminalizedReceipt>>;
export function denyWriterCanaryWithoutSuccess(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  advanceRef(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryRefPushReceipt>>;
  api: WriterCanaryRefApi;
  environment: Readonly<Record<string, unknown>>;
  verifyRange?: VerifyRange;
  workingDirectory?: string;
}>): Promise<Readonly<WriterCanaryWriterDeniedReceipt>>;
export function attestWriterCanary(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  attestStatus(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryAttestationResult>>;
}>): Promise<Readonly<WriterCanaryAttestedReceipt>>;
export function advanceWriterCanary(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  advanceRef(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryRefPushReceipt>>;
  api: WriterCanaryAdvanceApi;
  attestationReceipt: string;
  environment: Readonly<Record<string, unknown>>;
  proveStaleLease(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryStaleLeaseReceipt>>;
  verifyRange?: VerifyRange;
  workingDirectory?: string;
}>): Promise<Readonly<WriterCanaryAdvancedReceipt>>;
export function consumeWriterCanary(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  terminalizeStatus(
    receipt: WriterCanaryPreflightReceipt,
  ): Promise<Readonly<WriterCanaryTerminalStatusResult>>;
}>): Promise<Readonly<WriterCanaryConsumedReceipt>>;
export function finalizeWriterCanary(input: Readonly<{
  admitted: WriterCanaryPreflightReceipt;
  api: WriterCanaryStatusApi;
  phases: WriterCanaryFinalPhases;
}>): Promise<Readonly<WriterCanaryFinalReceipt>>;
