import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const siteRoot = resolve(import.meta.dir, "..");

describe("site typography", () => {
  test("loads the immutable Nebula Sans release for proportional roles", async () => {
    const [css, layout, manifestSource] = await Promise.all([
      readFile(resolve(siteRoot, "app/globals.css"), "utf8"),
      readFile(resolve(siteRoot, "app/layout.tsx"), "utf8"),
      readFile(resolve(siteRoot, "package.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.["@hraness/design-kit"])
      .toBe("github:hraness/design-kit#v0.17.0");
    expect(layout).toContain("import '@hraness/design-kit/fonts.css';");
    expect(layout.indexOf("@hraness/design-kit/fonts.css"))
      .toBeLessThan(layout.indexOf("./globals.css"));
    expect(css).toContain("@import '@hraness/design-kit/styles.css';");
    expect(css).not.toContain("@import '@hraness/design-kit/product-marketing.css';");
    expect(css).not.toContain("@import 'tail" + "windcss';");
    expect(css.indexOf("@import '@hraness/ui/stylex.css';"))
      .toBeLessThan(css.indexOf("@import '@hraness/design-kit/styles.css';"));
    expect(css).toContain('font-family: var(--font-text);');
    expect(css).not.toContain("font-family: Inter");
  });

  test("the complete Design Kit export reaches its compiled React recipes", async () => {
    const styles = await readFile(new URL(import.meta.resolve("@hraness/design-kit/styles.css")), "utf8");
    const components = await readFile(new URL(import.meta.resolve("@hraness/design-kit/components.css")), "utf8");
    const compiled = await readFile(new URL(import.meta.resolve("@hraness/design-kit/stylex.css")), "utf8");
    expect(styles).toContain('@import "./components.css";');
    expect(styles).toContain('@import "./product-marketing.css";');
    expect(components).toContain('@import "../dist/stylex.css";');
    expect(compiled).toContain("@layer components.hraness-design-kit.priority");
  });

  test("keeps one proportional face and an explicit mono role", async () => {
    const css = await readFile(resolve(siteRoot, "app/globals.css"), "utf8");
    const paper = await readFile(resolve(siteRoot, "styles/vendor/hraness-paper/paper-theme.css"), "utf8");

    expect(paper).toContain("--font-heading: var(--font-text);");
    expect(css).not.toMatch(/Iowan Old Style|Baskerville|Times New Roman/u);
    expect(css).not.toMatch(/text-transform:\s*uppercase/u);
    expect(paper).toContain('ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace');
  });
});
