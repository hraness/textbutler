import { fstatSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  extractXArchiveFile,
  type ExtractedXArchiveMember,
  type XArchiveMembers,
} from "./x-archive-zip.ts";

/**
 * Optional Rust fast path for the strict X-archive ZIP reader.
 *
 * The vendored `oh-archive-strict` WASM artifact is produced by the `oh`
 * workspace (`rust/oh-archive-strict-wasm`) and ports this module's full
 * validation contract to Rust. When the artifact or the archive cannot be
 * handled by WASM, the reference TypeScript implementation remains
 * authoritative and the caller falls back to it.
 */

const SELECTED_PATTERN =
  "^(?:[^/]+/)?data/(?:manifest|account|direct-message(?:-group)?-headers|direct-messages(?:-group)?[^/]*|tweets|deleted-tweets|community-tweet)\\.js$";

// wasm32 memories are bounded at 4 GiB; the reader copies the archive into the
// module's linear memory, so archives near that bound take the TypeScript path.
const MAX_WASM_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;

type StrictWasmExports = {
  memory: WebAssembly.Memory;
  oh_archive_alloc(length: number): number;
  oh_archive_free(pointer: number, length: number): void;
  oh_archive_read_strict(
    archivePointer: number,
    archiveLength: number,
    optionsPointer: number,
    optionsLength: number,
  ): number;
};

type StrictMember = Readonly<{ name: string; bytes: Uint8Array }>;

let cachedInstance: WebAssembly.Instance | null | undefined;

function strictWasmInstance(): WebAssembly.Instance | null {
  if (cachedInstance !== undefined) return cachedInstance;
  try {
    const artifact = fileURLToPath(new URL(
      "../vendor/oh-archive-strict/oh_archive_strict_wasm.wasm",
      import.meta.url,
    ));
    const bytes = readFileSync(artifact);
    const module = new WebAssembly.Module(bytes);
    cachedInstance = new WebAssembly.Instance(module, {});
  } catch {
    cachedInstance = null;
  }
  return cachedInstance;
}

