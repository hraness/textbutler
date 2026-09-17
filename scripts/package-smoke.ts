import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { publicReleaseEnvironment } from "./release-process-environment";

const PACKAGE_NAME = "@hraness/message-like-me";
const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const TYPESCRIPT_CLI = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");
const NON_BUN_SCRIPT_EXTENSIONS = new Set(["." + "p" + "y", "." + "p" + "yc", "." + "p" + "yo"]);
const NON_BUN_CACHE_DIRECTORY = ["__", "py", "cache__"].join("");
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
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const MAXIMUM_PACKED_FILE_COUNT = 256;
const MAXIMUM_PACKED_FILE_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_PACKED_TOTAL_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const FORBIDDEN_PACKAGE_TEXT = [
  { label: "private package name", pattern: /@jungle\//u },
  { label: "private source-repository name", pattern: /\bJungle\b/u },
  { label: "private source path", pattern: /(?:projects|packages)\/message-like-me/u },
  { label: "private repository identity", pattern: /0thernet\/jungle/iu },
  { label: "developer home path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u },
  { label: "private key material", pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u },
  { label: "GitHub token", pattern: /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u },
  { label: "OpenAI secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function startsWithSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && bytes.toString("utf8") === "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

export async function scanPackedPackage(root: string): Promise<void> {
  const problems: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    const packagePath = relative(root, path).split(sep).join("/") || ".";
    if (info.isSymbolicLink()) {
      problems.push(`${packagePath} is a symlink`);
      return;
    }
    if (info.isDirectory()) {
      if (basename(path) === NON_BUN_CACHE_DIRECTORY) {
        problems.push(`${packagePath} is a legacy non-Bun script artifact directory`);
      }
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(join(path, entry.name));
      }
      return;
    }
    if (!info.isFile()) {
      problems.push(`${packagePath} is not a regular file`);
      return;
    }
    fileCount += 1;
    totalBytes += info.size;
    if (fileCount > MAXIMUM_PACKED_FILE_COUNT) {
      problems.push(`package contains more than ${String(MAXIMUM_PACKED_FILE_COUNT)} regular files`);
    }
    if (info.size > MAXIMUM_PACKED_FILE_BYTES) {
      problems.push(`${packagePath} exceeds the per-file byte bound`);
      return;
    }
    if (totalBytes > MAXIMUM_PACKED_TOTAL_BYTES) {
      problems.push(`package exceeds the ${String(MAXIMUM_PACKED_TOTAL_BYTES)}-byte total bound`);
      return;
    }
    const extension = extname(path).toLowerCase();
    if (NON_BUN_SCRIPT_EXTENSIONS.has(extension)) {
      problems.push(`${packagePath} is a legacy non-Bun script artifact`);
    }
    if (DATABASE_EXTENSIONS.has(extension) || await startsWithSqliteHeader(path)) {
      problems.push(`${packagePath} contains a database artifact`);
    }
    if (!TEXT_EXTENSIONS.has(extension) && basename(path) !== "LICENSE") {
      problems.push(`${packagePath} has an unapproved public-package file type`);
      return;
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch {
      problems.push(`${packagePath} is not canonical UTF-8 text`);
      return;
    }
    for (const rule of FORBIDDEN_PACKAGE_TEXT) {
      if (rule.pattern.test(source)) problems.push(`${packagePath} contains ${rule.label}`);
    }
  }
  await visit(root);
  if (problems.length > 0) {
    throw new Error(`Packed standalone boundary failed:\n${[...new Set(problems)].sort().join("\n")}`);
  }
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
        throw new Error("Packed-package command output exceeded its byte bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function fileInventory(root: string, path: string = root): Promise<string[]> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Packed skill inventory contains a symlink: ${relative(root, path)}`);
  }
  if (info.isFile()) return [relative(root, path).split(sep).join("/")];
  if (!info.isDirectory()) {
    throw new Error(`Packed skill inventory contains a non-file entry: ${relative(root, path)}`);
  }
  const files: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    files.push(...await fileInventory(root, join(path, entry.name)));
  }
  return files;
}

async function assertEnsoulInventory(root: string, label: string): Promise<void> {
  const actual = (await fileInventory(root)).sort();
  const expected = [...EXPECTED_ENSOUL_FILES].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error([
      `${label} Ensoul inventory does not match the approved v0.3.1 copy.`,
      `Expected: ${expected.join(", ")}`,
      `Received: ${actual.join(", ")}`,
    ].join("\n"));
  }
}

async function run(
  command: readonly string[],
  cwd: string,
  options: Readonly<{ capture?: boolean }> = {},
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: publicReleaseEnvironment({ CI: "true", NO_COLOR: "1" }),
    stderr: "pipe",
    stdout: "pipe",
  });
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
    if (timedOut) throw new Error("Packed-package command exceeded its two-minute bound.");
    if (exitCode !== 0) {
      const diagnosticState = stderr.byteLength === 0
        ? "without diagnostic output"
        : "with redacted diagnostic output";
      throw new Error(`Packed-package command failed (${String(exitCode)}) ${diagnosticState}.`);
    }
    return options.capture === true ? stdout.toString("utf8") : "";
  } finally {
    clearTimeout(timer);
  }
}

