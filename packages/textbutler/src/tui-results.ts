/** One-line, human results for the guided terminal (textbutler tui). The
 * scriptable commands keep their JSON; the TUI never prints raw JSON. */
import type { ControlResponse } from "../../control/src/index.ts";
import type { Symbols } from "./cli-style.ts";
import type { LaunchAgentStatus } from "./launch-agent.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
/** Keeps a contact name on one line; the TUI escapes control characters. */
const label = (text: string): string => text.replace(/[\r\n\t]/gu, " ").slice(0, 300);
const sentence = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Detail strings are human sentences unless they look like a bare code. */
const humanDetail = (value: unknown): string | undefined => {
  const text = sentence(value);
  return text !== undefined && /\s/u.test(text) ? text : undefined;
};
const shell = (value: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export interface ResultContext {
  /** The TUI's data folder, so follow-up commands reach the same daemon. */
  dataDir?: string;
}
const jobsCommand = (jobId: string, context: ResultContext): string =>
  `textbutler${context.dataDir === undefined ? "" : ` --data-dir ${shell(context.dataDir)}`} jobs show ${shell(jobId)}`;
const PENDING = (jobId: string, context: ResultContext): string =>
  `Still waiting for a result. Check it with ${jobsCommand(jobId, context)}. Don't repeat this action: it may already have taken effect.`;

/** A control or owner-command result. `done` is the success line for changes
 * that only return fresh settings (pause, resume, contact changes). */
export function describeControlResult(value: unknown, symbols: Symbols, done = "Done.", context: ResultContext = {}): string {
  const result = row(value);
  if (!result) return `${symbols.ok} ${done}`;
  if (result.ok === false) return `${symbols.fail} ${sentence(result.message) ?? sentence(result.detail) ?? "That didn't work. Run textbutler doctor."}`;
  if (result.kind === "job" || result.status === "pending") return `${symbols.busy} ${PENDING(String(result.jobId), context)}`;
  const response = result as unknown as Extract<ControlResponse, { ok: true }>;
  switch (response.kind) {
    case "enrolled": {
      const name = response.snapshot.contacts.find(contact => contact.id === response.contactId)?.name;
      const who = name === undefined ? "the contact" : label(name);
      const history = response.historyInitialized
        ? ` Imported ${response.historyCount} recent ${response.historyCount === 1 ? "message" : "messages"} as context${historyNote(response.historyOmittedCount, response.historyShortenedCount)}.`
        : "";
      return `${symbols.ok} Added ${who}. Automatic replies are off.${history}`;
    }
    case "reply-sent": {
      const detail = humanDetail(response.detail), extra = detail === undefined ? "" : ` ${detail}`;
      if (response.state === "submitted") return `${symbols.ok} Reply sent.`;
      if (response.state === "cancelled") return `${symbols.skip} The reply wasn't sent: it was stopped before sending.${extra}`;
      if (response.state === "failed") return `${symbols.fail} The reply wasn't sent.${extra}`;
      const what = response.state === "partial" ? "Only part of the reply was sent." : "It isn't known whether the reply was sent.";
      return `${symbols.warn} ${what} Don't send it again. Check the chat, then run textbutler replies reconcile <contact> with --sent or --failed.`;
    }
    case "reply-suggestion": {
      if (response.draft) return `${symbols.ok} A suggested reply is ready to review.`;
      const why = humanDetail(response.pending.reason);
      return `${symbols.skip} No reply suggested for ${label(response.pending.name)}.${why === undefined ? "" : ` ${why}`}`;
    }
    case "reply-reconciled": return `${response.resolved ? symbols.ok : symbols.warn} ${response.detail}`;
    case "reply-discarded": return `${symbols.ok} ${response.discarded ? "Draft discarded." : "That draft was already gone."}`;
    case "snapshot": return `${symbols.ok} ${done}`;
    default: return `${symbols.ok} ${sentence(result.detail) ?? done}`;
  }
}

function historyNote(omitted: number, shortened: number): string {
  const parts = [...(omitted ? [`${omitted} skipped`] : []), ...(shortened ? [`${shortened} shortened`] : [])];
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** textbutler daemon install, from the TUI's setup step. */
export function describeServiceInstall(status: LaunchAgentStatus, symbols: Symbols): string {
  const ok = status.installation === "installed";
  return `${ok ? symbols.ok : symbols.warn} ${status.detail}${ok ? "" : `\n${symbols.next} textbutler doctor`}`;
}

/** Menu bar start, start-at-login and stop, from desktop-foundation's
 * companion commands. */
export function describeMenuBarResult(action: "start" | "install" | "stop", value: unknown, symbols: Symbols): string {
  const result = row(value) ?? {};
  if (action === "install") return result.loginStartup === "enabled"
    ? `${symbols.ok} The Textbutler menu will start when you log in.`
    : `${symbols.warn} The menu wasn't set to start at login.\n${symbols.next} textbutler doctor`;
  if (action === "stop") return result.running === false
    ? `${symbols.ok} The Textbutler menu stopped.`
    : `${symbols.warn} The Textbutler menu may still be running.\n${symbols.next} textbutler menubar status`;
  if (result.running === true) return `${symbols.ok} ${result.alreadyRunning === true ? "The Textbutler menu is already running." : "The Textbutler menu is running."}`;
  const reasons = (Array.isArray(result.diagnostics) ? result.diagnostics : []).map(row)
    .filter((item): item is Row => item !== null && item.severity === "error")
    .map(item => [sentence(item.message), sentence(item.guidance)].filter(Boolean).join(" ")).filter(Boolean).slice(0, 3);
  return `${symbols.fail} The Textbutler menu didn't start.${reasons.map(reason => `\n  ${label(reason)}`).join("")}\n${symbols.next} textbutler doctor`;
}
