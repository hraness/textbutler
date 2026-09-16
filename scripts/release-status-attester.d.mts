import type {
  ReleaseAppTokenEnvironment,
  ReleaseAppTokenReceipt,
  ReleaseAppTokenRevocationReceipt,
} from "./release-app-token.mjs";

export type ReleaseAuthorityStatusState = "error" | "success";
export type ReleaseProductionStatusContext =
  "message-like-me/website-production-authority";
export type ReleaseCanaryStatusContext =
  "message-like-me/website-production-writer-canary-authority";
export type ReleaseAuthorityStatusContext =
  | ReleaseProductionStatusContext
  | ReleaseCanaryStatusContext;

export interface ReleaseAuthorityStatusRequest<
  Context extends ReleaseAuthorityStatusContext = ReleaseProductionStatusContext,
  State extends ReleaseAuthorityStatusState = ReleaseAuthorityStatusState,
> {
  readonly body: Readonly<{
    context: Context;
    description: string;
    state: State;
    target_url: null;
  }>;
  readonly endpoint: string;
  readonly repository: "hraness/textbutler";
  readonly repositoryId: 1342143606;
  readonly targetSha: string;
}

export interface ReleaseAuthorityStatusReceipt<
  Context extends ReleaseAuthorityStatusContext = ReleaseProductionStatusContext,
  State extends ReleaseAuthorityStatusState = ReleaseAuthorityStatusState,
