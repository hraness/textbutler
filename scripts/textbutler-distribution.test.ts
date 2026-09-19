import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installTextbutler } from "./install-textbutler.ts";
import { DISTRIBUTION_FILES, parseDistributionManifest, publishArtifact, renderLauncher, sha256, validateBun, verifyDistribution, type DistributionFile, type DistributionManifest } from "./textbutler-distribution.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await chmodTree(root); await rm(root, { recursive: true, force: true }); } });
async function chmodTree(root: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await chmodTree(join(root, entry.name));
}
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "textbutler-distribution-")); roots.push(root);
  const from = join(root, "build"), prefix = join(root, "install with spaces");
  await mkdir(from, { mode: 0o700 });
  const bun = await validateBun(process.execPath);
  const runtime = Buffer.from('process.stdout.write("synthetic-import\\n"); export async function runInstalledCli(args, entrypoint) { process.stdout.write(JSON.stringify({args, entrypoint}) + "\\n"); return 0; }');
  const lockfileSha256 = sha256("synthetic lock"), inputsDigest = sha256("synthetic inputs");
  const files = new Map<DistributionFile, Buffer>([["runtime.mjs", runtime], ["textbutler.mjs", Buffer.from(renderLauncher(sha256(runtime), bun.sha256))], ["LICENSE", Buffer.from("Synthetic license")], ["notices.md", Buffer.from("Synthetic inert pilot")]]);
  const manifest: DistributionManifest = { schemaVersion: 1, product: "textbutler", kind: "local-pilot", providerAdmission: "unavailable",
    runtime: { version: "1.3.14", sha256: bun.sha256, platform: process.platform, arch: process.arch }, lockfileSha256, inputsDigest,
    version: sha256(JSON.stringify({ bundle: sha256(runtime), bun: bun.sha256, inputs: inputsDigest, lockfile: lockfileSha256 })),
    files: Object.fromEntries([...files].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: sha256(bytes) }])) as DistributionManifest["files"] };
  for (const file of DISTRIBUTION_FILES) await publishArtifact(from, file, files.get(file)!);
  await publishArtifact(from, "manifest.json", Buffer.from(JSON.stringify(manifest)));
  return { root, from, prefix, manifest, files };
}
async function run(command: string, args: string[] = []) {
  const child = Bun.spawn([command, ...args], { cwd: await realpath("/tmp"), stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-textbutler-fixture-home" } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("inert local Textbutler distribution", () => {
  test("manifest rejects provider attestation, extra files and a mismatched content identity", async () => {
    const f = await fixture();
    expect(parseDistributionManifest(f.manifest).providerAdmission).toBe("unavailable");
    expect(() => parseDistributionManifest({ ...f.manifest, providerAdmission: "qualified" })).toThrow();
    expect(() => parseDistributionManifest({ ...f.manifest, version: "a".repeat(64) })).toThrow();
    await writeFile(join(f.from, "extra.js"), "extra");
    await expect(verifyDistribution(f.from)).rejects.toThrow("inventory");
  });
  test("installation is content-addressed, preserves existing application data and is idempotent", async () => {
    const f = await fixture(), state = join(f.root, "state.json");
    await writeFile(state, "owner sentinel", { mode: 0o600 });
    const first = await installTextbutler(f), second = await installTextbutler(f);
    expect(first).toEqual(second);
    expect(first.directory).toBe(join(f.prefix, "share/textbutler/versions", f.manifest.version));
    expect(await readFile(state, "utf8")).toBe("owner sentinel");
    expect((await verifyDistribution(first.directory)).manifest.providerAdmission).toBe("unavailable");
    const result = await run(first.command, ["word with spaces", "$(literal)"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"args":["word with spaces","$(literal)"]');
    expect(result.stdout).toContain(join(first.directory, "textbutler.mjs"));
  });
  test("a foreign command and linked prefix are never overwritten", async () => {
    const f = await fixture();
    await mkdir(join(f.prefix, "bin"), { recursive: true, mode: 0o700 });
    const command = join(f.prefix, "bin/textbutler");
    await writeFile(command, "owner command", { mode: 0o500 });
    await expect(installTextbutler(f)).rejects.toThrow("already exists");
    expect(await readFile(command, "utf8")).toBe("owner command");
    const alias = join(f.root, "alias"); await symlink(f.prefix, alias);
    await expect(installTextbutler({ from: f.from, prefix: alias })).rejects.toThrow("physical");
    await expect(installTextbutler({ from: f.from, prefix: join(alias, "new-child") })).rejects.toThrow("physical");
    await expect(lstat(join(f.prefix, "new-child"))).rejects.toThrow();
  });
  test("publication preserves foreign files and ignores an interrupted staging file outside the version", async () => {
    const f = await fixture(), orphan = join(f.root, ".textbutler-stage-interrupted");
    await writeFile(orphan, "partial staging bytes", { mode: 0o600 });
    await expect(publishArtifact(f.from, "runtime.mjs", Buffer.from("foreign replacement"))).rejects.toThrow("preserved");
    expect((await readFile(join(f.from, "runtime.mjs"))).equals(f.files.get("runtime.mjs")!)).toBe(true);
    expect(await readdir(f.from)).toHaveLength(5);
    expect((await lstat(join(f.from, "runtime.mjs"))).nlink).toBe(1);
    expect((await verifyDistribution(f.from)).manifest.version).toBe(f.manifest.version);
    expect(await readFile(orphan, "utf8")).toBe("partial staging bytes");
    expect((await readdir(f.root)).filter(name => name.startsWith(".textbutler-stage-"))).toEqual([".textbutler-stage-interrupted"]);
  });
  test("tampering and hardlinks fail before application import", async () => {
    const f = await fixture(), installed = await installTextbutler(f);
    const runtime = join(installed.directory, "runtime.mjs");
    await chmod(runtime, 0o600); await writeFile(runtime, f.files.get("runtime.mjs")!.toString() + "\n// changed"); await chmod(runtime, 0o444);
    const tampered = await run(installed.command);
    expect(tampered.code).toBe(1); expect(tampered.stdout).toBe("");
    expect(tampered.stderr).toContain("could not run this local installation");
    await chmod(runtime, 0o600); await writeFile(runtime, f.files.get("runtime.mjs")!); await chmod(runtime, 0o444);
    await link(runtime, join(f.root, "linked-runtime"));
    const linked = await run(installed.command);
    expect(linked.code).toBe(1); expect(linked.stdout).toBe("");
  });
  test("retry completes a post-link crash without removing unrelated hardlinks", async () => {
    const f = await fixture(), target = join(f.from, "runtime.mjs");
    const stage = join(f.root, ".textbutler-stage-12345678-1234-1234-1234-123456789abc");
    await link(target, stage);
    await publishArtifact(f.from, "runtime.mjs", f.files.get("runtime.mjs")!);
    expect((await lstat(target)).nlink).toBe(1);
    await expect(lstat(stage)).rejects.toThrow();
    const unrelated = join(f.root, "owner-hardlink"); await link(target, unrelated);
    await expect(publishArtifact(f.from, "runtime.mjs", f.files.get("runtime.mjs")!)).rejects.toThrow("preserved");
    expect((await readFile(unrelated)).equals(f.files.get("runtime.mjs")!)).toBe(true);
  });
  test("installer recovers a post-link crash of the command before its no-clobber preflight", async () => {
    const f = await fixture(), installed = await installTextbutler(f);
    const stage = join(f.prefix, ".textbutler-stage-12345678-1234-1234-1234-123456789abc");
    await link(installed.command, stage);
    expect(await installTextbutler(f)).toEqual(installed);
    expect((await lstat(installed.command)).nlink).toBe(1);
    await expect(lstat(stage)).rejects.toThrow();
  });
  test("writable artifact and altered launcher are rejected by installation", async () => {
    const f = await fixture();
    await chmod(join(f.from, "runtime.mjs"), 0o644);
    await expect(installTextbutler(f)).rejects.toThrow("Unsafe");
    await chmod(join(f.from, "runtime.mjs"), 0o444);
    await chmod(join(f.from, "textbutler.mjs"), 0o600); await writeFile(join(f.from, "textbutler.mjs"), "unreviewed launcher"); await chmod(join(f.from, "textbutler.mjs"), 0o444);
    await expect(installTextbutler(f)).rejects.toThrow("integrity");
  });
});
