export const SITE_REPOSITORY: string;
export const SITE_REPOSITORY_ID: number;
export const SITE_WORKFLOW_PATH: string;
export const SITE_ARTIFACT_NAME: string;
export const SITE_REQUIRED_CI_JOBS: readonly string[];

export function siteDigest(value: unknown): string;
export function siteRecord(value: unknown, keys?: readonly string[], label?: string): Readonly<Record<string, unknown>>;
export function siteSha(value: unknown, label?: string): string;
export function siteId(value: unknown, label?: string): number;
export function siteTimestamp(value: unknown, label?: string): string;
export function parseSiteSubject(value: unknown): unknown;
export function parseSiteBuildManifest(value: unknown): unknown;
export function admitSiteCiRun(input: unknown): Readonly<{ runId: number; runAttempt: number; completedAt: string }>;
export function revalidateSiteSource(api: unknown, input: unknown): Promise<Readonly<{ runId: number; runAttempt: number; completedAt: string }>>;
export function revalidateSiteSubject(api: unknown, value: unknown): Promise<unknown>;
