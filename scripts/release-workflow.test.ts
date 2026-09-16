import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { chooseNpmWriterTransition } from "./publish-npm-release";

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const ROOT_GUIDE = join(import.meta.dir, "..", "AGENTS.md");
const SITE_GUIDE = join(import.meta.dir, "..", "site", "AGENTS.md");
const CODEOWNERS = join(import.meta.dir, "..", ".github", "CODEOWNERS");
const PUBLISHING_GUIDE = join(import.meta.dir, "..", "docs", "publishing.md");
const APP_TOKEN_HELPER = join(import.meta.dir, "release-app-token.mjs");
const PROVIDER_HELPER = join(import.meta.dir, "release-provider-outcome.mjs");
const REF_WRITER_HELPER = join(import.meta.dir, "release-ref-writer.mjs");
const STATUS_ATTESTER_HELPER = join(import.meta.dir, "release-status-attester.mjs");
const PRODUCTION_AUTHORITY_HELPER = join(import.meta.dir, "release-production-authority.mjs");
const CANARY_HELPER = join(import.meta.dir, "release-writer-canary.mjs");
const CLEANUP_HELPER = join(import.meta.dir, "release-authority-cleanup.mjs");
const NPM_PUBLISHER = join(import.meta.dir, "publish-npm-release.ts");
const NPM_PROVENANCE = join(import.meta.dir, "npm-provenance-verification.ts");
const NPM_RETRY = join(import.meta.dir, "check-npm-retry-state.ts");
const PUBLIC_ADMISSION = join(import.meta.dir, "check-public-release.ts");
const GITHUB_ADMISSION = join(import.meta.dir, "check-github-release.ts");
const GITHUB_PUBLISHER = join(import.meta.dir, "publish-github-release.ts");
const REF_AUTHORITY = join(import.meta.dir, "release-ref-authority.ts");
const WORKFLOW_RANGE = join(import.meta.dir, "release-workflow-range.mjs");
const SIGNER_VERIFIER = join(import.meta.dir, "verify-npm-provenance-signer.mjs");
const PACKAGE_MANIFEST = join(import.meta.dir, "..", "package.json");

function expectEveryPin(
  workflow: string,
  name: string,
  source: string,
  expectedCount: number,
) {
  const values = [...workflow.matchAll(new RegExp(`${name}: ([0-9a-f]{64})`, "gu"))]
    .map((match) => match[1]);
  expect(values).toHaveLength(expectedCount);
  expect(new Set(values)).toEqual(new Set([
    createHash("sha256").update(source).digest("hex"),
  ]));
}

test("CI runs the standalone package on Ubuntu and only synthetic local-data fixtures on macOS", async () => {
  const workflow = await readFile(join(WORKFLOWS, "ci.yml"), "utf8");

  expect(workflow).toContain("runs-on: ubuntu-24.04");
  expect(workflow).toContain("runs-on: macos-15");
  expect(workflow.match(/bun-version: "1\.3\.14"/gu)?.length).toBe(2);
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun test src/imessage.test.ts src/contacts.test.ts src/metrics.test.ts");
  expect(workflow).toContain("HOME: ${{ runner.temp }}/message-like-me-fixture-home");
  expect(workflow).toContain("git status --porcelain --untracked-files=all -- dist bun.lock");
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).not.toContain("workflow_dispatch:");
  expect(workflow).not.toContain("Library/Messages/chat.db");
});

test("npm writer recovery admits only ordered, unambiguous rerun transitions", () => {
  expect(chooseNpmWriterTransition({
    currentAttempt: 1,
    preflightAttempt: 1,
    preflightState: "absent",
    releaseExists: false,
  })).toBe("publish");
  expect(chooseNpmWriterTransition({
    currentAttempt: 3,
    preflightAttempt: 1,
    preflightState: "absent",
    releaseExists: false,
  })).toBe("publish");
  expect(chooseNpmWriterTransition({
    currentAttempt: 2,
    preflightAttempt: 1,
    preflightState: "absent",
    releaseExists: true,
  })).toBe("observe_existing");
  expect(chooseNpmWriterTransition({
    currentAttempt: 3,
    preflightAttempt: 1,
    preflightState: "exact_same_run",
    releaseExists: true,
  })).toBe("observe_existing");
  expect(() => chooseNpmWriterTransition({
    currentAttempt: 1,
    preflightAttempt: 1,
    preflightState: "absent",
    releaseExists: true,
  })).toThrow("appeared during the admitted attempt");
  expect(() => chooseNpmWriterTransition({
    currentAttempt: 2,
    preflightAttempt: 3,
    preflightState: "absent",
    releaseExists: false,
  })).toThrow("ordered positive preflight and writer attempt");
  expect(() => chooseNpmWriterTransition({
    currentAttempt: 2,
    preflightAttempt: 1,
    preflightState: "exact_same_run",
    releaseExists: false,
  })).toThrow("disappeared after retry admission");
});

