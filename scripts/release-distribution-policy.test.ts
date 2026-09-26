import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertReleaseAssetBytes,
  changelogSection,
  parseGitHubRelease,
  parseNpmRelease,
  releaseArchiveName,
  releaseBody,
  releaseDistribution,
  releasePackageForName,
  releaseVersionForCurrentAdmission,
  releaseTitle,
  rootReleasePackage,
  splitReleaseBody,
} from "./release-distribution-policy";

const version = "0.8.1";
const tarball = new TextEncoder().encode("exact package bytes");
const tarballDigest = createHash("sha256").update(tarball).digest("hex");
const checksum = new TextEncoder().encode(`${tarballDigest}  ${releaseArchiveName(version)}\n`);
const checksumDigest = createHash("sha256").update(checksum).digest("hex");
const npmUser = {
  email: "npm-oidc-no-reply@github.com",
  name: "GitHub Actions",
  trustedPublisher: {
    id: "github",
    oidcConfigId: "oidc:12345678-1234-1234-1234-123456789abc",
  },
};

function release(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    assets: [
      {
        browser_download_url: `https://github.com/hraness/textbutler/releases/download/v${version}/${releaseArchiveName(version)}`,
        digest: `sha256:${tarballDigest}`,
        id: 1,
        name: releaseArchiveName(version),
        size: tarball.byteLength,
        state: "uploaded",
      },
      {
        browser_download_url: `https://github.com/hraness/textbutler/releases/download/v${version}/SHA256SUMS`,
        digest: `sha256:${checksumDigest}`,
        id: 2,
        name: "SHA256SUMS",
        size: checksum.byteLength,
        state: "uploaded",
      },
    ],
    draft: false,
    body: `Automated public release of @hraness/message-like-me@${version} from v${version}.`,
    immutable: true,
    name: `Message Like Me v${version}`,
    prerelease: false,
    tag_name: `v${version}`,
    ...overrides,
  };
}

