/** macOS permission notices and recovery copy for Textbutler.
 *
 * The strings follow the desktop-foundation permissions kit templates
 * (docs/permissions.md, "Copy templates") word for word, so every Hraness
 * product reads the same. The kit ships in @hraness/desktop-foundation 0.8.0.
 * TODO(df-0.8): use renderPrePrompt/renderRecovery/permissionError from the kit.
 * TODO(wave-b): switch to the kit once Textbutler depends on 0.8.0, and delete
 * this file.
 *
 * Nothing here triggers a macOS prompt. Opening System Settings happens only
 * for an explicit owner keypress, and only for the allowlisted URLs below. */
import type { Symbols } from "./cli-style.ts";

export type TextbutlerPermissionKind = "full-disk-access" | "automation";

interface KindInfo { behavior: "asks" | "settings-only"; pane: string; path: string; settingsUrl: string }
const KINDS: Record<TextbutlerPermissionKind, KindInfo> = {
  "full-disk-access": { behavior: "settings-only", pane: "Full Disk Access", path: "System Settings › Privacy & Security › Full Disk Access",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" },
  automation: { behavior: "asks", pane: "Automation", path: "System Settings › Privacy & Security › Automation",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" },
};

export const settingsUrl = (kind: TextbutlerPermissionKind): string => KINDS[kind].settingsUrl;
export const settingsPath = (kind: TextbutlerPermissionKind): string => KINDS[kind].path;
/** The only URLs Textbutler ever hands to /usr/bin/open for System Settings. */
export const SETTINGS_URLS: readonly string[] = Object.values(KINDS).map(kind => kind.settingsUrl);

export interface PermissionNeed {
  kind: TextbutlerPermissionKind;
  /** Verb phrase after "let X", without a final period. */
  ask: string;
  /** One sentence ending with a period. */
  why: string;
  /** The name macOS shows in its dialog and in System Settings. */
  requester: string;
  product: string;
  next: string;
}

/** iMessage runs only through the local Textbutler app, whose display name is
 * "Textbutler", so it is the requester for both kinds. */
const REF = { product: "Textbutler", requester: "Textbutler", next: "textbutler doctor" } as const;

/** MESSAGES_FDA preset. */
export const MESSAGES_FDA: PermissionNeed = { ...REF, kind: "full-disk-access", ask: "read your Messages", why: "Only the chats you pick are read." };
/** AUTOMATION(ref, "Messages", why) preset. */
export const MESSAGES_AUTOMATION: PermissionNeed = { ...REF, kind: "automation", ask: "control Messages", why: "Textbutler only sends replies in chats you turn on." };

const forProduct = (need: PermissionNeed): string => need.requester === need.product ? "" : ` for ${need.product}`;

export interface RenderedNotice { lines: string[]; confirm?: string }

/** The notice shown before a prompt (asks) or before sending the owner to
 * Settings (settings-only). `interactive` adds the confirm line; it is true
 * only when stdin and stderr are both terminals. */
export function renderPrePrompt(need: PermissionNeed, interactive: boolean): RenderedNotice {
  const info = KINDS[need.kind];
  if (info.behavior === "settings-only") return {
    lines: [`${need.product} needs ${info.pane} to ${need.ask}.`, `macOS doesn't ask for this. Turn on ${need.requester} in ${info.path}. ${need.why}`],
    ...(interactive ? { confirm: "Press Enter to open Settings · s to skip" } : {}) };
  return {
    lines: [`macOS will ask to let ${need.requester} ${need.ask}${forProduct(need)}.`, `${need.why} Change this any time in ${info.path}.`],
    ...(interactive ? { confirm: "Press Enter to continue · s to skip" } : {}) };
}

/** Recovery after a denial, or when access can't be confirmed. */
export function renderRecovery(need: PermissionNeed, state: "denied" | "unknown", interactive: boolean): { headline: string; detail: string; next: string } {
  const info = KINDS[need.kind];
  if (state === "denied") return { headline: `${need.product} can't ${need.ask}: macOS access is off for ${need.requester}.`, detail: `Turn on ${need.requester} in ${info.path}.`,
    next: `${need.next}${interactive ? " · press o to open Settings" : ""}` };
  return { headline: `${need.product} couldn't ${need.ask}. macOS may be blocking ${need.requester}.`, detail: `Check ${info.path}.`, next: need.next };
}

/** The headline and detail as one line, for status text (doctor, JSON detail). */
export function recoverySentence(need: PermissionNeed, state: "denied" | "unknown"): string {
  const shown = renderRecovery(need, state, false);
  return `${shown.headline} ${shown.detail}`;
}

export function formatNotice(notice: RenderedNotice, symbols: Pick<Symbols, "notice">): string {
  const [first, ...rest] = notice.lines;
  return [`${symbols.notice} ${first}`, ...rest.map(line => `   ${line}`), ...(notice.confirm ? [`   ${notice.confirm}`] : [])].join("\n") + "\n";
}

export function formatRecovery(need: PermissionNeed, state: "denied" | "unknown", interactive: boolean, symbols: Pick<Symbols, "fail" | "next">): string {
  const shown = renderRecovery(need, state, interactive);
  return `${symbols.fail} ${shown.headline}\n  ${shown.detail}\n${symbols.next} ${shown.next}\n`;
}
