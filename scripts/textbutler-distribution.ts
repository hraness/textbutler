import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
export const DISTRIBUTION_FILES = ["runtime.mjs", "textbutler.mjs", "LICENSE", "notices.md"] as const;
export type DistributionFile = typeof DISTRIBUTION_FILES[number];
export interface DistributionManifest {
  schemaVersion: 1; product: "textbutler"; kind: "local-pilot"; version: string;
  runtime: { version: "1.3.14"; sha256: string; platform: string; arch: string };
  lockfileSha256: string; inputsDigest: string;
  files: Record<DistributionFile, { sha256: string; bytes: number }>;
  /** Distribution capability only; an external host must admit each provider. */
  providerAdmission: "unavailable" | "external-xcb";
}
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function parseDistributionManifest(input: unknown): DistributionManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Textbutler distribution manifest.");
  const m = input as DistributionManifest;
  if (Object.keys(m).sort().join(",") !== "files,inputsDigest,kind,lockfileSha256,product,providerAdmission,runtime,schemaVersion,version"
    || m.schemaVersion !== 1 || m.product !== "textbutler" || m.kind !== "local-pilot" || !["unavailable", "external-xcb"].includes(m.providerAdmission)
    || !digest(m.version) || !digest(m.lockfileSha256) || !digest(m.inputsDigest)
    || !m.runtime || Object.keys(m.runtime).sort().join(",") !== "arch,platform,sha256,version"
    || m.runtime.version !== "1.3.14" || !digest(m.runtime.sha256) || !["darwin", "linux"].includes(m.runtime.platform) || !["arm64", "x64"].includes(m.runtime.arch)
    || !m.files || Object.keys(m.files).sort().join(",") !== [...DISTRIBUTION_FILES].sort().join(",")) throw new Error("Invalid Textbutler distribution manifest.");
  for (const file of DISTRIBUTION_FILES) {
    const row = m.files[file];
    if (!row || Object.keys(row).sort().join(",") !== "bytes,sha256" || !digest(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_RUNTIME_BYTES) throw new Error("Invalid Textbutler distribution file.");
  }
  if (m.version !== sha256(JSON.stringify({ bundle: m.files["runtime.mjs"].sha256, bun: m.runtime.sha256, inputs: m.inputsDigest, lockfile: m.lockfileSha256 }))) throw new Error("Textbutler distribution identity does not match its runtime.");
  return m;
}