test("tag releases use annotated-tag authority and split exact GitHub-first and npm writers", async () => {
  const [
    workflow,
    npmPublisher,
    npmProvenance,
    npmRetry,
    publicAdmission,
    githubAdmission,
    githubPublisher,
    refAuthority,
    signerVerifier,
    packageManifest,
  ] = await Promise.all([
    readFile(join(WORKFLOWS, "release.yml"), "utf8"),
    readFile(NPM_PUBLISHER, "utf8"),
    readFile(NPM_PROVENANCE, "utf8"),
    readFile(NPM_RETRY, "utf8"),
    readFile(PUBLIC_ADMISSION, "utf8"),
    readFile(GITHUB_ADMISSION, "utf8"),
    readFile(GITHUB_PUBLISHER, "utf8"),
    readFile(REF_AUTHORITY, "utf8"),
    readFile(SIGNER_VERIFIER, "utf8"),
    readFile(PACKAGE_MANIFEST, "utf8"),
  ]);

  for (const required of [
    'tags:\n      - "v*"',
    "permissions:\n  contents: read",
    "group: stable-release",
    "cancel-in-progress: false",
    "fetch-depth: 1",
    "fetch-tags: false",
    "persist-credentials: false",
    "ref: refs/tags/${{ steps.request.outputs.tag }}",
    'node --experimental-strip-types ./scripts/release-ref-authority.ts release "$REQUESTED_TAG"',
    'site_version="$(bun -e',
    "Site version $site_version does not match package version $package_version",
    "bun run check",
    "working-directory: site",
    "bun run sync:readme",
    "bun run test",
    "bun run lint",
    "bun run build",
    "git diff --exit-code -- site/app/readme.generated.ts",
    "bun test src/imessage.test.ts src/contacts.test.ts src/metrics.test.ts",
    "npm pack --ignore-scripts --pack-destination artifacts .",
    "release-artifact-checksum.ts write artifacts/*.tgz artifacts/SHA256SUMS",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "id: release_artifact",
    "name: message-like-me-release-${{ github.run_attempt }}",
    "release_artifact_digest: ${{ steps.release_artifact.outputs.artifact-digest }}",
    "release_artifact_id: ${{ steps.release_artifact.outputs.artifact-id }}",
    "github_writer_artifact_digest: ${{ steps.github_writer_artifact.outputs.artifact-digest }}",
    "github_writer_artifact_id: ${{ steps.github_writer_artifact.outputs.artifact-id }}",
    "writer_artifact_digest: ${{ steps.writer_artifact.outputs.artifact-digest }}",
    "writer_artifact_id: ${{ steps.writer_artifact.outputs.artifact-id }}",
    "retention-days: 30",
    "Stage exact dependency-free release writers from reviewed source",
    'npm_writer_root="$(mktemp -d "$RUNNER_TEMP/message-like-me-npm-writer.XXXXXX")"',
    'github_writer_root="$(mktemp -d "$RUNNER_TEMP/message-like-me-github-writer.XXXXXX")"',
    "copy_regular_source",
    '[[ ! -f "$source" || -L "$source" ]]',
    "Release writer closure is not the exact regular-file allowlist",
    "path: ${{ steps.writer_roots.outputs.npm_path }}",
    "path: ${{ steps.writer_roots.outputs.github_path }}",
    "name: message-like-me-github-release-writer-${{ github.run_attempt }}",
    "artifact-ids: ${{ needs.verify.outputs.release_artifact_id }}",
    "merge-multiple: true",
    "Release artifact has no exact immutable identity",
    "exact_artifact:",
    "matrix:\n        os: [ubuntu-24.04, macos-15]",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "release-artifact-checksum.ts check artifacts/*.tgz artifacts/SHA256SUMS",
    "package-smoke.ts artifacts/*.tgz",
    "publish_github:",
    "name: Publish immutable GitHub Release",
    "Download the reviewed GitHub Release writer by numeric artifact ID",
    "artifact-ids: ${{ needs.verify.outputs.github_writer_artifact_id }}",
    "pre_npm:",
    "name: Admit immutable GitHub bytes and npm retry state",
    "publish_npm:",
    "name: Publish exact npm package through OIDC only",
    "admit:",
    "name: Admit exact public npm and GitHub distributions",
    "contents: write",
    "id-token: write",
    "contents: none",
    "check-github-release.ts artifacts/*.tgz artifacts/SHA256SUMS",
    "check-npm-retry-state.ts artifacts/*.tgz",
    "preflight_run_id: ${{ steps.npm_state.outputs.preflight_run_id }}",
    "preflight_run_attempt: ${{ steps.npm_state.outputs.preflight_run_attempt }}",
    "PRE_NPM_RUN_ID: ${{ needs.pre_npm.outputs.preflight_run_id }}",
    "PRE_NPM_RUN_ATTEMPT: ${{ needs.pre_npm.outputs.preflight_run_attempt }}",
    "npm_completion: ${{ steps.npm_publish.outputs.npm_completion }}",
    "npm_completion_run_id: ${{ steps.npm_publish.outputs.npm_completion_run_id }}",
    "npm_completion_run_attempt: ${{ steps.npm_publish.outputs.npm_completion_run_attempt }}",
    "NPM_WRITER_RESULT: ${{ needs.publish_npm.outputs.npm_completion }}",
    'NPM_WRITER_RESULT_REQUIRED: "true"',
    "NPM_COMPLETION_RUN_ID: ${{ needs.publish_npm.outputs.npm_completion_run_id }}",
    "NPM_COMPLETION_RUN_ATTEMPT: ${{ needs.publish_npm.outputs.npm_completion_run_attempt }}",
    "PRE_NPM_STATE: ${{ needs.pre_npm.outputs.npm_state }}",
    "writer/scripts/publish-npm-release.ts artifacts/*.tgz",
    "github-release-writer/scripts/publish-github-release.ts \"$VERIFIED_TAG\" artifacts/*.tgz artifacts/SHA256SUMS",
    "Install the pinned Sigstore verifier",
  ] as const) {
    expect(workflow).toContain(required);
  }

  expect(workflow).not.toContain("workflow_dispatch:");
  expect(workflow).not.toContain("environment:");
  expect(workflow).not.toContain("create-github-app-token");
  expect(workflow).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY");
  expect(workflow).not.toContain("provider_baseline:");
  expect(workflow).not.toContain("provider_outcome:");
  expect(workflow).not.toContain("release-provider-outcome.mjs promote");
  expect(workflow).not.toContain("deployments: read");
  expect(workflow).not.toContain("pull_request:");
  expect(workflow).not.toContain("VERCEL_TOKEN");
  expect(workflow).not.toContain("/commits/tags/");
  expect(workflow).not.toContain("--clobber");
  expect(workflow).not.toContain("fetch-depth: 0");
  expect(workflow).not.toContain("git fetch --force");
  expect(workflow).not.toContain("git tag --list");
  expect(workflow).not.toContain("mkdir -p release-writer");
  expect(workflow).not.toContain("mkdir -p github-release-writer");
  for (const source of [workflow, npmPublisher]) {
    expect(source).not.toMatch(/\bnpm\s+stage\b/iu);
    expect(source).not.toMatch(/\bstage\s+publish\b/iu);
  }
  expect(workflow.match(/fetch-depth: 1/gu)).toHaveLength(5);
  expect(workflow.match(/fetch-tags: false/gu)).toHaveLength(5);
  expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(5);
  expect(workflow.match(/contents: write/gu)).toHaveLength(1);
  expect(workflow.match(/id-token: write/gu)).toHaveLength(1);
  expect(workflow.match(/name: message-like-me-release-\$\{\{ github\.run_attempt \}\}/gu)).toHaveLength(1);
  expect(workflow.match(/artifact-ids: \$\{\{ needs\.verify\.outputs\.release_artifact_id \}\}/gu)?.length).toBeGreaterThanOrEqual(4);
  const writerStageIndex = workflow.indexOf("Stage exact dependency-free release writers from reviewed source");
  expect(writerStageIndex).toBeGreaterThan(0);
  expect(writerStageIndex).toBeLessThan(workflow.indexOf("oven-sh/setup-bun"));
  expect(writerStageIndex).toBeLessThan(workflow.indexOf("Verify exact release identity"));
  expect(writerStageIndex).toBeLessThan(workflow.indexOf("bun install --frozen-lockfile"));
  const githubWriter = workflow.slice(
    workflow.indexOf("\n  publish_github:\n"),
    workflow.indexOf("\n  pre_npm:\n"),
  );
  const npmWriter = workflow.slice(
    workflow.indexOf("\n  publish_npm:\n"),
    workflow.indexOf("\n  admit:\n"),
  );
  const finalAdmission = workflow.slice(workflow.indexOf("\n  admit:\n"));
  expect(githubWriter).toContain("contents: write");
  expect(githubWriter).not.toContain("id-token: write");
  expect(githubWriter).not.toContain("actions/checkout");
  expect(githubWriter).not.toContain("bun install");
  expect(githubWriter).not.toContain("release-ref-authority.ts checkout");
  expect(githubWriter).not.toContain("    env:\n      GH_TOKEN:");
  expect(githubWriter).toContain(
    "Create and prove the immutable GitHub Release from exact bytes\n        env:\n          GH_TOKEN: ${{ github.token }}",
  );
  expect(githubPublisher).toContain('from "./release-distribution-policy.ts"');
  expect(githubPublisher).toContain('from "./release-included-response.ts"');
  expect(githubPublisher).toContain('from "./release-process-environment.ts"');
  expect(githubPublisher).toContain('from "./release-ref-authority.ts"');
  expect(githubPublisher).not.toMatch(/from "\.\/[^".]+"/u);
  expect(npmPublisher).toContain('from "./npm-release-policy.ts"');
  expect(npmPublisher).toContain('from "./release-distribution-policy.ts"');
  expect(npmPublisher).toContain('from "./release-process-environment.ts"');
  expect(npmPublisher).not.toMatch(/from "\.\/[^".]+"/u);
  expect(npmPublisher).toContain([
    '          "npm",',
    '          "publish",',
    "          tarball,",
    '          "--access",',
    '          "public",',
  ].join("\n"));
  expect(npmWriter).toContain("contents: none");
  expect(npmWriter).toContain("id-token: write");
  expect(npmWriter).not.toContain("actions/checkout");
  expect(npmWriter).not.toContain("bun install");
  expect(npmWriter).not.toContain("GH_TOKEN");
  expect(finalAdmission).not.toContain("PRE_NPM_STATE:");
  expect(finalAdmission).not.toContain("GITHUB_RUN_ATTEMPT");
  expect(finalAdmission).toContain("needs.publish_npm.outputs.npm_completion_run_attempt");
  expect(npmPublisher).toContain("registryLatestUrl");
  expect(npmPublisher).toContain("parseNpmRelease(latestPayload");
  expect(npmPublisher).toContain("expectedShasum");
  expect(npmPublisher).toContain("provenance-bearing npm latest");
  expect(npmPublisher).toContain('preNpmState !== "absent"');
  expect(npmPublisher).toContain('preNpmState !== "exact_same_run"');
  expect(npmPublisher).toContain("preNpmRunId !== runId");
  expect(npmPublisher).toContain('recordCompletion("observed_existing")');
  expect(npmPublisher).toContain('recordCompletion("published")');
  expect(npmPublisher).toContain("existing tarball differs from the reviewed workflow artifact");
  expect(npmPublisher).toContain("refusing an ambiguous same-attempt race");
  expect(npmPublisher).toContain("Date.now() + 180_000");
  expect(npmPublisher).toContain("}, 120_000)");
  expect(npmPublisher).not.toContain('runAttempt !== "1"');
  expect(npmPublisher).not.toContain("verifyNpmProvenance");
  expect(npmPublisher).not.toContain("process.stdout.write");
  expect(npmPublisher).not.toContain("process.stderr.write");
  expect(npmProvenance).toContain('"audit",\n      "signatures"');
  expect(npmProvenance).toContain("workflow.path !== coordinate.releasePackage.workflowPath");
  expect(npmProvenance).toContain("sourceDigest.gitCommit !== coordinate.verifiedSha");
  expect(npmProvenance).toContain("await verifyReleaseSigner(provenance.bundle");
  expect(npmProvenance).toContain("invocation: provenance.invocation");
  expect(npmProvenance).toContain("maximumAttempt");
  expect(npmProvenance).toContain("requiredAttempt");
  expect(npmProvenance).toContain("requiredRunId");
  expect(npmRetry).toContain("exact_same_run");
  expect(npmRetry).toContain("maximumAttempt");
  expect(npmRetry).toContain("requiredRunId");
  expect(publicAdmission).toContain("verifyNpmProvenance(npmTarball");
  expect(publicAdmission).toContain("EXPECTED_RELEASE_RUN_ID");
  expect(publicAdmission).toContain('npmWriterResult === "published"');
  expect(publicAdmission).toContain('npmWriterResult === "observed_existing"');
  expect(publicAdmission).toContain('npmWriterResultRequired === "true" && !writerConstraint');
  expect(publicAdmission).toContain("requiredAttempt: Number(npmCompletionRunAttempt)");
  expect(publicAdmission).toContain("maximumAttempt: Number(npmCompletionRunAttempt)");
  expect(githubAdmission).toContain("reviewed-main ancestry");
  expect(githubAdmission).toContain("releases/latest");
  expect(githubAdmission).toContain("GitHub Release bytes differ from the reviewed workflow artifact");
  expect(githubPublisher.match(/verifyRemoteAnnotatedTag\(\);/gu)).toHaveLength(2);
  expect(githubPublisher).toContain("/git/ref/tags/${tagArgument}");
  expect(githubPublisher).toContain("/git/tags/${tagObject.sha}");
  expect(githubPublisher).toContain("Bun.spawn(command");
  expect(githubPublisher).toContain("}, 120_000)");
  expect(githubPublisher).toContain("with redacted diagnostic output");
  expect(githubPublisher).toContain("parseGitHubIncludedJsonResponse(existing.stdout)");
  expect(githubPublisher).toContain('"--draft"');
  expect(githubPublisher).toContain("exactDraft");
  expect(githubPublisher).toContain("verifyDraftAssets");
  expect(githubPublisher).toContain("readDraftById");
  expect(githubPublisher).toContain(
    [
      '      "--input", source,',
      '      `https://uploads.github.com/repos/${publicRepository}/releases/${String(current.id)}/assets?name=${encodeURIComponent(basename(source))}`,',
      "    ]);",
      "    current = await readDraftById(draft.id);",
      "    await verifyDraftAssets(current);",
    ].join("\n"),
  );
  expect(githubPublisher).not.toContain('"gh", "release", "upload"');
  expect(githubPublisher).toContain('"-F", "draft=false"');
  expect(githubPublisher).not.toContain("--target");
  expect(githubPublisher).not.toContain("target_commitish");
  expect(githubPublisher).toContain("existingResponse.status !== 404");
  expect(githubPublisher).toContain('existingResponse.body.message !== "Not Found"');
  expect(githubPublisher).toContain('existingResponse.body.status !== "404"');
  for (const source of [githubPublisher, githubAdmission, publicAdmission]) {
    expect(source).not.toContain(".head_commit");
  }
  for (const required of [
    "https://github.com/hraness/textbutler.git",
    '["ls-remote", "--refs", REPOSITORY_URL, MAIN_REF]',
    '["ls-remote", "--refs", "--tags", REPOSITORY_URL, `refs/tags/${namespace}*`]',
    '`refs/tags/${namespace}*`',
    '`${MAIN_REF}:${LOCAL_MAIN_REF}`',
    '`${localTagRef}:${localTagRef}`',
    '"--no-tags"',
    '"--no-write-fetch-head"',
    '"--no-recurse-submodules"',
    '"--unshallow"',
    "MAXIMUM_SNAPSHOT_BYTES = 64 * 1_024",
    "MAXIMUM_SNAPSHOT_ROWS = 500",
    "parseGovernedRemoteSnapshot",
    "Combined governed remote ref inventory exceeds its byte bound",
    "Combined governed remote ref inventory exceeds its row bound",
    'input.mode === "release" ? [localTagRef] : []',
    "[LOCAL_MAIN_REF, localTagRef]",
    "Remote release-ref inventory changed during verification",
  ] as const) expect(refAuthority).toContain(required);
  for (const forbidden of [
    '"fetch", "--tags"',
    '"fetch", "--force"',
    '"tag", "--list"',
    '"--refmap"',
    "refs/message-like-me-release-authority",
  ] as const) expect(refAuthority).not.toContain(forbidden);
  expect(githubPublisher).not.toContain("spawnSync");
  expect(githubPublisher).not.toContain("exists.\\n${failure}");
  expect(signerVerifier).toContain('certificateIssuer: GITHUB_OIDC_ISSUER');
  expect(signerVerifier).toContain('certificateIdentityURI: `^${escapeRegularExpression(identity)}$`');
  expect(signerVerifier).toContain("certificateOIDs: Object.freeze");
  expect(signerVerifier).toContain("tufForceCache: true");
  expect(signerVerifier).toContain("ctLogThreshold: 1");
  expect(signerVerifier).toContain("tlogThreshold: 1");
  expect(JSON.parse(packageManifest).devDependencies.sigstore).toBe("4.1.1");

  const npmPublish = workflow.indexOf("publish-npm-release.ts artifacts/*.tgz");
  const githubPublish = workflow.indexOf(
    'publish-github-release.ts "$VERIFIED_TAG" artifacts/*.tgz artifacts/SHA256SUMS',
  );
  expect(githubPublish).toBeGreaterThan(0);
  expect(npmPublish).toBeGreaterThan(githubPublish);
});

