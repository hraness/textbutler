import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseClaudePriceCatalog, type ClaudePriceCatalog } from "@hraness/agentmixer";

export type GhostgetHostConfig = Readonly<{ executable: string; runtimeExecutable?: string; authId: string; stateHome?: string;
  automationAccounts?: readonly Readonly<{ provider: "imessage" | "whatsapp"; authId: string }>[] }>;
export type ProviderAccountConfig = Readonly<{ id: string; label: string }> & (
  | Readonly<{ route: "claude-api"; credentialFile: string; replyModel: string; prices: ClaudePriceCatalog; maxBudgetUsd: number }>
  | Readonly<{ route: "claude-code" | "codex" }>
);
export type HostConfig = Readonly<{ schemaVersion: 1; ghostget?: GhostgetHostConfig; providerAccounts?: readonly ProviderAccountConfig[] }>;
function invalid(): never { throw new Error("Invalid private Textbutler host configuration"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
export function parseHostConfig(value: unknown): HostConfig {
  const config = record(value);
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => !["schemaVersion", "ghostget", "providerAccounts"].includes(key))) return invalid();
  let providerAccounts: readonly ProviderAccountConfig[] | undefined;
  if (config.providerAccounts !== undefined) {
    if (!Array.isArray(config.providerAccounts) || config.providerAccounts.length > 8) return invalid();
    providerAccounts = Object.freeze(config.providerAccounts.map(parseProviderAccount));
    if (new Set(providerAccounts.map(account => account.id)).size !== providerAccounts.length) return invalid();
  }
  const common = { schemaVersion: 1 as const, ...(providerAccounts === undefined ? {} : { providerAccounts }) };
  if (config.ghostget === undefined) return Object.freeze(common);
  const ghostget = record(config.ghostget);
  if (Object.keys(ghostget).some(key => !["executable", "runtimeExecutable", "authId", "stateHome", "automationAccounts"].includes(key)) || typeof ghostget.authId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(ghostget.authId)) return invalid();
  let automationAccounts: GhostgetHostConfig["automationAccounts"];
  if (ghostget.automationAccounts !== undefined) {
    if (!Array.isArray(ghostget.automationAccounts) || ghostget.automationAccounts.length < 1 || ghostget.automationAccounts.length > 2) return invalid();
    automationAccounts = Object.freeze(ghostget.automationAccounts.map(value => {
      const account = record(value);
      if (Object.keys(account).sort().join(",") !== "authId,provider" || account.provider !== "imessage" && account.provider !== "whatsapp"
        || typeof account.authId !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(account.authId)) return invalid();
      return Object.freeze({ provider: account.provider, authId: account.authId });
    }));
    if (new Set(automationAccounts.map(account => account.provider)).size !== automationAccounts.length) return invalid();
  }
  return Object.freeze({ ...common, ghostget: Object.freeze({ executable: path(ghostget.executable), authId: ghostget.authId,
    ...(ghostget.runtimeExecutable === undefined ? {} : { runtimeExecutable: path(ghostget.runtimeExecutable) }),
    ...(ghostget.stateHome === undefined ? {} : { stateHome: path(ghostget.stateHome) }),
    ...(automationAccounts === undefined ? {} : { automationAccounts }),
  }) });
}
function parseProviderAccount(value: unknown): ProviderAccountConfig {
  const account = record(value);
  if (typeof account.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(account.id)
    || ["native-codex", "native-claude-code"].includes(account.id)
    || typeof account.label !== "string" || !account.label.trim() || account.label.length > 100 || /[\u0000-\u001f\u007f]/u.test(account.label)) return invalid();
  if (account.route === "claude-code" || account.route === "codex") {
    if (Object.keys(account).some(key => !["id", "label", "route"].includes(key))) return invalid();
    return Object.freeze({ id: account.id, label: account.label, route: account.route });
  }
  if (account.route !== "claude-api" || Object.keys(account).some(key => !["id", "label", "route", "credentialFile", "replyModel", "prices", "maxBudgetUsd"].includes(key))
    || typeof account.credentialFile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(account.credentialFile)
    || typeof account.replyModel !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(account.replyModel)) return invalid();
  const maxBudgetUsd = account.maxBudgetUsd ?? 0.25;
  if (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 5) return invalid();
  let prices: ClaudePriceCatalog;
  try {
    const price = record(account.prices);
    // Configuration parsing validates shape; readiness rejects future/stale prices.
    prices = parseClaudePriceCatalog(price, price.observedAt as number);
  } catch { return invalid(); }
  return Object.freeze({ id: account.id, label: account.label, route: "claude-api", credentialFile: account.credentialFile,
    replyModel: account.replyModel, prices, maxBudgetUsd });
}
async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (await realpath(directory) !== directory || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) invalid();
}
/** Reads only explicit owner configuration. It does not inspect accounts,
 * messages, contacts, credentials or provider permissions. Absence is disabled. */
export async function loadHostConfig(dataDirectory: string): Promise<HostConfig> {
  const root = resolve(dataDirectory), state = join(root, "state"), file = join(state, "host.json");
  await privateDirectory(root);
  try { await privateDirectory(state); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 }; throw error; }
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 }; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > 16_384) invalid();
    const bytes = Buffer.alloc(16_385); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(file);
    if (size > 16_384 || size !== before.size || before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink() || after.nlink !== 1 || after.mode !== before.mode || after.uid !== before.uid || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid();
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))); } catch { return invalid(); }
    return parseHostConfig(input);
  } finally { await handle.close(); }
}