describe("public release distribution policy", () => {
  test("derives an older admitted release from its tag instead of newer current-main version metadata", () => {
    expect(releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/message-like-me",
      version: "9.9.9",
    }, "v0.8.1")).toBe("0.8.1");
    expect(() => releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/not-message-like-me",
    }, "v0.8.1")).toThrow("wrong public package");
    expect(() => releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/message-like-me",
    }, "latest")).toThrow("canonical stable version");
  });

  test("derives the exact scoped npm pack filename", () => {
    expect(releaseArchiveName(version)).toBe("hraness-message-like-me-0.8.1.tgz");
    expect(() => releaseArchiveName("latest")).toThrow("release version");
  });

  test("binds the closed package descriptor to its own tag, archive, and manifest", () => {
    expect(releasePackageForName("@hraness/message-like-me")).toBe(rootReleasePackage);
    expect(() => releasePackageForName("@hraness/agentmixer")).toThrow("manifest identity");
    expect(() => releasePackageForName("@hraness/other")).toThrow("manifest identity");
    expect(() => releasePackageForName("message-like-me")).toThrow("manifest identity");
    expect(() => releasePackageForName("constructor")).toThrow("manifest identity");
    expect(() => releasePackageForName("hasOwnProperty")).toThrow("manifest identity");

    const root = releaseDistribution(rootReleasePackage);
    expect(root.releaseArchiveName(version)).toBe(releaseArchiveName(version));
    expect(root.stableTag.exec(`v${version}`)?.[1]).toBe(version);
    expect(root.stableTag.test(`agentmixer-v${version}`)).toBe(false);
    expect(() => root.releaseVersionForCurrentAdmission({
      license: "MIT",
      name: "@hraness/message-like-me",
    }, `agentmixer-v${version}`)).toThrow("canonical stable version");
  });

  test("requires MIT npm identity and public-repository provenance", () => {
    const parsed = parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/message-like-me",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fmessage-like-me@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/message-like-me/-/message-like-me-${version}.tgz`,
      },
    }, version);
    expect(parsed.integrity).toBe("sha512-QUJDRA==");
    expect(() => parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/message-like-me",
      version,
      license: "MIT",
      dist: {
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/message-like-me/-/message-like-me-${version}.tgz`,
      },
    }, version)).toThrow("attestations");
    expect(() => parseNpmRelease({
      _npmUser: npmUser,
      name: "@hraness/message-like-me",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@attacker%2fmessage-like-me@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/message-like-me/-/message-like-me-${version}.tgz`,
      },
    }, version)).toThrow("provenance");
    expect(() => parseNpmRelease({
      _npmUser: {
        ...npmUser,
        trustedPublisher: { id: "github", oidcConfigId: "not-a-uuid" },
      },
      name: "@hraness/message-like-me",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fmessage-like-me@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/message-like-me/-/message-like-me-${version}.tgz`,
      },
    }, version)).toThrow("trusted-publisher provenance");
    const exactRelease = {
      name: "@hraness/message-like-me",
      version,
      license: "MIT",
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: `https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fmessage-like-me@${version}`,
        },
        integrity: "sha512-QUJDRA==",
        shasum: "b".repeat(40),
        tarball: `https://registry.npmjs.org/@hraness/message-like-me/-/message-like-me-${version}.tgz`,
      },
    };
    for (const badUser of [
      undefined,
      { ...npmUser, name: "token publisher" },
      { ...npmUser, email: "publisher@example.invalid" },
      { ...npmUser, trustedPublisher: { ...npmUser.trustedPublisher, id: "other" } },
    ]) {
      expect(() => parseNpmRelease({ ...exactRelease, _npmUser: badUser }, version)).toThrow();
    }
  });

  test("requires two exact immutable GitHub artifacts and their bytes", () => {
    const parsed = parseGitHubRelease(release(), version);
    expect(() => assertReleaseAssetBytes(
      parsed,
      tarball,
      checksum,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    )).not.toThrow();
    expect(() => parseGitHubRelease(release({ assets: [] }), version)).toThrow("exactly two");
  });

  test("renders the standard page from the changelog section and parses its identity", () => {
    const next = "0.8.22";
    const commit = "c".repeat(40);
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "Nothing yet.",
      "",
      "- Pending.",
      "",
      `## ${next} - 2026-09-30`,
      "",
      "Replies now wait for the owner.",
      "",
      "- `replies pause` stops the loop.",
      "- Paused contacts keep their queue.",
      "",
      "## 0.8.21 - 2026-09-24",
      "",
      "Older summary.",
      "",
      "- Older change.",
      "",
    ].join("\n");
    const source = { changelog, commit };
    const body = releaseBody(next, source);
    expect(releaseTitle(next)).toBe(`Textbutler v${next}`);
    expect(body.startsWith("Replies now wait for the owner.\n\n## Changes\n\n- `replies pause` stops the loop.\n- Paused contacts keep their queue.\n\n## Install\n")).toBe(true);
    expect(body).toContain(`bun add --global https://github.com/hraness/textbutler/releases/download/v${next}/hraness-message-like-me-${next}.tgz`);
    expect(body).toContain(`bun add --global @hraness/message-like-me@${next}`);
    expect(body).toContain("\n## Verify\n");
    expect(body).toContain(`https://github.com/hraness/textbutler/commit/${commit}`);
    expect(body).toContain(`https://github.com/hraness/textbutler/blob/v${next}/docs/publishing.md#legacy-package-publication`);
    expect(body).not.toContain("latest");
    expect(body).not.toContain("Older");
    expect(body.endsWith(
      `\n\n<!-- Automated public release of @hraness/message-like-me@${next} from v${next}. -->`,
    )).toBe(true);
    expect(body.indexOf("## Changes")).toBeLessThan(body.indexOf("## Install"));
    expect(body.indexOf("## Install")).toBeLessThan(body.indexOf("## Verify"));
    const page = splitReleaseBody(body);
    expect(page.identity).toBe(`Automated public release of @hraness/message-like-me@${next} from v${next}.`);
    expect(`${page.notes}\n\n<!-- ${page.identity} -->`).toBe(body);

    const standard = (overrides: Readonly<Record<string, unknown>> = {}) => ({
      ...release(),
      assets: release().assets.map((asset) => ({
        ...asset,
        browser_download_url: asset.browser_download_url.replaceAll(version, next),
        name: asset.name.replaceAll(version, next),
      })),
      body,
      name: `Textbutler v${next}`,
      tag_name: `v${next}`,
      ...overrides,
    });
    expect(() => parseGitHubRelease(standard(), next, source)).not.toThrow();
    expect(() => parseGitHubRelease(standard(), next)).toThrow("changelog source");
    expect(() => parseGitHubRelease(standard({ body: body.replace("stops the loop", "starts the loop") }), next, source))
      .toThrow("differ from the rendered changelog");
    expect(() => parseGitHubRelease(standard({ body: body.replace("Replies now", "<!-- x -->\n\nReplies now") }), next, source))
      .toThrow("differ from the rendered changelog");
    expect(() => parseGitHubRelease(standard({ body: `${body}\n` }), next, source)).toThrow("identity record");
    expect(() => parseGitHubRelease(standard({ body: `${body}\n\n<!-- extra -->` }), next, source))
      .toThrow("wrong identity record");
    expect(() => parseGitHubRelease(standard({ body: body.replace("@0.8.22 from", "@0.8.23 from") }), next, source))
      .toThrow("wrong identity record");
    expect(() => parseGitHubRelease(standard({ name: `Message Like Me v${next}` }), next, source))
      .toThrow("wrong title");
    expect(() => parseGitHubRelease(standard(), next, { changelog, commit: "d".repeat(40) }))
      .toThrow("differ from the rendered changelog");
    expect(() => parseGitHubRelease(standard({
      body: `Automated public release of @hraness/message-like-me@${next} from v${next}.`,
      name: `Message Like Me v${next}`,
    }), next, source)).toThrow();
  });

  test("keeps accepting the exact legacy page only for releases published before the standard", () => {
    const legacyVersion = "0.8.21";
    const legacy = {
      ...release(),
      assets: release().assets.map((asset) => ({
        ...asset,
        browser_download_url: asset.browser_download_url.replaceAll(version, legacyVersion),
        name: asset.name.replaceAll(version, legacyVersion),
      })),
      body: `Automated public release of @hraness/message-like-me@${legacyVersion} from v${legacyVersion}.`,
      name: `Message Like Me v${legacyVersion}`,
      tag_name: `v${legacyVersion}`,
    };
    expect(() => parseGitHubRelease(legacy, legacyVersion)).not.toThrow();
    expect(() => parseGitHubRelease({ ...legacy, name: `Textbutler v${legacyVersion}` }, legacyVersion)).toThrow();
    expect(() => parseGitHubRelease({ ...legacy, body: `${legacy.body}\n` }, legacyVersion)).toThrow();
  });

  test("fails closed when the changelog section is missing, empty, malformed, or Unreleased", () => {
    const section = (heading: string, body: string) => `# Changelog\n\n${heading}\n\n${body}\n\n## 0.1.0\n\nOld.\n\n- Old.\n`;
    const good = "Summary.\n\n- Change.";
    expect(changelogSection(section("## 0.9.0", good), "0.9.0")).toEqual({ changes: "- Change.", summary: "Summary." });
    expect(changelogSection(section("## v0.9.0 - 2026-10-01", good), "0.9.0").summary).toBe("Summary.");
    expect(() => changelogSection(section("## 0.9.1", good), "0.9.0")).toThrow("no section");
    expect(() => changelogSection(section("## 0.9.00", good), "0.9.0")).toThrow("no section");
    expect(() => changelogSection(section("## Unreleased", good), "0.9.0")).toThrow("no section");
    expect(() => changelogSection(section("## 0.9.0", ""), "0.9.0")).toThrow("empty");
    expect(() => changelogSection(section("## 0.9.0 - Unreleased", good), "0.9.0")).toThrow("Unreleased");
    expect(() => changelogSection(section("## 0.9.0 (Unreleased)", good), "0.9.0")).toThrow("Unreleased");
    expect(() => changelogSection(section("## 0.9.0", "Unreleased.\n\n- Change."), "0.9.0")).toThrow("Unreleased");
    expect(() => changelogSection(section("## 0.9.0 (2026-10-01)", good), "0.9.0")).toThrow("optional");
    expect(() => changelogSection(section("## 0.9.0", "- Only bullets."), "0.9.0")).toThrow("summary paragraph");
    expect(() => changelogSection(section("## 0.9.0", "Only a summary."), "0.9.0")).toThrow("summary paragraph");
    expect(() => changelogSection(section("## 0.9.0", "Summary.\n\n### Sub\n\n- Change."), "0.9.0")).toThrow("only a summary");
    expect(() => changelogSection(section("## 0.9.0", "Summary <!-- x -->.\n\n- Change."), "0.9.0")).toThrow("only a summary");
    expect(() => changelogSection(`${section("## 0.9.0", good)}\n## 0.9.0\n\n${good}\n`, "0.9.0")).toThrow("more than one");
    expect(() => changelogSection("", "0.9.0")).toThrow("no section");
  });

  test("the repository changelog carries a renderable section for the current package version", () => {
    const root = resolve(import.meta.dir, "..");
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
    const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
    const body = releaseBody(manifest.version, { changelog, commit: "0".repeat(40) });
    expect(splitReleaseBody(body).identity).toBe(
      `Automated public release of @hraness/message-like-me@${manifest.version} from v${manifest.version}.`,
    );
  });
});