test("site promotion gates complete workflow history before App attestation and a leased workflow-token move", async () => {
  const [
    completeWorkflow,
    appTokenHelper,
    providerHelper,
    productionAuthorityHelper,
    refWriterHelper,
    statusAttesterHelper,
    workflowRangeHelper,
    publicAdmission,
  ] = await Promise.all([
    readFile(join(WORKFLOWS, "website-production.yml"), "utf8"),
    readFile(APP_TOKEN_HELPER, "utf8"),
    readFile(PROVIDER_HELPER, "utf8"),
    readFile(PRODUCTION_AUTHORITY_HELPER, "utf8"),
    readFile(REF_WRITER_HELPER, "utf8"),
    readFile(STATUS_ATTESTER_HELPER, "utf8"),
    readFile(WORKFLOW_RANGE, "utf8"),
    readFile(PUBLIC_ADMISSION, "utf8"),
  ]);

  // Keep all legacy path assertions intact; the independent site path is checked below
  // and in site-production.test.mjs. Both writers are mutually exclusive.
  const workflow = completeWorkflow.split("\n  site_build:")[0]!;
  expect(completeWorkflow.match(/^\s+contents: write$/gmu)).toHaveLength(2);
  expect(completeWorkflow).toContain("if: needs.site_preflight.outputs.advance_required == 'true'");

  for (const required of [
    "workflow_run:",
    "workflows: [Release]",
    "types: [completed]",
    "workflow_dispatch:",
    "release_tag:",
    "control_epoch_digest:",
    "INPUT_CONTROL_EPOCH_DIGEST: ${{ inputs.control_epoch_digest }}",
    "control_epoch_digest: ${{ steps.request.outputs.control_epoch_digest }}",
    "Control epoch requires one lowercase SHA-256 digest on manual attempt 1",
    "permissions:\n  contents: read",
    "group: website-production-promotion",
    "cancel-in-progress: false",
    'DEFAULT_BRANCH" != "main"',
    'EVENT_REF" != "refs/heads/main"',
    "EXPECTED_RELEASE_WORKFLOW_ID: ${{ vars.MLM_RELEASE_WORKFLOW_ID }}",
    'UPSTREAM_WORKFLOW_ID" != "$EXPECTED_RELEASE_WORKFLOW_ID"',
    'UPSTREAM_WORKFLOW_NAME" != "Release"',
    'UPSTREAM_PATH" != ".github/workflows/release.yml"',
    'UPSTREAM_EVENT" != "push"',
    '! "$UPSTREAM_RUN_ATTEMPT" =~ ^[1-9][0-9]*$',
    '! "$UPSTREAM_RUN_ID" =~ ^[1-9][0-9]*$',
    'UPSTREAM_CONCLUSION" != "success"',
    'UPSTREAM_HEAD_REPOSITORY" != "$GITHUB_REPOSITORY"',
    'current_main_sha="$(gh api',
    "Promotion workflow source $EVENT_SHA is not the checked current main",
    "Verify exact annotated release coordinate",
    'node --experimental-strip-types ./scripts/release-ref-authority.ts promotion "$REQUESTED_TAG" "$RECOVERY_WORKFLOW_SHA" "$UPSTREAM_SHA"',
    'refs/tags/$REQUESTED_TAG^{commit}',
    "release-provider-outcome.mjs revalidate-authority",
    "Admit the exact public npm and GitHub artifacts",
    "check-public-release.ts",
    "provider_baseline:",
    "advance_required: ${{ steps.baseline.outputs.advance_required }}",
    "ref_sha: ${{ steps.baseline.outputs.ref_sha }}",
    "release-provider-outcome.mjs baseline",
    "advance_production_ref_preflight:",
    "Prove the complete workflow-control range before environment admission",
    "--admit-production",
    "control_epoch_inventory:",
    "control_epoch_changes:",
    "write_production_ref:",
    "advance_production_ref:",
    "if: needs.provider_baseline.outputs.advance_required == 'true'",
    "environment: { name: production-ref-writer-key, deployment: false }",
    "permissions:\n      contents: write",
    "GITHUB_REPOSITORY_ID: ${{ github.repository_id }}",
    "GITHUB_REPOSITORY_OWNER: ${{ github.repository_owner }}",
    "MLM_RELEASE_APP_CLIENT_ID: ${{ vars.MLM_RELEASE_APP_CLIENT_ID }}",
    "MLM_RELEASE_APP_ID: ${{ vars.MLM_RELEASE_APP_ID }}",
    "MLM_RELEASE_APP_INSTALLATION_ID: ${{ vars.MLM_RELEASE_APP_INSTALLATION_ID }}",
    "MLM_RELEASE_APP_PRIVATE_KEY: ${{ secrets.MLM_RELEASE_APP_PRIVATE_KEY }}",
    "MLM_RELEASE_APP_SLUG: ${{ vars.MLM_RELEASE_APP_SLUG }}",
    "MLM_RELEASE_REF_TOKEN: ${{ github.token }}",
    "GH_TOKEN: ${{ github.token }}",
    "PROMOTION_EXPECTED_MODE: advanced",
    "Pin the complete production authority TCB to reviewed hashes",
    "APP_TOKEN_SHA256:",
    "PROVIDER_SHA256:",
    "REF_AUTHORITY_SHA256:",
    "REF_WRITER_SHA256:",
    "STATUS_ATTESTER_SHA256:",
    "WORKFLOW_RANGE_SHA256:",
    "Re-prove the complete workflow-control range before reading the key",
    "release-workflow-range.mjs",
    "WORKFLOW_RANGE_RECEIPT: ${{ steps.workflow_range.outputs.receipt }}",
    "release-provider-outcome.mjs promote",
    "Revalidate authority after production-ref mutation",
    "confirm_existing_production_ref:",
    "if: needs.provider_baseline.outputs.advance_required == 'false'",
    "PROMOTION_EXPECTED_MODE: already-exact",
    "select_promotion:",
    "Bind exactly one promotion path",
    "post_promotion_admission:",
    "Re-admit authority and public bytes after the selected promotion path",
    "provider_outcome:",
    "deployments: read",
    "timeout-minutes: 40",
    "release-provider-outcome.mjs wait",
    "final_public_admission:",
    "Re-admit exact public artifacts after provider success",
  ] as const) {
    expect(workflow).toContain(required);
  }

  expect(workflow).not.toContain('tags:\n      - "v*"');
  expect(workflow.match(/^\s+contents: write$/gmu)).toHaveLength(1);
  expect(workflow).toContain("if: github.event_name != 'workflow_dispatch' || inputs.site_sha == ''");
  expect(workflow).not.toContain("--method POST");
  expect(workflow).not.toContain("/releases\"");
  expect(workflow).not.toContain("Integration `15368`");
  expect(workflow).not.toContain("actions/create-github-app-token");
  expect(workflow).not.toContain("/rulesets");
  expect(workflow).not.toContain("required_status_checks");
  expect(workflow).not.toContain("fetch-depth: 0");
  expect(workflow).not.toContain("git tag --list");
  expect(workflow.match(/fetch-depth: 1/gu)).toHaveLength(10);
  expect(workflow.match(/fetch-tags: false/gu)).toHaveLength(10);
  expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(10);
  expect(workflow.match(/ref: \$\{\{ needs\.verify\.outputs\.workflow_sha \}\}/gu)).toHaveLength(9);
  expect(workflow).not.toContain("ref: ${{ needs.verify.outputs.verified_sha }}");
  expect(publicAdmission).toContain("releaseVersionForCurrentAdmission(");
  expect(appTokenHelper).toContain("repository_ids");
  expect(appTokenHelper).toContain('permissions: Object.freeze({ metadata: "read", statuses: "write" })');
  expect(appTokenHelper).not.toContain('contents: "write"');
  expect(appTokenHelper).not.toContain('workflows: "write"');
  expect(appTokenHelper).toContain("MESSAGE_LIKE_ME_REPOSITORY_ID = 1_342_143_606");
  expect(appTokenHelper).toContain("/app/installations/${String(input.installationId)}");
  expect(appTokenHelper).toContain('method: "DELETE"');
  expect(appTokenHelper).toContain("/installation/token");
  expect(appTokenHelper).toContain("/installation/repositories");
  expect(appTokenHelper).toContain("performance.now()");
  expect(appTokenHelper).toContain("RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS");
  expect(providerHelper).toContain('key.startsWith("MLM_RELEASE_APP_")');
  expect(providerHelper).not.toContain(".head_commit");
  expect(providerHelper).not.toContain('event === "push"');
  expect(providerHelper).toContain('from "./release-ref-writer.mjs"');
  expect(providerHelper).toContain("advanceWebsiteProductionRefFromEnvironment");
  expect(providerHelper).not.toContain("withReleaseAppTokenFromEnvironment");
  expect(providerHelper).not.toContain("withReleaseAuthorityStatusFromEnvironment");
  expect(providerHelper).not.toContain("MLM_RELEASE_APP_TOKEN");
  expect(providerHelper).toContain("assertProductionWorkflowAdmissionReceipt(workflowRangeReceipt");
  expect(providerHelper.indexOf("assertProductionWorkflowAdmissionReceipt(workflowRangeReceipt"))
    .toBeLessThan(providerHelper.lastIndexOf("advanceWebsiteProductionRefFromEnvironment"));
  const revalidateAuthorityCommand = providerHelper.slice(
    providerHelper.indexOf('if (command === "revalidate-authority")'),
    providerHelper.indexOf('if (command === "deny-production")'),
  );
  const promoteCommand = providerHelper.slice(
    providerHelper.indexOf('if (command === "promote")'),
    providerHelper.indexOf('if (command === "wait")'),
  );
  expect(revalidateAuthorityCommand).not.toContain("workflowRangeReceipt");
  expect(promoteCommand).toContain("decodeWorkflowAdmissionReceipt(process.env.WORKFLOW_RANGE_RECEIPT)");
  expect(workflowRangeHelper).toContain('`${oldCommit}..${newCommit}`');
  expect(workflowRangeHelper).toContain("MAXIMUM_WORKFLOW_RANGE_COMMITS = 250");
  expect(workflowRangeHelper).toContain("trees.findIndex((tree) => tree !== baselineTree)");
  expect(workflowRangeHelper).toContain("message-like-me/control-epoch/production/v2");
  expect(workflowRangeHelper).toContain("message-like-me/control-epoch/canary/v2");
  expect(workflowRangeHelper).toContain("decodeWorkflowRangeReceipt(value)");
  expect(refWriterHelper).toContain("verifiedReleaseFetchArguments");
  expect(refWriterHelper).toContain('"FETCH_HEAD^{commit}"');
  expect(refWriterHelper).toContain('`--depth=${String(PROTECTED_REF_ANCESTRY_FETCH_DEPTH)}`');
  expect(refWriterHelper).toContain('"website-production fast-forward ancestry"');
  expect(refWriterHelper).toContain('"merge-base"');
  expect(refWriterHelper).toContain('"--is-ancestor"');
  expect(refWriterHelper).toContain('`refs/tags/${tag}`');
  expect(refWriterHelper).toContain("GIT_LFS_SKIP_SMUDGE");
  expect(refWriterHelper).toContain("verifiedTag: input.verifiedTag");
  expect(refWriterHelper).toContain("MLM_RELEASE_REF_TOKEN");
  expect(refWriterHelper).not.toContain("MLM_RELEASE_APP_TOKEN");
  expect(refWriterHelper).toContain('classification: "required-status-errored"');
  expect(refWriterHelper).toContain('is errored.');
  expect(refWriterHelper).not.toContain('is expected');
  expect(providerHelper).toContain("message-like-me-production-required-status-denial-v3");
  expect(providerHelper).not.toContain("message-like-me-production-required-status-denial-v2");
  expect(productionAuthorityHelper).toContain("message-like-me-production-authority-final-v3");
  expect(productionAuthorityHelper).not.toContain("message-like-me-production-authority-final-v2");
  expect(statusAttesterHelper).toContain("message-like-me/website-production-authority");
  expect(statusAttesterHelper).not.toContain("MLM_RELEASE_REF_TOKEN");
  expect(statusAttesterHelper).toContain('state: "success"');
  expect(statusAttesterHelper).toContain('state: "error"');
  expect(statusAttesterHelper).toContain("withReleaseAppTokenFromEnvironment");
  const githubApiStart = providerHelper.indexOf("class GitHubApi");
  const githubApiEnd = providerHelper.indexOf("\nasync function", githubApiStart);
  const githubApiClass = providerHelper.slice(githubApiStart, githubApiEnd);
  expect(githubApiStart).toBeGreaterThan(0);
  expect(githubApiEnd).toBeGreaterThan(githubApiStart);
  expect(githubApiClass).toContain("async get(endpoint)");
  expect(githubApiClass).toContain("async graphql(");
  expect(githubApiClass).not.toContain("advanceRef(");
  expect(githubApiClass).not.toContain('"--method"');
  expect(/APP_TOKEN_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(appTokenHelper).digest("hex"),
  );
  expect(/PROVIDER_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(providerHelper).digest("hex"),
  );
  expect(/REF_AUTHORITY_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(await readFile(REF_AUTHORITY, "utf8")).digest("hex"),
  );
  expect(/REF_WRITER_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(refWriterHelper).digest("hex"),
  );
  expect(/STATUS_ATTESTER_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(statusAttesterHelper).digest("hex"),
  );
  expect(/WORKFLOW_RANGE_SHA256: ([0-9a-f]{64})/u.exec(workflow)?.[1]).toBe(
    createHash("sha256").update(workflowRangeHelper).digest("hex"),
  );
  expect(workflow.match(/release-provider-outcome\.mjs revalidate-authority/gu)?.length).toBeGreaterThanOrEqual(6);
  expect(workflow.match(/^\s+CONTROL_EPOCH_DIGEST: \$\{\{ needs\.verify\.outputs\.control_epoch_digest \}\}$/gmu))
    .toHaveLength(3);
  expect(workflow.match(/check-public-release\.ts/gu)?.length).toBeGreaterThanOrEqual(8);
  expect(workflow.match(/timeout-minutes: 15/gu)?.length).toBeGreaterThanOrEqual(3);
  expect(workflow.match(/timeout-minutes: 25/gu)?.length).toBeGreaterThanOrEqual(3);
  expect(workflow.match(/timeout-minutes: 40/gu)?.length).toBe(1);

  const baselineStart = workflow.indexOf("\n  provider_baseline:\n");
  const preflightStart = workflow.indexOf("\n  advance_production_ref_preflight:\n");
  const writerStart = workflow.indexOf("\n  write_production_ref:\n");
  const writerEnd = workflow.indexOf("\n  advance_production_ref:\n");
  const baselineJob = workflow.slice(baselineStart, preflightStart);
  const preflightJob = workflow.slice(preflightStart, writerStart);
  const writerJob = workflow.slice(writerStart, writerEnd);
  const workflowOutsideWriter = workflow.slice(0, writerStart) + workflow.slice(writerEnd);
  expect(baselineStart).toBeGreaterThan(0);
  expect(preflightStart).toBeGreaterThan(baselineStart);
  expect(writerStart).toBeGreaterThan(0);
  expect(writerEnd).toBeGreaterThan(writerStart);
  for (const exactDigestConsumer of [baselineJob, preflightJob, writerJob]) {
    expect(exactDigestConsumer.match(/^\s+CONTROL_EPOCH_DIGEST: \$\{\{ needs\.verify\.outputs\.control_epoch_digest \}\}$/gmu))
      .toHaveLength(1);
  }
  expect(writerJob).toContain("production-ref-writer-key");
  expect(writerJob).toContain("permissions:\n      contents: write");
  expect(writerJob).toContain("MLM_RELEASE_APP_PRIVATE_KEY");
  expect(writerJob).toContain("MLM_RELEASE_REF_TOKEN: ${{ github.token }}");
  expect(writerJob).toContain("release-provider-outcome.mjs promote");
  expect(writerJob).toContain("release-workflow-range.mjs");
  expect(writerJob).not.toContain("bun install");
  expect(writerJob).toContain("setup-node");
  expect(writerJob).not.toContain("setup-bun");
  expect(writerJob).not.toContain("check-public-release.ts");
  expect(writerJob).toContain("release-ref-authority.ts promotion");
  expect(writerJob).not.toContain("MLM_RELEASE_APP_TOKEN");
  expect(writerJob.indexOf("Re-prove the complete workflow-control range before reading the key"))
    .toBeLessThan(writerJob.indexOf("MLM_RELEASE_APP_PRIVATE_KEY:"));
  expect(workflow.match(/^\s+MLM_RELEASE_APP_PRIVATE_KEY:/gmu)).toHaveLength(3);
  expect(workflow.match(/^\s+MLM_RELEASE_REF_TOKEN:/gmu)).toHaveLength(2);
  expect(workflow.match(/environment: \{ name: production-ref-writer-key, deployment: false \}/gu))
    .toHaveLength(1);
  expect(workflowOutsideWriter).not.toContain("contents: write");
  expect(workflowOutsideWriter).not.toContain("MLM_RELEASE_REF_TOKEN");
  expect(workflowOutsideWriter).not.toContain("MLM_RELEASE_APP_PRIVATE_KEY");

  const existingStart = workflow.indexOf("\n  confirm_existing_production_ref:\n");
  const selectStart = workflow.indexOf("\n  select_promotion:\n");
  const postPromotionStart = workflow.indexOf("\n  post_promotion_admission:\n");
  const providerOutcomeStart = workflow.indexOf("\n  provider_outcome:\n");
  const finalPublicStart = workflow.indexOf("\n  final_public_admission:\n");
  const existingJob = workflow.slice(existingStart, selectStart);
  const selectJob = workflow.slice(selectStart, postPromotionStart);
  const postPromotionJob = workflow.slice(postPromotionStart, providerOutcomeStart);
  const providerOutcomeJob = workflow.slice(providerOutcomeStart, finalPublicStart);
  const finalPublicJob = workflow.slice(finalPublicStart);
  expect(existingJob).not.toContain("environment:");
  expect(existingJob).not.toContain("MLM_RELEASE_APP_");
  expect(existingJob).not.toContain("MLM_RELEASE_REF_TOKEN");
  expect(selectJob).toContain(
    "${{ always() &&\n          needs.verify.result == 'success' &&\n          needs.provider_baseline.result == 'success' }}",
  );
  expect(postPromotionJob).toContain(
    "${{ always() &&\n          !cancelled() &&\n          needs.verify.result == 'success' &&\n          needs.select_promotion.result == 'success' }}",
  );
  expect(providerOutcomeJob).toContain(
    "${{ always() &&\n          !cancelled() &&\n          needs.verify.result == 'success' &&\n          needs.provider_baseline.result == 'success' &&\n          needs.select_promotion.result == 'success' &&\n          needs.post_promotion_admission.result == 'success' }}",
  );
  expect(finalPublicJob).toContain("if: ${{ always() && !cancelled() && (github.event_name != 'workflow_dispatch' || inputs.site_sha == '') }}");
  expect(finalPublicJob).toContain("Bind the complete terminal admission chain");
  expect(finalPublicJob).toContain(
    "PROVIDER_OUTCOME_RESULT: ${{ needs.provider_outcome.result }}",
  );
  expect(finalPublicJob).toContain("VERIFY_RESULT: ${{ needs.verify.result }}");
  expect(finalPublicJob).toContain(
    '[[ "$VERIFY_RESULT" != "success" || "$PROVIDER_OUTCOME_RESULT" != "success" ]]',
  );
  expect(finalPublicJob).toContain(
    "Production promotion did not complete every required admission job",
  );
});

