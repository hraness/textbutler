type JsonRecord = Record<string, unknown>;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const OIDC_CONFIG_ID = /^oidc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/u;

/** One publishable package coordinate. tagPrefix namespaces its immutable
 * release tags; title is the registry product name that prefixes the GitHub
 * Release name. Releases up to lastLegacyPageVersion were published with
 * legacyTitle and the bare identity sentence as their whole body; later
 * releases carry the standard page. Every field is a closed constant — no
 * caller input may extend this set. */
export type ReleasePackage = Readonly<{
  lastLegacyPageVersion: string;
  legacyTitle: string;
  name: string;
  repository: string;
  tagPrefix: string;
  title: string;
  workflowPath: string;
}>;

export const publicPackageName = "@hraness/message-like-me";
export const publicRepository = "hraness/textbutler";
export const rootReleasePackage: ReleasePackage = Object.freeze({
  lastLegacyPageVersion: "0.8.21",
  legacyTitle: "Message Like Me",
  name: publicPackageName,
  repository: publicRepository,
  tagPrefix: "v",
  title: "Textbutler",
  workflowPath: ".github/workflows/release.yml",
});
const releasePackages: ReadonlyMap<string, ReleasePackage> = new Map([
  [rootReleasePackage.name, rootReleasePackage],
]);

/** Resolve the closed package descriptor for a staged manifest name. The
 * staged writer reads its own package.json; an unknown name fails closed so a
 * foreign manifest can never publish through this repository's authority. */
