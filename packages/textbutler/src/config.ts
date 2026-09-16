export type Provider = "codex" | "claude";
export type ReplyMode = "smart" | "keyword";
export type Disclosure = Readonly<{ character: string; begin: string; end: string }>;
export type ContactSettings = Readonly<{
  id: string;
  label: string;
  routeId: string;
  enabled: boolean;
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
export function newContact(id: string, label: string, routeId: string): ContactSettings {
  return parseContact({ id, label, routeId, enabled: false, mode: "smart", keyword: "butler", provider: "codex", accountId: "default", replyModel: null, classifierModel: null, disclosure: DEFAULT_DISCLOSURE, revision: 1, pausedUntil: 0, humanCooldownMs: 300_000, debounceMs: 8_000, maxRepliesPerHour: 12 });
}
export function parseContact(value: unknown): ContactSettings {
  const input = record(value);
  const id = string(input.id, "contact id", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new Error("Contact id must be an opaque path-safe identifier");
  if (typeof input.enabled !== "boolean") throw new Error("Invalid enabled flag");
  if (input.mode !== "smart" && input.mode !== "keyword") throw new Error("Invalid reply mode");
  if (input.provider !== "codex" && input.provider !== "claude") throw new Error("Invalid provider");
  return Object.freeze({
    id, label: string(input.label, "label"), routeId: string(input.routeId, "route id", 512), enabled: input.enabled,
    mode: input.mode, keyword: string(input.keyword, "keyword", 40).trim(), provider: input.provider,
    accountId: string(input.accountId, "account id", 100),
    replyModel: input.replyModel === null ? null : string(input.replyModel, "reply model", 100),
    classifierModel: input.classifierModel === null ? null : string(input.classifierModel, "classifier model", 100),
    disclosure: parseDisclosure(input.disclosure), revision: integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    pausedUntil: integer(input.pausedUntil, "pause", 0, Number.MAX_SAFE_INTEGER),
    humanCooldownMs: integer(input.humanCooldownMs, "human cooldown", 30_000, 86_400_000),
    debounceMs: integer(input.debounceMs, "debounce", 1_000, 120_000),
    maxRepliesPerHour: integer(input.maxRepliesPerHour, "reply limit", 1, 120),
  });
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
