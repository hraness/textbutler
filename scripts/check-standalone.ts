import { assertSupportFoundationInputs, isReviewedSupportRuntime } from "./support-runtime-policy.ts";
import {
  lstat,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  basename,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const PUBLIC_DESCRIPTION = "A local-first CLI and Agent Skill for studying private messaging history and drafting messages that sound like you.";
const SKILLS_BADGE = "[![skills.sh](https://skills.sh/b/hraness/message-like-me)](https://skills.sh/hraness/message-like-me)";
const SCANNED_DIRECTORIES = [
  ".github",
  "dist",
  "docs",
  "schema",
  "scripts",
  "skills",
  "src",
  "packages",
] as const;
const SCANNED_ROOT_FILES = [
  ".gitignore",
  "AGENTS.md",
  "PRODUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "tsconfig.build.json",
  "tsconfig.json",
] as const;
const IGNORED_NAMES = new Set([".git", "node_modules"]);
// Generated pack-time output; it is compiled from already-scanned sources and absent in a
// clean checkout, so scanning it would only feed hand-tuned source regexes build artifacts.
const IGNORED_PATHS = new Set<string>([]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const NON_BUN_SCRIPT_EXTENSIONS = new Set(["." + "p" + "y", "." + "p" + "yc", "." + "p" + "yo"]);
const NON_BUN_CACHE_DIRECTORY = ["__", "py", "cache__"].join("");
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".rs",
  ".mjs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const SELF_SCANNERS = new Set([
  "scripts/check-standalone.ts",
  "scripts/check-standalone.test.ts",
  "scripts/package-smoke.ts",
]);
const NPM_TRUSTED_PUBLISHER_IDENTITY_FILES = new Set([
  "scripts/release-distribution-policy.test.ts",
  "scripts/release-distribution-policy.ts",
]);
const EXPECTED_ENSOUL_FILES = [
  "LICENSE",
  "NOTICE.md",
  "SKILL.md",
  "VENDORED_FROM.md",
  "agents/openai.yaml",
  "references/ensoul-source-packet-v1.schema.json",
  "references/evidence-method.md",
  "references/output-blueprint.md",
  "references/source-packets.md",
  "scripts/prepare-x-archive.ts",
  "scripts/source-packet.ts",
  "scripts/validate-source-packet.ts",
  "scripts/x-zip-file.ts",
] as const;
const LEGACY_NON_BUN_REFERENCE = new RegExp([
  String.raw`\bpy`,
  String.raw`thon3?\b`,
  String.raw`|prepare_`,
  String.raw`x_archive\.p`,
  "y",
  String.raw`|validate_`,
  String.raw`source_packet\.p`,
  "y",
].join(""), "u");