test("production, canary, and cleanup keep status and ref authority split", async () => {
  const [
    productionWorkflow,
    canaryWorkflow,
    cleanupWorkflow,
    appToken,
    productionAuthority,
    provider,
    refWriter,
    statusAttester,
    workflowRange,
    canary,
    cleanup,
  ] = await Promise.all([
    readFile(join(WORKFLOWS, "website-production.yml"), "utf8"),
    readFile(join(WORKFLOWS, "production-writer-canary.yml"), "utf8"),
    readFile(join(WORKFLOWS, "release-authority-cleanup.yml"), "utf8"),
    readFile(APP_TOKEN_HELPER, "utf8"),
    readFile(PRODUCTION_AUTHORITY_HELPER, "utf8"),
    readFile(PROVIDER_HELPER, "utf8"),
    readFile(REF_WRITER_HELPER, "utf8"),
    readFile(STATUS_ATTESTER_HELPER, "utf8"),
    readFile(WORKFLOW_RANGE, "utf8"),
    readFile(CANARY_HELPER, "utf8"),
    readFile(CLEANUP_HELPER, "utf8"),
  ]);

  for (const workflow of [productionWorkflow, canaryWorkflow, cleanupWorkflow]) {
    expect(workflow).toContain("group: website-production-promotion");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/__[A-Z0-9_]+__/u);
  }
  expect(productionWorkflow).toContain(
    "run-name: ${{ inputs.site_sha != '' && format('Promote site {0} / control {1}', inputs.site_sha, inputs.control_epoch_digest || 'routine') || (github.event_name == 'workflow_run' && format('Promote release target {0}', github.event.workflow_run.head_sha) || format('Promote release tag {0} / control {1}', inputs.release_tag, inputs.control_epoch_digest || 'routine')) }}",
  );
  for (const predicate of [
    "if: ${{ steps.workflow_range.outcome == 'success' && steps.pre_precondition_pin.outcome == 'success' }}",
    "if: ${{ steps.attest.outcome == 'success' && steps.post_attest_pin.outcome == 'success' }}",
    "if: ${{ always() && steps.workflow_range.outcome == 'success' && steps.pre_precondition_pin.outcome == 'success' && steps.precondition.outcome != 'skipped' && steps.post_writer_pin.outcome == 'success' }}",
  ]) {
    expect(productionWorkflow).toContain(predicate);
  }
  expect(productionWorkflow.split("\n  site_build:")[0]!.match(/^\s+MLM_RELEASE_APP_PRIVATE_KEY:/gmu)).toHaveLength(3);
  expect(productionWorkflow.split("\n  site_build:")[0]!.match(/^\s+MLM_RELEASE_REF_TOKEN:/gmu)).toHaveLength(2);
  expect(productionWorkflow.split("\n  site_build:")[0]!.match(/^\s+contents: write$/gmu)).toHaveLength(1);
  expect(productionWorkflow).toContain("release-provider-outcome.mjs finalize-authority");

  expect(canaryWorkflow).toContain(
    "run-name: Prove writer canary target ${{ github.workflow_sha }} / control ${{ inputs.control_epoch_digest || 'routine' }}",
  );
  expect(canaryWorkflow).toContain("control_epoch_digest:");
  expect(canaryWorkflow).toContain("CONTROL_EPOCH_DIGEST: ${{ inputs.control_epoch_digest }}");
  expect(canary).toContain("RELEASE_CANARY_STATUS_CONTEXT");
  expect(canary).toContain("message-like-me-production-writer-canary-writer-denied-v3");
  expect(canary).toContain("message-like-me-production-writer-canary-final-v3");
  expect(canary).not.toContain("message-like-me-production-writer-canary-writer-denied-v2");
  expect(canary).not.toContain("message-like-me-production-writer-canary-final-v2");
  expect(statusAttester).toContain(
    "message-like-me/website-production-writer-canary-authority",
  );
  expect(canaryWorkflow).toContain(
    "if: ${{ always() && steps.pin.outcome == 'success' && steps.revalidate.outcome == 'success' && steps.pre_terminalize_pin.outcome == 'success' && steps.terminalize.outcome != 'skipped' }}",
  );
  expect(canaryWorkflow).toContain(
    "if: ${{ always() && steps.cleanup_pin.outcome == 'success' }}",
  );
  expect(canaryWorkflow.match(/^\s+MLM_RELEASE_APP_PRIVATE_KEY:/gmu)).toHaveLength(3);
  expect(canaryWorkflow.match(/^\s+MLM_RELEASE_REF_TOKEN:/gmu)).toHaveLength(2);

  expect(cleanupWorkflow).toContain(
    "run-name: Terminalize release authority target ${{ inputs.expected_target_sha }}",
  );
  expect(cleanupWorkflow).not.toContain("incident_kind");
  expect(cleanupWorkflow).toContain("MLM_RELEASE_PRODUCTION_WORKFLOW_ID");
  expect(cleanupWorkflow).toContain("MLM_RELEASE_CANARY_WORKFLOW_ID");
  expect(cleanupWorkflow).toContain("MLM_RELEASE_CLEANUP_WORKFLOW_ID");
  expect(cleanupWorkflow).toContain("if: ${{ always() && steps.pin.outcome == 'success' }}");
  expect(cleanupWorkflow.match(/if: \$\{\{ always\(\) \}\}/gu)).toHaveLength(3);
  expect(cleanupWorkflow.match(/^\s+MLM_RELEASE_APP_PRIVATE_KEY:/gmu)).toHaveLength(1);
  expect(cleanupWorkflow).not.toContain("MLM_RELEASE_REF_TOKEN");
  expect(cleanupWorkflow).not.toContain("contents: write");
  expect(cleanupWorkflow).toContain("timeout-minutes: 40");
  expect(cleanupWorkflow.match(/timeout-minutes: 45/gu)).toHaveLength(2);
  expect(cleanup).toContain("36 * 24 * 60 * 60 * 1000");
  expect(cleanup).toContain("MAX_TOTAL_ATTEMPTS = 150");
  expect(cleanup).toContain("body.total_count >= MAX_WORKFLOW_RUNS_PER_WORKFLOW");
  expect(cleanup).toContain("Promote release target ${expected.expectedTargetSha}");
  expect(cleanup).toContain("Promote release tag ${expected.verifiedTag}");
  expect(cleanup).toContain("disabled_manually");
  expect(cleanup).toContain("message-like-me-release-authority-cleanup-incomplete-v2");
  expect(cleanup).toContain('method: "POST"');
  expect(cleanup.match(/method: "POST"/gu)).toHaveLength(1);
  expect(cleanup).not.toContain('method: "PATCH"');
  expect(cleanup).not.toContain("release-ref-writer");
  expect(cleanup).not.toContain("advanceWebsiteProduction");

  expectEveryPin(productionWorkflow, "APP_TOKEN_SHA256", appToken, 6);
  expectEveryPin(productionWorkflow, "PRODUCTION_AUTHORITY_SHA256", productionAuthority, 6);
  expectEveryPin(productionWorkflow, "PROVIDER_SHA256", provider, 6);
  expectEveryPin(productionWorkflow, "REF_WRITER_SHA256", refWriter, 6);
  expectEveryPin(productionWorkflow, "STATUS_ATTESTER_SHA256", statusAttester, 6);
  expectEveryPin(productionWorkflow, "WORKFLOW_RANGE_SHA256", workflowRange, 6);
  expectEveryPin(canaryWorkflow, "APP_TOKEN_SHA256", appToken, 7);
  expectEveryPin(canaryWorkflow, "CANARY_SHA256", canary, 7);
  expectEveryPin(canaryWorkflow, "REF_WRITER_SHA256", refWriter, 7);
  expectEveryPin(canaryWorkflow, "STATUS_ATTESTER_SHA256", statusAttester, 7);
  expectEveryPin(canaryWorkflow, "WORKFLOW_RANGE_SHA256", workflowRange, 7);
  expectEveryPin(cleanupWorkflow, "APP_TOKEN_SHA256", appToken, 4);
  expectEveryPin(cleanupWorkflow, "CLEANUP_SHA256", cleanup, 4);
});

