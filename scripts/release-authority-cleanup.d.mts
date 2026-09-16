export interface CleanupReleaseAssetEvidence {
  readonly digest: `sha256:${string}`;
  readonly id: number;
  readonly name: string;
  readonly size: number;
}

export interface CleanupReleaseEvidence {
  readonly assets: readonly CleanupReleaseAssetEvidence[];
  readonly id: number;
  readonly publishedAt: string;
  readonly tag: string;
}

export interface CleanupCoordinate {
  readonly expectedProductionSha: string;
  readonly release: CleanupReleaseEvidence;
  readonly tagObjectSha: string;
  readonly targetSha: string;
  readonly verifiedTag: string;
  readonly workflowSha: string;
}

export interface CleanupIncident {
  readonly conclusion:
    | "action_required"
    | "cancelled"
    | "failure"
    | "stale"
    | "startup_failure"
    | "timed_out";
  readonly createdAt: string;
  readonly displayTitle: string;
  readonly event: string;
  readonly headBranch: "main";
  readonly headSha: string;
  readonly htmlUrl: string;
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly runAttempt: number;
  readonly runId: number;
  readonly runStartedAt: string;
  readonly status: "completed";
  readonly updatedAt: string;
  readonly url: string;
  readonly workflowId: number;
  readonly workflowPath: string;
}

export interface CleanupAbsentPredecessor {
  readonly kind: "absent";
}

export interface CleanupStatusPredecessor {
  readonly createdAt: string;
  readonly creatorId: number;
  readonly creatorLogin: "mlm-prod-ref-writer-1342143606[bot]";
  readonly creatorNodeId: string;
  readonly description:
    | "Exact release authority admitted for one production-ref attempt"
    | "Release authority consumed after the production-ref attempt";
  readonly kind: "app-status";
  readonly state: "error" | "success";
  readonly statusId: number;
  readonly statusNodeId: string;
  readonly statusUrl: string;
  readonly targetSha: string;
}

export type CleanupPredecessor = CleanupAbsentPredecessor | CleanupStatusPredecessor;

