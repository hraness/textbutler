import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { absoluteUrl, CANONICAL_PAGE_PATHS, RELEASE_URL, SITE_NAME, SITE_ORIGIN, SOFTWARE_VERSION } from "../app/_lib/site.ts";

import manifest from "../app/manifest.ts";
import { metadata } from "../app/layout.tsx";

type PackageIdentity = Readonly<{ version?: unknown }>;

async function packageVersion(path: string): Promise<string> {
  const manifest = await Bun.file(path).json() as PackageIdentity;
  if (typeof manifest.version !== "string") throw new Error(`${path} has no package version`);
  return manifest.version;
}

describe("release identity", () => {
  test("uses Textbutler identity without advertising a web messaging app", () => {
    expect(SITE_NAME).toBe("Textbutler");
    expect(SITE_ORIGIN).toBe("https://textbutler.app");
    expect(new URL(String(metadata.metadataBase)).origin).toBe(SITE_ORIGIN);
    expect(metadata.applicationName).toBe(SITE_NAME);
    for (const path of CANONICAL_PAGE_PATHS) expect(new URL(absoluteUrl(path)).origin).toBe(SITE_ORIGIN);
    expect(manifest().name).toBe(SITE_NAME);
    expect(manifest().display).toBe("browser");
  });

  test("preserves the immutable legacy package release coordinates", async () => {
    const siteRoot = resolve(import.meta.dir, "..");
    const repositoryRoot = resolve(siteRoot, "..");
    const [packageRelease, siteRelease] = await Promise.all([
      packageVersion(resolve(repositoryRoot, "package.json")),
      packageVersion(resolve(siteRoot, "package.json")),
    ]);

    expect(siteRelease).toBe(packageRelease);
    expect(SOFTWARE_VERSION).toBe(packageRelease);
    expect(RELEASE_URL).toBe(
      `https://github.com/hraness/textbutler/releases/tag/v${packageRelease}`,
    );
  });

  test("keeps legacy installation separate from the unreleased menu companion", async () => {
    const siteRoot = resolve(import.meta.dir, "..");
    const repositoryRoot = resolve(siteRoot, "..");
    const packageRelease = await packageVersion(resolve(repositoryRoot, "package.json"));
    const exactInstall = `bun add --global @hraness/message-like-me@${packageRelease}`;
    const [readme, page, changelog] = await Promise.all([
      Bun.file(resolve(repositoryRoot, "README.md")).text(),
      Bun.file(resolve(siteRoot, "app", "page.tsx")).text(),
      Bun.file(resolve(repositoryRoot, "CHANGELOG.md")).text(),
    ]);

    expect(readme).toContain(exactInstall);
    expect(page).toContain("Message Like Me v{SOFTWARE_VERSION}");
    expect(page).toContain("It does not install Textbutler or enable automatic replies.");
    expect(page).not.toContain("bun add --global");
    expect(readme).not.toContain("github:hraness/message-like-me#");
    expect(page).not.toContain("github:hraness/message-like-me#");
    expect(readme).not.toContain("is not published to npm");
    expect(changelog).toContain(
      `exact public \`@hraness/message-like-me@${packageRelease}\` npm package`,
    );
    expect(changelog).toContain("same reviewed bytes mirrored in the");
    expect(changelog).toContain("immutable GitHub Release");
  });
});
