import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  assertReleaseAssetBytes,
  parseGitHubRelease,
  parseNpmRelease,
  releaseArchiveName,
  releaseDistribution,
  releasePackageForName,
  releaseVersionForCurrentAdmission,
  rootReleasePackage,
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
});
