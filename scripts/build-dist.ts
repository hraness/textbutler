import { assertSupportFoundationInputs } from "./support-runtime-policy.ts";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const TYPESCRIPT_CLI = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");

function outputDirectory(argv: readonly string[]): string {
  if (argv.length === 0) return join(PACKAGE_ROOT, "dist");
  if (argv.length !== 2 || argv[0] !== "--outdir" || argv[1] === undefined) {
    throw new Error("Usage: bun scripts/build-dist.ts [--outdir PATH]");
  }
  const output = isAbsolute(argv[1]) ? resolve(argv[1]) : resolve(PACKAGE_ROOT, argv[1]);
  const fromPackage = relative(PACKAGE_ROOT, output);
  if (output === PACKAGE_ROOT) throw new Error("Build output must not be the package root");
  if (!isAbsolute(argv[1]) && (fromPackage === ".." || fromPackage.startsWith(`..${sep}`))) {
    throw new Error("Relative build output must stay inside the package");
  }
  return output;
}

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: PACKAGE_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error([
      `Command failed (${String(exitCode)}): ${command.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
    ].filter((line) => line !== "").join("\n"));
  }
  if (stdout.trim() !== "") process.stdout.write(stdout);
  if (stderr.trim() !== "") process.stderr.write(stderr);
}

export async function buildDist(argv: readonly string[]): Promise<void> {
  await assertSupportFoundationInputs(PACKAGE_ROOT);
  const outdir = outputDirectory(argv);
  await mkdir(outdir, { recursive: true });
  await run([
    process.execPath,
    "build",
    "src/index.ts",
    "src/message-bundle-v1.ts",
    "src/message-bundle-v2.ts",
    "src/agentic-messaging-v1.ts",
    "src/ensoul-source-v1.ts",
    "--outdir",
    outdir,
    "--root",
    "src",
    "--target",
    "bun",
    "--format",
    "esm",
    "--splitting",
    "--packages",
    "external",
  ]);
  // Keep command-only resources and their bundled runtime out of every public
  // protocol entry and shared protocol chunk. Immutable installs need no
  // separately resolved runtime package.
  await run([
    process.execPath, "build", "src/support-runtime.ts", "--outdir", outdir,
    "--root", "src", "--target", "bun", "--format", "esm",
  ]);
  const cli = await Bun.build({
    entrypoints: [join(PACKAGE_ROOT, "src/cli.ts")],
    outdir,
    root: join(PACKAGE_ROOT, "src"),
    target: "bun",
    format: "esm",
    plugins: [{
      name: "checked-support-runtime",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/support-runtime\.js$/u }, args => {
          if (args.importer !== join(PACKAGE_ROOT, "src/support.ts")) throw new Error("Unexpected support runtime importer");
          return { path: "./support-runtime.js", external: true };
        });
      },
    }],
  });
  if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");
  await run([
    process.execPath,
    TYPESCRIPT_CLI,
    "--project",
    join(PACKAGE_ROOT, "tsconfig.build.json"),
    "--outDir",
    outdir,
  ]);
}

if (import.meta.main) await buildDist(process.argv.slice(2));
