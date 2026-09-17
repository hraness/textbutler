import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanPackedPackage } from "./package-smoke";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "message-like-me-packed-privacy-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "LICENSE"), "MIT\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("packed public privacy boundary", () => {
  test("accepts only the reviewed finite UTF-8 package surface", async () => {
    const root = await fixture();
    try {
      await expect(scanPackedPackage(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects unknown binary and extensionless artifacts instead of skipping them", async () => {
    for (const [name, bytes] of [
      ["private.pem", "secret"],
      ["archive.zip", "PK"],
      ["credentials", "secret"],
      ["invalid.md", Buffer.from([0xff, 0xfe])],
    ] as const) {
      const root = await fixture();
      try {
        await writeFile(join(root, name), bytes);
        await expect(scanPackedPackage(root)).rejects.toThrow(
          name === "invalid.md" ? "canonical UTF-8" : "unapproved public-package file type",
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  test("admits vendored WASM only at single-level vendor paths", async () => {
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    for (const [name, accepted] of [
      ["vendor/oh-archive-strict/module.wasm", true],
      ["vendor/nested/deep/module.wasm", false],
      ["dist/module.wasm", false],
      ["module.wasm", false],
    ] as const) {
      const root = await fixture();
      try {
        const target = join(root, name);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, wasm);
        if (accepted) {
          await expect(scanPackedPackage(root)).resolves.toBeUndefined();
        } else {
          await expect(scanPackedPackage(root)).rejects.toThrow(
            "unapproved public-package file type",
          );
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });
});
