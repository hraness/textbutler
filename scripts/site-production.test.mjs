import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { admitSiteCiRun, parseSiteSubject, revalidateSiteSource, revalidateSiteSubject, SITE_REQUIRED_CI_JOBS,
  SITE_REPOSITORY as repo, SITE_REPOSITORY_ID as repoId, siteDigest } from "./site-production-subject.mjs";
import { assertSiteInvocation, assertConsumedSiteStatus, proveSiteProductionDenial, promoteSiteProduction, siteMain, siteReceiptDigest } from "./site-production.mjs";
import { encodeProviderReceipt } from "./release-provider-outcome.mjs";
import { createProductionAuthorityAttestedReceipt, createProductionAuthorityConsumedReceipt,
  encodeProductionAuthorityPhaseReceipt, finalizeProductionAuthority } from "./release-production-authority.mjs";
import { describeControlEpoch, verifySiteWorkflowAdmission, assertSiteWorkflowAdmissionReceipt,
  encodeWorkflowAdmissionReceipt, decodeWorkflowAdmissionReceipt } from "./release-workflow-range.mjs";
import { advanceWebsiteProductionSiteRef } from "./release-ref-writer.mjs";

const oldSha = "1".repeat(40), sha = "2".repeat(40), context = "message-like-me/website-production-authority";
const identity = { id: repoId, full_name: repo };
const subject = Object.freeze({ kind: "site", sourceSha: sha, ciRunId: 10, ciRunAttempt: 1, buildRunId: 20, buildRunAttempt: 1,
  buildArtifactId: 30, buildArtifactDigest: `sha256:${"a".repeat(64)}`, manifestDigest: "b".repeat(64),
  buildCompletedAt: "2026-09-11T10:01:00.000Z", sourceQualifiedAt: "2026-09-11T10:00:00.000Z" });
function ciFixture() {
  const run = { id: 10, run_attempt: 1, workflow_id: 7, path: ".github/workflows/ci.yml", name: "CI", event: "push",
    head_branch: "main", head_sha: sha, status: "completed", conclusion: "success", repository: identity, head_repository: identity };
  const workflow = { id: 7, path: run.path, name: "CI", state: "active" };
  const jobs = SITE_REQUIRED_CI_JOBS.map(name => ({ name, run_id: 10, run_attempt: 1, head_sha: sha,
    status: "completed", conclusion: "success", completed_at: "2026-09-11T10:00:00Z" }));
  return { run, workflow, jobs, sourceSha: sha, runId: 10, runAttempt: 1 };
}
function sourceApi(changes = {}) {
  const fixture = ciFixture();
  const values = {
    [`/repos/${repo}`]: { ...identity, default_branch: "main" },
    [`/repos/${repo}/git/ref/heads/main`]: { ref: "refs/heads/main", object: { type: "commit", sha } },
    [`/repos/${repo}/actions/workflows/ci.yml`]: fixture.workflow,
    [`/repos/${repo}/actions/runs/10`]: fixture.run,
    [`/repos/${repo}/actions/runs/10/attempts/1`]: fixture.run,
    [`/repos/${repo}/actions/runs/10/attempts/1/jobs?per_page=100`]: { total_count: SITE_REQUIRED_CI_JOBS.length, jobs: fixture.jobs },
    [`/repos/${repo}/actions/artifacts/30`]: { id: 30, name: "textbutler-site-build", expired: false,
      digest: subject.buildArtifactDigest, size_in_bytes: 1000, created_at: "2026-09-11T10:01:00Z", workflow_run: { id: 20, head_sha: sha } },
    [`/repos/${repo}/actions/runs/20/attempts/1`]: { id: 20, run_attempt: 1, workflow_id: 8,
      path: ".github/workflows/website-production.yml", event: "workflow_dispatch", head_branch: "main", head_sha: sha,
      status: "in_progress", conclusion: null, repository: identity, head_repository: identity },
    [`/repos/${repo}/actions/workflows/website-production.yml`]: { id: 8, path: ".github/workflows/website-production.yml",
      name: "Promote website production", state: "active" },
    ...changes,
  };
  return { values, get: async path => { if (!(path in values)) throw new Error(`unexpected test request ${path}`); return structuredClone(values[path]); } };
}

