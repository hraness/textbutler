import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createManagedCodexAccountController, type CodexAccountTransport, type CodexManagedLoginMethod } from "@hraness/agentmixer";
import { createCodexAccountStdioTransport, type CodexAccountProcessPort } from "@hraness/agentmixer";
import { createCodexAccountProcess, type CodexAccountDeviceCodeAdmission, type CodexAccountProcessOptions, type CodexAccountRuntimeAdmission } from "@hraness/agentmixer";
import { identifier } from "@hraness/agentmixer";
import type { ManagedCodexAccountFactory } from "./provider-host.ts";

export type ManagedCodexFactoryOptions = Readonly<{
  runtime: CodexAccountRuntimeAdmission; deviceCodeAdmission: CodexAccountDeviceCodeAdmission;
}>;
/** Internal trusted test/host seam, never owner configuration or an agent tool.
 * It must return custody synchronously, including while launch is pending. */
export type ManagedCodexProcessFactory = (options: CodexAccountProcessOptions) => CodexAccountProcessPort;

function invalid(): never { throw new Error("TEXTBUTLER_MANAGED_CODEX_ADMISSION_INVALID"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid();
    copied[key] = descriptor.value;
  }
  return copied;
}
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return invalid(); return value; }
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f"\\]/u.test(value)) return invalid();
  return value;
}
function privateDirectory(value: string): void {
  const before = lstatSync(value);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o700 || realpathSync(value) !== value) throw new Error("TEXTBUTLER_MANAGED_CODEX_PRIVATE_DIRECTORY_REQUIRED");
  const fd = openSync(value, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), current = lstatSync(value);
    if (opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode || current.uid !== before.uid) throw new Error("TEXTBUTLER_MANAGED_CODEX_DIRECTORY_CHANGED");
  } finally { closeSync(fd); }
}
function childDirectory(parent: string, name: string): string {
  privateDirectory(parent); const child = join(parent, name);
  try {
    mkdirSync(child, { mode: 0o700 });
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  privateDirectory(parent); privateDirectory(child); return child;
}

/** Opt-in composition only. Importing or constructing the factory performs no
 * filesystem, provider, process or account operations. Trusted distribution pins
 * are copied here; a matching object is not provenance or live qualification.
 * Callers provide the host data directory, never a contact directory or JSON
 * runtime settings. This factory does not register an agent execution adapter. */
export function createManagedCodexAccountFactory(options: ManagedCodexFactoryOptions, processFactory: ManagedCodexProcessFactory = createCodexAccountProcess): ManagedCodexAccountFactory {
  const supplied = record(options, ["runtime", "deviceCodeAdmission"]);
  const raw = record(supplied.runtime, ["executablePath", "version", "sha256", "schemaSha256", "parentRuntime"]);
  const parent = record(raw.parentRuntime, ["expectedSha256"]), network = record(supplied.deviceCodeAdmission, ["profile", "nativeSha256", "schemaSha256", "parentSha256"]);
  const runtime: CodexAccountRuntimeAdmission = Object.freeze({ executablePath: path(raw.executablePath), version: identifier(raw.version), sha256: digest(raw.sha256), schemaSha256: digest(raw.schemaSha256),
    parentRuntime: Object.freeze({ expectedSha256: digest(parent.expectedSha256) }) });
  if (network.profile !== "codex-account-device-code-tcp443-dns-v1" && network.profile !== "codex-account-device-code-tcp443-dns-v2") return invalid();
  const deviceCodeAdmission: CodexAccountDeviceCodeAdmission = Object.freeze({ profile: network.profile, nativeSha256: digest(network.nativeSha256), schemaSha256: digest(network.schemaSha256), parentSha256: digest(network.parentSha256) });
  if (deviceCodeAdmission.nativeSha256 !== runtime.sha256 || deviceCodeAdmission.schemaSha256 !== runtime.schemaSha256 || deviceCodeAdmission.parentSha256 !== runtime.parentRuntime.expectedSha256 || typeof processFactory !== "function") return invalid();
  let generation = 0;
  return input => {
    const supplied = record(input, ["accountId", "dataDir", "leases"]), accountId = identifier(supplied.accountId), dataDir = path(supplied.dataDir);
    privateDirectory(dataDir);
    const stateRoot = childDirectory(childDirectory(dataDir, "state"), "codex-accounts");
    if (!Number.isSafeInteger(generation + 1)) throw new Error("TEXTBUTLER_MANAGED_CODEX_GENERATION_EXHAUSTED");
    const processGeneration = ++generation, owner = `textbutler-account-${randomBytes(16).toString("hex")}`;
    const controller = createManagedCodexAccountController({ accountId, owner, processGeneration, leases: input.leases,
      transportFactory(binding, onEvent) {
        const process = processFactory(Object.freeze({ binding, stateRoot, runtime, mode: "device-code", deviceCodeAdmission }));
        try { return createCodexAccountStdioTransport({ binding, process, onEvent }); }
        catch {
          // Retain a returned process even if its port fails protocol setup.
          // Its identity/started work is uncertain: attempt cleanup, but never
          // invent protocol-join proof or release this controller's lease.
          const unavailable = async (): Promise<never> => { throw new Error("TEXTBUTLER_MANAGED_CODEX_TRANSPORT_UNAVAILABLE"); };
          return Object.freeze({ accountRead: unavailable, startLogin: unavailable, cancelLogin: unavailable, logout: unavailable, listModels: unavailable,
            async close(request) { try { await process.stopAndJoin(request); } catch {}
              return Object.freeze({ binding, processExited: false, processGroupStopped: false, stdoutEnded: false, stderrEnded: false, writesSettled: false, requestsSettled: false, notificationsSettled: false }); },
          } satisfies CodexAccountTransport);
        }
      },
    });
    return Object.freeze({ ...controller, startLogin(method: CodexManagedLoginMethod, signal?: AbortSignal) {
      if (method !== "chatgptDeviceCode") return Promise.reject(new Error("TEXTBUTLER_CODEX_DEVICE_CODE_REQUIRED"));
      return controller.startLogin(method, signal);
    } });
  };
}