export async function physicalDirectory(path: string, create = false): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Use a physical absolute directory path.");
  if (create) {
    let ancestor = path;
    for (;;) {
      try { await lstat(ancestor); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
    }
    if (await realpath(ancestor) !== ancestor) throw new Error("Use a physical directory without linked ancestors.");
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("The distribution directory must be physical, owned and not writable by other users.");
}

export async function readArtifact(path: string, maximum: number, readOnly = false): Promise<Buffer> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("Artifact paths must be physical and absolute.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || ![process.getuid?.(), 0].includes(before.uid) || (before.mode & (readOnly ? 0o222 : 0o022)) !== 0 || before.size > maximum) throw new Error("Unsafe Textbutler artifact.");
    const bytes = Buffer.alloc(before.size + 1), result = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(), current = await lstat(path);
    if (result.bytesRead !== before.size || before.size !== after.size || before.mode !== after.mode || before.nlink !== after.nlink || before.uid !== after.uid || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error("Textbutler artifact changed while reading.");
    return bytes.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

/** Finish only the exact two-link publication left by a crash after link().
 * Unrelated hardlinks and incomplete staging files remain untouched. */
export async function recoverPublishedStage(target: string, parent: string, bytes: Uint8Array, mode: number): Promise<void> {
  await physicalDirectory(dirname(target)); await physicalDirectory(parent);
  if (dirname(dirname(target)) !== parent || bytes.length > MAX_RUNTIME_BYTES || ![0o444, 0o500].includes(mode)) throw new Error("Invalid artifact recovery boundary.");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (info.nlink === 1) return;
    if (!info.isFile() || info.nlink !== 2 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== mode || info.size !== bytes.length) throw new Error("An existing artifact has unexpected links; it was preserved.");
    const saved = Buffer.alloc(bytes.length + 1), read = await file.read(saved, 0, saved.length, 0);
    if (read.bytesRead !== bytes.length || !saved.subarray(0, read.bytesRead).equals(Buffer.from(bytes))) throw new Error("An existing linked artifact differs; it was preserved.");
    const names = await readdir(parent);
    if (names.length > 10_000) throw new Error("Too many entries to recover artifact publication safely.");
    for (const name of names) {
      if (!/^\.textbutler-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(name)) continue;
      const stage = join(parent, name);
      let staged; try { staged = await lstat(stage); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (staged.dev !== info.dev || staged.ino !== info.ino || !staged.isFile() || staged.isSymbolicLink()) continue;
      const current = await lstat(target), after = await file.stat();
      if (current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink() || after.nlink !== 2 || after.uid !== info.uid || after.mode !== info.mode || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Artifact publication changed during recovery; it was preserved.");
      await unlink(stage);
      return;
    }
    throw new Error("An existing artifact has an unknown hardlink; it was preserved.");
  } finally { await file.close(); }
}

/** No-clobber publication also makes interrupted installs safely resumable: an
 * existing file must match exactly; only missing files may be added. */
export async function publishArtifact(directory: string, name: string, bytes: Uint8Array, mode = 0o444): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(name) || bytes.length > MAX_RUNTIME_BYTES || ![0o444, 0o500].includes(mode)) throw new Error("Invalid distribution artifact name, size or permissions.");
  await physicalDirectory(directory);
  // Stage outside the version inventory. A crash can leave a harmless orphan
  // beside the version, but never a partially written final artifact.
  const parent = dirname(directory); await physicalDirectory(parent);
  const target = join(directory, name), stage = join(parent, `.textbutler-stage-${randomUUID()}`);
  const handle = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const owned = await handle.stat(); let existed = false;
  try {
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync();
    try { await link(stage, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; existed = true; }
  } finally {
    await handle.close();
    const current = await lstat(stage);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid || current.isSymbolicLink()) throw new Error("Textbutler staging file changed; it was preserved.");
    await unlink(stage);
  }
  if (existed) {
    await recoverPublishedStage(target, parent, bytes, mode);
    const existing = await readArtifact(target, MAX_RUNTIME_BYTES);
    if (!existing.equals(Buffer.from(bytes))) throw new Error("An existing Textbutler artifact differs; it was preserved.");
    const info = await lstat(target);
    if ((info.mode & 0o777) !== mode) throw new Error("An existing Textbutler artifact has different permissions; it was preserved.");
  }
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

export async function verifyDistribution(directory: string): Promise<{ manifest: DistributionManifest; files: Map<DistributionFile, Buffer>; manifestBytes: Buffer }> {
  await physicalDirectory(directory);
  const inventory = (await readdir(directory)).sort();
  if (inventory.join(",") !== [...DISTRIBUTION_FILES, "manifest.json"].sort().join(",")) throw new Error("Unexpected Textbutler distribution inventory.");
  const manifestBytes = await readArtifact(join(directory, "manifest.json"), 16_384, true);
  const manifest = parseDistributionManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
  const files = new Map<DistributionFile, Buffer>();
  for (const name of DISTRIBUTION_FILES) {
    const bytes = await readArtifact(join(directory, name), MAX_RUNTIME_BYTES, true);
    if (bytes.length !== manifest.files[name].bytes || sha256(bytes) !== manifest.files[name].sha256) throw new Error(`Textbutler distribution integrity failed: ${name}`);
    files.set(name, bytes);
  }
  const expectedLauncher = renderLauncher(manifest.files["runtime.mjs"].sha256, manifest.runtime.sha256);
  if (files.get("textbutler.mjs")!.toString("utf8") !== expectedLauncher) throw new Error("Textbutler launcher differs from the local install contract.");
  return { manifest, files, manifestBytes };
}

export async function sealDistribution(directory: string): Promise<void> { await chmod(directory, 0o500); }
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The launcher never imports application code until the complete bundle and
 * exact Bun runtime have passed integrity checks. Digests do not claim provider
 * qualification or signed distribution provenance. */
export function renderLauncher(bundleDigest: string, bunDigest: string): string {
  if (!digest(bundleDigest) || !digest(bunDigest)) throw new Error("Invalid launcher digest.");
  return `import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const launcher = fileURLToPath(import.meta.url);
async function verified(path, expected, max, readOnly, capture = false) {
  if (await realpath(path) !== path) throw Error("artifact-linked");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || ![0, process.getuid?.()].includes(before.uid) || (before.mode & (readOnly ? 146 : 18)) || before.size > max) throw Error("artifact-unsafe");
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536), chunks = []; let offset = 0;
    while (offset <= before.size) { const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, before.size + 1 - offset), offset); if (!bytesRead) break; const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); if (capture) chunks.push(Buffer.from(bytes)); offset += bytesRead; }
    const after = await file.stat(), current = await lstat(path);
    if (offset !== before.size || hash.digest("hex") !== expected || before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink() || before.mode !== after.mode || before.nlink !== after.nlink || before.uid !== after.uid || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error("artifact-changed");
    return capture ? Buffer.concat(chunks) : undefined;
  } finally { await file.close(); }
}
try {
  if (typeof Bun === "undefined" || Bun.version !== "1.3.14") throw Error("bun-version");
  const directory = dirname(launcher), info = await lstat(directory);
  if (await realpath(directory) !== directory || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 18)) throw Error("directory-unsafe");
  const runtime = join(directory, "runtime.mjs");
  await verified(await realpath(process.execPath), ${JSON.stringify(bunDigest)}, 134217728, false);
  const bytes = await verified(runtime, ${JSON.stringify(bundleDigest)}, 67108864, true, true);
  const source = Buffer.concat([Buffer.from("const __TEXTBUTLER_ARTIFACT_URL = " + JSON.stringify(pathToFileURL(runtime).href) + ";\\n"), bytes]);
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const { runInstalledCli } = await import(moduleUrl);
    process.exitCode = await runInstalledCli(process.argv.slice(2), launcher);
  } finally { URL.revokeObjectURL(moduleUrl); }
} catch {
  process.stderr.write("Textbutler could not run this local installation. Its runtime or bundle may have changed, or setup needs attention. Rebuild/install from the source checkout; existing settings are preserved.\\n");
  process.exitCode = 1;
}
`;
}

export async function validateBun(path: string, expected?: string): Promise<{ path: string; sha256: string }> {
  const physical = await realpath(path), bytes = await readArtifact(physical, 128 * 1024 * 1024);
  const digest = sha256(bytes);
  if (expected !== undefined && digest !== expected) throw new Error("The selected Bun runtime differs from the build runtime. Rebuild with this Bun version.");
  if (((await lstat(physical)).mode & 0o111) === 0) throw new Error("Bun is not executable.");
  const parent = await lstat(dirname(physical));
  if (!parent.isDirectory() || ![process.getuid?.(), 0].includes(parent.uid) || (parent.mode & 0o022) !== 0) throw new Error("Unsafe Bun runtime directory.");
  return { path: physical, sha256: digest };
}
