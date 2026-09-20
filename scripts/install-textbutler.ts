import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildTextbutler } from "./build-textbutler.ts";
import { DISTRIBUTION_FILES, physicalDirectory, publishArtifact, readArtifact, recoverPublishedStage, sealDistribution, shellQuote, validateBun, verifyDistribution } from "./textbutler-distribution.ts";

const WRAPPER_LIMIT = 16_384, VERSION_LIMIT = 1024;
const EXEC_PREFIX = 'exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 TERM="${TERM-dumb}" LANG="${LANG-en_US.UTF-8}" ';
const execSuffix = (directory: string) => ` --config=/dev/null --cwd=/ --no-env-file ${shellQuote(join(directory, "textbutler.mjs"))} "$@"`;
function renderCommand(directory: string, bun: string): Buffer {
  return Buffer.from(`#!/bin/sh\ncd ${shellQuote(directory)} || exit 1\n${EXEC_PREFIX}${shellQuote(bun)}${execSuffix(directory)}\n`);
}
const sameFile = (before: Stats, after: Stats): boolean => ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]
  .every(key => before[key as keyof Stats] === after[key as keyof Stats]);
async function commandSnapshot(command: string): Promise<{ bytes: Buffer; identity: Stats }> {
  const before = await lstat(command);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o777) !== 0o500)
    throw new Error("An existing textbutler command is not an owned immutable launcher; it was preserved.");
  const bytes = await readArtifact(command, WRAPPER_LIMIT, true), after = await lstat(command);
  if (!sameFile(before, after)) throw new Error("The textbutler command changed during verification; it was preserved.");
  return { bytes, identity: after };
}
type ManagedCommand = Awaited<ReturnType<typeof commandSnapshot>> & { directory: string; version: string; bun: string };
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
/** Recognize only the exact installed wrapper. Never execute or source a shell
 * file to discover its identity, and never infer ownership from its filename. */
async function managedCommand(command: string, versions: string): Promise<ManagedCommand> {
  const snapshot = await commandSnapshot(command), lines = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes).split("\n");
  if (lines.length !== 4 || lines[0] !== "#!/bin/sh" || lines[3] !== "") throw new Error("A different textbutler command already exists; --upgrade preserved it.");
  await physicalDirectory(versions);
  const inventory = await readdir(versions);
  if (inventory.length > VERSION_LIMIT) throw new Error("Too many installed versions to identify the managed Textbutler command safely.");
  const version = inventory.find(name => /^[a-f0-9]{64}$/u.test(name) && lines[1] === `cd ${shellQuote(join(versions, name))} || exit 1`);
  if (version === undefined) throw new Error("A different textbutler command already exists and was preserved; --upgrade requires a verified installed version.");
  const directory = join(versions, version), suffix = execSuffix(directory), execution = lines[2]!;
  if (!execution.startsWith(EXEC_PREFIX) || !execution.endsWith(suffix)) throw new Error("A different textbutler command already exists; --upgrade preserved it.");
  const encoded = execution.slice(EXEC_PREFIX.length, -suffix.length);
  if (!encoded.startsWith("'") || !encoded.endsWith("'")) throw new Error("The installed Textbutler runtime path is not canonical; it was preserved.");
  const bunPath = encoded.slice(1, -1).replaceAll("'\\''", "'");
  if (shellQuote(bunPath) !== encoded || !isAbsolute(bunPath) || resolve(bunPath) !== bunPath || /[\u0000-\u001f\u007f]/u.test(bunPath)) throw new Error("The installed Textbutler runtime path is not canonical; it was preserved.");
  const installed = await verifyDistribution(directory);
  if (installed.manifest.version !== version || (await lstat(directory)).mode & 0o222) throw new Error("The installed Textbutler version is not immutable; it was preserved.");
  if (installed.manifest.runtime.platform !== process.platform || installed.manifest.runtime.arch !== process.arch) throw new Error("The installed Textbutler version targets another platform; it was preserved.");
  const bun = await validateBun(bunPath, installed.manifest.runtime.sha256);
  if (!snapshot.bytes.equals(renderCommand(directory, bun.path))) throw new Error("A different textbutler command already exists; --upgrade preserved it.");
  return { ...snapshot, directory, version, bun: bun.path };
}

async function replaceManagedCommand(input: { command: string; bin: string; versions: string; directory: string; backup: string; wrapper: Buffer; previous: ManagedCommand },
  beforeCommit?: () => Promise<void>): Promise<void> {
  const stage = join(input.bin, `.textbutler-upgrade-${randomUUID()}`);
  const file = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let owned = await file.stat(), published = false;
  try {
    await file.writeFile(input.wrapper); await file.chmod(0o500); await file.sync(); owned = await file.stat();
    // This hook is a trusted test seam for interruption/race checks, never CLI
    // input or owner configuration. Final validation always follows it.
    await beforeCommit?.();
    await physicalDirectory(input.bin); await verifyDistribution(input.directory);
    const current = await managedCommand(input.command, input.versions);
    if (!sameFile(input.previous.identity, current.identity) || !current.bytes.equals(input.previous.bytes)) throw new Error("The textbutler command changed before upgrade; it was preserved.");
    if (!(await commandSnapshot(input.backup)).bytes.equals(input.previous.bytes)) throw new Error("The previous Textbutler launcher backup changed; the installed command was preserved.");
    if (!sameFile(owned, await lstat(stage)) || !(await readArtifact(stage, WRAPPER_LIMIT, true)).equals(input.wrapper)) throw new Error("The staged Textbutler launcher changed; it was preserved.");
    const final = await commandSnapshot(input.command);
    if (!sameFile(input.previous.identity, final.identity) || !final.bytes.equals(input.previous.bytes)) throw new Error("The textbutler command changed before upgrade; it was preserved.");
    // rename is the sole activation point. The old immutable version and copied
    // launcher are already durable; a crash leaves either complete command.
    await rename(stage, input.command); published = true;
    await syncDirectory(input.bin);
    if (!(await commandSnapshot(input.command)).bytes.equals(input.wrapper)) throw new Error("Textbutler upgrade publication could not be confirmed. Inspect the installed command before retrying.");
  } finally {
    await file.close();
    if (!published) {
      const current = await lstat(stage);
      if (!sameFile(owned, current) || current.isSymbolicLink()) throw new Error("The upgrade staging file changed; it was preserved.");
      await unlink(stage);
    }
  }
}