test("workflow changes have one explicit code owner", async () => {
  const value = await readFile(CODEOWNERS, "utf8");
  expect(value).toBe(
    "/.github/workflows/** @0thernet\n" +
    "/.github/CODEOWNERS @0thernet\n" +
    "/scripts/check-github-release.ts @0thernet\n" +
    "/scripts/check-npm-retry-state.ts @0thernet\n" +
    "/scripts/check-npm-trusted-publishing.ts @0thernet\n" +
    "/scripts/check-public-release.ts @0thernet\n" +
    "/scripts/npm-provenance-* @0thernet\n" +
    "/scripts/verify-npm-provenance-* @0thernet\n" +
    "/scripts/npm-release-policy* @0thernet\n" +
    "/scripts/package-smoke* @0thernet\n" +
    "/scripts/publish-* @0thernet\n" +
    "/scripts/release-* @0thernet\n" +
    "/scripts/site-production* @0thernet\n" +
    "/docs/publishing.md @0thernet\n" +
    "/package.json @0thernet\n" +
    "/bun.lock @0thernet\n",
  );
});

test("repository guides describe the separate release and production writers", async () => {
  const [rootGuide, siteGuide] = await Promise.all([
    readFile(ROOT_GUIDE, "utf8"),
    readFile(SITE_GUIDE, "utf8"),
  ]);
  expect(rootGuide).toContain("separate current-`main` promotion workflow");
  expect(rootGuide).toContain("Build the\n  package once, publish the immutable Latest GitHub Release");
  expect(rootGuide).toContain("tarball\n  plus `SHA256SUMS` first");
  expect(rootGuide).toContain("fresh dependency-free, hash-pinned promotion job");
  expect(rootGuide).toContain("complete non-shallow history. The complete range must either preserve the\n  baseline `.github/workflows` tree OID with no digest");
  expect(rootGuide).toContain("match the exact\n  independently reviewed v2 control-epoch receipt and digest");
  expect(rootGuide).toContain("`statuses:write` plus `metadata:read`");
  expect(rootGuide).toContain("status App must have neither `contents:write` nor\n  `workflows:write`");
  expect(rootGuide).toContain("singular exact GH013 violation payload\n  for the protected ref");
  expect(rootGuide).toContain("known Git non-TTY display suffix: zero, one, or eight ASCII\n  spaces");
  expect(rootGuide).toContain("Reject every other trailing byte,\n  suffix length, or mixed framing");
  expect(rootGuide).toContain("transport ordering,\n  and helper-label framing as diagnostics rather than proof");
  expect(rootGuide).toContain("`is expected` or a missing-status interpretation");
  expect(rootGuide).toContain("Already-exact recovery must not enter the key environment");
  expect(rootGuide).toContain("36-day complete attempt inventory");
  expect(rootGuide).toContain("65-minute token-expiry quarantine");
  expect(rootGuide).toContain("every incomplete cleanup receipt as continued quarantine");
  expect(siteGuide).toContain("dedicated\n  current-`main` production workflow is the sole routine writer");
  expect(siteGuide).toContain("exact npm package and immutable, artifact-complete Latest GitHub");
  expect(siteGuide).toContain("fresh dependency-free, hash-pinned job");
  expect(siteGuide).toContain("`statuses:write` plus `metadata:read` App token");
  expect(siteGuide).toContain("a no-digest range that preserves the\n  production baseline's `.github/workflows` tree");
  expect(siteGuide).toContain("exact independently\n  reviewed v2 receipt and digest");
  expect(siteGuide).toContain("The App is the ruleset-pinned source of one exact-SHA success status");
  expect(siteGuide).toContain("same job's scoped `GITHUB_TOKEN`");
  expect(siteGuide).toContain("context ending `is errored.`");
  expect(siteGuide).toContain("known Git non-TTY display suffix: zero, one, or eight\n  ASCII spaces");
  expect(siteGuide).toContain("Reject every other trailing byte,\n  suffix length, or mixed framing");
  expect(siteGuide).toContain("transport\n  ordering, and helper-label framing are not proof");
  expect(siteGuide).toContain("missing-status, ambiguous, or differently\n  bound semantic payloads");
  expect(rootGuide).toContain("transition-scoped v2 digest protocol");
  expect(rootGuide).toContain("one no-digest run must fail before key admission");
  expect(rootGuide).toContain("independently reviewed exact digest");
  expect(rootGuide).toContain("Never expand the status App");
  expect(siteGuide).toContain("publishing runbook's transition-scoped v2 digest");
  expect(siteGuide).toContain("a no-digest attempt\n  fails before key admission");
  expect(siteGuide).toContain("independently reviewed exact digest");
  expect(siteGuide).toContain("never expands the status App");
  expect(siteGuide).toContain("Already-exact recovery stays\n  read-only and outside the key environment");
  expect(siteGuide).toContain("target-bound, 36-day-inventory");
  expect(siteGuide).toContain("Incomplete or absent evidence never\n  permits a retry");
  expect(siteGuide).not.toContain("Release\n  workflow is the sole routine writer");
});