describe("site source and artifact admission", () => {
  test("admits only an explicit site subject and exact successful current-main CI jobs", async () => {
    expect(parseSiteSubject(subject)).toEqual(subject);
    expect(admitSiteCiRun(ciFixture()).completedAt).toBe(subject.sourceQualifiedAt);
    expect(await revalidateSiteSubject(sourceApi(), subject)).toEqual(subject);
    expect(() => parseSiteSubject({ ...subject, verifiedTag: "v0.8.9" })).toThrow("unexpected keys");
    expect(() => parseSiteSubject({ ...subject, kind: "release" })).toThrow();
  });
  test("rejects missing, skipped, failed, duplicated, and wrong-attempt CI jobs", () => {
    for (const change of [f => f.jobs.pop(), f => { f.jobs[0].conclusion = "skipped"; },
      f => { f.jobs[0].conclusion = "failure"; }, f => { f.jobs[0].name = f.jobs[1].name; },
      f => { f.jobs[0].run_attempt = 2; }, f => { f.run.event = "pull_request"; }]) {
      const fixture = ciFixture(); change(fixture); expect(() => admitSiteCiRun(fixture)).toThrow();
    }
  });
  test("rejects advancing main and a CI run rerun after the selected successful attempt", async () => {
    const api = sourceApi(); api.values[`/repos/${repo}/git/ref/heads/main`].object.sha = oldSha;
    await expect(revalidateSiteSource(api, subject)).rejects.toThrow("current main");
    const rerun = sourceApi(); rerun.values[`/repos/${repo}/actions/runs/10`] = { ...ciFixture().run, run_attempt: 2, conclusion: "failure" };
    await expect(revalidateSiteSource(rerun, subject)).rejects.toThrow("rerun");
  });
  test("rejects substituted artifact run, digest, source, expiry, and completed promotion", async () => {
    for (const change of [a => { a.workflow_run.id = 99; }, a => { a.workflow_run.head_sha = oldSha; },
      a => { a.digest = `sha256:${"c".repeat(64)}`; }, a => { a.expired = true; }]) {
      const api = sourceApi(); change(api.values[`/repos/${repo}/actions/artifacts/30`]);
      await expect(revalidateSiteSubject(api, subject)).rejects.toThrow("artifact");
    }
    const api = sourceApi(); api.values[`/repos/${repo}/actions/runs/20/attempts/1`].status = "completed";
    await expect(revalidateSiteSubject(api, subject)).rejects.toThrow("artifact");
  });
  test("dispatch cannot mix a package tag, stale checkout, or a repeated promotion attempt", () => {
    const env = { SITE_SOURCE_SHA: sha, SITE_CI_RUN_ID: "10", SITE_CI_RUN_ATTEMPT: "1", GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha,
      GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: String(repoId), GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "20" };
    expect(assertSiteInvocation(env).sourceSha).toBe(sha);
    for (const change of [{ SITE_RELEASE_TAG: "v0.8.9" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_SHA: oldSha }]) {
      expect(() => assertSiteInvocation({ ...env, ...change })).toThrow();
    }
  });
});

function status(state, id, at) {
  return { appId: 4830612, appSlug: "mlm-prod-ref-writer-1342143606", context, createdAt: at.replace(".000Z", "Z"),
    creator: { id: 123, login: "mlm-prod-ref-writer-1342143606[bot]", nodeId: "BOT_123" },
    description: state === "success" ? "Exact release authority admitted for one production-ref attempt" : "Release authority consumed after the production-ref attempt",
    installationId: 159058102, repository: repo, repositoryId: repoId, serverDate: at, state,
    statusId: id, statusNodeId: `STATUS_${id}`, statusUrl: `https://api.github.com/repos/${repo}/statuses/${sha}`, targetSha: sha };
}
function revocation(at) { return { converged: true, deletionServerDate: at, lastObservationServerDate: at,
  observationCount: 2, propagationObserved: false, stableDenials: 2 }; }
