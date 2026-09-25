import { isAbsolute, join, resolve } from "node:path";
import { assertOwnedPath, readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { parseClaudePriceCatalog, type ClaudePriceCatalog } from "@hraness/agentmixer";
import { parseFastDriverConfig, type FastDriverConfig } from "./fast-driver.ts";

export type GhostgetHostConfig = Readonly<{ executable: string; runtimeExecutable?: string; authId: string; stateHome?: string;
  automationAccounts?: readonly Readonly<{ provider: "imessage" | "whatsapp" | "beeper"; authId: string }>[] }>;
export type XcbHostConfig = Readonly<{ executable: string; stateHome: string; sha256: string;
  accounts: readonly Readonly<{ provider: XcbProvider; accountId: string; model: string }>[] }>;
/** Subscription providers XCB can drive through its application route. */
export type XcbProvider = "claude" | "codex" | "devin";
export const XCB_PROVIDERS: readonly XcbProvider[] = Object.freeze(["claude", "codex", "devin"]);
export type ProviderAccountConfig = Readonly<{ id: string; label: string }> & (
  | Readonly<{ route: "claude-api"; credentialFile: string; replyModel: string; prices: ClaudePriceCatalog; maxBudgetUsd: number }>
  | Readonly<{ route: "claude-code" | "codex" | "devin" }>
);
export type HabitatHostConfig = Readonly<{ enabled: boolean; driver: FastDriverConfig; evolutionModel: string | null; debounceMs: number }>;
export type HostConfig = Readonly<{ schemaVersion: 1; ghostget?: GhostgetHostConfig; xcb?: XcbHostConfig; providerAccounts?: readonly ProviderAccountConfig[]; habitat?: HabitatHostConfig }>;
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
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => !["schemaVersion", "ghostget", "xcb", "providerAccounts", "habitat"].includes(key))) return invalid();
  let providerAccounts: readonly ProviderAccountConfig[] | undefined;
  if (config.providerAccounts !== undefined) {
    if (!Array.isArray(config.providerAccounts) || config.providerAccounts.length > 8) return invalid();
    providerAccounts = Object.freeze(config.providerAccounts.map(parseProviderAccount));
    if (new Set(providerAccounts.map(account => account.id)).size !== providerAccounts.length) return invalid();
  }
  let habitat: HabitatHostConfig | undefined;
  if (config.habitat !== undefined) {
    const value = record(config.habitat);
    if (Object.keys(value).sort().join(",") !== "debounceMs,driver,enabled,evolutionModel" || typeof value.enabled !== "boolean"
      || !Number.isSafeInteger(value.debounceMs) || (value.debounceMs as number) < 1000 || (value.debounceMs as number) > 8000
      || value.evolutionModel !== null && (typeof value.evolutionModel !== "string" || !/^claude\/[A-Za-z0-9_.-]{1,80}(?:\/[A-Za-z0-9_.-]{1,40})?$/u.test(value.evolutionModel))) return invalid();
    try { habitat = Object.freeze({ enabled: value.enabled, driver: parseFastDriverConfig(value.driver), evolutionModel: value.evolutionModel as string | null, debounceMs: value.debounceMs as number }); } catch { return invalid(); }
  }
  const common = { schemaVersion: 1 as const, ...(providerAccounts === undefined ? {} : { providerAccounts }),
    ...(habitat === undefined ? {} : { habitat }), ...(config.xcb === undefined ? {} : { xcb: parseXcbConfig(config.xcb) }) };
  if (config.ghostget === undefined) return Object.freeze(common);
  const ghostget = record(config.ghostget);
  if (Object.keys(ghostget).some(key => !["executable", "runtimeExecutable", "authId", "stateHome", "automationAccounts"].includes(key)) || typeof ghostget.authId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(ghostget.authId)) return invalid();
  let automationAccounts: GhostgetHostConfig["automationAccounts"];
  if (ghostget.automationAccounts !== undefined) {
    if (!Array.isArray(ghostget.automationAccounts) || ghostget.automationAccounts.length < 1 || ghostget.automationAccounts.length > 3) return invalid();
    automationAccounts = Object.freeze(ghostget.automationAccounts.map(value => {
      const account = record(value);
      if (Object.keys(account).sort().join(",") !== "authId,provider" || account.provider !== "imessage" && account.provider !== "whatsapp" && account.provider !== "beeper"
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
function parseXcbConfig(value: unknown): XcbHostConfig {
  const xcb = record(value);
  if (Object.keys(xcb).sort().join(",") !== "accounts,executable,sha256,stateHome"
    || typeof xcb.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(xcb.sha256)
    || !Array.isArray(xcb.accounts) || xcb.accounts.length < 1 || xcb.accounts.length > XCB_PROVIDERS.length) return invalid();
  const accounts = Object.freeze(xcb.accounts.map(value => {
    const account = record(value);
    if (Object.keys(account).sort().join(",") !== "accountId,model,provider"
      || typeof account.provider !== "string" || !(XCB_PROVIDERS as readonly string[]).includes(account.provider)
      || typeof account.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.\[\]-]{0,159}$/u.test(account.accountId)
      || typeof account.model !== "string" || !/^(?:claude|codex|devin)\/[A-Za-z0-9][A-Za-z0-9_.\[\]-]{0,159}(?:\/[A-Za-z0-9][A-Za-z0-9_.\[\]-]{0,159})?$/u.test(account.model)
      || !account.model.startsWith(`${account.provider}/`)) return invalid();
    return Object.freeze({ provider: account.provider as XcbProvider, accountId: account.accountId, model: account.model });
  }));
  if (new Set(accounts.map(account => account.provider)).size !== accounts.length) return invalid();
  return Object.freeze({ executable: path(xcb.executable), stateHome: path(xcb.stateHome), sha256: xcb.sha256, accounts });
}
function parseProviderAccount(value: unknown): ProviderAccountConfig {
  const account = record(value);
  if (typeof account.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(account.id)
    || ["native-codex", "native-claude-code", "native-devin"].includes(account.id)
    || typeof account.label !== "string" || !account.label.trim() || account.label.length > 100 || /[\u0000-\u001f\u007f]/u.test(account.label)) return invalid();
  if (account.route === "claude-code" || account.route === "codex" || account.route === "devin") {
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
  try {
    await assertOwnedPath(directory, { kind: "directory", canonical: true, ownerOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    invalid();
  }
}
/** Reads only explicit owner configuration. It does not inspect accounts,
 * messages, contacts, credentials or provider permissions. Absence is disabled. */
export async function loadHostConfig(dataDirectory: string): Promise<HostConfig> {
  const root = resolve(dataDirectory), state = join(root, "state"), file = join(state, "host.json");
  await privateDirectory(root);
  try { await privateDirectory(state); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 }; throw error; }
  let bytes: Buffer;
  try { bytes = await readOwnedFileStable(file, 16_384); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
    invalid();
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
  return parseHostConfig(input);
}
