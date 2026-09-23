import { afterEach, expect, test } from "bun:test";
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactWorkspace } from "./workspace.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-test-")));
  roots.push(root);
  const workspace = await ContactWorkspace.create(join(root, "contact"));
  return { root, workspace };
}
test("contact memory is editable; policy and other contacts are unreachable", async () => {
  const { workspace } = await setup();
  await workspace.write("notes/preferences.md", "Tea, according to m1.");
  await workspace.edit("notes/preferences.md", "Tea", "Coffee");
  expect(await workspace.read("notes/preferences.md")).toBe("Coffee, according to m1.");
  for (const path of ["../other/MEMORY.md", "/etc/passwd", "settings.json", "notes/../MEMORY.md", "hooks/plugin.ts", "notes/.secret", "AGENTS.md/trick"]) await expect(workspace.write(path, "bad")).rejects.toThrow();
});
test("rejects symlinks and hard links before truncating outside files", async () => {
  const { root, workspace } = await setup();
  const outside = join(root, "outside.txt");
  await writeFile(outside, "preserve me", { mode: 0o600 });
  await symlink(outside, join(workspace.root, "notes", "symbolic.md"));
  await link(outside, join(workspace.root, "notes", "hard.md"));
  await expect(workspace.write("notes/symbolic.md", "bad")).rejects.toThrow();
  await expect(workspace.write("notes/hard.md", "bad")).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("preserve me");
});
test("bootstrap is bounded, attributed, and never a live event", async () => {
  const { workspace } = await setup();
  const path = await workspace.initializeHistory([{ id: "m1", author: "owner", at: 100, text: "A synthetic fixture." }]);
  expect(JSON.parse(await workspace.read(path))).toMatchObject({ purpose: "context-only-never-trigger", messages: [{ author: "owner" }] });
  await expect(workspace.initializeHistory(Array(201).fill({ id: "x", author: "contact", at: 1, text: "x" }))).rejects.toThrow();
});
test("existing files survive initialization and unsafe permissions fail", async () => {
  const { workspace } = await setup();
  await workspace.write("MEMORY.md", "Keep this context.");
  await ContactWorkspace.create(workspace.root);
  expect(await workspace.read("MEMORY.md")).toBe("Keep this context.");
  await chmod(join(workspace.root, "MEMORY.md"), 0o644);
  await expect(workspace.read("MEMORY.md")).rejects.toThrow();
});
test("conditional edits preserve a newer owner revision", async () => {
  const { workspace } = await setup();
  const original = await workspace.readVersioned("MEMORY.md");
  await workspace.write("MEMORY.md", "Owner correction");
  await expect(workspace.writeVersioned("MEMORY.md", "Stale agent edit", original.revision)).rejects.toThrow("conflict");
  expect(await workspace.read("MEMORY.md")).toBe("Owner correction");
});
test("an interrupted atomic-write stage does not obstruct memory recovery", async () => {
  const { workspace } = await setup();
  await writeFile(join(workspace.root, ".staging", "interrupted-write"), "Uncommitted new memory", { mode: 0o600 });
  await workspace.write("notes/recovery.md", "The original memory is available.");
  expect((await workspace.list()).some(file => file.path.includes("staging"))).toBe(false);
  expect(await workspace.read("notes/recovery.md")).toBe("The original memory is available.");
  await expect(workspace.read(".staging/interrupted-write")).rejects.toThrow();
});
test("creation sweeps stale staging orphans but never an in-flight stage", async () => {
  const { workspace } = await setup();
  const staging = join(workspace.root, ".staging");
  await writeFile(join(staging, "crash-orphan"), "stale staged bytes", { mode: 0o600 });
  await writeFile(join(staging, "active-stage"), "younger staged bytes", { mode: 0o600 });
  const stale = new Date(Date.now() - 120_000);
  await utimes(join(staging, "crash-orphan"), stale, stale);
  await ContactWorkspace.create(workspace.root);
  await expect(lstat(join(staging, "crash-orphan"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(staging, "active-stage"))).isFile()).toBe(true);
});
test("AGENTS.md is created once and stays read-only for every writable file path", async () => {
  const { workspace } = await setup();
  const original = await workspace.read("AGENTS.md");
  expect(original).toContain("Textbutler");
  const { revision } = await workspace.readVersioned("AGENTS.md");
  for (const attempt of [
    () => workspace.write("AGENTS.md", "injected instructions"),
    () => workspace.writeVersioned("AGENTS.md", "injected instructions", null),
    () => workspace.writeVersioned("AGENTS.md", "injected instructions", revision),
    () => workspace.edit("AGENTS.md", "Your role", "replanted"),
  ]) await expect(attempt()).rejects.toThrow();
  expect(await workspace.read("AGENTS.md")).toBe(original);
  await workspace.write("MEMORY.md", "Memory stays writable.");
  await ContactWorkspace.create(workspace.root);
  expect(await workspace.read("AGENTS.md")).toBe(original);
  expect(await workspace.read("MEMORY.md")).toBe("Memory stays writable.");
});