function consumed(at, attested, promotionDigest) {
  const item = status("error", 42, at);
  return createProductionAuthorityConsumedReceipt(sha, attested, promotionDigest, { consumption: item,
    readback: { context, serverDate: at, state: "failure", statusCount: 1, targetSha: sha,
      terminalStatusId: item.statusId, terminalStatusNodeId: item.statusNodeId } }, revocation(at));
}
function combined(item) {
  return { commit_url: `https://api.github.com/repos/${repo}/commits/${sha}`, repository: { ...identity, name: "textbutler", owner: { login: "hraness", type: "Organization" } },
    sha, state: item.state === "success" ? "success" : "failure", statuses: [{ context, created_at: item.createdAt,
      description: item.description, id: item.statusId, node_id: item.statusNodeId, state: item.state, target_url: null,
      updated_at: item.createdAt, url: item.statusUrl }], total_count: 1, url: `https://api.github.com/repos/${repo}/commits/${sha}/status` };
}
function rules(at) {
  const rule = { parameters: { do_not_enforce_on_create: false, required_status_checks: [{ context, integration_id: 4830612 }],
    strict_required_status_checks_policy: false }, type: "required_status_checks" };
  const base = (id, name, entries) => ({ _links: { html: { href: `https://github.com/${repo}/rules/${id}` },
    self: { href: `https://api.github.com/repos/${repo}/rulesets/${id}` } }, bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/website-production"] } }, current_user_can_bypass: "never",
    enforcement: "active", id, name, rules: entries, source: repo, source_type: "Repository", target: "branch" });
  const life = ["creation", "deletion", "non_fast_forward"];
  return { authority: { body: base(22290922, "Message Like Me production status authority", [rule]), serverDate: at },
    lifecycle: { body: base(21821875, "Immutable website-production lifecycle", life.map(type => ({ type }))), serverDate: at },
    effective: { body: [...life.map(type => ({ ruleset_id: 21821875, ruleset_source: repo, ruleset_source_type: "Repository", type })),
      { ...rule, ruleset_id: 22290922, ruleset_source: repo, ruleset_source_type: "Repository" }], serverDate: at } };
}
function promotionFixture() {
  const api = sourceApi(); let ref = oldSha, tick = Date.parse("2026-09-11T10:04:00.000Z"), currentStatus;
  const next = () => new Date(tick += 1000).toISOString();
  api.values[`/repos/${repo}/compare/${oldSha}...${sha}`] = { ahead_by: 1, behind_by: 0, status: "ahead",
    base_commit: { sha: oldSha }, merge_base_commit: { sha: oldSha }, commits: [{ sha }], total_commits: 1 };
  api.getRules = async () => rules(next());
  api.getWithServerDate = async path => {
    if (path.endsWith("/git/ref/heads/website-production")) return { body: { ref: "refs/heads/website-production", object: { type: "commit", sha: ref } }, serverDate: next() };
    if (path.endsWith("/status?per_page=100")) return { body: combined(currentStatus), serverDate: next() };
    throw new Error(`unexpected Date request ${path}`);
  };
  api.getRef = async () => ({ body: ref, serverDate: next() });
  api.getCombinedStatus = async () => ({ body: combined(currentStatus), serverDate: next() });
  const baseline = { completedAt: "2026-09-11T10:02:00.000Z", deploymentFingerprint: siteDigest([]), deploymentIds: [],
    lowerBound: "2026-09-11T10:02:00.000Z", productionRef: "refs/heads/website-production", refSha: oldSha,
    repository: repo, schema: "message-like-me-provider-baseline-v1", verifiedSha: sha };
  const workflow = { newCommitCount: 1, newCommitDigest: "c".repeat(64), previousSha: oldSha, verifiedSha: sha,
    workflowTreeOid: "4".repeat(40), productionRef: "refs/heads/website-production", schema: "message-like-me-workflow-range-v1" };
  return { api, baseline, workflow, next, setStatus: value => { currentStatus = value; },
    advance: () => { ref = sha; return { classification: "fast-forward", fromSha: oldSha, toSha: sha,
      protectedRef: "refs/heads/website-production", summarySha256: "d".repeat(64) }; } };
}

