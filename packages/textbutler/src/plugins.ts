import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { assertOwnedPath, readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Hooks, validateExtension } from "./hooks.ts";

const MAX_MANIFEST_BYTES = 16_384;
const MAX_MODULE_BYTES = 262_144;
// Bun caches file imports by physical path, including across query strings.
// Refuse changed code in this process rather than reporting a new digest for
// an old module. A complete daemon process restart is the reload boundary.
const importedSources = new Map<string, string>();
type Entry = Readonly<{ id: string; version: string; entry: string }>;
export type LoadedExtension = Readonly<{ id: string; version: string; sha256: string }>;
export type LoadedExtensions = Readonly<{ hooks: Hooks; extensions: readonly LoadedExtension[] }>;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function manifest(value: unknown): readonly Entry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid owner extension manifest");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 || item.schemaVersion !== 1 || !Array.isArray(item.extensions) || item.extensions.length > 32) throw new Error("Invalid owner extension manifest");
  const ids = new Set<string>(), files = new Set<string>();
  return item.extensions.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension entry");
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(entry.id) || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(entry.version) || typeof entry.entry !== "string" || !/^[a-z0-9][a-z0-9.-]{0,79}\.(?:ts|js|mjs)$/u.test(entry.entry) || ids.has(entry.id) || files.has(entry.entry)) throw new Error("Invalid or duplicate extension entry");
    ids.add(entry.id); files.add(entry.entry);
    return { id: entry.id, version: entry.version, entry: entry.entry };
  });
}
async function privateDirectory(path: string): Promise<void> {
  try {
    await assertOwnedPath(path, { kind: "directory", canonical: true, ownerOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("Extension directory must be physical, owned, and private", { cause: error });
  }
}
async function readSource(path: string, maxBytes: number): Promise<Buffer> {
  try {
    const bytes = await readOwnedFileStable(path, maxBytes);
    // Reject malformed UTF-8 before an importer can execute the source.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "Private file changed during the read.") throw new Error("Extension file changed during loading");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("Extension file must be bounded, owned, private, and unlinked", { cause: error });
  }
}

/** Explicit owner-installed application code, never a model or message plugin.
 * Listed modules and their imports run with the daemon's full authority. Loading
 * is deliberately not a sandbox, package installer, watcher or permission grant.
 * A failed load prevents use of the entire hook collection. Restart to reload. */
export async function loadOwnerExtensions(dataDirectory: string): Promise<LoadedExtensions> {
  const dataDir = resolve(dataDirectory), directory = join(dataDir, "plugins"), hooks = new Hooks();
  await privateDirectory(dataDir);
  try { await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hooks, extensions: [] }; throw error; }
  await privateDirectory(directory);
  const manifestPath = join(directory, "extensions.json");
  const source = await readSource(manifestPath, MAX_MANIFEST_BYTES);
  const entries = manifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)));
  // Preflight the full inventory before running any owner module.
  const sources = await Promise.all(entries.map(async entry => ({ ...entry, path: join(directory, entry.entry), bytes: await readSource(join(directory, entry.entry), MAX_MODULE_BYTES) })));
  const extensions: LoadedExtension[] = [];
  for (const entry of sources) {
    await privateDirectory(dataDir); await privateDirectory(directory);
    const sha256 = digest(entry.bytes);
    if (digest(await readSource(manifestPath, MAX_MANIFEST_BYTES)) !== digest(source) || digest(await readSource(entry.path, MAX_MODULE_BYTES)) !== sha256) throw new Error("Owner extensions changed during startup");
    const previous = importedSources.get(entry.path);
    if (previous !== undefined && previous !== sha256) throw new Error("Extension source changed; restart the daemon process to load it");
    if (previous === undefined && importedSources.size >= 256) throw new Error("Extension module capacity reached; restart the daemon process");
    importedSources.set(entry.path, sha256);
    const module = await import(pathToFileURL(entry.path).href) as Record<string, unknown>;
    const extension = validateExtension(module.default);
    if (extension.id !== entry.id || extension.version !== entry.version) throw new Error("Extension identity does not match its owner manifest");
    if (digest(await readSource(entry.path, MAX_MODULE_BYTES)) !== sha256) throw new Error("Owner extension changed during import");
    hooks.register(extension);
    extensions.push(Object.freeze({ id: entry.id, version: entry.version, sha256 }));
  }
  if (digest(await readSource(manifestPath, MAX_MANIFEST_BYTES)) !== digest(source)) throw new Error("Owner extensions changed during startup");
  return { hooks, extensions: Object.freeze(extensions) };
}
