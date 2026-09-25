import { parseSiteSubject } from "./release-production-authority.mjs";
import { createHash } from "node:crypto";

export const SITE_REPOSITORY = "hraness/textbutler";
export const SITE_REPOSITORY_ID = 1342143606;
export const SITE_WORKFLOW_PATH = ".github/workflows/website-production.yml";
export const SITE_ARTIFACT_NAME = "textbutler-site-build";
/** Jobs `ci.yml` runs on every push, in workflow order. */
export const SITE_ALWAYS_CI_JOBS = Object.freeze([
  "Detect changed paths",
  "Standalone package",
  "Tests",
  "Textbutler packages",
  "Required",
]);
/** Conditional jobs; they must succeed whenever changed paths schedule them. */
export const SITE_CONDITIONAL_CI_JOBS = Object.freeze([
  "Site",
  "macOS synthetic Messages and Contacts fixtures",
]);
/** The closed inventory every admitted run's job names must stay inside. */
export const SITE_REQUIRED_CI_JOBS = Object.freeze([
  ...SITE_ALWAYS_CI_JOBS,
  ...SITE_CONDITIONAL_CI_JOBS,
]);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[1-9][0-9]*$/u;

export function siteDigest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function siteRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (keys !== undefined && JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
  return value;
}

export function siteSha(value, label = "site source SHA") {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function siteId(value, label) {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value > 0) &&
      !(typeof value === "string" && ID.test(value) && Number.isSafeInteger(Number(value)))) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