test("site deny→attest→leased advance→consume finalizes with no legacy release lookup", async () => {
  const f = promotionFixture();
  const precondition = consumed("2026-09-11T10:03:00.000Z");
  const denial = await proveSiteProductionDenial({ api: f.api, subject, baselineReceipt: f.baseline,
    preconditionReceipt: encodeProductionAuthorityPhaseReceipt(precondition), workflowReceipt: f.workflow,
    denyRef: async () => ({ classification: "required-status-errored", diagnosticSha256: "e".repeat(64) }) });
  const success = status("success", 41, f.next()); f.setStatus(success);
  const attested = createProductionAuthorityAttestedReceipt(sha, success, revocation(f.next()));
  let sends = 0;
  const input = { api: f.api, subject, baselineReceipt: f.baseline, denialReceipt: denial,
    attestationReceipt: encodeProductionAuthorityPhaseReceipt(attested), workflowReceipt: f.workflow,
    advanceRef: async () => { sends++; return f.advance(); } };
  await expect(promoteSiteProduction({ ...input, denialReceipt: { ...denial, subject: { ...subject, buildArtifactId: 99 } } })).rejects.toThrow();
  const legacyDenial = { ...denial, schema: "message-like-me-production-required-status-denial-v3", verifiedTag: "v0.8.9" };
  delete legacyDenial.subject;
  await expect(promoteSiteProduction({ ...input, denialReceipt: legacyDenial })).rejects.toThrow();
  expect(sends).toBe(0);
  const promotion = await promoteSiteProduction(input);
  expect(sends).toBe(1); expect(promotion.subject.kind).toBe("site"); expect(promotion.verifiedTag).toBeUndefined();
  // The consumption workflow receives the emitted output, not the object's
  // self-digest field. Hashing the self-digest again breaks this binding.
  expect(siteReceiptDigest(promotion)).toBe(promotion.receiptSha256);
  expect(siteReceiptDigest(promotion)).not.toBe(siteDigest(promotion));
  const consumption = consumed(f.next(), attested, siteReceiptDigest(promotion)); f.setStatus(consumption.status);
  const final = await finalizeProductionAuthority({ api: f.api, preconditionReceipt: precondition, denialReceipt: denial,
    attestationReceipt: attested, consumptionReceipt: consumption, promotion });
  expect(final.schema).toBe("textbutler-site-authority-final-v1");
  await expect(finalizeProductionAuthority({ api: f.api, preconditionReceipt: precondition, denialReceipt: legacyDenial,
    attestationReceipt: attested, consumptionReceipt: consumption, promotion })).rejects.toThrow();
  const environment = { SITE_SOURCE_SHA: sha, SITE_CI_RUN_ID: "10", SITE_CI_RUN_ATTEMPT: "1", GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: String(repoId), GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "20",
    SITE_SUBJECT_RECEIPT: encodeProviderReceipt(subject), SITE_BASELINE_RECEIPT: encodeProviderReceipt(f.baseline),
    SITE_WORKFLOW_RECEIPT: encodeWorkflowAdmissionReceipt(f.workflow), SITE_DENIAL_RECEIPT: encodeProviderReceipt(denial),
    SITE_PROMOTION_RECEIPT: encodeProviderReceipt(promotion), AUTHORITY_PRECONDITION_RECEIPT: encodeProductionAuthorityPhaseReceipt(precondition),
    AUTHORITY_ATTESTATION_RECEIPT: encodeProductionAuthorityPhaseReceipt(attested), AUTHORITY_CONSUMPTION_RECEIPT: encodeProductionAuthorityPhaseReceipt(consumption) };
  // Exercise the real CLI wire boundary: environment receipts are encoded.
  await expect(siteMain("finalize", environment, { api: f.api })).resolves.toBeUndefined();
  for (const command of ["finalize", "wait"]) {
    await expect(siteMain(command, { ...environment, AUTHORITY_CONSUMPTION_RECEIPT: "invalid" }, { api: f.api })).rejects.toThrow();
    const wrongConsumption = consumed(f.next(), attested, siteDigest(promotion));
    await expect(siteMain(command, { ...environment, AUTHORITY_CONSUMPTION_RECEIPT: encodeProductionAuthorityPhaseReceipt(wrongConsumption) }, { api: f.api })).rejects.toThrow("one exact promotion");
  }
  expect(() => siteReceiptDigest({ ...promotion, receiptSha256: "0".repeat(64) })).toThrow("digest");
});

test("already-exact recovery refuses unconsumed or impersonated status without requesting a key", async () => {
  const terminal = status("error", 42, "2026-09-11T10:05:00.000Z");
  const actor = { id: 123, node_id: "BOT_123", login: "mlm-prod-ref-writer-1342143606[bot]", type: "Bot" };
  const api = { get: async path => path.startsWith("/users/") ? actor : path.includes("/statuses?") ? [{ ...combined(terminal).statuses[0], creator: actor }] : combined(terminal) };
  await expect(assertConsumedSiteStatus(api, subject)).resolves.toBeUndefined();
  await expect(assertConsumedSiteStatus({ get: async () => combined(status("success", 41, terminal.serverDate)) }, subject)).rejects.toThrow("cleanup");
  await expect(assertConsumedSiteStatus({ get: async path => path.includes("/statuses?") ? [{ ...combined(terminal).statuses[0], creator: { login: "someone", type: "User" } }] : combined(terminal) }, subject)).rejects.toThrow("exact status App");
});

