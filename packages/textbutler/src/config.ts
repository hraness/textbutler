export type Provider = "codex" | "claude" | "devin";
export type ReplyMode = "smart" | "keyword";
export type Disclosure = Readonly<{ character: string; begin: string; end: string }>;
export type ContactSettings = Readonly<{
  id: string;
  label: string;
  routeId: string;
  enabled: boolean;
  /** The owner marked this conversation as their own address: every outgoing
   * row echoes back inbound, so echoes are not an owner answer. */
  selfChat: boolean;
  mode: ReplyMode;
  keyword: string;
  provider: Provider;
  accountId: string;
  replyModel: string | null;
  classifierModel: string | null;
  disclosure: Disclosure;
  revision: number;
  pausedUntil: number;
  humanCooldownMs: number;
  debounceMs: number;
  maxRepliesPerHour: number;
  /** Owner-approved public repository URLs this contact's agent may sync and
   * inspect. Approval is recorded through the owner's self-chat channel. */
  repos: readonly string[];
}>;
export type Settings = Readonly<{
  schemaVersion: 1;
  paused: boolean;
  maxActiveContacts: number;
  contacts: readonly ContactSettings[];
}>;

export const DEFAULT_DISCLOSURE: Disclosure = Object.freeze({ character: "🤖", begin: "{", end: "}" });
export const DEFAULT_ACTIVE_LIMIT = 5;
export const MAX_ACTIVE_LIMIT = 50;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}
function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}`);
  return value;
}
/** Each field is either empty (cleared) or exactly one visible grapheme. */
function marker(value: unknown, field: string): string {
  if (value === "") return "";
  const symbol = string(value, field, 16);
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  if ([...segments.segment(symbol)].length !== 1 || /[\p{White_Space}\p{Bidi_Control}]/u.test(symbol) || /^[\p{Default_Ignorable_Code_Point}\p{Mark}]+$/u.test(symbol)) throw new Error("Disclosure fields must be empty or one visible symbol");
  return symbol;
}
export function parseDisclosure(value: unknown): Disclosure {
  const input = record(value);
  return Object.freeze({ character: marker(input.character, "character"), begin: marker(input.begin, "begin"), end: marker(input.end, "end") });
}
/** The wrap a message carries, or null when every disclosure field is cleared. */
export function disclosureMarkers(symbols: Disclosure): Readonly<{ prefix: string; suffix: string }> | null {
  const parsed = parseDisclosure(symbols);
  const left = `${parsed.character}${parsed.begin}`;
  if (!left && !parsed.end) return null;
  return Object.freeze({ prefix: left ? `${left} ` : "", suffix: parsed.end ? ` ${parsed.end}` : "" });
}
export function disclose(text: string, symbols: Disclosure = DEFAULT_DISCLOSURE): string {
  const markers = disclosureMarkers(symbols);
  if (!text.trim() || Buffer.byteLength(text) > 16_384 || /\u0000/u.test(text)) throw new Error("Invalid response text");
  const trimmed = text.trim();
  return markers === null ? trimmed : `${markers.prefix}${trimmed}${markers.suffix}`;
}
/** True only when the text carries this disclosure's complete configured wrap. */
export function disclosedText(text: string, symbols: Disclosure): boolean {
  const markers = disclosureMarkers(symbols);
  return markers !== null && text.startsWith(markers.prefix) && text.endsWith(markers.suffix) && text.length > markers.prefix.length + markers.suffix.length;
}
/** A repository the agent may request is an ordinary HTTPS git remote: no
 * embedded credentials, no non-default ports, and a path that cannot escape or
 * smuggle scheme-relative or backslash forms. Returns the normalized URL. */
export function parseRepoUrl(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > 256 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  // Reject inputs the URL parser would silently rewrite: query, fragment and
  // dot segments must not turn one requested repo into a different stored URL.
  if (value.includes("?") || value.includes("#")) return null;
  const marker = value.indexOf("://"), slash = marker === -1 ? -1 : value.indexOf("/", marker + 3);
  if (slash !== -1 && value.slice(slash).split("/").some(part => part === "." || part === "..")) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")
    || !parsed.hostname || parsed.hostname.length > 253 || parsed.hostname.split(".").some(label => !label)
    || !/^[\w.~-]+(?:\.[\w.~-]+)*$/u.test(parsed.hostname)) return null;
  // A "public repository" names a DNS host: reject IP literals in every
  // normalized form, single-label intranet names, and local-domain suffixes so
  // an approved URL cannot point at a loopback, LAN, or link-local endpoint.
  if (!parsed.hostname.includes(".") || parsed.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/u.test(parsed.hostname)
    || /\.(?:local|localhost|internal|lan|corp|home\.arpa|test|example|invalid)$/iu.test(parsed.hostname)) return null;
  const path = parsed.pathname;
  if (path.length < 2 || path.length > 200 || !/^\/[\w./~+-]+$/u.test(path) || path.split("/").some(part => part === "." || part === "..")) return null;
  return `https://${parsed.hostname}${path}`;
}
/** The checkout name is the final URL segment without its .git suffix. */
export function repoName(url: string): string | null {
  const base = url.split("/").at(-1)?.replace(/\.git$/u, "") ?? "";
  return /^[\w][\w.-]{0,79}$/u.test(base) ? base : null;
}
export function newContact(id: string, label: string, routeId: string): ContactSettings {
  return parseContact({ id, label, routeId, enabled: false, selfChat: false, mode: "keyword", keyword: "butler", provider: "codex", accountId: "default", replyModel: null, classifierModel: null, disclosure: DEFAULT_DISCLOSURE, revision: 1, pausedUntil: 0, humanCooldownMs: 300_000, debounceMs: 8_000, maxRepliesPerHour: 12, repos: [] });
}
export function parseContact(value: unknown): ContactSettings {
  const input = record(value);
  const id = string(input.id, "contact id", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("Contact id must be an opaque path-safe identifier");
  if (typeof input.enabled !== "boolean") throw new Error("Invalid enabled flag");
  if (input.selfChat !== undefined && typeof input.selfChat !== "boolean") throw new Error("Invalid self conversation flag");
  if (input.mode !== "smart" && input.mode !== "keyword") throw new Error("Invalid reply mode");
  if (input.provider !== "codex" && input.provider !== "claude" && input.provider !== "devin") throw new Error("Invalid provider");
  const disclosure = parseDisclosure(input.disclosure);
  // A cleared wrap leaves a self chat unable to tell its own inbound reply
  // echoes from new owner text, which could answer itself forever.
  if (input.selfChat === true && disclosureMarkers(disclosure) === null) throw new Error("A self conversation keeps a visible butler wrap");
  return Object.freeze({
    id, label: string(input.label, "label"), routeId: string(input.routeId, "route id", 512), enabled: input.enabled,
    selfChat: input.selfChat === true,
    mode: input.mode, keyword: string(input.keyword, "keyword", 40).trim(), provider: input.provider,
    accountId: string(input.accountId, "account id", 100),
    replyModel: input.replyModel === null ? null : string(input.replyModel, "reply model", 100),
    classifierModel: input.classifierModel === null ? null : string(input.classifierModel, "classifier model", 100),
    disclosure, revision: integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    pausedUntil: integer(input.pausedUntil, "pause", 0, Number.MAX_SAFE_INTEGER),
    humanCooldownMs: integer(input.humanCooldownMs, "human cooldown", 30_000, 86_400_000),
    debounceMs: integer(input.debounceMs, "debounce", 1_000, 120_000),
    maxRepliesPerHour: integer(input.maxRepliesPerHour, "reply limit", 1, 120),
    repos: Object.freeze(parseRepos(input.repos)),
  });
}
function parseRepos(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid contact repo allowlist");
  const repos = value.map(entry => parseRepoUrl(entry));
  if (repos.some(entry => entry === null) || new Set(repos).size !== repos.length) throw new Error("Invalid contact repo allowlist");
  return repos as string[];
}
export function parseSettings(value: unknown): Settings {
  const input = record(value);
  if (input.schemaVersion !== 1 || typeof input.paused !== "boolean" || !Array.isArray(input.contacts) || input.contacts.length > 10_000) throw new Error("Invalid settings");
  const contacts = input.contacts.map(parseContact);
  const maxActiveContacts = integer(input.maxActiveContacts, "active contact limit", 1, MAX_ACTIVE_LIMIT);
  if (contacts.filter(c => c.enabled).length > maxActiveContacts) throw new Error("Active contact limit reached");
  if (new Set(contacts.map(c => c.id)).size !== contacts.length || new Set(contacts.map(c => c.routeId)).size !== contacts.length) throw new Error("Duplicate contact or conversation route");
  return Object.freeze({ schemaVersion: 1, paused: input.paused, maxActiveContacts, contacts: Object.freeze(contacts) });
}
export function configureContact(settings: Settings, id: string, patch: Partial<Omit<ContactSettings, "id" | "revision">>): Settings {
  if (!settings.contacts.some(c => c.id === id)) throw new Error("Unknown contact");
  return parseSettings({ ...settings, contacts: settings.contacts.map(c => c.id === id ? { ...c, ...patch, id: c.id, revision: c.revision + 1 } : c) });
}