/** Installation is intentionally inert: copy exact artifact bytes, create a
 * no-clobber command by default, and preserve all settings and login services.
 * Explicit upgrades replace only a verified managed wrapper, with a backup. */
export async function installTextbutler(options: { from: string; prefix: string; upgrade?: boolean },
  dependencies: { beforeUpgradeCommit?: () => Promise<void> } = {}): Promise<{ command: string; directory: string; version: string; previous?: { command: string; directory: string; version: string } }> {
  const source = await verifyDistribution(resolve(options.from));
  if (source.manifest.runtime.platform !== process.platform || source.manifest.runtime.arch !== process.arch || Bun.version !== source.manifest.runtime.version) throw new Error("This Textbutler build targets a different platform or Bun version.");
  const bun = await validateBun(process.execPath, source.manifest.runtime.sha256);
  const prefix = resolve(options.prefix), bin = join(prefix, "bin"), versions = join(prefix, "share/textbutler/versions"), directory = join(versions, source.manifest.version);
  await physicalDirectory(prefix, true); await physicalDirectory(bin, true); await physicalDirectory(versions, true);
  const command = join(bin, "textbutler"), wrapper = renderCommand(directory, bun.path);
  let previous: ManagedCommand | undefined;
  // Check a preexisting command before writing a new version. Publication below
  // still uses atomic no-clobber publication and rechecks bytes to cover races.
  let exists = false;
  try { await lstat(command); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (exists) {
    await recoverPublishedStage(command, prefix, wrapper, 0o500);
    if (!(await readArtifact(command, WRAPPER_LIMIT)).equals(wrapper)) {
      if (options.upgrade !== true) throw new Error("A different textbutler command already exists. It was preserved; use --upgrade for a verified managed installation or choose another --prefix.");
      previous = await managedCommand(command, versions);
    }
  }
  await physicalDirectory(directory, true);
  if ((await readdir(directory)).some(name => ![...DISTRIBUTION_FILES, "manifest.json"].includes(name as typeof DISTRIBUTION_FILES[number]))) throw new Error("The target version directory contains unexpected files; it was preserved.");
  for (const name of DISTRIBUTION_FILES) await publishArtifact(directory, name, source.files.get(name)!);
  await publishArtifact(directory, "manifest.json", source.manifestBytes);
  await verifyDistribution(directory); await sealDistribution(directory);
  if (previous) {
    const backups = join(prefix, "share/textbutler/launchers"), backup = join(backups, previous.version);
    await physicalDirectory(backups, true);
    await publishArtifact(backups, previous.version, previous.bytes, 0o500);
    await syncDirectory(versions); await syncDirectory(join(prefix, "share/textbutler"));
    await replaceManagedCommand({ command, bin, versions, directory, backup, wrapper, previous }, dependencies.beforeUpgradeCommit);
    return { command, directory, version: source.manifest.version, previous: { command: backup, directory: previous.directory, version: previous.version } };
  }
  await publishArtifact(bin, "textbutler", wrapper, 0o500);
  return { command, directory, version: source.manifest.version };
}

if (import.meta.main) {
  const args = process.argv.slice(2); let from: string | undefined, prefix = join(homedir(), ".local"), upgrade = false;
  try {
    for (let i = 0; i < args.length;) {
      const option = args[i++];
      if (option === "--upgrade" && !upgrade) { upgrade = true; continue; }
      const value = args[i++];
      if (!value?.startsWith("/") || option !== "--from" && option !== "--prefix") throw new Error("Usage: bun run textbutler:install [--from /absolute/build] [--prefix /absolute/install/prefix] [--upgrade]");
      if (option === "--from") { if (from !== undefined) throw new Error("Choose one distribution."); from = value; }
      else prefix = value;
    }
    const distribution = from ?? (await buildTextbutler()).directory;
    const installed = await installTextbutler({ from: distribution, prefix, upgrade });
    const { manifest } = await verifyDistribution(installed.directory);
    process.stdout.write(`${JSON.stringify({ ok: true, ...installed, providerAdmission: manifest.providerAdmission, next: [installed.command, "setup"], detail: "Local pilot installed. No daemon, menu, account or automatic replies were started. Provider readiness requires separate account configuration and runtime admission." })}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Textbutler installation failed."}\n`); process.exitCode = 1; }
}
