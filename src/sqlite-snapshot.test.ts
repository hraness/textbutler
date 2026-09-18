import { Database } from "bun:sqlite";
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateSource as isolateMessageSourceTs, type SourceFile as MessageSourceFile } from "./imessage.ts";
import { isolateSource as isolateContactsSourceTs, type SourceFile as ContactsSourceFile } from "./contacts.ts";
import { isolateContactsSource, isolateMessageSource } from "./sqlite-snapshot.ts";

function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "textbutler-sqlite-snapshot-test-"));
}

function createSqliteFile(path: string): void {
  const database = new Database(path);
  try {
    database.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
  } finally {
    database.close();
  }
}

function messageSourceFile(path: string): MessageSourceFile {
  return Object.freeze({ path, stats: lstatSync(path, { bigint: true }) });
}

function contactsSourceFile(key: string, path: string): ContactsSourceFile {
  return Object.freeze({ key, path, stats: lstatSync(path, { bigint: true }) });
}

describe("sqlite-snapshot wrapper parity", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = makeTempDirectory();
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  test("message source wrapper matches TypeScript fallback for a plain database", () => {
    const sourcePath = join(tempDirectory, "chat.db");
    createSqliteFile(sourcePath);

    const source = messageSourceFile(sourcePath);
    const wrapperResult = isolateMessageSource(source, 64 * 1024 * 1024);
    const fallbackResult = isolateMessageSourceTs(source, 64 * 1024 * 1024);

    expect(basename(wrapperResult.path)).toBe("chat.db");
    expect(basename(fallbackResult.path)).toBe("chat.db");
    expect(lstatSync(wrapperResult.path).size).toBe(lstatSync(sourcePath).size);
    expect(lstatSync(fallbackResult.path).size).toBe(lstatSync(sourcePath).size);

    rmSync(wrapperResult.temporaryDirectory, { recursive: true, force: true });
    rmSync(fallbackResult.temporaryDirectory, { recursive: true, force: true });
  });

  test("message source wrapper matches TypeScript fallback for a WAL database", () => {
    const sourcePath = join(tempDirectory, "chat.db");
    createSqliteFile(sourcePath);
    // The isolation contract copies the WAL sidecar if present; create a bounded one manually.
    writeFileSync(`${sourcePath}-wal`, Buffer.from("wal bytes"));
    expect(lstatSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);

    const source = messageSourceFile(sourcePath);
    const wrapperResult = isolateMessageSource(source, 64 * 1024 * 1024);
    const fallbackResult = isolateMessageSourceTs(source, 64 * 1024 * 1024);

    expect(lstatSync(`${wrapperResult.path}-wal`).size).toBe(lstatSync(`${sourcePath}-wal`).size);
    expect(lstatSync(`${fallbackResult.path}-wal`).size).toBe(lstatSync(`${sourcePath}-wal`).size);

    rmSync(wrapperResult.temporaryDirectory, { recursive: true, force: true });
    rmSync(fallbackResult.temporaryDirectory, { recursive: true, force: true });
  });

  test("contacts source wrapper matches TypeScript fallback for a plain database", () => {
    const sourcePath = join(tempDirectory, "AddressBook-v1.abcddb");
    createSqliteFile(sourcePath);

    const source = contactsSourceFile("test", sourcePath);
    const wrapperResult = isolateContactsSource(source, 64 * 1024 * 1024);
    const fallbackResult = isolateContactsSourceTs(source, 64 * 1024 * 1024);

    expect(basename(wrapperResult.path)).toBe("AddressBook-v1.abcddb");
    expect(basename(fallbackResult.path)).toBe("AddressBook-v1.abcddb");
    expect(lstatSync(wrapperResult.path).size).toBe(lstatSync(sourcePath).size);
    expect(lstatSync(fallbackResult.path).size).toBe(lstatSync(sourcePath).size);

    rmSync(wrapperResult.temporaryDirectory, { recursive: true, force: true });
    rmSync(fallbackResult.temporaryDirectory, { recursive: true, force: true });
  });

  test("wrapper falls back to TypeScript when the sidecar binary path is missing", () => {
    const previousPath = process.env.HRANESS_OH_SQLITE_CLI_PATH;
    const previousTmpdir = process.env.TMPDIR;
    process.env.HRANESS_OH_SQLITE_CLI_PATH = join(tempDirectory, "no-such-sidecar");
    process.env.TMPDIR = tempDirectory;
    try {
      const sourcePath = join(tempDirectory, "chat.db");
      createSqliteFile(sourcePath);

      const source = messageSourceFile(sourcePath);
      const wrapperResult = isolateMessageSource(source, 64 * 1024 * 1024);
      expect(lstatSync(wrapperResult.path).size).toBe(lstatSync(sourcePath).size);
      expect(readdirSync(tempDirectory).filter(name => name.startsWith("textbutler-sqlite-snapshot-"))).toEqual([]);
      rmSync(wrapperResult.temporaryDirectory, { recursive: true, force: true });
    } finally {
      if (previousPath === undefined) {
        delete process.env.HRANESS_OH_SQLITE_CLI_PATH;
      } else {
        process.env.HRANESS_OH_SQLITE_CLI_PATH = previousPath;
      }
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
    }
  });
});