function copyIn(exports: StrictWasmExports, bytes: Uint8Array): number {
  const pointer = exports.oh_archive_alloc(bytes.length);
  if (pointer === 0) throw new Error("X ZIP WASM allocation failed");
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

function readArchive(descriptor: number, archiveSize: number): Buffer {
  const buffer = Buffer.allocUnsafe(archiveSize);
  let position = 0;
  while (position < archiveSize) {
    const count = readSync(descriptor, buffer, position, archiveSize - position, position);
    if (count < 1) throw new Error("X ZIP archive is truncated");
    position += count;
  }
  return buffer;
}

function parseStrictResult(exports: StrictWasmExports, pointer: number): StrictMember[] {
  if (pointer === 0) throw new Error("X ZIP WASM call failed");
  const view = new DataView(exports.memory.buffer);
  const capacity = view.getUint32(pointer, true);
  const status = view.getUint32(pointer + 4, true);
  const payloadLength = view.getUint32(pointer + 8, true);
  const payload = new Uint8Array(exports.memory.buffer, pointer + 12, payloadLength);
  try {
    if (status !== 0) {
      throw new Error(new TextDecoder().decode(payload.slice()));
    }
    const entries: StrictMember[] = [];
    let cursor = 0;
    const entryView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = entryView.getUint32(cursor, true);
    cursor += 4;
    for (let index = 0; index < count; index += 1) {
      const nameLength = entryView.getUint32(cursor, true);
      cursor += 4;
      const name = new TextDecoder().decode(payload.subarray(cursor, cursor + nameLength));
      cursor += nameLength;
      const dataLength = Number(entryView.getBigUint64(cursor, true));
      cursor += 8;
      const bytes = payload.slice(cursor, cursor + dataLength);
      cursor += dataLength;
      entries.push({ name, bytes });
    }
    return entries;
  } finally {
    exports.oh_archive_free(pointer, capacity);
  }
}

function logicalName(name: string): string | null {
  if (name.startsWith("data/")) return name;
  const components = name.split("/");
  return components.length === 3 && components[1] === "data"
    ? components.slice(1).join("/")
    : null;
}

function membersFromStrictEntries(entries: readonly StrictMember[]): XArchiveMembers {
  const selected = new Map<string, ExtractedXArchiveMember>();
  for (const entry of entries) {
    const logical = logicalName(entry.name);
    if (logical === null) throw new Error("X ZIP selected member has an unsupported root");
    if (selected.has(logical)) {
      throw new Error("X ZIP archive contains a duplicate selected member");
    }
    selected.set(logical, { memberName: entry.name, logicalName: logical, bytes: entry.bytes });
  }
  const manifest = selected.get("data/manifest.js");
  const account = selected.get("data/account.js");
  const directMessages = selected.get("data/direct-messages.js") ?? null;
  const groupDirectMessages = selected.get("data/direct-messages-group.js") ?? null;
  if (manifest === undefined || account === undefined) {
    throw new Error("X archive must contain data/manifest.js and data/account.js");
  }
  if (directMessages === null && groupDirectMessages === null) {
    throw new Error("X archive must contain at least one direct-message member");
  }
  const allowed = new Set([
    "data/manifest.js",
    "data/account.js",
    "data/direct-messages.js",
    "data/direct-messages-group.js",
    "data/direct-message-headers.js",
    "data/direct-message-group-headers.js",
    "data/tweets.js",
    "data/deleted-tweets.js",
    "data/community-tweet.js",
  ]);
  const unsupported = [...selected.keys()].find((name) => !allowed.has(name));
  if (unsupported !== undefined) {
    throw new Error(`X archive contains an unsupported additional direct-message part: ${unsupported}`);
  }
  return {
    manifest,
    account,
    directMessages,
    groupDirectMessages,
    directMessageHeaders: selected.get("data/direct-message-headers.js") ?? null,
    groupDirectMessageHeaders: selected.get("data/direct-message-group-headers.js") ?? null,
    identityMetadata: [
      selected.get("data/tweets.js"),
      selected.get("data/deleted-tweets.js"),
      selected.get("data/community-tweet.js"),
    ].filter((member): member is ExtractedXArchiveMember => member !== undefined),
  };
}

/** Extract via the vendored strict Rust reader; throws when unavailable. */
export function extractXArchiveFileRust(descriptor: number, archiveSize: number): XArchiveMembers {
  const instance = strictWasmInstance();
  if (instance === null) throw new Error("X ZIP WASM artifact is unavailable");
  if (fstatSync(descriptor).size !== archiveSize) throw new Error("X ZIP archive changed while being read");
  const exports = instance.exports as unknown as StrictWasmExports;
  const archive = readArchive(descriptor, archiveSize);
  const options = new TextEncoder().encode(JSON.stringify({ patterns: [SELECTED_PATTERN] }));
  const archivePointer = copyIn(exports, archive);
  let optionsPointer = 0;
  try {
    optionsPointer = copyIn(exports, options);
    const resultPointer = exports.oh_archive_read_strict(
      archivePointer,
      archive.length,
      optionsPointer,
      options.length,
    );
    return membersFromStrictEntries(parseStrictResult(exports, resultPointer));
  } finally {
    exports.oh_archive_free(archivePointer, archive.length);
    if (optionsPointer !== 0) exports.oh_archive_free(optionsPointer, options.length);
  }
}

/**
 * Prefer the strict Rust reader when its vendored WASM artifact is present and
 * the archive fits in wasm32 memory; otherwise use the TypeScript reference.
 * Any Rust-side failure falls back to the reference implementation so the
 * TypeScript contract remains authoritative.
 */
export function extractXArchiveFileAuto(descriptor: number, archiveSize: number): XArchiveMembers {
  if (archiveSize <= MAX_WASM_ARCHIVE_BYTES && strictWasmInstance() !== null) {
    try {
      return extractXArchiveFileRust(descriptor, archiveSize);
    } catch {
      // The TypeScript reader performs the same validation and re-raises the
      // equivalent error for hostile archives.
    }
  }
  return extractXArchiveFile(descriptor, archiveSize);
}
