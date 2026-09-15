import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { buildAgentrouterDist } from "./build-agentrouter-dist.ts";
import { scanPackedPackage } from "./package-smoke.ts";

const PACKAGE_NAME = "@hraness/agentrouter";
const PACKAGE_DIR = resolve(import.meta.dir, "../packages/agentrouter");
const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const BUILTIN_MODULES = new Set(["bun:sqlite", "bun:test"]);
const MINIMUM_NODE_VERSION = "22.13.0";
const REQUIRED_EXPORTS = [
  "AgentRouter",
  "SqliteAccountLeases",
  "createCodexManagedTaskAdapter",
  "createPublicWeb",
  "createToolBroker",
  "codexManagedStaticCatalog",
  "openAccountDatabase",
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

async function readBoundedCommandOutput(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAXIMUM_COMMAND_OUTPUT_BYTES) {
        kill();
        throw new Error("AgentRouter package command output exceeded its byte bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" });
  const kill = () => child.kill(9);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedCommandOutput(child.stdout, kill),
      readBoundedCommandOutput(child.stderr, kill),
    ]);
    if (timedOut) throw new Error("AgentRouter package command exceeded its two-minute bound.");
    if (exitCode !== 0) {
      const diagnosticState = stderr.byteLength === 0
        ? "without diagnostic output"
        : "with redacted diagnostic output";
      throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")} ${diagnosticState}`);
    }
    return stdout.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/** Collect package names from import specifiers. Relative, bun: and node:
 * specifiers are not registry dependencies. */
export function importedPackageNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (specifier === undefined || specifier.startsWith(".") || specifier.startsWith("node:")
      || BUILTIN_MODULES.has(specifier)) continue;
    const segments = specifier.split("/");
    names.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!);
  }
  return [...names].sort();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:js|d\.ts)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Every registry specifier in shipped sources must be a declared dependency,
 * so a consumer's install resolves the complete import surface. */
async function dependencyCompleteness(installedRoot: string, dependencies: ReadonlySet<string>): Promise<string[]> {
  const problems: string[] = [];
  for (const file of await sourceFiles(join(installedRoot, "dist"))) {
    for (const name of importedPackageNames(await readFile(file, "utf8"))) {
      if (!dependencies.has(name)) {
        problems.push(`${basename(file)} imports undeclared package ${name}`);
      }
    }
  }
  return problems;
}

/** The package's Node floor is the first release where node:sqlite loads without
 * an experimental flag; earlier runtimes cannot open account custody stores. */
function nodeVersionSupported(version: string): boolean {
  const parts = version.trim().replace(/^v/u, "").split(".").map(part => Number(part));
  const floor = MINIMUM_NODE_VERSION.split(".").map(part => Number(part));
  for (const [index, part] of floor.entries()) {
    const observed = parts[index] ?? 0;
    if (observed !== part) return observed > part;
  }
  return true;
}

