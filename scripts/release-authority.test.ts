import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  exactPublishedRelease,
  revalidateReleaseAuthority,
} from "./release-provider-outcome.mjs";

const repository = "hraness/textbutler";
const tag = "v0.8.0";
const tagResolutionFixture = JSON.parse(readFileSync(
  new URL("./fixtures/github-v0.8.0-tag-resolution.json", import.meta.url),
  "utf8",
)) as Readonly<{
  resolvedCommit: Readonly<Record<string, unknown> & { sha: string }>;
  tag: string;
  tagRef: Readonly<{
    object: Readonly<{ sha: string; type: string; url: string }>;
    ref: string;
  }>;
}>;
const sha = tagResolutionFixture.resolvedCommit.sha;
const tagObjectSha = tagResolutionFixture.tagRef.object.sha;
// Keep the archived pre-rename response unchanged; model a new canonical API
// response using the same immutable tag-object identity and explicit URLs.
const canonicalTagRef = {
  ...tagResolutionFixture.tagRef,
  url: `https://api.github.com/repos/${repository}/git/refs/tags/${tag}`,
  object: {
    ...tagResolutionFixture.tagRef.object,
    url: `https://api.github.com/repos/${repository}/git/tags/${tagObjectSha}`,
  },
};
const currentMainSha = "3".repeat(40);
const workflowSha = currentMainSha;

type ApiValue = unknown | readonly unknown[];

function apiFrom(entries: Readonly<Record<string, ApiValue>>) {
  const offsets = new Map<string, number>();
  const calls: string[] = [];
  return Object.freeze({
    calls,
    api: {
      get: async (endpoint: string): Promise<unknown> => {
        calls.push(endpoint);
        const entry = entries[endpoint];
        if (entry === undefined) throw new Error(`unexpected endpoint ${endpoint}`);
        if (!Array.isArray(entry)) return entry;
        const offset = offsets.get(endpoint) ?? 0;
        const value = entry[offset];
        if (value === undefined) throw new Error(`exhausted endpoint ${endpoint}`);
        offsets.set(endpoint, offset + 1);
        return value;
      },
    },
  });
}

function ref(branch: string, commit: string) {
  return { object: { sha: commit, type: "commit" }, ref: `refs/heads/${branch}` };
}

function tagObject(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    object: { sha, type: "commit" },
    sha: tagObjectSha,
    tag,
    ...overrides,
  };
}

function compare(base: string, head: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ahead_by: 1,
    base_commit: { sha: base },
    behind_by: 0,
    commits: [{ sha: head }],
    merge_base_commit: { sha: base },
    status: "ahead",
    ...overrides,
  };
}

function release(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    assets: [],
    draft: false,
    id: 123,
    immutable: true,
    prerelease: false,
    published_at: "2026-08-29T20:00:00Z",
    tag_name: tag,
    ...overrides,
  };
}

function releaseAsset(releaseTag: string, name: string, id: number) {
  return {
    browser_download_url:
      `https://github.com/hraness/textbutler/releases/download/${releaseTag}/${name}`,
    digest: `sha256:${"a".repeat(64)}`,
    id,
    name,
    size: id,
    state: "uploaded",
  };
}

function authorityApi(overrides: Readonly<Record<string, ApiValue>> = {}) {
  return apiFrom({
    [`/repos/${repository}`]: [{ default_branch: "main" }, { default_branch: "main" },
      { default_branch: "main" }, { default_branch: "main" }],
    [`/repos/${repository}/git/ref/heads/main`]: [
      ref("main", currentMainSha),
      ref("main", currentMainSha),
      ref("main", currentMainSha),
      ref("main", currentMainSha),
    ],
    [`/repos/${repository}/compare/${sha}...${currentMainSha}`]: [
      compare(sha, currentMainSha),
      compare(sha, currentMainSha),
      compare(sha, currentMainSha),
      compare(sha, currentMainSha),
    ],
    [`/repos/${repository}/git/ref/tags/${tag}`]: [
      canonicalTagRef,
      canonicalTagRef,
    ],
    [`/repos/${repository}/git/tags/${tagObjectSha}`]: [tagObject(), tagObject()],
    [`/repos/${repository}/releases/tags/${tag}`]: [release(), release()],
    [`/repos/${repository}/releases/latest`]: [{ tag_name: tag }, { tag_name: tag }],
    ...overrides,
  });
}

function verify(api: ReturnType<typeof authorityApi>["api"], input = {}) {
  return revalidateReleaseAuthority({
    api,
    defaultBranch: "main",
    eventName: "workflow_dispatch",
    recoveryWorkflowSha: workflowSha,
    repository,
    verifiedSha: sha,
    verifiedTag: tag,
    ...input,
  });
}