export function releasePackageForName(name: string): ReleasePackage {
  const descriptor = releasePackages.get(name);
  if (descriptor === undefined) {
    throw new Error("The public package manifest identity is invalid.");
  }
  return descriptor;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

export type NpmReleaseCoordinate = Readonly<{
  integrity: string;
  shasum: string;
  tarball: string;
}>;

export type GitHubReleaseAsset = Readonly<{
  browserDownloadUrl: string;
  digest: string;
  id: number;
  name: string;
  size: number;
}>;

export type GitHubReleaseCoordinate = Readonly<{
  checksum: GitHubReleaseAsset;
  tarball: GitHubReleaseAsset;
}>;


const MAXIMUM_CHANGELOG_BYTES = 1_024 * 1_024;
const MAXIMUM_SECTION_BYTES = 32 * 1_024;
const IDENTITY_OPEN = "<!-- ";
const IDENTITY_CLOSE = " -->";

export type ChangelogSection = Readonly<{
  changes: string;
  summary: string;
}>;

function compareSemver(left: string, right: string): number {
  const a = text(left, SEMVER, "release version").split(".").map(Number);
  const b = text(right, SEMVER, "release version").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Select the one CHANGELOG.md section for version. Its heading is
 * `## X.Y.Z` or `## vX.Y.Z` with an optional ` - YYYY-MM-DD`; its body is a
 * summary paragraph followed by a bulleted list. A missing, duplicated,
 * empty, malformed, or Unreleased section fails closed so the release page
 * is never written without reviewed notes. */
export function changelogSection(changelog: string, version: string): ChangelogSection {
  text(version, SEMVER, "changelog version");
  if (typeof changelog !== "string" || Buffer.byteLength(changelog, "utf8") > MAXIMUM_CHANGELOG_BYTES) {
    throw new Error("CHANGELOG.md is missing or exceeds its byte bound.");
  }
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const escaped = version.replaceAll(".", "\\.");
  const heading = new RegExp(`^## v?${escaped}(?![0-9A-Za-z.-])(.*)$`, "u");
  const starts = lines.flatMap((line, index) => heading.test(line) ? [index] : []);
  if (starts.length === 0) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  if (starts.length > 1) throw new Error(`CHANGELOG.md has more than one section for ${version}.`);
  const start = starts[0] as number;
  const suffix = heading.exec(lines[start] as string)?.[1] ?? "";
  if (/unreleased/iu.test(suffix)) throw new Error(`CHANGELOG.md section ${version} still says Unreleased.`);
  if (suffix !== "" && !/^ - [0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(suffix)) {
    throw new Error(`CHANGELOG.md heading for ${version} must be "## ${version}" with an optional " - YYYY-MM-DD".`);
  }
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /u.test(lines[end] as string)) end += 1;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (body.length === 0) throw new Error(`CHANGELOG.md section ${version} is empty.`);
  if (Buffer.byteLength(body, "utf8") > MAXIMUM_SECTION_BYTES) {
    throw new Error(`CHANGELOG.md section ${version} exceeds its byte bound.`);
  }
  if (/unreleased/iu.test(body)) throw new Error(`CHANGELOG.md section ${version} still says Unreleased.`);
  if (body.includes("<!--") || body.includes("-->") || /^#/mu.test(body)) {
    throw new Error(`CHANGELOG.md section ${version} must hold only a summary and bullets.`);
  }
  const firstBullet = body.search(/^- /mu);
  if (firstBullet <= 0) {
    throw new Error(`CHANGELOG.md section ${version} needs a summary paragraph followed by bullets.`);
  }
  const summary = body.slice(0, firstBullet).trim();
  const changes = body.slice(firstBullet).trim();
  if (summary.length === 0 || summary.split("\n").some((line) => line.startsWith("- "))) {
    throw new Error(`CHANGELOG.md section ${version} needs a summary paragraph followed by bullets.`);
  }
  return Object.freeze({ changes, summary });
}

/** Split a release body into the visible notes and the identity record: the
 * text inside the last `<!-- ` marker, which must close the body with `-->`. */
export function splitReleaseBody(body: unknown): Readonly<{ identity: string; notes: string }> {
  if (typeof body !== "string" || !body.endsWith(IDENTITY_CLOSE)) {
    throw new Error("GitHub Release body does not end with its identity record.");
  }
  const marker = body.lastIndexOf(IDENTITY_OPEN);
  if (marker < 0) throw new Error("GitHub Release body has no identity record.");
  const identity = body.slice(marker + IDENTITY_OPEN.length, body.length - IDENTITY_CLOSE.length);
  if (identity.length === 0 || identity.includes("\n") || identity.includes("-->")) {
    throw new Error("GitHub Release identity record is malformed.");
  }
  if (marker < 2 || body.slice(marker - 2, marker) !== "\n\n") {
    throw new Error("GitHub Release identity record must follow the notes after one blank line.");
  }
  return Object.freeze({ identity, notes: body.slice(0, marker - 2) });
}

/** The source a release page is rendered from: the CHANGELOG.md bytes of the
 * release commit and that full commit SHA. */
export type ReleasePageSource = Readonly<{
  changelog: string;
  commit: string;
}>;

export function releaseDistribution(releasePackage: ReleasePackage) {
  if (!SCOPED_PACKAGE.test(releasePackage.name)) throw new Error("Release package name is not one exact scoped coordinate.");
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(releasePackage.tagPrefix)) {
    throw new Error("Release package tag prefix is not one literal namespace.");
  }
  const unscoped = releasePackage.name.slice(releasePackage.name.indexOf("/") + 1);
  const scopeOwner = releasePackage.name.slice(1, releasePackage.name.indexOf("/"));
  const stableTag = new RegExp(`^${releasePackage.tagPrefix}(${SEMVER.source.slice(1, -1)})$`, "u");

  function releaseVersionForCurrentAdmission(manifestValue: unknown, verifiedTag: string): string {
    const manifest = record(manifestValue, "current-main release admission manifest");
    if (manifest.name !== releasePackage.name || manifest.license !== "MIT") {
      throw new Error("Current-main release admission code has the wrong public package or license identity.");
    }
    const match = stableTag.exec(verifiedTag);
    if (match?.[1] === undefined) throw new Error("Verified release tag is not one canonical stable version.");
    return match[1];
  }

  function releaseArchiveName(version: string): string {
    text(version, SEMVER, "release version");
    return `${scopeOwner}-${unscoped}-${version}.tgz`;
  }


  function releaseIdentity(version: string): string {
    text(version, SEMVER, "release identity version");
    return `Automated public release of ${releasePackage.name}@${version} from ${releasePackage.tagPrefix}${version}.`;
  }

  function releaseTitle(version: string): string {
    text(version, SEMVER, "release title version");
    return `${releasePackage.title} ${releasePackage.tagPrefix}${version}`;
  }

  function releaseNotes(version: string, source: ReleasePageSource): string {
    text(source.commit, SHA1, "release source commit");
    const section = changelogSection(source.changelog, version);
    const tag = `${releasePackage.tagPrefix}${version}`;
    const archive = releaseArchiveName(version);
    const base = `https://github.com/${releasePackage.repository}`;
    return [
      section.summary,
      "",
      "## Changes",
      "",
      section.changes,
      "",
      "## Install",
      "",
      "Install this version from the GitHub Release file:",
      "",
      "```sh",
      `bun add --global ${base}/releases/download/${tag}/${archive}`,
      "```",
      "",
      "The same bytes from npm:",
      "",
      "```sh",
      `bun add --global ${releasePackage.name}@${version}`,
      "```",
      "",
      "## Verify",
      "",
      `\`SHA256SUMS\` on this release lists the SHA-256 digest of \`${archive}\`. Download both files and run \`shasum -a 256 -c SHA256SUMS\`.`,
      "",
      `Built from commit [\`${source.commit}\`](${base}/commit/${source.commit}). The npm copy carries trusted-publisher provenance from this repository's release workflow. The [publishing guide](${base}/blob/${tag}/docs/publishing.md#legacy-package-publication) describes how the files are built and checked.`,
    ].join("\n");
  }

  /** The complete standard release body: changelog summary and changes,
   * generated Install and Verify, then the identity record as the final bytes. */
  function releaseBody(version: string, source: ReleasePageSource): string {
    return `${releaseNotes(version, source)}\n\n${IDENTITY_OPEN}${releaseIdentity(version)}${IDENTITY_CLOSE}`;
  }

  function assertReleasePage(release: JsonRecord, version: string, source: ReleasePageSource | undefined): void {
    const legacyEra = compareSemver(version, releasePackage.lastLegacyPageVersion) <= 0;
    if (
      legacyEra
      && release.name === `${releasePackage.legacyTitle} ${releasePackage.tagPrefix}${version}`
      && release.body === releaseIdentity(version)
    ) return;
    if (release.name !== releaseTitle(version)) {
      throw new Error(`GitHub Release ${releasePackage.tagPrefix}${version} has the wrong title.`);
    }
    const page = splitReleaseBody(release.body);
    if (page.identity !== releaseIdentity(version)) {
      throw new Error(`GitHub Release ${releasePackage.tagPrefix}${version} has the wrong identity record.`);
    }
    if (source === undefined) {
      throw new Error(`GitHub Release ${releasePackage.tagPrefix}${version} notes need their changelog source.`);
    }
    if (page.notes !== releaseNotes(version, source)) {
      throw new Error(`GitHub Release ${releasePackage.tagPrefix}${version} notes differ from the rendered changelog.`);
    }
  }

  function parseNpmRelease(
    value: unknown,
    version: string,
    options: Readonly<{ requireProvenance: boolean }> = { requireProvenance: true },
  ): NpmReleaseCoordinate {
    text(version, SEMVER, "npm release version");
    const release = record(value, "npm release");
    if (release.name !== releasePackage.name || release.version !== version || release.license !== "MIT") {
      throw new Error(`npm ${releasePackage.name}@${version} has the wrong package identity or license.`);
    }
    const dist = record(release.dist, "npm release dist");
    const expectedTarball = `https://registry.npmjs.org/${releasePackage.name}/-/${unscoped}-${version}.tgz`;
    if (dist.tarball !== expectedTarball) throw new Error("npm release tarball URL is not canonical.");
    const coordinate = Object.freeze({
      integrity: text(dist.integrity, SHA512_INTEGRITY, "npm release integrity"),
      shasum: text(dist.shasum, SHA1, "npm release SHA-1"),
      tarball: expectedTarball,
    });
    if (options.requireProvenance) {
      const npmUser = record(release._npmUser, "npm trusted publisher identity");
      const trustedPublisher = record(npmUser.trustedPublisher, "npm trusted publisher");
      const attestations = record(dist.attestations, "npm release provenance attestations");
      const provenance = record(attestations.provenance, "npm release provenance");
      const expectedAttestationUrl =
        `https://registry.npmjs.org/-/npm/v1/attestations/${releasePackage.name.replaceAll("/", "%2f")}@${version}`;
      if (
        provenance.predicateType !== "https://slsa.dev/provenance/v1"
        || attestations.url !== expectedAttestationUrl
        || npmUser.name !== "GitHub Actions"
        || npmUser.email !== "npm-oidc-no-reply@github.com"
        || trustedPublisher.id !== "github"
        || typeof trustedPublisher.oidcConfigId !== "string"
        || !OIDC_CONFIG_ID.test(trustedPublisher.oidcConfigId)
      ) {
        throw new Error("npm release trusted-publisher provenance is missing or invalid.");
      }
    }
    return coordinate;
  }

  function parseAsset(value: unknown, expectedName: string, tag: string): GitHubReleaseAsset {
    const asset = record(value, `GitHub Release asset ${expectedName}`);
    const expectedUrl = `https://github.com/${releasePackage.repository}/releases/download/${tag}/${expectedName}`;
    if (asset.name !== expectedName || asset.state !== "uploaded" || asset.browser_download_url !== expectedUrl) {
      throw new Error(`GitHub Release asset ${expectedName} has the wrong identity or state.`);
    }
    return Object.freeze({
      browserDownloadUrl: expectedUrl,
      digest: text(asset.digest, SHA256_DIGEST, `GitHub Release asset ${expectedName} digest`),
      id: positiveInteger(asset.id, `GitHub Release asset ${expectedName} id`),
      name: expectedName,
      size: positiveInteger(asset.size, `GitHub Release asset ${expectedName} size`),
    });
  }

  function parseGitHubRelease(
    value: unknown,
    version: string,
    source?: ReleasePageSource,
  ): GitHubReleaseCoordinate {
    text(version, SEMVER, "GitHub release version");
    const tag = `${releasePackage.tagPrefix}${version}`;
    const release = record(value, "GitHub Release");
    assertReleasePage(release, version, source);
    if (
      release.tag_name !== tag
      || release.draft !== false
      || release.prerelease !== false
      || release.immutable !== true
    ) {
      throw new Error(`GitHub Release ${tag} is not exact, published, and immutable.`);
    }
    if (!Array.isArray(release.assets) || release.assets.length !== 2) {
      throw new Error(`GitHub Release ${tag} must contain exactly two immutable artifacts.`);
    }
    const byName = new Map(release.assets.map((asset) => {
      const item = record(asset, "GitHub Release asset");
      return [item.name, asset] as const;
    }));
    if (byName.size !== 2) throw new Error(`GitHub Release ${tag} contains duplicate asset names.`);
    const archiveName = releaseArchiveName(version);
    const tarball = parseAsset(byName.get(archiveName), archiveName, tag);
    const checksum = parseAsset(byName.get("SHA256SUMS"), "SHA256SUMS", tag);
    return Object.freeze({ checksum, tarball });
  }

  return Object.freeze({
    package: releasePackage,
    releaseVersionForCurrentAdmission,
    releaseArchiveName,
    parseNpmRelease,
    parseGitHubRelease,
    releaseBody,
    releaseIdentity,
    releaseNotes,
    releaseTitle,
    stableTag,
    unscoped,
  });
}

const root = releaseDistribution(rootReleasePackage);

export function releaseVersionForCurrentAdmission(
  manifestValue: unknown,
  verifiedTag: string,
): string {
  return root.releaseVersionForCurrentAdmission(manifestValue, verifiedTag);
}

export function releaseArchiveName(version: string): string {
  return root.releaseArchiveName(version);
}

export function parseNpmRelease(
  value: unknown,
  version: string,
  options: Readonly<{ requireProvenance: boolean }> = { requireProvenance: true },
): NpmReleaseCoordinate {
  return root.parseNpmRelease(value, version, options);
}

export function parseGitHubRelease(
  value: unknown,
  version: string,
  source?: ReleasePageSource,
): GitHubReleaseCoordinate {
  return root.parseGitHubRelease(value, version, source);
}

export function releaseBody(version: string, source: ReleasePageSource): string {
  return root.releaseBody(version, source);
}

export function releaseTitle(version: string): string {
  return root.releaseTitle(version);
}

export function assertReleaseAssetBytes(
  coordinate: GitHubReleaseCoordinate,
  tarballBytes: Uint8Array,
  checksumBytes: Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): void {
  const tarballDigest = sha256(tarballBytes);
  const checksumDigest = sha256(checksumBytes);
  if (
    coordinate.tarball.size !== tarballBytes.byteLength
    || coordinate.tarball.digest !== `sha256:${tarballDigest}`
    || coordinate.checksum.size !== checksumBytes.byteLength
    || coordinate.checksum.digest !== `sha256:${checksumDigest}`
  ) throw new Error("GitHub Release asset size or digest does not match its immutable bytes.");
  const expectedChecksum = `${tarballDigest}  ${coordinate.tarball.name}\n`;
  if (new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes) !== expectedChecksum) {
    throw new Error("SHA256SUMS does not describe the exact GitHub Release tarball.");
  }
}
