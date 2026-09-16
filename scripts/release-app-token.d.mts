export interface ReleaseAppTokenEnvironment {
  readonly [key: string]: string | undefined;
}

export type ReleaseAppFetch = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface ReleaseAppTokenReceipt {
  readonly appId: number;
  readonly appSlug: string;
  readonly clientId: string;
  readonly expiresAt: string;
  readonly installationId: number;
  readonly repositoryId: number;
}

export interface ReleaseAppTokenRevocationReceipt {
  readonly converged: true;
  readonly deletionServerDate: string;
  readonly lastObservationServerDate: string;
  readonly observationCount: number;
  readonly propagationObserved: boolean;
  readonly stableDenials: 2;
}

export const MESSAGE_LIKE_ME_REPOSITORY_ID: 1342143606;
export const RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS: readonly [
  0,
  250,
  500,
  1000,
  2000,
  4000,
  8000,
  16000,
  24000,
  29000,
];

export function parseReleaseAppConfiguration(environment: ReleaseAppTokenEnvironment): Readonly<{
  apiUrl: URL;
  appId: number;
  appSlug: string;
  clientId: string;
  installationId: number;
  privateKey: string;
  repository: "hraness/textbutler";
  repositoryId: 1342143606;
}>;

export function createReleaseAppJwt(input: Readonly<{
  clientId: string;
  nowMilliseconds: number;
  privateKey: string;
}>): string;

export function releaseAppTokenRequestBody(): Readonly<{
  permissions: Readonly<{ metadata: "read"; statuses: "write" }>;
  repository_ids: readonly [1342143606];
}>;

export function parseReleaseAppIdentity(
  value: unknown,
  configuration: ReturnType<typeof parseReleaseAppConfiguration>,
): void;

export function parseReleaseAppInstallation(
  value: unknown,
  configuration: ReturnType<typeof parseReleaseAppConfiguration>,
): void;

export function parseReleaseAppTokenResponse(value: unknown, serverDate: unknown): Readonly<{
  expiresAt: string;
  permissions: Readonly<{ metadata: "read"; statuses: "write" }>;
  repositoryId: 1342143606;
  token: string;
}>;

export function withReleaseAppToken<Result>(options: Readonly<{
  environment: ReleaseAppTokenEnvironment;
  inspect(input: Readonly<{ apiUrl: URL; jwt: string }>): Promise<unknown>;
  inspectInstallation(input: Readonly<{
    apiUrl: URL;
    installationId: number;
    jwt: string;
  }>): Promise<unknown>;
  mask(token: string): void;
  mint(input: Readonly<{
    apiUrl: URL;
    body: ReturnType<typeof releaseAppTokenRequestBody>;
    installationId: number;
    jwt: string;
  }>): Promise<Readonly<{ body: unknown; serverDate: unknown }>>;
  nowMilliseconds(): number;
  onRevoked?(receipt: ReleaseAppTokenRevocationReceipt): void | Promise<void>;
  revoke(input: Readonly<{
    apiUrl: URL;
    expiresAt: unknown;
    token: string;
  }>): Promise<unknown>;
}>, operation: (token: string, receipt: ReleaseAppTokenReceipt) => Promise<Result>): Promise<Result>;

export function revokeReleaseAppTokenWithConvergence(input: Readonly<{
  apiUrl: URL;
  createTimeoutSignal?(milliseconds: number): AbortSignal;
  expiresAt: unknown;
  fetchImplementation?: ReleaseAppFetch;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  token: string;
}>): Promise<ReleaseAppTokenRevocationReceipt>;

export function withReleaseAppTokenFromEnvironment<Result>(
  environment: ReleaseAppTokenEnvironment,
  operation: (token: string, receipt: ReleaseAppTokenReceipt) => Promise<Result>,
  onRevoked?: (receipt: ReleaseAppTokenRevocationReceipt) => void | Promise<void>,
): Promise<Result>;
