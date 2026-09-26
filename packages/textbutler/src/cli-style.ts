/** Hraness CLI style contract (desktop-foundation docs, SPEC § C and § D):
 * audience detection, status symbols with ASCII fallbacks, and the one-line
 * error shape. Textbutler prints no color, so NO_COLOR needs no handling here.
 * TODO(df-0.8): use detectAudience and cli-style from @hraness/desktop-foundation
 * once 0.8.0 is released. TODO(wave-b): switch to the kit. */

export type Audience = "human" | "agent" | "quiet";
type Env = Readonly<Record<string, string | undefined>>;

/** Exact names only. Prefixes such as CODEX_ also match human configuration. */
const AGENT_MARKERS = ["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI"] as const;

export function detectAudience(input: { env?: Env; stderrIsTTY?: boolean } = {}): Audience {
  const env = input.env ?? process.env;
  const forced = env.HRANESS_AUDIENCE;
  if (forced === "human" || forced === "agent" || forced === "quiet") return forced;
  if (forced === "off") return "quiet";
  if (AGENT_MARKERS.some(name => (env[name] ?? "") !== "")) return "agent";
  return (input.stderrIsTTY ?? process.stderr.isTTY === true) ? "human" : "quiet";
}

export interface Symbols { ok: string; fail: string; warn: string; next: string; on: string; off: string; skip: string; busy: string; notice: string }
const UNICODE: Symbols = { ok: "✓", fail: "✗", warn: "⚠", next: "→", on: "●", off: "○", skip: "–", busy: "↻", notice: "🔐" };
const ASCII: Symbols = { ok: "OK", fail: "FAIL", warn: "WARN", next: "->", on: "*", off: "o", skip: "-", busy: "...", notice: "NOTE" };

/** ASCII when TERM=dumb, HRANESS_ASCII=1, or no locale variable names UTF-8. */
export function symbolsFor(env: Env = process.env): Symbols {
  if (env.HRANESS_ASCII === "1" || env.TERM === "dumb") return ASCII;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/iu.test(locale) ? UNICODE : ASCII;
}

/** A usage or input error: one sentence, then exactly one next command. */
export class CliUsageError extends Error {
  constructor(message: string, readonly next: string, readonly code = "usage") { super(message); this.name = "CliUsageError"; }
}

export function renderError(message: string, next: string | undefined, symbols: Symbols): string {
  return `${symbols.fail} ${message}\n${next === undefined ? "" : `${symbols.next} ${next}\n`}`;
}

export function jsonError(code: string, message: string, next: string | undefined): string {
  return `${JSON.stringify({ ok: false, error: { code, message, ...(next === undefined ? {} : { next }) } })}\n`;
}

/** Levenshtein distance, bounded to short command words. */
function distance(a: string, b: string): number {
  if (a.length > 40 || b.length > 40) return Number.POSITIVE_INFINITY;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The closest known word within two edits, or undefined. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined, score = 3;
  for (const candidate of candidates) { const value = distance(input.toLowerCase(), candidate); if (value < score) { best = candidate; score = value; } }
  return best;
}

/** Terminal-safe single-line echo of user input inside an error. */
export function quoteInput(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, "").slice(0, 60));
}