function packagePaths(value: unknown, label: string): string[] {
  if (typeof value === "string") {
    return value.startsWith("./") ? [value.slice(2)] : [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain package-relative paths`);
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    packagePaths(nested, `${label}.${key}`)
  );
}

async function requirePublishedPaths(packageRoot: string, manifest: JsonRecord): Promise<void> {
  const bin = record(manifest.bin, "installed package.json bin");
  const exported = [
    ...packagePaths(manifest.exports, "installed package.json exports"),
    ...packagePaths(bin, "installed package.json bin"),
  ];
  for (const path of [...new Set(exported)].sort()) {
    const resolved = resolve(packageRoot, path);
    if (!isWithin(packageRoot, resolved)) {
      throw new Error(`Published path escapes the installed package: ${path}`);
    }
    try {
      await access(resolved);
    } catch {
      throw new Error(`Published path is missing from the installed package: ${path}`);
    }
  }
}

export async function packageSmoke(suppliedArchive?: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "message-like-me-package-"));
  try {
    const archive = suppliedArchive === undefined
      ? join(work, "package.tgz")
      : resolve(suppliedArchive);
    const cache = join(work, "cache");
    const consumer = join(work, "consumer");
    await Promise.all([mkdir(cache), mkdir(consumer)]);
    if (suppliedArchive === undefined) {
      await run([
        process.execPath,
        "pm",
        "pack",
        "--filename",
        archive,
        "--ignore-scripts",
        "--quiet",
      ], PACKAGE_ROOT);
    }
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await run([
      process.execPath,
      "add",
      archive,
      "--ignore-scripts",
      "--offline",
      "--cache-dir",
      cache,
      "--backend",
      "copyfile",
    ], consumer);

    const installedPackage = await realpath(
      join(consumer, "node_modules", "@hraness", "message-like-me"),
    );
    await scanPackedPackage(installedPackage);
    const manifest = record(
      JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as unknown,
      "installed package.json",
    );
    if (manifest.name !== PACKAGE_NAME) {
      throw new Error(`Packed package name is ${JSON.stringify(manifest.name)}, expected ${PACKAGE_NAME}`);
    }
    const publishConfig = record(manifest.publishConfig, "installed package.json publishConfig");
    if (
      publishConfig.access !== "public"
      || publishConfig.provenance !== true
      || publishConfig.registry !== "https://registry.npmjs.org"
    ) {
      throw new Error("Packed package does not require public npm provenance.");
    }
    await requirePublishedPaths(installedPackage, manifest);
    await run([process.execPath, "-e", `await import(${JSON.stringify(PACKAGE_NAME)})`], consumer);
    await run([
      process.execPath,
      "-e",
      `const contract = await import(${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v1`)}); if (contract.LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION !== "1.1.0") throw new Error("wrong bundle contract")`,
    ], consumer);
    await run([
      process.execPath,
      "-e",
      `const contract = await import(${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v2`)}); if (contract.LOCAL_MESSAGE_BUNDLE_V2_SOURCE_TRANSFORM_VERSION !== "1.0.0" || contract.LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_ID !== "whatsapp" || contract.LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_VERSION !== "0.15.0") throw new Error("wrong WhatsApp bundle contract")`,
    ], consumer);
    await run([
      process.execPath,
      "-e",
      `const contract = await import(${JSON.stringify(`${PACKAGE_NAME}/agentic-messaging-v1`)}); if (contract.GHOSTGET_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH !== "5e64da6a3d826e7f6fa3db7dca0a4ba92c10cfb784981e71a25aed9513a5c687" || contract.GHOSTGET_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH !== "7f6cf724f0200b2399e4f4641c637b20b48914fc5c9b13755127a8ec69fe66f4") throw new Error("wrong agentic messaging contract")`,
    ], consumer);
    await run([
      process.execPath,
      "-e",
      `const contract = await import(${JSON.stringify(`${PACKAGE_NAME}/ensoul-source-v1`)}); if (contract.ENSOUL_SOURCE_PACKET_V1_SCHEMA_IDENTITY !== "ensoul.source-packet.v1" || contract.ENSOUL_MESSAGES_SOURCE_V1_ADAPTER_ID !== "ensoul.messages-source.v1" || contract.ENSOUL_DIGEST_CANONICALIZATION !== "JCS-RFC8785") throw new Error("wrong Ensoul source contract")`,
    ], consumer);
    await writeFile(
      join(consumer, "index.ts"),
      [
        `import { canonicalJson, sha256 } from ${JSON.stringify(PACKAGE_NAME)};`,
        `import type { ContactMetrics, StyleProfileV2 } from ${JSON.stringify(PACKAGE_NAME)};`,
        `import { LOCAL_MESSAGE_BUNDLE_V1_ARTIFACTS, parseLocalMessageBundleV1Record } from ${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v1`)};`,
        `import type { LocalMessageBundleV1Manifest } from ${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v1`)};`,
        `import { LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS, parseLocalMessageBundleV2Record } from ${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v2`)};`,
        `import type { LocalMessageBundleV2Manifest } from ${JSON.stringify(`${PACKAGE_NAME}/message-bundle-v2`)};`,
        `import { parseAgentMessageHandoffV1, GHOSTGET_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH, GHOSTGET_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH } from ${JSON.stringify(`${PACKAGE_NAME}/agentic-messaging-v1`)};`,
        `import type { AgentMessageHandoffV1 } from ${JSON.stringify(`${PACKAGE_NAME}/agentic-messaging-v1`)};`,
        `import { buildEnsoulMessagesSourcePacketV1, ENSOUL_MESSAGES_SOURCE_V1_ADAPTER_ID } from ${JSON.stringify(`${PACKAGE_NAME}/ensoul-source-v1`)};`,
        `import type { EnsoulMessagesSourcePacketV1 } from ${JSON.stringify(`${PACKAGE_NAME}/ensoul-source-v1`)};`,
        "const digest: string = sha256(canonicalJson({ fixture: true }));",
        "const profile = null as unknown as StyleProfileV2;",
        "const metrics = null as unknown as ContactMetrics;",
        "const manifest = null as unknown as LocalMessageBundleV1Manifest;",
        "const whatsappManifest = null as unknown as LocalMessageBundleV2Manifest;",
        "const parseRecord: typeof parseLocalMessageBundleV1Record = parseLocalMessageBundleV1Record;",
        "const parseWhatsAppRecord: typeof parseLocalMessageBundleV2Record = parseLocalMessageBundleV2Record;",
        "const handoff = null as unknown as AgentMessageHandoffV1;",
        "const parseHandoff: typeof parseAgentMessageHandoffV1 = parseAgentMessageHandoffV1;",
        "const ensoulPacket = null as unknown as EnsoulMessagesSourcePacketV1;",
        "const buildEnsoul: typeof buildEnsoulMessagesSourcePacketV1 = buildEnsoulMessagesSourcePacketV1;",
        "void [digest, profile, metrics, manifest, whatsappManifest, parseRecord, parseWhatsAppRecord, handoff, parseHandoff, ensoulPacket, buildEnsoul, ENSOUL_MESSAGES_SOURCE_V1_ADAPTER_ID, LOCAL_MESSAGE_BUNDLE_V1_ARTIFACTS, LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS, GHOSTGET_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH, GHOSTGET_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH];",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024",
          types: [],
        },
        include: ["index.ts"],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await run([
      process.execPath,
      TYPESCRIPT_CLI,
      "--project",
      join(consumer, "tsconfig.json"),
    ], consumer);

    const binary = join(consumer, "node_modules", ".bin", "messagelikeme");
    const help = await run([binary, "--help"], consumer, { capture: true });
    if (!help.includes("messagelikeme")) {
      throw new Error("Packed CLI help does not identify messagelikeme");
    }
    if (!help.includes("ensoul prepare CONTACT_ID --subject owner|contact")) {
      throw new Error("Packed CLI help does not expose the Ensoul source adapter");
    }
    const reportedVersion = (await run([binary, "--version"], consumer, { capture: true })).trim();
    if (reportedVersion !== manifest.version) {
      throw new Error(
        `Packed CLI reports version ${JSON.stringify(reportedVersion)}, expected ${JSON.stringify(manifest.version)}`,
      );
    }
    const dataDirectory = join(work, "private-data");
    const initialized = record(
      JSON.parse(await run([
        binary,
        "--data-dir",
        dataDirectory,
        "init",
        "--json",
      ], consumer, { capture: true })) as unknown,
      "packed initialization receipt",
    );
    if (initialized.initialized !== true) {
      throw new Error("Packed CLI did not initialize one isolated private store");
    }
    const doctor = record(
      JSON.parse(await run([
        binary,
        "--data-dir",
        dataDirectory,
        "doctor",
        "--json",
      ], consumer, { capture: true })) as unknown,
      "packed doctor receipt",
    );
    if (doctor.ok !== true) {
      throw new Error("Packed CLI doctor did not verify the isolated private store");
    }
    const reportedSkill = (await run([binary, "skill", "path"], consumer, { capture: true })).trim();
    const installedSkill = await realpath(reportedSkill);
    const expectedSkill = await realpath(join(installedPackage, "skills", "message-like-me"));
    if (installedSkill !== expectedSkill || !isWithin(installedPackage, installedSkill)) {
      throw new Error(`Packed CLI resolved skill outside its install: ${reportedSkill}`);
    }
    await access(join(installedSkill, "SKILL.md"));
    const installedEnsoulSkill = await realpath(join(installedPackage, "skills", "ensoul"));
    if (!isWithin(installedPackage, installedEnsoulSkill)) {
      throw new Error("Packed Ensoul skill resolved outside its install");
    }
    await assertEnsoulInventory(installedEnsoulSkill, "Packed");
    const installReceipt = record(
      JSON.parse(await run([
        binary,
        "skill",
        "install",
        "--target",
        "agents",
        "--scope",
        "project",
        "--project",
        consumer,
        "--json",
      ], consumer, { capture: true })) as unknown,
      "packed dual-skill install receipt",
    );
    if (installReceipt.target !== "agents" || installReceipt.scope !== "project") {
      throw new Error("Packed dual-skill install receipt has the wrong target or scope");
    }
    const destinations = record(installReceipt.destinations, "packed dual-skill destinations");
    if (installReceipt.destination !== destinations.messageLikeMe) {
      throw new Error("Packed dual-skill install receipt broke the legacy destination field");
    }
    await access(join(consumer, ".agents", "skills", "message-like-me", "SKILL.md"));
    await assertEnsoulInventory(
      join(consumer, ".agents", "skills", "ensoul"),
      "Installed",
    );
    const schema = record(
      JSON.parse(
        await readFile(join(installedPackage, "schema", "style-profile-v1.schema.json"), "utf8"),
      ) as unknown,
      "installed style profile schema",
    );
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      throw new Error("Packed style profile schema must use JSON Schema draft 2020-12");
    }
    const bundleSchema = record(
      JSON.parse(
        await readFile(
          join(installedPackage, "schema", "local-message-bundle-v1.schema.json"),
          "utf8",
        ),
      ) as unknown,
      "installed local message bundle schema",
    );
    if (
      bundleSchema.$schema !== "https://json-schema.org/draft/2020-12/schema"
      || bundleSchema.$id !== "https://messagelikeme.com/schema/local-message-bundle-v1.schema.json"
    ) {
      throw new Error("Packed local message bundle schema has the wrong identity");
    }
    const whatsappBundleSchema = record(
      JSON.parse(
        await readFile(
          join(installedPackage, "schema", "local-message-bundle-v2.schema.json"),
          "utf8",
        ),
      ) as unknown,
      "installed native WhatsApp bundle schema",
    );
    if (
      whatsappBundleSchema.$schema !== "https://json-schema.org/draft/2020-12/schema"
      || whatsappBundleSchema.$id !== "https://messagelikeme.com/schema/local-message-bundle-v2.schema.json"
    ) {
      throw new Error("Packed native WhatsApp bundle schema has the wrong identity");
    }
    const ensoulSchema = record(
      JSON.parse(
        await readFile(
          join(installedPackage, "schema", "ensoul-messages-source-v1.schema.json"),
          "utf8",
        ),
      ) as unknown,
      "installed Ensoul messages source schema",
    );
    if (
      ensoulSchema.$schema !== "https://json-schema.org/draft/2020-12/schema"
      || ensoulSchema.$id !== "https://messagelikeme.com/schema/ensoul-messages-source-v1.schema.json"
    ) {
      throw new Error("Packed Ensoul messages source schema has the wrong identity");
    }
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  await packageSmoke(process.argv[2]);
  console.log("Packed install, consumer types, library import, CLI identity, and both bundled skills verified.");
}