describe("promotion authority revalidation", () => {
  test("sandwiches exact current-main workflow source and annotated-tag ancestry", async () => {
    const fixture = authorityApi();
    await verify(fixture.api);

    const workflowPhase = [
      `/repos/${repository}`,
      `/repos/${repository}/git/ref/heads/main`,
      `/repos/${repository}/compare/${sha}...${currentMainSha}`,
    ];
    const releasePhase = [
      `/repos/${repository}/git/ref/tags/${tag}`,
      `/repos/${repository}/git/tags/${tagObjectSha}`,
      `/repos/${repository}/releases/tags/${tag}`,
      `/repos/${repository}/releases/latest`,
    ];
    expect(fixture.calls).toEqual([
      ...workflowPhase,
      ...workflowPhase,
      ...releasePhase,
      ...workflowPhase,
      ...workflowPhase,
      ...releasePhase,
    ]);
  });

  test("requires exact current-main workflow source and rejects non-ancestor releases", async () => {
    const fixture = authorityApi();
    await expect(verify(fixture.api, { eventName: "push" })).rejects.toThrow(
      "site promotion authority must be one reviewed-main workflow run",
    );
    await expect(verify(fixture.api, { recoveryWorkflowSha: "" })).rejects.toThrow(
      "site promotion authority must be one reviewed-main workflow run",
    );
    expect(fixture.calls).toEqual([]);

    const movedMain = "4".repeat(40);
    const staleWorkflow = authorityApi({
      [`/repos/${repository}/git/ref/heads/main`]: [ref("main", movedMain)],
    });
    await expect(verify(staleWorkflow.api)).rejects.toThrow(
      "release recovery workflow source is not exact current main",
    );

    const nonAncestor = authorityApi({
      [`/repos/${repository}/compare/${sha}...${currentMainSha}`]: [
        compare(sha, currentMainSha, { status: "diverged" }),
      ],
    });
    await expect(verify(nonAncestor.api)).rejects.toThrow(
      `${sha} is not a reviewed ancestor of current main ${currentMainSha}`,
    );
  });

  test("ignores Release.target_commitish after exact tag authority is proven", async () => {
    const conflicting = authorityApi({
      [`/repos/${repository}/releases/tags/${tag}`]: [
        release({ target_commitish: "definitely-not-authority" }),
        release({ target_commitish: "also-not-authority" }),
      ],
    });
    await expect(verify(conflicting.api)).resolves.toBeUndefined();
  });

  test("rejects lightweight or moved tags, malformed releases, and a non-Latest tag", async () => {
    const lightweightTag = authorityApi({
      [`/repos/${repository}/git/ref/tags/${tag}`]: [{
        object: { sha, type: "commit", url: canonicalTagRef.object.url },
        ref: `refs/tags/${tag}`,
      }],
    });
    await expect(verify(lightweightTag.api)).rejects.toThrow("is not one exact annotated tag ref");

    const movedTag = authorityApi({
      [`/repos/${repository}/git/tags/${tagObjectSha}`]: [tagObject({
        object: { sha: "4".repeat(40), type: "commit" },
      })],
    });
    await expect(verify(movedTag.api)).rejects.toThrow(
      "does not bind the exact annotated tag object to the verified release commit",
    );

    const assets = authorityApi({
      [`/repos/${repository}/releases/tags/${tag}`]: [release({
        assets: [releaseAsset(tag, "unexpected.tgz", 1)],
      })],
    });
    await expect(verify(assets.api)).rejects.toThrow(
      "not exact, published, immutable, and artifact-complete",
    );

    const latest = authorityApi({
      [`/repos/${repository}/releases/latest`]: [{ tag_name: "v0.7.0" }],
    });
    await expect(verify(latest.api)).rejects.toThrow("Latest Release is not v0.8.0");
  });

  test("rejects changed immutable release identity on the terminal readback", async () => {
    const changed = authorityApi({
      [`/repos/${repository}/releases/tags/${tag}`]: [
        release(),
        release({ id: 124 }),
      ],
    });
    await expect(verify(changed.api)).rejects.toThrow("changed during authority verification");
  });

  test("grandfathers only asset-free v0.8.0 and requires the exact artifact pair later", () => {
    expect(() => exactPublishedRelease(release(), tag)).not.toThrow();

    const futureTag = "v0.8.1";
    const archiveName = "hraness-message-like-me-0.8.1.tgz";
    const futureRelease = release({
      assets: [
        releaseAsset(futureTag, archiveName, 1),
        releaseAsset(futureTag, "SHA256SUMS", 2),
      ],
      tag_name: futureTag,
    });
    expect(() => exactPublishedRelease(futureRelease, futureTag)).not.toThrow();
    expect(() => exactPublishedRelease(release({ tag_name: futureTag }), futureTag)).toThrow(
      "not exact, published, immutable, and artifact-complete",
    );
    expect(() => exactPublishedRelease({
      ...futureRelease,
      assets: [
        releaseAsset(futureTag, archiveName, 1),
        { ...releaseAsset(futureTag, "SHA256SUMS", 2), digest: "sha256:invalid" },
      ],
    }, futureTag)).toThrow("not one exact uploaded immutable artifact");
  });
});
