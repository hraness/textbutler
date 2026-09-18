import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractXArchiveFile,
  type ExtractedXArchiveMember,
  type XArchiveMembers,
} from "./x-archive-zip.ts";
import {
  emitXArchiveRustFallback,
  extractXArchiveFileAuto,
  extractXArchiveFileRust,
} from "./x-archive-zip-rust.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

type ZipEntry = Readonly<{ name: string; value: string }>;

function storedZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.value, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function zip64StoredZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.value, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(20, 28);
    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(0x0001, 0);
    localExtra.writeUInt16LE(16, 2);
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeBigUInt64LE(BigInt(data.length), 8);
    descriptor.writeBigUInt64LE(BigInt(data.length), 16);
    locals.push(local, name, localExtra, data, descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x032d, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(28, 30);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(0xffffffff, 42);
    const centralExtra = Buffer.alloc(28);
    centralExtra.writeUInt16LE(0x0001, 0);
    centralExtra.writeUInt16LE(24, 2);
    centralExtra.writeBigUInt64LE(BigInt(data.length), 4);
    centralExtra.writeBigUInt64LE(BigInt(data.length), 12);
    centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    centrals.push(central, name, centralExtra);
    offset += local.length + name.length + localExtra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const zip64EndOffset = offset + directory.length;
  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(0x032d, 12);
  zip64End.writeUInt16LE(45, 14);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64End.writeBigUInt64LE(BigInt(directory.length), 40);
  zip64End.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...locals, directory, zip64End, locator, end]);
}

const ARCHIVE_ENTRIES: readonly ZipEntry[] = [
  { name: "data/manifest.js", value: "window.YTD.manifest.part0 = {}" },
  { name: "data/account.js", value: "window.YTD.account.part0 = []" },
  { name: "data/direct-messages.js", value: "window.YTD.direct_messages.part0 = []" },
  { name: "data/direct-message-headers.js", value: "window.YTD.direct_message_headers.part0 = []" },
  { name: "data/tweets.js", value: "window.YTD.tweets.part0 = []" },
  { name: "assets/logo.png", value: "not selected" },
];

function archiveDescriptor(archive: Buffer): { descriptor: number; size: number } {
  const directory = mkdtempSync(join(tmpdir(), "x-archive-rust-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "archive.zip");
  writeFileSync(path, archive);
  return { descriptor: openSync(path, "r"), size: archive.length };
}

function comparable(members: XArchiveMembers): unknown {
  const encode = (member: ExtractedXArchiveMember | null) =>
    member === null ? null : {
      memberName: member.memberName,
      logicalName: member.logicalName,
      bytes: Buffer.from(member.bytes).toString("utf8"),
    };
  return {
    manifest: encode(members.manifest),
    account: encode(members.account),
    directMessages: encode(members.directMessages),
    groupDirectMessages: encode(members.groupDirectMessages),
    directMessageHeaders: encode(members.directMessageHeaders),
    groupDirectMessageHeaders: encode(members.groupDirectMessageHeaders),
    identityMetadata: members.identityMetadata.map(encode),
  };
}

describe("strict Rust X-archive reader", () => {
  test("matches the TypeScript reader on a stored archive", () => {
    const { descriptor, size } = archiveDescriptor(storedZip(ARCHIVE_ENTRIES));
    try {
      const expected = extractXArchiveFile(descriptor, size);
      const actual = extractXArchiveFileRust(descriptor, size);
      expect(comparable(actual)).toEqual(comparable(expected));
    } finally {
      // descriptor is closed by the OS when the temp directory is removed.
    }
  });

  test("matches the TypeScript reader on a ZIP64 archive with descriptors", () => {
    const { descriptor, size } = archiveDescriptor(zip64StoredZip(ARCHIVE_ENTRIES));
    const expected = extractXArchiveFile(descriptor, size);
    const actual = extractXArchiveFileRust(descriptor, size);
    expect(comparable(actual)).toEqual(comparable(expected));
  });

  test("auto path prefers Rust and returns identical members", () => {
    const { descriptor, size } = archiveDescriptor(zip64StoredZip(ARCHIVE_ENTRIES));
    const expected = extractXArchiveFile(descriptor, size);
    const actual = extractXArchiveFileAuto(descriptor, size);
    expect(comparable(actual)).toEqual(comparable(expected));
  });

  test("rejects a truncated archive like the TypeScript reader", () => {
    const full = storedZip(ARCHIVE_ENTRIES);
    const { descriptor, size } = archiveDescriptor(full.subarray(0, full.length - 4));
    expect(() => extractXArchiveFile(descriptor, size)).toThrow();
    expect(() => extractXArchiveFileRust(descriptor, size)).toThrow();
  });

  test("rejects archives missing required members like the TypeScript reader", () => {
    const { descriptor, size } = archiveDescriptor(storedZip([
      { name: "data/manifest.js", value: "{}" },
      { name: "data/account.js", value: "[]" },
    ]));
    expect(() => extractXArchiveFile(descriptor, size)).toThrow(
      "X archive must contain at least one direct-message member",
    );
    expect(() => extractXArchiveFileRust(descriptor, size)).toThrow(
      "X archive must contain at least one direct-message member",
    );
  });

  test("rejects corrupted CRC like the TypeScript reader", () => {
    const archive = Buffer.from(storedZip(ARCHIVE_ENTRIES));
    // Corrupt a byte inside the first member's data region.
    archive[30 + "data/manifest.js".length] = archive[30 + "data/manifest.js".length]! ^ 0xff;
    const { descriptor, size } = archiveDescriptor(archive);
    expect(() => extractXArchiveFile(descriptor, size)).toThrow();
    expect(() => extractXArchiveFileRust(descriptor, size)).toThrow();
  });

  test("rejects path-traversal member names like the TypeScript reader", () => {
    const { descriptor, size } = archiveDescriptor(storedZip([
      { name: "data/manifest.js", value: "{}" },
      { name: "data/account.js", value: "[]" },
      { name: "data/direct-messages.js", value: "[]" },
      { name: "data/../escape.js", value: "x" },
    ]));
    expect(() => extractXArchiveFile(descriptor, size)).toThrow();
    expect(() => extractXArchiveFileRust(descriptor, size)).toThrow();
  });

  test("fallback diagnostics are emitted once per bounded reason", () => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitXArchiveRustFallback("archive-too-large-or-no-artifact");
      emitXArchiveRustFallback("archive-too-large-or-no-artifact");
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toBe(
        "[oh-archive-rust-fallback] archive-too-large-or-no-artifact\n",
      );
    } finally {
      write.mockRestore();
    }
  });
});