> {
  readonly appId: number;
  readonly appSlug: string;
  readonly context: Context;
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

export interface ReleaseAuthorityStatusReadbackReceipt<
  Context extends ReleaseAuthorityStatusContext = ReleaseProductionStatusContext,
> {
  readonly context: Context;
  readonly serverDate: string;
  readonly state: "failure";
  readonly statusCount: number;
  readonly targetSha: string;
  readonly terminalStatusId: number;
  readonly terminalStatusNodeId: string;
}

export type ReleaseAuthorityAttestationReceipt =
  ReleaseAuthorityStatusReceipt<ReleaseProductionStatusContext, "success">;
export type ReleaseAuthorityConsumptionReceipt =
  ReleaseAuthorityStatusReceipt<ReleaseProductionStatusContext, "error">;
export type ReleaseCanaryStatusRequest<
  State extends ReleaseAuthorityStatusState = ReleaseAuthorityStatusState,
> = ReleaseAuthorityStatusRequest<ReleaseCanaryStatusContext, State>;
export type ReleaseCanaryStatusReceipt<
  State extends ReleaseAuthorityStatusState = ReleaseAuthorityStatusState,
> = ReleaseAuthorityStatusReceipt<ReleaseCanaryStatusContext, State>;
export type ReleaseCanaryAttestationReceipt =
  ReleaseCanaryStatusReceipt<"success">;
export type ReleaseCanaryConsumptionReceipt =
  ReleaseCanaryStatusReceipt<"error">;
export type ReleaseCanaryStatusReadbackReceipt =
  ReleaseAuthorityStatusReadbackReceipt<ReleaseCanaryStatusContext>;

type StatusOptions<Context extends ReleaseAuthorityStatusContext> = Readonly<{
  app: ReleaseAppTokenReceipt;
  postStatus(
    request: Readonly<ReleaseAuthorityStatusRequest<Context>>,
  ): Promise<Readonly<{ body: unknown; serverDate: unknown }>>;
  readCombinedStatus(
    targetSha: string,
  ): Promise<Readonly<{ body: unknown; serverDate: unknown }>>;
  targetSha: unknown;
}>;

type TerminalStatusTransaction<Context extends ReleaseAuthorityStatusContext> = Readonly<{
  consumption: Readonly<ReleaseAuthorityStatusReceipt<Context, "error">>;
  readback: Readonly<ReleaseAuthorityStatusReadbackReceipt<Context>>;
}>;

export const RELEASE_AUTHORITY_STATUS_CONTEXT: ReleaseProductionStatusContext;
export const RELEASE_CANARY_STATUS_CONTEXT: ReleaseCanaryStatusContext;

export function releaseAuthorityStatusRequest(
  targetSha: unknown,
  state: "success",
): Readonly<ReleaseAuthorityStatusRequest<ReleaseProductionStatusContext, "success">>;
export function releaseAuthorityStatusRequest(
  targetSha: unknown,
  state: "error",
): Readonly<ReleaseAuthorityStatusRequest<ReleaseProductionStatusContext, "error">>;
export function releaseAuthorityStatusRequest(
  targetSha: unknown,
  state: unknown,
): Readonly<ReleaseAuthorityStatusRequest>;
export function releaseCanaryStatusRequest(
  targetSha: unknown,
  state: "success",
): Readonly<ReleaseCanaryStatusRequest<"success">>;
export function releaseCanaryStatusRequest(
  targetSha: unknown,
  state: "error",
): Readonly<ReleaseCanaryStatusRequest<"error">>;
export function releaseCanaryStatusRequest(
  targetSha: unknown,
  state: unknown,
): Readonly<ReleaseCanaryStatusRequest>;

export function parseReleaseAuthorityStatusResponse<
  State extends ReleaseAuthorityStatusState,
>(
  value: unknown,
  serverDate: unknown,
  input: Readonly<{
    app: ReleaseAppTokenReceipt;
    state: State;
    targetSha: unknown;
  }>,
): Readonly<ReleaseAuthorityStatusReceipt<ReleaseProductionStatusContext, State>>;
export function parseReleaseCanaryStatusResponse<
  State extends ReleaseAuthorityStatusState,
>(
  value: unknown,
  serverDate: unknown,
  input: Readonly<{
    app: ReleaseAppTokenReceipt;
    state: State;
    targetSha: unknown;
  }>,
): Readonly<ReleaseCanaryStatusReceipt<State>>;

export function parseReleaseAuthorityCombinedStatusResponse(
  value: unknown,
  serverDate: unknown,
  input: Readonly<{
    app: ReleaseAppTokenReceipt;
    consumption: Readonly<ReleaseAuthorityConsumptionReceipt>;
    targetSha: unknown;
  }>,
): Readonly<ReleaseAuthorityStatusReadbackReceipt>;
export function parseReleaseCanaryCombinedStatusResponse(
  value: unknown,
  serverDate: unknown,
  input: Readonly<{
    app: ReleaseAppTokenReceipt;
    consumption: Readonly<ReleaseCanaryConsumptionReceipt>;
    targetSha: unknown;
  }>,
): Readonly<ReleaseCanaryStatusReadbackReceipt>;

export function withReleaseAuthorityAttestation(
  options: Pick<StatusOptions<ReleaseProductionStatusContext>, "app" | "postStatus" | "targetSha">,
): Promise<Readonly<ReleaseAuthorityAttestationReceipt>>;
export function withReleaseCanaryAttestation(
  options: Pick<StatusOptions<ReleaseCanaryStatusContext>, "app" | "postStatus" | "targetSha">,
): Promise<Readonly<ReleaseCanaryAttestationReceipt>>;

export function withReleaseAuthorityTerminalStatus(
  options: StatusOptions<ReleaseProductionStatusContext>,
): Promise<TerminalStatusTransaction<ReleaseProductionStatusContext>>;
export function withReleaseCanaryTerminalStatus(
  options: StatusOptions<ReleaseCanaryStatusContext>,
): Promise<TerminalStatusTransaction<ReleaseCanaryStatusContext>>;

export function withReleaseAuthorityAttestationFromEnvironment(
  environment: ReleaseAppTokenEnvironment,
  onRevoked?: (
    receipt: ReleaseAppTokenRevocationReceipt,
  ) => void | Promise<void>,
): Promise<Readonly<ReleaseAuthorityAttestationReceipt>>;
export function withReleaseCanaryAttestationFromEnvironment(
  environment: ReleaseAppTokenEnvironment,
  onRevoked?: (
    receipt: ReleaseAppTokenRevocationReceipt,
  ) => void | Promise<void>,
): Promise<Readonly<ReleaseCanaryAttestationReceipt>>;

export function withReleaseAuthorityTerminalStatusFromEnvironment(
  environment: ReleaseAppTokenEnvironment,
  onRevoked?: (
    receipt: ReleaseAppTokenRevocationReceipt,
  ) => void | Promise<void>,
): Promise<TerminalStatusTransaction<ReleaseProductionStatusContext>>;
export function withReleaseCanaryTerminalStatusFromEnvironment(
  environment: ReleaseAppTokenEnvironment,
  onRevoked?: (
    receipt: ReleaseAppTokenRevocationReceipt,
  ) => void | Promise<void>,
): Promise<TerminalStatusTransaction<ReleaseCanaryStatusContext>>;