export interface CleanupRulesReceipt {
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

export interface CleanupPreflightReceipt {
  readonly coordinate: CleanupCoordinate;
  readonly currentRun: Readonly<{
    runAttempt: 1;
    runId: number;
    workflowId: number;
    workflowPath: ".github/workflows/release-authority-cleanup.yml";
  }>;
  readonly incident: CleanupIncident;
  readonly inventory: Readonly<{
    attemptCount: number;
    digest: string;
    freezeAnchorAt: string;
    since: string;
    workflowIds: Readonly<{ canary: number; cleanup: number; production: number }>;
    workflowRunCounts: Readonly<{ canary: number; cleanup: number; production: number }>;
    workflowStates: Readonly<{
      canary: "disabled_manually";
      cleanup: "active";
      production: "disabled_manually";
    }>;
  }>;
  readonly predecessor: CleanupPredecessor;
  readonly quarantineUntil: string;
  readonly repository: "hraness/textbutler";
  readonly rules: CleanupRulesReceipt;
  readonly schema: "message-like-me-release-authority-cleanup-preflight-v2";
  readonly serverDates: Readonly<{
    completedAt: string;
    incidentSourceAt: string;
    inventoryAt: string;
    snapshotAt: string;
    statusFirst: string;
    statusHistory: string;
    statusSecond: string;
  }>;
}

export interface CleanupTerminalReceipt {
  readonly app: Readonly<{
    appId: 4830612;
    appSlug: "mlm-prod-ref-writer-1342143606";
    clientId: string;
    expiresAt: string;
    installationId: 159058102;
  }>;
  readonly context: "message-like-me/website-production-authority";
  readonly initialSha256: string;
  readonly predecessorSha256: string;
  readonly preflightSha256: string;
  readonly readback: Readonly<{
    context: "message-like-me/website-production-authority";
    serverDate: string;
    state: "error";
    statusCount: number;
    targetSha: string;
    terminalStatusId: number;
    terminalStatusNodeId: string;
  }>;
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly revocation: Readonly<{
    converged: true;
    deletionServerDate: string;
    lastObservationServerDate: string;
    observationCount: number;
    propagationObserved: boolean;
    stableDenials: 2;
  }>;
  readonly schema: "message-like-me-release-authority-cleanup-terminal-v2";
  readonly status: Readonly<{
    appId: 4830612;
    appSlug: "mlm-prod-ref-writer-1342143606";
    context: "message-like-me/website-production-authority";
    createdAt: string;
    creator: Readonly<{
      id: number;
      login: "mlm-prod-ref-writer-1342143606[bot]";
      nodeId: string;
      siteAdmin: false;
      type: "Bot";
    }>;
    description: "Release authority consumed after the production-ref attempt";
    installationId: 159058102;
    repository: "hraness/textbutler";
    repositoryId: 1342143606;
    serverDate: string;
    state: "error";
    statusId: number;
    statusNodeId: string;
    statusUrl: string;
    targetSha: string;
  }>;
  readonly targetSha: string;
}

export interface CleanupPostflightReceipt {
  readonly admittedSha256: string;
  readonly admittedSource: "initial-fallback" | "revalidated";
  readonly classification:
    | "terminal-bound"
    | "terminal-not-observed"
    | "terminal-observed-unbound";
  readonly observation: CleanupPreflightReceipt;
  readonly schema: "message-like-me-release-authority-cleanup-postflight-v2";
  readonly terminalSha256: string | null;
}

export interface CleanupFinalReceipt {
  readonly complete: true;
  readonly finalBoundary: Readonly<{
    productionRef: Readonly<{ serverDate: string; sha: string }>;
    rules: CleanupRulesReceipt;
    terminalStatus: Readonly<{
      createdAt: string;
      serverDate: string;
      state: "error";
      statusId: number;
      statusNodeId: string;
      targetSha: string;
    }>;
  }>;
  readonly initial: CleanupPreflightReceipt;
  readonly postflight: CleanupPostflightReceipt;
  readonly revalidated: CleanupPreflightReceipt | null;
  readonly schema: "message-like-me-release-authority-cleanup-final-v2";
  readonly terminal: CleanupTerminalReceipt | null;
}

export interface CleanupIncompleteFinalReceipt {
  readonly complete: false;
  readonly evidence: Readonly<{
    initial: CleanupIncompleteEvidenceEntry<CleanupPreflightReceipt>;
    postflight: CleanupIncompleteEvidenceEntry<CleanupPostflightReceipt>;
    revalidated: CleanupIncompleteEvidenceEntry<CleanupPreflightReceipt>;
    terminal: CleanupIncompleteEvidenceEntry<CleanupTerminalReceipt>;
  }>;
  readonly failureSha256: string;
  readonly productionRefReadback: Readonly<{
    expectedSha: string;
    preserved: boolean;
    serverDate: string;
    sha: string;
  }> | null;
  readonly readbackFailureSha256: string | null;
  readonly repository: "hraness/textbutler";
  readonly runAttempt: 1;
  readonly runId: number;
  readonly schema: "message-like-me-release-authority-cleanup-incomplete-v2";
  readonly workflowSha: string;
}

export interface CleanupIncompleteEvidenceEntry<T> {
  readonly failureSha256: string | null;
  readonly receipt: Readonly<T> | null;
}

export type CleanupEnvironment = Readonly<Record<string, string | undefined>>;

export function encodeCleanupPreflightReceipt(value: unknown): string;
export function decodeCleanupPreflightReceipt(value: unknown): Readonly<CleanupPreflightReceipt>;
export function encodeCleanupTerminalReceipt(value: unknown): string;
export function decodeCleanupTerminalReceipt(value: unknown): Readonly<CleanupTerminalReceipt>;
export function encodeCleanupPostflightReceipt(value: unknown): string;
export function decodeCleanupPostflightReceipt(value: unknown): Readonly<CleanupPostflightReceipt>;
export function createCleanupPreflight(environment: CleanupEnvironment): Promise<Readonly<CleanupPreflightReceipt>>;
export function terminalizeCleanupAuthority(environment: CleanupEnvironment): Promise<Readonly<CleanupTerminalReceipt>>;
export function createCleanupPostflight(environment: CleanupEnvironment): Promise<Readonly<CleanupPostflightReceipt>>;
export function finalizeCleanupAuthority(environment: CleanupEnvironment): Promise<Readonly<CleanupFinalReceipt>>;
export function createCleanupIncompleteFinalReceipt(
  environment: CleanupEnvironment,
  error: unknown,
): Promise<Readonly<CleanupIncompleteFinalReceipt>>;
