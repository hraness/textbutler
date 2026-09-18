import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  isolateSource as isolateContactsSourceTs,
  type IsolatedSource,
  type SourceFile as ContactsSourceFile,
} from "./contacts.ts";
import {
  isolateSource as isolateMessageSourceTs,
  type SourceFile as MessageSourceFile,
  type SourceSnapshot,
} from "./imessage.ts";

const OH_SQLITE_SNAPSHOT_MODULE = "@hraness/oh/sqlite-snapshot";
const require = createRequire(import.meta.url);

type OhLoader = Readonly<{
  snapshotDatabaseSync: (options: {
    sourcePath: string;
    outputDirectory: string;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  }) => {
    databasePath: string;
    walPath: string | null;
    journalPath: string | null;
    totalBytes: number;
  };
  SnapshotSidecarNotFoundError: { new (...args: unknown[]): Error };
}>;

function loadOhLoader(): OhLoader | null {
  try {
    const mod = require(OH_SQLITE_SNAPSHOT_MODULE) as Partial<OhLoader>;
    if (typeof mod.snapshotDatabaseSync !== "function") return null;
    return mod as OhLoader;
  } catch {
    return null;
  }
}

function isSidecarMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "SnapshotSidecarNotFoundError";
}

function temporaryDirectory(): string {
  const root = tmpdir();
  if (!isAbsolute(root)) throw new Error("temporary directory must be absolute");
  return mkdtempSync(join(root, "textbutler-sqlite-snapshot-"));
}

/**
 * iMessage SQLite snapshot isolation wrapper. Tries the Rust sidecar from
 * @hraness/oh/sqlite-snapshot and falls back to the original TypeScript
 * isolation if the sidecar binary is unavailable for the current platform.
 */
export function isolateMessageSource(source: MessageSourceFile, maximumBytes: number): SourceSnapshot {
  const loader = loadOhLoader();
  if (loader === null) {
    return isolateMessageSourceTs(source, maximumBytes);
  }

  const outputDirectory = temporaryDirectory();
  try {
    const snapshot = loader.snapshotDatabaseSync({
      sourcePath: source.path,
      outputDirectory,
      maxFileBytes: maximumBytes,
      maxTotalBytes: maximumBytes * 2,
    });
    return Object.freeze({
      source,
      path: snapshot.databasePath,
      temporaryDirectory: outputDirectory,
    });
  } catch (error) {
    if (isSidecarMissingError(error)) {
      return isolateMessageSourceTs(source, maximumBytes);
    }
    throw error;
  }
}

/**
 * Contacts (AddressBook) SQLite snapshot isolation wrapper. Tries the Rust
 * sidecar from @hraness/oh/sqlite-snapshot and falls back to the original
 * TypeScript isolation if the sidecar binary is unavailable.
 */
export function isolateContactsSource(source: ContactsSourceFile, maximumBytes: number): IsolatedSource {
  const loader = loadOhLoader();
  if (loader === null) {
    return isolateContactsSourceTs(source, maximumBytes);
  }

  const outputDirectory = temporaryDirectory();
  try {
    const snapshot = loader.snapshotDatabaseSync({
      sourcePath: source.path,
      outputDirectory,
      maxFileBytes: maximumBytes,
      maxTotalBytes: maximumBytes * 2,
    });
    return Object.freeze({
      source,
      path: snapshot.databasePath,
      temporaryDirectory: outputDirectory,
    });
  } catch (error) {
    if (isSidecarMissingError(error)) {
      return isolateContactsSourceTs(source, maximumBytes);
    }
    throw error;
  }
}