export function siteTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")) {
    throw new Error(`${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function sha256(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export { parseSiteSubject } from "./release-production-authority.mjs";

export function parseSiteBuildManifest(value) {
  const item = siteRecord(value, [
    "schema", "repository", "repositoryId", "sourceSha", "sourceTree", "siteTree",
    "siteLockSha256", "buildManifestSha256", "ciRunId", "ciRunAttempt", "buildRunId", "buildRunAttempt",
  ], "site build manifest");
  if (item.schema !== "textbutler-site-build-v1" || item.repository !== SITE_REPOSITORY || item.repositoryId !== SITE_REPOSITORY_ID) {
    throw new Error("site build manifest has the wrong identity");
  }
  return Object.freeze({
    schema: item.schema,
    repository: SITE_REPOSITORY,
    repositoryId: SITE_REPOSITORY_ID,
    sourceSha: siteSha(item.sourceSha),
    sourceTree: siteSha(item.sourceTree, "site source tree"),
    siteTree: siteSha(item.siteTree, "site subtree"),
    siteLockSha256: sha256(item.siteLockSha256, "site lockfile digest"),
    buildManifestSha256: sha256(item.buildManifestSha256, "site Next build manifest digest"),
    ciRunId: siteId(item.ciRunId, "site CI run"),
    ciRunAttempt: siteId(item.ciRunAttempt, "site CI attempt"),
    buildRunId: siteId(item.buildRunId, "site build run"),
    buildRunAttempt: siteId(item.buildRunAttempt, "site build attempt"),
  });
}

function repository(value, label) {
  const repo = siteRecord(value, undefined, label);
  if (repo.full_name !== SITE_REPOSITORY || repo.id !== SITE_REPOSITORY_ID) throw new Error(`${label} has the wrong identity`);
}

export function admitSiteCiRun({ run, workflow, jobs, sourceSha, runId, runAttempt }) {
  siteSha(sourceSha);
  repository(run.repository, "CI repository");
  repository(run.head_repository, "CI head repository");
  if (run.id !== siteId(runId, "CI run") || run.run_attempt !== siteId(runAttempt, "CI attempt") ||
      run.workflow_id !== workflow.id || workflow.path !== ".github/workflows/ci.yml" || workflow.name !== "CI" ||
      workflow.state !== "active" || run.path !== ".github/workflows/ci.yml" || run.name !== "CI" ||
      run.event !== "push" || run.head_branch !== "main" || run.head_sha !== sourceSha ||
      run.status !== "completed" || run.conclusion !== "success" ||
      !Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("site requires the exact successful current-main CI run");
  }
  const known = new Set(SITE_REQUIRED_CI_JOBS);
  const always = new Set(SITE_ALWAYS_CI_JOBS);
  const conditional = new Set(SITE_CONDITIONAL_CI_JOBS);
  const present = new Set(jobs.map(job => job.name));
  if (jobs.some(job => !known.has(job.name)) || ![...always].every(name => present.has(name)) ||
      jobs.some(job => job.run_id !== run.id || job.run_attempt !== run.run_attempt ||
        job.head_sha !== sourceSha || job.status !== "completed" ||
        job.conclusion !== (conditional.has(job.name) && job.conclusion === "skipped" ? "skipped" : "success"))) {
    throw new Error("site CI required jobs are missing, stale, skipped, or failed");
  }
  const completedAt = new Date(Math.max(...jobs.map(job => Date.parse(siteTimestamp(job.completed_at, "CI job completion"))))).toISOString();
  return Object.freeze({ runId: run.id, runAttempt: run.run_attempt, completedAt });
}

export async function revalidateSiteSource(api, input) {
  const sourceSha = siteSha(input.sourceSha);
  const [repo, ref, workflow, run, jobs, currentRun] = await Promise.all([
    api.get(`/repos/${SITE_REPOSITORY}`),
    api.get(`/repos/${SITE_REPOSITORY}/git/ref/heads/main`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/workflows/ci.yml`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/runs/${siteId(input.ciRunId, "CI run")}/attempts/${siteId(input.ciRunAttempt, "CI attempt")}`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/runs/${siteId(input.ciRunId, "CI run")}/attempts/${siteId(input.ciRunAttempt, "CI attempt")}/jobs?per_page=100`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/runs/${siteId(input.ciRunId, "CI run")}`),
  ]);
  repository(repo, "site repository");
  if (repo.default_branch !== "main" || ref.ref !== "refs/heads/main" || ref.object?.type !== "commit" || ref.object.sha !== sourceSha) {
    throw new Error("site source is no longer exact current main");
  }
  if (jobs.total_count !== jobs.jobs?.length) throw new Error("CI jobs inventory is incomplete");
  if (currentRun.id !== run.id || currentRun.run_attempt !== run.run_attempt || currentRun.status !== "completed" ||
      currentRun.conclusion !== "success" || currentRun.head_sha !== sourceSha) throw new Error("site CI run was rerun or is no longer successful");
  return admitSiteCiRun({ run, workflow, jobs: jobs.jobs, sourceSha, runId: input.ciRunId, runAttempt: input.ciRunAttempt });
}

export async function revalidateSiteSubject(api, value) {
  const subject = parseSiteSubject(value);
  const ci = await revalidateSiteSource(api, subject);
  if (ci.completedAt !== subject.sourceQualifiedAt || Date.parse(subject.sourceQualifiedAt) > Date.parse(subject.buildCompletedAt)) {
    throw new Error("site source qualification does not bind successful CI completion");
  }
  const [artifact, run, workflow] = await Promise.all([
    api.get(`/repos/${SITE_REPOSITORY}/actions/artifacts/${subject.buildArtifactId}`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/runs/${subject.buildRunId}/attempts/${subject.buildRunAttempt}`),
    api.get(`/repos/${SITE_REPOSITORY}/actions/workflows/website-production.yml`),
  ]);
  repository(run.repository, "site build repository");
  repository(run.head_repository, "site build head repository");
  if (run.id !== subject.buildRunId || run.run_attempt !== subject.buildRunAttempt || run.workflow_id !== workflow.id ||
      workflow.path !== SITE_WORKFLOW_PATH || workflow.name !== "Promote website production" || workflow.state !== "active" ||
      run.path !== SITE_WORKFLOW_PATH || run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
      run.head_sha !== subject.sourceSha || run.status !== "in_progress" || run.conclusion !== null ||
      artifact.id !== subject.buildArtifactId || artifact.name !== SITE_ARTIFACT_NAME || artifact.expired !== false ||
      artifact.digest !== subject.buildArtifactDigest || !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 || artifact.size_in_bytes > 64 * 1024 ||
      artifact.workflow_run?.id !== subject.buildRunId || artifact.workflow_run.head_sha !== subject.sourceSha ||
      siteTimestamp(artifact.created_at, "artifact creation") !== subject.buildCompletedAt) {
    throw new Error("site build artifact is not bound to this exact running promotion");
  }
  return subject;
}
