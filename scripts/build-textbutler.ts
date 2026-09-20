import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";
import { assertSupportFoundationInputs } from "./support-runtime-policy.ts";
import { validateXcbIntegrationAdmission, XCB_INTEGRATION_RECEIPT } from "./xcb-integration-admission.ts";
import { DISTRIBUTION_FILES, MAX_RUNTIME_BYTES, physicalDirectory, publishArtifact, renderLauncher, sealDistribution, sha256, validateBun, verifyDistribution, type DistributionManifest, type DistributionFile } from "./textbutler-distribution.ts";

const ROOT = resolve(import.meta.dir, "..");
const PINNED_INPUTS = {
  "@hraness/agentmixer": "https://github.com/hraness/agentmixer/releases/download/v0.1.1/hraness-agentmixer-0.1.1.tgz",
  "@hraness/desktop-foundation": "https://github.com/hraness/desktop-foundation/releases/download/v0.7.0/hraness-desktop-foundation-0.7.0.tgz",
  "@anthropic-ai/sdk": "0.125.0",
} as const;

/** Creates a self-contained local pilot. Input digests establish reproducible
 * integrity metadata, not a distribution signature or provider qualification. */
export async function buildTextbutler(options: { outdir?: string } = {}): Promise<{ directory: string; manifest: DistributionManifest }> {
  if (Bun.version !== "1.3.14") throw new Error("Textbutler builds require Bun 1.3.14.");
  await assertSupportFoundationInputs(ROOT);
  const xcbAdmission = await validateXcbIntegrationAdmission(ROOT);
  const packageBytes = await readFile(join(ROOT, "package.json"));
  const packageManifest = JSON.parse(packageBytes.toString("utf8")) as { devDependencies: Record<string, string> };
  for (const [name, pin] of Object.entries(PINNED_INPUTS)) if (packageManifest.devDependencies[name] !== pin) throw new Error(`Textbutler build dependency pin changed: ${name}`);
  const lockfile = await readFile(join(ROOT, "bun.lock"));
  const bun = await validateBun(process.execPath);
  const desktopRoot = join(ROOT, "node_modules/@hraness/desktop-foundation");
  const companionManifest = await readFile(join(desktopRoot, "release-manifest.json"), "utf8");
  const desktopClient = join(desktopRoot, "dist/src/client.js");
  const inputs = new Map<string, string>([["package.json", sha256(packageBytes)], ["bun.lock", sha256(lockfile)], ["desktop-foundation/release-manifest.json", sha256(companionManifest)]]);
  for (const input of ["scripts/build-textbutler.ts", "scripts/textbutler-distribution.ts", "scripts/support-runtime-policy.ts", "scripts/xcb-integration-admission.ts", XCB_INTEGRATION_RECEIPT, "LICENSE", "docs/support-foundation-notice.md"]) inputs.set(input, sha256(await readFile(join(ROOT, input))));
  const result = await Bun.build({ entrypoints: [join(ROOT, "packages/textbutler/src/runtime-entry.ts")], target: "bun", format: "esm", minify: true, splitting: false,
    define: { "import.meta.url": "__TEXTBUTLER_ARTIFACT_URL", __TEXTBUTLER_XCB_ADMISSION: JSON.stringify(xcbAdmission) },
    plugins: [{ name: "textbutler-complete-local-artifact", setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|[cm]?ts|tsx|json)$/u }, async args => {
        const path = resolve(args.path), label = relative(ROOT, path);
        if (label.startsWith("../") || label === "..") throw new Error("The Textbutler build tried to read outside its checkout.");
        const original = await readFile(path, "utf8"); inputs.set(label, sha256(original));
        let contents = original;
        if (path === desktopClient) {
          const source = "await readFile(new URL('../../release-manifest.json', import.meta.url))";
          if (contents.split(source).length !== 2) throw new Error("The pinned companion manifest load changed; review bundling before building.");
          contents = contents.replace(source, JSON.stringify(companionManifest));
        }
        const extension = extname(path);
        const loader: Bun.Loader = extension === ".json" ? "json" : extension === ".tsx" ? "tsx" : extension.endsWith("ts") ? "ts" : "js";
        return { contents, loader };
      });
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, "Textbutler must build as one complete runtime bundle.");
  const bundle = Buffer.from(await result.outputs[0]!.arrayBuffer());
  if (bundle.length < 1 || bundle.length > MAX_RUNTIME_BYTES) throw new Error("Textbutler runtime bundle exceeds the artifact limit.");
  const imports = new Bun.Transpiler({ loader: "js" }).scan(bundle).imports;
  const external = imports.filter(item => !item.path.startsWith("node:") && !item.path.startsWith("bun:") && !builtinModules.includes(item.path));
  if (external.length) throw new Error(`Textbutler bundle contains external code imports: ${external.map(item => item.path).slice(0, 8).join(", ")}`);
  if (!packageBytes.equals(await readFile(join(ROOT, "package.json"))) || !lockfile.equals(await readFile(join(ROOT, "bun.lock")))) throw new Error("Dependency inputs changed during the build.");
  const bundledAdmission = await validateXcbIntegrationAdmission(ROOT, inputs);
  if (JSON.stringify(bundledAdmission) !== JSON.stringify(xcbAdmission)) throw new Error("Textbutler XCB admission changed during the build.");
  const dependencyRoots = new Set<string>();
  for (const input of inputs.keys()) {
    if (!input.startsWith("node_modules/")) continue;
    const parts = input.split("/"); dependencyRoots.add(parts.slice(0, parts[1]?.startsWith("@") ? 3 : 2).join("/"));
  }
  const dependencyNotices: string[] = [];
  for (const dependency of [...dependencyRoots].sort()) {
    const metadata = await readFile(join(ROOT, dependency, "package.json"), "utf8");
    inputs.set(`${dependency}/package.json`, sha256(metadata));
    const pkg = JSON.parse(metadata) as { name: string; version: string; license?: string };
    const licenses = (await readdir(join(ROOT, dependency))).filter(name => /^(?:license|copying|notice)(?:\.|$)/iu.test(name)).sort();
    dependencyNotices.push(`## ${pkg.name} ${pkg.version}\n\nDeclared license: ${pkg.license ?? "See package terms."}\n`);
    for (const name of licenses) {
      const content = await readFile(join(ROOT, dependency, name), "utf8");
      inputs.set(`${dependency}/${name}`, sha256(content)); dependencyNotices.push(`### ${name}\n\n${content}\n`);
    }
  }
  const bundledQsLicense = await readFile(join(ROOT, "node_modules/@anthropic-ai/sdk/src/internal/qs/LICENSE.md"), "utf8");
  inputs.set("anthropic-sdk/internal/qs/LICENSE.md", sha256(bundledQsLicense));
  const inputsDigest = sha256(JSON.stringify([...inputs].sort(([a], [b]) => a.localeCompare(b))));
  const lockfileSha256 = sha256(lockfile), bundleDigest = sha256(bundle);
  const version = sha256(JSON.stringify({ bundle: bundleDigest, bun: bun.sha256, inputs: inputsDigest, lockfile: lockfileSha256 }));
  const notices = `# Textbutler local pilot\n\nTextbutler is an MIT-licensed reference application for xcb subscription inference. This artifact was built locally with Bun 1.3.14. Digests verify integrity; they are not a signed release or reviewed provider attestation.\n\nNative subscription inference requires a separately installed xcb executable, an explicit account/model binding, and xcb's current runtime admission and confinement checks. xcb and provider executables are not bundled. Credentials and provider custody remain in xcb. The external-xcb manifest value describes this connection capability; it does not qualify a provider or prove live message delivery. Claude API remains unavailable in this local distribution without separate trusted runtime admission. No account or messaging activation occurs during build or installation.\n\nSource: https://github.com/hraness/textbutler\nxcb: https://github.com/hraness/xcb\n\nPinned runtime dependencies:\n${Object.entries(PINNED_INPUTS).map(([name, pin]) => `- ${name}: ${pin}`).join("\n")}\n\n## Support foundation\n\n${await readFile(join(ROOT, "docs/support-foundation-notice.md"), "utf8")}\n\n${dependencyNotices.join("\n")}\n## Anthropic SDK bundled qs license\n\n${bundledQsLicense}\n`;
  const files = new Map<DistributionFile, Buffer>([["runtime.mjs", bundle], ["textbutler.mjs", Buffer.from(renderLauncher(bundleDigest, bun.sha256))],
    ["LICENSE", await readFile(join(ROOT, "LICENSE"))], ["notices.md", Buffer.from(notices)]]);
  const manifest: DistributionManifest = { schemaVersion: 1, product: "textbutler", kind: "local-pilot", version,
    runtime: { version: "1.3.14", sha256: bun.sha256, platform: process.platform, arch: process.arch }, lockfileSha256, inputsDigest,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }])) as DistributionManifest["files"], providerAdmission: "external-xcb" };
  const base = resolve(options.outdir ?? join(ROOT, "build/textbutler")), directory = join(base, version);
  await physicalDirectory(base, true); await physicalDirectory(directory, true);
  for (const name of DISTRIBUTION_FILES) await publishArtifact(directory, name, files.get(name)!);
  await publishArtifact(directory, "manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await verifyDistribution(directory); await sealDistribution(directory);
  return { directory, manifest };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 0 && !(args.length === 2 && args[0] === "--outdir" && args[1]?.startsWith("/"))) throw new Error("Usage: bun run textbutler:build [--outdir /absolute/build/directory]");
    const result = await buildTextbutler(args[1] === undefined ? {} : { outdir: args[1] });
    process.stdout.write(`${JSON.stringify({ ok: true, directory: result.directory, version: result.manifest.version, providerAdmission: result.manifest.providerAdmission, detail: "Local pilot built. Install it with textbutler:install --from DIRECTORY, then configure an external xcb account. Build integrity does not qualify providers or activate replies." })}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Textbutler build failed."}\n`); process.exitCode = 1; }
}