test("binary attachments are admitted as owned snapshots without widening text tools", async () => {
  const { workspace } = await setup(); const bytes = Buffer.alloc(2 * 1024 * 1024, 255);
  await writeFile(join(workspace.root, "outbox", "fixture.bin"), bytes, { mode: 0o600 });
  const asset = await workspace.admitAsset("outbox/fixture.bin");
  expect(asset.bytes).toEqual(bytes); expect(asset.sha256).toHaveLength(64);
  expect((await workspace.list()).find(entry => entry.path === "outbox/fixture.bin")?.bytes).toBe(bytes.length);
  await expect(workspace.read("outbox/fixture.bin")).rejects.toThrow();
  await expect(workspace.admitAsset("MEMORY.md")).rejects.toThrow();
  await writeFile(join(workspace.root, "outbox", "fixture.bin"), "owner changed", { mode: 0o600 });
  expect(asset.bytes).toEqual(bytes);
});
test("attachment admission refuses links and oversized assets", async () => {
  const { root, workspace } = await setup(); const outside = join(root, "other.bin");
  await writeFile(outside, "private", { mode: 0o600 });
  await symlink(outside, join(workspace.root, "outbox", "link.bin"));
  await link(outside, join(workspace.root, "outbox", "hard.bin"));
  for (const path of ["outbox/link.bin", "outbox/hard.bin", "../other.bin"]) await expect(workspace.admitAsset(path)).rejects.toThrow();
  await writeFile(join(workspace.root, "outbox", "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
  await expect(workspace.admitAsset("outbox/large.bin")).rejects.toThrow();
});
test("owner binary import is private, complete and idempotent without widening model text tools", async () => {
  const { workspace } = await setup(), bytes = Buffer.alloc(2 * 1024 * 1024, 255);
  const imported = await workspace.importAsset(bytes, "jpg");
  expect(imported.bytes).toBe(bytes.length);
  expect((await workspace.admitAsset(imported.path)).bytes).toEqual(bytes);
  expect((await lstat(join(workspace.root, imported.path))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(workspace.root, imported.path))).nlink).toBe(1);
  const inode = (await lstat(join(workspace.root, imported.path))).ino;
  expect(await workspace.importAsset(bytes, "jpg")).toEqual(imported);
  expect((await lstat(join(workspace.root, imported.path))).ino).toBe(inode);
  await expect(workspace.read(imported.path)).rejects.toThrow();
  await writeFile(join(workspace.root, imported.path), "changed", { mode: 0o600 });
  await expect(workspace.importAsset(bytes, "jpg")).rejects.toThrow("identity changed");
  expect(await readFile(join(workspace.root, imported.path), "utf8")).toBe("changed");
});
test("owner media import rejects excessive bytes, unsafe names and linked outboxes", async () => {
  const { root, workspace } = await setup();
  for (const extension of ["../jpg", "PNG", "", "x/y"]) await expect(workspace.importAsset(Buffer.from("x"), extension)).rejects.toThrow();
  await expect(workspace.importAsset(Buffer.alloc(0))).rejects.toThrow();
  await expect(workspace.importAsset(Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toThrow();
  await rm(join(workspace.root, "outbox"), { recursive: true });
  await symlink(root, join(workspace.root, "outbox"));
  await expect(workspace.importAsset(Buffer.from("x"))).rejects.toThrow();
});