export async function agentrouterPackageSmoke(tarballArgument?: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "agentrouter-package-"));
  try {
    const archive = tarballArgument === undefined
      ? join(work, "package.tgz")
      : resolve(tarballArgument);
    const stage = join(work, "stage");
    const consumer = join(work, "consumer");
    await Promise.all([mkdir(stage), mkdir(consumer, { recursive: true })]);
    if (tarballArgument === undefined) {
      await buildAgentrouterDist();
      await run([
        process.execPath, "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet",
      ], PACKAGE_DIR);
    }
    await run(["tar", "-xzf", archive, "-C", stage], work);

    const packedRoot = await realpath(join(stage, "package"));
    await scanPackedPackage(packedRoot);

    const manifest = record(
      JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8")) as unknown,
      "installed package.json",
    );
    const problems: string[] = [];
    if (manifest.name !== PACKAGE_NAME) problems.push(`packed name is ${JSON.stringify(manifest.name)}`);
    if (manifest.private !== undefined) problems.push("packed package must not carry a private marker");
    if (manifest.license !== "MIT") problems.push("packed license must be MIT");
    if (manifest.type !== "module") problems.push("packed package must be ESM");
    const publishConfig = manifest.publishConfig as JsonRecord | undefined;
    if (
      publishConfig?.access !== "public"
      || publishConfig.provenance !== true
      || publishConfig.registry !== "https://registry.npmjs.org"
    ) problems.push("packed publishConfig must pin public OIDC provenance to npmjs.org");
    const repository = manifest.repository as JsonRecord | undefined;
    if (
      repository?.type !== "git"
      || repository.url !== "git+https://github.com/hraness/message-like-me.git"
      || repository.directory !== "packages/agentrouter"
    ) problems.push("packed repository must bind this monorepo path for npm provenance");
    const files = manifest.files;
    if (!Array.isArray(files) || files.some((entry) => typeof entry !== "string")) {
      problems.push("packed files allowlist must be an array of paths");
    } else {
      for (const entry of files as readonly string[]) {
        try {
          await access(join(packedRoot, entry));
        } catch {
          problems.push(`files allowlist entry is missing from the packed package: ${entry}`);
        }
      }
    }
    for (const forbidden of ["test", "qualification", "scripts", "AGENTS.md", "tsconfig.json", "node_modules"]) {
      try {
        await access(join(packedRoot, forbidden));
        problems.push(`packed package contains unshipped entry ${forbidden}`);
      } catch { /* absent as required */ }
    }
    const exportsField = record(manifest.exports, "packed exports")["."];
    const exportPaths = typeof exportsField === "string" ? [exportsField] : Object.values(record(exportsField, "packed export entry"));
    for (const path of exportPaths) {
      if (typeof path !== "string" || !path.startsWith("./")) {
        problems.push(`packed export path must be package-relative: ${JSON.stringify(path)}`);
        continue;
      }
      try {
        await access(join(packedRoot, path.slice(2)));
      } catch {
        problems.push(`packed export path is missing: ${path}`);
      }
    }
    const dependencies = record(manifest.dependencies, "packed dependencies");
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string" || !/^\d+\.\d+\.\d+$/u.test(specifier)) {
        problems.push(`dependency ${name} must be pinned to an exact version`);
      }
    }
    problems.push(...await dependencyCompleteness(packedRoot, new Set(Object.keys(dependencies))));
    if (problems.length > 0) {
      throw new Error(`AgentRouter packed manifest failed:\n${[...new Set(problems)].sort().join("\n")}`);
    }

    // Install the real packed artifact with its declared dependencies supplied
    // from the repository's pinned install, then prove the public entry resolves
    // and executes under both Bun and Node. No network, registry or provider call.
    const modules = join(consumer, "node_modules");
    const scope = join(modules, "@hraness");
    await mkdir(scope, { recursive: true });
    await run(["mv", packedRoot, join(scope, "agentrouter")], work);
    for (const name of Object.keys(dependencies)) {
      const target = join(REPOSITORY_ROOT, "node_modules", name);
      const link = join(modules, name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, "dir");
    }
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(consumer, "smoke.mjs"),
      [
        `import { ${REQUIRED_EXPORTS.join(", ")} } from "${PACKAGE_NAME}";`,
        `const built = codexManagedStaticCatalog({ model: "smoke-model", catalog: { models: [{`,
        `  slug: "smoke-model", display_name: "Smoke", description: "Synthetic",`,
        `  supported_reasoning_levels: [{ effort: "medium", description: "Normal work" }],`,
        `  default_reasoning_level: "medium", shell_type: "unified_exec", visibility: "list", supported_in_api: true,`,
        `  priority: 1, support_verbosity: true, default_verbosity: "low", truncation_policy: { mode: "tokens", limit: 1 },`,
        `  experimental_supported_tools: [], tool_mode: "code_mode_only", apply_patch_tool_type: "freeform",`,
        `  supports_search_tool: true, supports_experimental_context: true, multi_agent_version: "v2",`,
        `  node_repl_disabled: false, context_window: 1, max_context_window: 1, auto_compact_token_limit: 1,`,
        `  effective_context_window_percent: 1, use_responses_lite: true, supports_reasoning_summary_parameter: false,`,
        `  default_reasoning_summary: "detailed", input_modalities: ["text"],`,
        `  service_tiers: [{ id: "default", name: "Standard", description: "Normal" }], default_service_tier: "default",`,
        `  additional_speed_tiers: [], model_messages: { instructions_template: "x", instructions_variables: null, tools: {} },`,
        `  base_instructions: "x" }] } });`,
        `if (built.model !== "smoke-model" || built.catalog.models.length !== 1 || !Object.isFrozen(built))`,
        `  throw new Error("packed catalog helper returned an unexpected result");`,
        `const runtime = typeof Bun === "undefined" ? "node" : "bun";`,
        `const database = await openAccountDatabase("smoke-leases-" + runtime + ".sqlite");`,
        `const leases = new SqliteAccountLeases(database);`,
        `const lease = leases.acquire({ provider: "codex", accountId: "smoke-account", owner: "smoke-owner", now: 1_000, ttlMs: 60_000 });`,
        `if (!leases.release(lease) || leases.inspect("codex", "smoke-account") !== null)`,
        `  throw new Error("packed account lease store failed its custody round trip");`,
        `database.close();`,
        `console.log(JSON.stringify({ exports: ${REQUIRED_EXPORTS.length}, model: built.model,`,
        `  sha256: built.sha256.length, generation: lease.generation, runtime }));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const nodeVersion = (await run(["node", "--version"], consumer)).trim();
    if (!nodeVersionSupported(nodeVersion)) {
      throw new Error(`AgentRouter Node smoke requires node >= ${MINIMUM_NODE_VERSION}; found ${nodeVersion}`);
    }
    for (const executable of [process.execPath, "node"]) {
      const output = await run([executable, join(consumer, "smoke.mjs")], consumer);
      const observed = record(JSON.parse(output.trim()), "installed smoke output");
      if (observed.exports !== REQUIRED_EXPORTS.length || observed.model !== "smoke-model"
        || observed.sha256 !== 64 || observed.generation !== 1) {
        throw new Error(`Installed AgentRouter smoke under ${executable} returned ${output.trim()}`);
      }
      const expectedRuntime = executable === "node" ? "node" : "bun";
      if (observed.runtime !== expectedRuntime) {
        throw new Error(`Installed AgentRouter smoke ran under ${String(observed.runtime)}, expected ${expectedRuntime}`);
      }
    }
    console.log("AgentRouter standalone package boundary verified under Bun and Node.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarballArgument, extra] = process.argv.slice(2);
  if (extra !== undefined) throw new Error("Usage: agentrouter-package-smoke.ts [TARBALL.tgz]");
  await agentrouterPackageSmoke(tarballArgument);
}