test("publishing documents the exact App, environment, canary, and ref controls", async () => {
  const guide = await readFile(PUBLISHING_GUIDE, "utf8");

  for (const required of [
    "167738fcc40e523d2696e2ff2bdbe29d502ba7df",
    "`refs/heads/website-production` is absent",
    "repository ruleset inventory is exactly empty",
    "prj_K7VHB2ELASGF1OxTCxG8bfxOEoQJ",
    "`link.productionBranch=main`",
    "`READY` and\n  `PROMOTED`",
    "appgprj_6a88baf1c6388191af90b2e1d7b846ee",
    "do not create a replacement Sites project",
    "Create the missing `website-production` ref once",
    "Require `link.productionBranch` to equal",
    "production-ref-writer-key",
    "environment: { name: production-ref-writer-key, deployment: false }",
    "MLM_RELEASE_APP_PRIVATE_KEY",
    "MLM_RELEASE_APP_CLIENT_ID",
    "MLM_RELEASE_APP_ID",
    "MLM_RELEASE_APP_INSTALLATION_ID",
    "MLM_RELEASE_APP_SLUG",
    "MLM_RELEASE_WORKFLOW_ID",
    "Immutable version tags",
    "current_user_can_bypass=never",
    "permission set to be `createPackage` plus npm's provider-imposed\n   `createStagedPackage`",
    "never `npm stage` or `stage publish`",
    "staged-package inventory to be exactly empty",
    "registry may resolve both `legacy` and `latest` to those same",
    "Dist-tags are mutable labels",
    "manual `v0.8.0` registry seed is historical bootstrap only",
    "first automated OIDC release",
    "becomes Latest",
    "Never retag or reuse `v0.8.0`",
    "later release must use OIDC",
    "automatic npm provenance for every automated release",
    "`Commit statuses: Read and write`",
    "exactly `statuses:write` plus `metadata:read`",
    "no `contents` or\n  `workflows` authority",
    "{hraness/textbutler}",
    "GitHub Actions Integration `15368`",
    "message-like-me/website-production-authority",
    "GH013: Repository rule violations found for refs/heads/website-production.",
    "remote: - Required status check \"message-like-me/website-production-authority\" is errored.",
    "zero, one, or eight ASCII spaces",
    "Any other trailing byte, suffix length, or mixed framing is a",
    "duplicate GH013 payload",
    "multiple rule reasons",
    "has no update restriction or bypass actor",
    "external release gate, not as inputs the promotion workflow may administer",
    "must not create, replace, patch, disable, or broaden a ruleset",
    "requiring pull requests",
    "code-owner",
    "precreate persistent ref",
    "website-production-writer-canary",
    "Review one workflow-control epoch",
    "v2 control-epoch digest",
    "does not use an out-of-band ref write or broaden either credential",
    "`control_epoch_digest`",
    "must fail at the complete-history gate before",
    "ordered old-through-workflow-source commit inventory",
    "canonical lowercase SHA-256 digest",
    "Do not trust the digest without reviewing its complete preimage",
    "const receipt = describeControlEpoch({",
    "Before dispatching the reviewed control-epoch transition",
    "tree OID as the baseline for the next",
    "completed epoch requires no key rotation",
    "Automatic `workflow_run` events, rerun attempts, already-exact refs",
    "complete inventory and digest before environment admission",
    "recomputes and revalidates the same transition before reading the key",
    "never treat the digest as retry authority",
    "workflow-delta canary",
    "empty-digest rejection before",
    "fresh manual attempt 1 with its exact digest",
    "later positive non-workflow canary",
    "complete-history gate",
    "capped at 250 newly reachable commits",
    "merge-side changes and an edit followed",
    "seven reviewed helpers",
    "--force-with-lease",
    "The sterile writer fetches only the exact verified tag, with one more commit of\nhistory than the admitted workflow range",
    "the push receipt must still report one\nordinary fast-forward rather than a forced update",
    "The final public\nadmission runs as a terminal sentinel",
    "a skipped tail cannot make the workflow green",
    "GIT_ASKPASS",
    "stale leases all fail without mutation",
    "completed\n`workflow_run`",
    "positive run ID and attempt",
    "required check came from the pinned App",
    "used no bypass",
    "do\nnot attempt deletion",
    "repository ID `1342143606`",
    "repository_ids: [1342143606]",
    "DELETE /installation/token",
    "two stable authenticated HTTP 401 authorization-denial responses",
    "An HTTP 403 is\nindeterminate",
    "30-second half-open\nrequest-start window",
    "bodies are streamed under a 1 MiB cap and scrubbed",
    "Message Like Me operational ceiling, not a claim about GitHub's\nrevocation-propagation SLA",
    "full App path is\ncapped at seventeen REST requests",
    "quarantined authorization incident, never a retry signal",
    "status-only cleanup to append and read back the terminal `error`",
    "Terminalize an interrupted production authority",
    "target-bearing run\ntitle",
    "MLM_RELEASE_PRODUCTION_WORKFLOW_ID",
    "MLM_RELEASE_CANARY_WORKFLOW_ID",
    "MLM_RELEASE_CLEANUP_WORKFLOW_ID",
    "minus 36 days",
    "35-day maximum workflow lifetime",
    "more than 150 attempts\ntotal",
    "at least 65 minutes",
    "persists a canonical incomplete receipt",
    "Cleanup never moves or creates a ref, posts `success`",
    "Do not dispatch another writer while the newest exact context is successful or\nunknown",
    "exact production-ref post-read cannot\nbegin until convergence",
    "terminal `error` after\n   consumption",
    "success cannot\n   authorize a replay",
    "MLM_RELEASE_REF_TOKEN",
    "only the fixed ref writer reads `MLM_RELEASE_REF_TOKEN`",
    "App token is never passed\n   to the ref writer",
    "An indeterminate terminal status or revocation therefore prevents\n   every post-read",
    "`refs/tags/<verified-tag>`",
    "`FETCH_HEAD^{commit}`",
    "submodule recursion disabled",
    "skips the\nentire `production-ref-writer-key` job, and mints no App token",
    "a later `main` push creates no Vercel Production deployment",
    "product pull request must not change\n`.github/workflows/`, `.github/CODEOWNERS`",
    "No personal access token, deploy key, Vercel token",
    "The tag workflow has no environment, App credential",
    "one npm tarball and `SHA256SUMS`",
    "writer closures. Both closures are copied from regular non-symlink files",
    "checked against exact file inventories before\n   any repository code or dependency executes",
    "Every local writer import names its\n   `.ts` source explicitly",
    "GitHub publication job `contents: write`",
    "no-checkout npm publication job `id-token: write`",
    "part of the\n   privileged TCB",
    "GitHub token is scoped only to the final\n   dependency-free publisher step",
    "publish that tarball to npm through\ntrusted publishing",
    "uploads only the tarball and checksum",
    "Fulcio subject",
    "certificate extensions",
    "exact npm\n   version and Latest integrity",
    "A tag cannot enter\n`production-ref-writer-key`",
    "Recovery uses the same `Promote website production` workflow dispatch",
    "It\nnever creates, replaces, or edits an npm version or GitHub Release",
    "never retags",
  ] as const) {
    if (!guide.includes(required)) {
      throw new Error(`Publishing guide is missing exact contract text: ${JSON.stringify(required)}`);
    }
  }
  for (const inaccurate of [
    "non-Latest `legacy` dist-tag",
    "remains outside Latest",
    "non-Latest `v0.8.0` bootstrap coordinate",
  ] as const) {
    expect(guide).not.toContain(inaccurate);
  }
});