// The exact macOS resolver socket and OS-redacted imsg crash path are public
// OS forms. Quote/end boundaries keep parents, siblings, suffixes and every
// actual temporary directory subject to private-path detection.
export const PRIVATE_TEMPORARY_PATH = /\/private\/(?:tmp\/(?!\*\/imsg(?:["'`]|$))|var\/(?!run\/mDNSResponder(?:["'`]|$)))/u;

const OPACITY_RULES = [
  { label: "private package name", pattern: /@jungle\//u },
  { label: "private source-repository name", pattern: /\bjungle\b/iu },
  { label: "private source path", pattern: /(?:projects|packages)\/message-like-me/u },
  { label: "private repository identity", pattern: /0thernet\/jungle/iu },
  { label: "private workspace dependency protocol", pattern: /["'`](?:workspace|catalog):[^"'`\s]*["'`]/u },
  { label: "developer home path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u },
  { label: "private temporary path", pattern: PRIVATE_TEMPORARY_PATH },
  { label: "publication implementation detail", pattern: /OPEN_SOURCE_SYNC_/u },
] as const;

const CREDENTIAL_RULES = [
  { label: "private key material", pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u },
  { label: "GitHub token", pattern: /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u },
  { label: "OpenAI secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
] as const;

const BANNED_RUNTIME_IMPORTS = [
  "@ai-sdk/",
  "@anthropic-ai/",
  "@auth/",
  "@aws-sdk/client-bedrock",
  "@clerk/",
  "@google/generative-ai",
  "@google/genai",
  "@huggingface/inference",
  "@mistralai/",
  "ai",
  "anthropic",
  "auth0",
  "axios",
  "better-auth",
  "cohere-ai",
  "dgram",
  "dns",
  "firebase/auth",
  "got",
  "groq-sdk",
  "http",
  "http2",
  "https",
  "jose",
  "langchain",
  "net",
  "node-fetch",
  "node:child_process",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:net",
  "node:tls",
  "oauth",
  "ollama",
  "openai",
  "passport",
  "replicate",
  "tls",
  "together-ai",
  "undici",
  "ws",
] as const;

const BANNED_DEPENDENCY_PREFIXES = [
  "@ai-sdk/",
  "@anthropic-ai/",
  "@auth/",
  "@aws-sdk/client-bedrock",
  "@clerk/",
  "@google/generative-ai",
  "@google/genai",
  "@huggingface/inference",
  "@jungle/",
  "@langchain/",
  "@mistralai/",
] as const;
const BANNED_DEPENDENCIES = new Set([
  "ai",
  "anthropic",
  "auth0",
  "axios",
  "better-auth",
  "cohere-ai",
  "firebase",
  "got",
  "groq-sdk",
  "jose",
  "langchain",
  "next-auth",
  "node-fetch",
  "oauth",
  "ollama",
  "openai",
  "passport",
  "replicate",
  "together-ai",
  "undici",
  "ws",
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function normalizedRelative(path: string): string {
  return relative(PACKAGE_ROOT, path).split(sep).join("/");
}

function ignored(path: string): boolean {
  const relative = normalizedRelative(path);
  if (IGNORED_PATHS.has(relative)) return true;
  const parts = relative.split("/");
  return parts.some((part) => IGNORED_NAMES.has(part));
}

async function collectFiles(path: string): Promise<string[]> {
  if (ignored(path)) return [];
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Standalone source must not contain a symlink: ${normalizedRelative(path)}`);
  }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    nested.push(...await collectFiles(join(path, entry.name)));
  }
  return nested;
}

async function startsWithSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return bytesRead === 16 && bytes.toString("utf8") === "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

function dependencyNames(value: unknown): string[] {
  if (value === undefined) return [];
  return Object.keys(record(value, "package dependency map"));
}

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

function bannedImport(specifier: string): boolean {
  return BANNED_RUNTIME_IMPORTS.some((candidate) =>
    specifier === candidate || specifier.startsWith(`${candidate}/`)
  );
}

function checkRuntimeSource(path: string, source: string): string[] {
  const problems: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (bannedImport(specifier)) {
      problems.push(`${path} imports forbidden network, auth, shell, or AI runtime ${specifier}`);
    }
  }
  const runtimeRules = [
    { label: "network fetch", pattern: /\bfetch\s*\(/u },
    { label: "XMLHttpRequest network client", pattern: /\bnew\s+XMLHttpRequest\s*\(/u },
    { label: "WebSocket network client", pattern: /\bnew\s+WebSocket\s*\(/u },
    { label: "EventSource network client", pattern: /\bnew\s+EventSource\s*\(/u },
    { label: "Bun network listener or client", pattern: /\bBun\.(?:connect|listen|serve)\s*\(/u },
    { label: "Deno network client or listener", pattern: /\bDeno\.(?:connect|connectTls|listen|listenTls|serve)\s*\(/u },
    { label: "browser beacon client", pattern: /\bnavigator\.sendBeacon\s*\(/u },
    { label: "remote URL", pattern: /["']https?:\/\//u },
    { label: "OAuth runtime", pattern: /\bOAuth(?:2)?\b/u },
    { label: "bearer-token runtime", pattern: /\bBearer\s+[A-Za-z0-9._~-]/u },
    { label: "API-key runtime", pattern: /\b(?:AI_GATEWAY|ANTHROPIC|OPENAI)_API_KEY\b/u },
  ] as const;
  for (const rule of runtimeRules) {
    if (rule.pattern.test(source)) problems.push(`${path} contains ${rule.label}`);
  }
  return problems;
}

function checkEmailAddresses(path: string, source: string): string[] {
  const problems: string[] = [];
  for (const match of source.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
    const address = match[0]?.toLowerCase();
    const domain = match[1]?.toLowerCase();
    if (address === undefined || domain === undefined) continue;
    if (
      ["example.com", "example.net", "example.org"].includes(domain)
      || [".example", ".invalid", ".localhost", ".test"].some((suffix) => domain.endsWith(suffix))
      || (
        address === "npm-oidc-no-reply@github.com"
        && NPM_TRUSTED_PUBLISHER_IDENTITY_FILES.has(path)
      )
      || /^[1-9][0-9]{4,14}@s\.whatsapp\.net$/u.test(address)
      || /^[1-9][0-9]{4,19}(?:-[1-9][0-9]{0,19})?@g\.us$/u.test(address)
    ) continue;
    problems.push(`${path} contains a non-reserved email address`);
  }
  return problems;
}

function checkPhoneNumbers(path: string, source: string): string[] {
  const problems: string[] = [];
  const candidates = [
    /(?:^|[^\d])(\+[1-9](?:[ .()-]?\d){7,14})(?!\d)/gu,
    /(?:^|[^\d])((?:1[ .-])?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4})(?!\d)/gu,
  ];
  for (const pattern of candidates) for (const match of source.matchAll(pattern)) {
    const digits = match[1]?.replaceAll(/\D/gu, "");
    if (digits === undefined || digits.includes("555")) continue;
    problems.push(`${path} contains a non-fixture international phone number`);
  }
  return problems;
}

function checkPackageManifest(value: unknown): string[] {
  const manifest = record(value, "package.json");
  const problems: string[] = [];
  if (manifest.name !== "@hraness/message-like-me") {
    problems.push("package.json name must be @hraness/message-like-me");
  }
  if (
    typeof manifest.version !== "string"
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(manifest.version)
  ) {
    problems.push("package.json version must be a stable semantic version");
  }
  if (manifest.homepage !== "https://messagelikeme.com") {
    problems.push("package.json homepage must be https://messagelikeme.com");
  }
  const repository = record(manifest.repository, "package.json repository");
  if (repository.url !== "git+https://github.com/hraness/textbutler.git") {
    problems.push("package.json repository must be hraness/textbutler");
  }
  const bin = record(manifest.bin, "package.json bin");
  if (Object.keys(bin).length !== 1 || bin.messagelikeme !== "./dist/cli.js") {
    problems.push("package.json must expose only messagelikeme at ./dist/cli.js");
  }
  if (manifest.description !== PUBLIC_DESCRIPTION) {
    problems.push("package.json description must match the canonical public description");
  }

  // Exact development-only dependencies support the separate Textbutler source
  // tree. They do not enter the legacy public runtime or its packed exports.
  const textbutlerProviderToolchain: Readonly<Record<string, string>> = {
    "@anthropic-ai/claude-agent-sdk": "0.3.268",
    "@anthropic-ai/sdk": "0.125.0",
  };
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const entries = manifest[field];
    for (const name of dependencyNames(entries)) {
      if (field === "devDependencies" && Object.hasOwn(textbutlerProviderToolchain, name)
        && (entries as JsonRecord)[name] === textbutlerProviderToolchain[name]) continue;
      if (BANNED_DEPENDENCIES.has(name) || BANNED_DEPENDENCY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        problems.push(`package.json ${field} depends on forbidden network, auth, AI, or private package ${name}`);
      }
    }
  }
  return problems;
}

async function checkVersionContracts(manifest: JsonRecord): Promise<string[]> {
  if (typeof manifest.version !== "string") return [];
  const version = manifest.version;
  const [sourceVersion, readme] = await Promise.all([
    readFile(join(PACKAGE_ROOT, "src", "version.ts"), "utf8"),
    readFile(join(PACKAGE_ROOT, "README.md"), "utf8"),
  ]);
  const problems: string[] = [];
  const expectedSource = `export const MESSAGE_LIKE_ME_VERSION = ${JSON.stringify(version)} as const;`;
  if (sourceVersion.trim() !== expectedSource) {
    problems.push(`src/version.ts must match package version ${version}`);
  }
  const expectedInstall = `@hraness/message-like-me@${version}`;
  if (!readme.includes(expectedInstall)) {
    problems.push(`README.md npm install must match package version ${version}`);
  }
  if (!readme.startsWith(`# Textbutler\n\n${SKILLS_BADGE}\n\n`)) {
    problems.push("README.md must identify Textbutler and retain the legacy skill badge for its published history tools");
  }
  return problems;
}

/** Apply the opacity, credential, address, and phone text rules to one scanned
 * source. Dependency protocols match only a complete quoted specifier such as
 * "workspace:*" or "catalog:react18"; ordinary catalog/workspace properties and
 * quoted keys are not specifiers. Unquoted occurrences are indistinguishable
 * from ordinary properties and remain outside this rule. */
export function standaloneSourceProblems(path: string, source: string): string[] {
  const problems: string[] = [];
  if (LEGACY_NON_BUN_REFERENCE.test(source)) {
    problems.push(`${path} contains a legacy non-Bun Ensoul script reference`);
  }
  for (const rule of [...OPACITY_RULES, ...CREDENTIAL_RULES]) {
    if (rule.pattern.test(source)) problems.push(`${path} contains ${rule.label}`);
  }
  problems.push(...checkEmailAddresses(path, source));
  problems.push(...checkPhoneNumbers(path, source));
  return problems;
}

export async function standaloneProblems(): Promise<string[]> {
  await assertSupportFoundationInputs(PACKAGE_ROOT);
  const roots = [
    ...SCANNED_DIRECTORIES.map((path) => join(PACKAGE_ROOT, path)),
    ...SCANNED_ROOT_FILES.map((path) => join(PACKAGE_ROOT, path)),
  ];
  const files = [...new Set((await Promise.all(roots.map(collectFiles))).flat())]
    .sort((left, right) => left.localeCompare(right));
  const problems: string[] = [];

  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const manifest = record(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    "package.json",
  );
  problems.push(...checkPackageManifest(manifest));
  problems.push(...await checkVersionContracts(manifest));

  const actualEnsoulFiles = files
    .map(normalizedRelative)
    .filter((path) => path.startsWith("skills/ensoul/"))
    .map((path) => path.slice("skills/ensoul/".length))
    .sort();
  const expectedEnsoulFiles = [...EXPECTED_ENSOUL_FILES].sort();
  if (actualEnsoulFiles.join("\n") !== expectedEnsoulFiles.join("\n")) {
    problems.push([
      "skills/ensoul inventory must exactly match the approved v0.3.1 copy.",
      `Expected: ${expectedEnsoulFiles.join(", ")}`,
      `Received: ${actualEnsoulFiles.join(", ")}`,
    ].join("\n"));
  }

  for (const file of files) {
    const path = normalizedRelative(file);
    const extension = extname(file).toLowerCase();
    if (NON_BUN_SCRIPT_EXTENSIONS.has(extension) || path.split("/").includes(NON_BUN_CACHE_DIRECTORY)) {
      problems.push(`${path} is a legacy non-Bun script artifact`);
    }
    if (DATABASE_EXTENSIONS.has(extension)) {
      problems.push(`${path} is a committed database artifact; fixtures must be constructed at test time`);
    }
    if (await startsWithSqliteHeader(file)) {
      problems.push(`${path} contains a SQLite database`);
    }
    if (!TEXT_EXTENSIONS.has(extension) && basename(file) !== "LICENSE") continue;
    const source = await readFile(file, "utf8");
    if (!SELF_SCANNERS.has(path)) problems.push(...standaloneSourceProblems(path, source));
    if (path === "dist/support-runtime.js") {
      // Only the exact reviewed shared CLI bundle may contain its bounded local
      // Git-config reader and public Accounts links. Every other runtime keeps
      // the broad network/auth/process bans.
      if (!isReviewedSupportRuntime(path, source)) problems.push("The reviewed CLI support runtime bytes drifted");
    } else if (path.startsWith("src/") || path.startsWith("dist/")) {
      problems.push(...checkRuntimeSource(path, source));
    }
  }

  return [...new Set(problems)].sort((left, right) => left.localeCompare(right));
}

if (import.meta.main) {
  const problems = await standaloneProblems();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log("Standalone opacity, privacy, and local-only runtime boundary verified.");
  }
}
