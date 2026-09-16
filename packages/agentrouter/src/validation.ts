export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_OBJECT");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("UNKNOWN_FIELD");
  return record;
}

export function boundedText(value: unknown, maxBytes: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.trim().length === 0)
    || value.includes("\0") || new TextEncoder().encode(value).byteLength > maxBytes) throw new Error("INVALID_TEXT");
  return value;
}

export function identifier(value: unknown): string {
  const text = boundedText(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(text)) throw new Error("INVALID_IDENTIFIER");
  return text;
}

export function safeInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("INVALID_INTEGER");
  return value;
}

export type AgentProvider = "codex" | "claude";
export function provider(value: unknown): AgentProvider {
  if (value !== "codex" && value !== "claude") throw new Error("UNSUPPORTED_PROVIDER");
  return value;
}
