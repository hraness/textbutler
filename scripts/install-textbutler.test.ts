import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTextbutler } from "./install-textbutler.ts";
import { DISTRIBUTION_FILES, publishArtifact, renderLauncher, sha256, validateBun, verifyDistribution, type DistributionFile, type DistributionManifest } from "./textbutler-distribution.ts";

const roots: string[] = [];
afterEach(async () => {
  async function writable(path: string): Promise<void> {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name));
  }
  for (const root of roots.splice(0)) { await writable(root); await rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "tb-upgrade-")); roots.push(root);
  const prefix = join(root, "owner's install with spaces"), bun = await validateBun(process.execPath);
  async function distribution(label: string) {
    const from = join(root, label); await mkdir(from, { mode: 0o700 });
    const runtime = Buffer.from(`export async function runInstalledCli() { return 0; }\n// ${label}\n`);
    const lockfileSha256 = sha256("synthetic lock"), inputsDigest = sha256(`synthetic inputs ${label}`);
    const files = new Map<DistributionFile, Buffer>([["runtime.mjs", runtime], ["textbutler.mjs", Buffer.from(renderLauncher(sha256(runtime), bun.sha256))],
      ["LICENSE", Buffer.from("Synthetic license")], ["notices.md", Buffer.from("Synthetic inert upgrade")]]);
    const manifest: DistributionManifest = { schemaVersion: 1, product: "textbutler", kind: "local-pilot", providerAdmission: "unavailable",
      runtime: { version: "1.3.14", sha256: bun.sha256, platform: process.platform, arch: process.arch }, lockfileSha256, inputsDigest,
      version: sha256(JSON.stringify({ bundle: sha256(runtime), bun: bun.sha256, inputs: inputsDigest, lockfile: lockfileSha256 })),
      files: Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) as DistributionManifest["files"] };
    for (const file of DISTRIBUTION_FILES) await publishArtifact(from, file, files.get(file)!);
    await publishArtifact(from, "manifest.json", Buffer.from(JSON.stringify(manifest)));
    return { from, manifest, files };
  }
  return { root, prefix, old: await distribution("old"), next: await distribution("next") };
}

test("default install preserves a different managed version without publishing a new version", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix }), bytes = await readFile(old.command);
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix })).rejects.toThrow("--upgrade");
  expect(await readFile(old.command)).toEqual(bytes);
  await expect(lstat(join(f.prefix, "share/textbutler/versions", f.next.manifest.version))).rejects.toThrow();
});
test("explicit upgrade preserves the immutable old version and canonical launcher backup", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix });
  const before = await readFile(old.command), state = join(f.root, "owner-state"); await writeFile(state, "private settings retained", { mode: 0o600 });
  const next = await installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true });
  expect(next.previous).toEqual({ command: join(f.prefix, "share/textbutler/launchers", old.version), directory: old.directory, version: old.version });
  expect(await readFile(next.previous!.command)).toEqual(before);
  expect((await lstat(next.previous!.command)).mode & 0o777).toBe(0o500);
  expect((await lstat(old.directory)).mode & 0o777).toBe(0o500);
  expect((await verifyDistribution(old.directory)).manifest.version).toBe(old.version);
  expect((await verifyDistribution(next.directory)).manifest.version).toBe(next.version);
  expect(await readFile(next.command, "utf8")).toContain(next.directory.replaceAll("'", "'\\''"));
  expect(await readFile(state, "utf8")).toBe("private settings retained");
  const installed = await readFile(next.command), identity = await lstat(next.command);
  expect((await installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).version).toBe(next.version);
  expect((await installTextbutler({ from: f.next.from, prefix: f.prefix })).version).toBe(next.version);
  expect(await readFile(next.command)).toEqual(installed);
  expect((await lstat(next.command)).ino).toBe(identity.ino);
});
test("upgrade never replaces an arbitrary command or follows a command symlink", async () => {
  const f = await fixture(); await mkdir(join(f.prefix, "bin"), { recursive: true, mode: 0o700 });
  const command = join(f.prefix, "bin/textbutler"), sentinel = Buffer.from("#!/bin/sh\n# owner's unrelated command\nexit 0\n");
  await writeFile(command, sentinel, { mode: 0o500 });
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).rejects.toThrow("preserved");
  expect(await readFile(command)).toEqual(sentinel);
  const other = join(f.root, "unrelated-command"); await writeFile(other, sentinel, { mode: 0o500 });
  await unlink(command); await symlink(other, command);
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).rejects.toThrow();
  expect((await lstat(command)).isSymbolicLink()).toBe(true);
  expect(await readFile(other)).toEqual(sentinel);
  await expect(lstat(join(f.prefix, "share/textbutler/versions", f.next.manifest.version))).rejects.toThrow();
});
test("a managed-looking wrapper requires its complete unmodified installed distribution", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix }), before = await readFile(old.command);
  await chmod(old.directory, 0o700); await unlink(join(old.directory, "LICENSE")); await chmod(old.directory, 0o500);
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).rejects.toThrow("inventory");
  expect(await readFile(old.command)).toEqual(before);
  await expect(lstat(join(f.prefix, "share/textbutler/versions", f.next.manifest.version))).rejects.toThrow();
});
test("interruption before activation leaves the old command and retry completes the prepared upgrade", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix }), before = await readFile(old.command);
  const orphan = join(f.prefix, "bin/.textbutler-upgrade-interrupted"); await writeFile(orphan, "unconfirmed staging bytes", { mode: 0o500 });
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true }, {
    async beforeUpgradeCommit() { throw Error("Synthetic interrupted publication"); },
  })).rejects.toThrow("Synthetic interrupted publication");
  expect(await readFile(old.command)).toEqual(before);
  expect(await readFile(join(f.prefix, "share/textbutler/launchers", old.version))).toEqual(before);
  expect((await verifyDistribution(join(f.prefix, "share/textbutler/versions", f.next.manifest.version))).manifest.version).toBe(f.next.manifest.version);
  expect((await readdir(join(f.prefix, "bin"))).sort()).toEqual([".textbutler-upgrade-interrupted", "textbutler"]);
  expect((await installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).version).toBe(f.next.manifest.version);
  expect(await readFile(orphan, "utf8")).toBe("unconfirmed staging bytes");
});
test("upgrade revalidates the exact command immediately before atomic replacement", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix }), before = await readFile(old.command);
  const oldIdentity = await lstat(old.command), held = join(f.root, "original-launcher-held");
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true }, {
    // Keep the original inode allocated: Linux may reuse it after unlink.
    async beforeUpgradeCommit() { await rename(old.command, held); await writeFile(old.command, before, { mode: 0o500 }); },
  })).rejects.toThrow("changed before upgrade");
  expect(await readFile(old.command)).toEqual(before);
  expect((await lstat(held)).ino).toBe(oldIdentity.ino);
  expect((await lstat(old.command)).ino).not.toBe(oldIdentity.ino);
});
test("upgrade preserves an unrelated existing launcher backup", async () => {
  const f = await fixture(), old = await installTextbutler({ from: f.old.from, prefix: f.prefix }), before = await readFile(old.command);
  const backups = join(f.prefix, "share/textbutler/launchers"); await mkdir(backups, { mode: 0o700 });
  const backup = join(backups, old.version); await writeFile(backup, "owner backup sentinel", { mode: 0o500 });
  await expect(installTextbutler({ from: f.next.from, prefix: f.prefix, upgrade: true })).rejects.toThrow("preserved");
  expect(await readFile(old.command)).toEqual(before);
  expect(await readFile(backup, "utf8")).toBe("owner backup sentinel");
});
