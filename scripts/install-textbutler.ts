import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildTextbutler } from "./build-textbutler.ts";
import { DISTRIBUTION_FILES, physicalDirectory, publishArtifact, recoverPublishedStage, sealDistribution, shellQuote, validateBun, verifyDistribution } from "./textbutler-distribution.ts";

/** Installation is intentionally inert: copy exact artifact bytes, create a
 * no-clobber command, and preserve all application settings and login services. */
export async function installTextbutler(options: { from: string; prefix: string }): Promise<{ command: string; directory: string; version: string }> {
  const source = await verifyDistribution(resolve(options.from));
  if (source.manifest.runtime.platform !== process.platform || source.manifest.runtime.arch !== process.arch || Bun.version !== source.manifest.runtime.version) throw new Error("This Textbutler build targets a different platform or Bun version.");
  const bun = await validateBun(process.execPath, source.manifest.runtime.sha256);
  const prefix = resolve(options.prefix), bin = join(prefix, "bin"), versions = join(prefix, "share/textbutler/versions"), directory = join(versions, source.manifest.version);
  await physicalDirectory(prefix, true); await physicalDirectory(bin, true); await physicalDirectory(versions, true);
  const command = join(bin, "textbutler"), launcher = join(directory, "textbutler.mjs");
  const wrapper = Buffer.from(`#!/bin/sh\ncd ${shellQuote(directory)} || exit 1\nexec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 TERM="\${TERM-dumb}" LANG="\${LANG-en_US.UTF-8}" ${shellQuote(bun.path)} --config=/dev/null --cwd=/ --no-env-file ${shellQuote(launcher)} "$@"\n`);
  // Check a preexisting command before writing a new version. Publication below
  // still uses atomic no-clobber publication and rechecks bytes to cover races.
  try {
    await lstat(command);
    await recoverPublishedStage(command, prefix, wrapper, 0o500);
    const { readArtifact } = await import("./textbutler-distribution.ts");
    if (!(await readArtifact(command, 16_384)).equals(wrapper)) throw new Error("A different textbutler command already exists. It was preserved; choose another --prefix.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await physicalDirectory(directory, true);
  if ((await readdir(directory)).some(name => ![...DISTRIBUTION_FILES, "manifest.json"].includes(name as typeof DISTRIBUTION_FILES[number]))) throw new Error("The target version directory contains unexpected files; it was preserved.");
  for (const name of DISTRIBUTION_FILES) await publishArtifact(directory, name, source.files.get(name)!);
  await publishArtifact(directory, "manifest.json", source.manifestBytes);
  await verifyDistribution(directory); await sealDistribution(directory);
  await publishArtifact(bin, "textbutler", wrapper, 0o500);
  return { command, directory, version: source.manifest.version };
}

if (import.meta.main) {
  const args = process.argv.slice(2); let from: string | undefined, prefix = join(homedir(), ".local");
  try {
    for (let i = 0; i < args.length; i += 2) {
      const option = args[i], value = args[i + 1];
      if (!value?.startsWith("/") || option !== "--from" && option !== "--prefix") throw new Error("Usage: bun run textbutler:install [--from /absolute/build] [--prefix /absolute/install/prefix]");
      if (option === "--from") { if (from !== undefined) throw new Error("Choose one distribution."); from = value; }
      else prefix = value;
    }
    const distribution = from ?? (await buildTextbutler()).directory;
    const installed = await installTextbutler({ from: distribution, prefix });
    process.stdout.write(`${JSON.stringify({ ok: true, ...installed, providerAdmission: "unavailable", next: [installed.command, "setup"], detail: "Local pilot installed. No daemon, menu, account or automatic replies were started. AI runtime qualification remains unavailable." })}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Textbutler installation failed."}\n`); process.exitCode = 1; }
}