test("site control epoch binds complete workflow changes to current main without a tag", () => {
  const root = mkdtempSync(join(tmpdir(), "textbutler-site-control-"));
  const git = (...args) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  try {
    git("init", "--initial-branch=main"); git("config", "user.name", "Site fixture"); git("config", "user.email", "site@example.invalid");
    mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/site.yml"), "name: before\n");
    git("add", "."); git("commit", "-m", "before"); const previousSha = git("rev-parse", "HEAD");
    writeFileSync(join(root, ".github/workflows/site.yml"), "name: after\n"); git("add", "."); git("commit", "-m", "after"); const targetSha = git("rev-parse", "HEAD");
    const input = { repository: repo, repositoryId: repoId, mode: "site", protectedRef: "refs/heads/website-production", tag: null,
      previousSha, targetSha, workflowSha: targetSha, currentMainSha: targetSha, workingDirectory: root,
      githubActions: "true", eventName: "workflow_dispatch", eventRef: "refs/heads/main", eventSha: targetSha, runAttempt: 1 };
    const description = describeControlEpoch(input);
    expect(() => verifySiteWorkflowAdmission(input)).toThrow("reviewed");
    const receipt = verifySiteWorkflowAdmission({ ...input, controlEpochDigest: description.digest });
    expect(receipt.schema).toBe("textbutler-site-control-epoch-v1"); expect(receipt.tag).toBeNull();
    expect(assertSiteWorkflowAdmissionReceipt(decodeWorkflowAdmissionReceipt(encodeWorkflowAdmissionReceipt(receipt)), { previousSha, targetSha })).toEqual(receipt);
    expect(() => verifySiteWorkflowAdmission({ ...input, currentMainSha: previousSha, controlEpochDigest: description.digest })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("site sterile writer never pushes when current main or expected old ref changed", () => {
  for (const wrongRef of ["production", "main"]) {
    const calls = [];
    const spawnImplementation = (_command, args) => {
      calls.push(args);
      let stdout = "";
      if (args.includes("--list")) stdout = "core.repositoryformatversion\n0\0core.filemode\ntrue\0core.bare\ntrue\0";
      if (args.includes("rev-parse")) stdout = `${args.at(-1).includes("/canary") ? (wrongRef === "production" ? "3".repeat(40) : oldSha) : (wrongRef === "main" ? "3".repeat(40) : sha)}\n`;
      return { status: 0, stdout, stderr: "", error: undefined };
    };
    expect(() => advanceWebsiteProductionSiteRef({ repository: repo, targetSha: sha, workflowSha: sha,
      expectedOldSha: oldSha, environment: { MLM_RELEASE_REF_TOKEN: "fixture-token" }, spawnImplementation })).toThrow();
    expect(calls.some(args => args.includes("push"))).toBe(false);
  }
});

test("workflow keeps site cancellation consumption, key separation, shared concurrency, and read-only recovery", () => {
  const source = readFileSync(new URL("../.github/workflows/website-production.yml", import.meta.url), "utf8");
  const site = source.slice(source.indexOf("  site_build:"));
  expect(source).toContain("group: website-production-promotion");
  expect(site).toContain("if: ${{ always() && steps.admitted.outcome == 'success' }}");
  expect(site).toContain("node ./scripts/release-production-authority.mjs consume");
  expect(site).toContain("textbutler-site-attempt");
  expect(site).toContain("node ./scripts/site-production.mjs qualify");
  const recovery = site.slice(site.indexOf("  site_provider_outcome:"));
  expect(recovery).not.toContain("secrets."); expect(recovery).not.toContain("MLM_RELEASE_REF_TOKEN");
  expect(site).not.toContain("npm publish"); expect(site).not.toContain("check-public-release");
  const hashes = [...site.matchAll(/^          ([0-9a-f]{64})  (scripts\/[^\n]+)$/gmu)];
  expect(hashes.length).toBeGreaterThan(50);
  for (const [, hash, path] of hashes) expect(createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex")).toBe(hash);
});
