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

const PENDING = (jobId: string): string =>
  `Still waiting for a result. Check it with textbutler jobs show ${jobId}. Don't repeat this action: it may already have taken effect.`;

/** A control or owner-command result. `done` is the success line for changes
 * that only return fresh settings (pause, resume, contact changes). */
export function describeControlResult(value: unknown, symbols: Symbols, done = "Done."): string {
  const result = row(value);
  if (!result) return `${symbols.ok} ${done}`;
  if (result.ok === false) return `${symbols.fail} ${sentence(result.message) ?? sentence(result.detail) ?? "That didn't work. Run textbutler doctor."}`;
  if (result.kind === "job" || result.status === "pending") return `${symbols.busy} ${PENDING(String(result.jobId))}`;
  const response = result as unknown as Extract<ControlResponse, { ok: true }>;
  switch (response.kind) {
    case "enrolled": {
      const name = response.snapshot.contacts.find(contact => contact.id === response.contactId)?.name;
      const who = name === undefined ? "the contact" : label(name);
      const history = response.historyInitialized
        ? ` Imported ${response.historyCount} recent ${response.historyCount === 1 ? "message" : "messages"} as context${response.historyOmittedCount ? ` (${response.historyOmittedCount} skipped)` : ""}.`
        : "";
      return `${symbols.ok} Added ${who}. Automatic replies are off.${history}`;
    }
    case "reply-sent": {
      const mark = response.state === "submitted" ? symbols.ok : response.state === "cancelled" ? symbols.skip : response.state === "failed" ? symbols.fail : symbols.warn;
      return `${mark} ${response.detail}`;
    }
    case "reply-reconciled": return `${response.resolved ? symbols.ok : symbols.warn} ${response.detail}`;
    case "reply-discarded": return `${symbols.ok} ${response.discarded ? "Draft discarded." : "That draft was already gone."}`;
    case "snapshot": return `${symbols.ok} ${done}`;
    default: return `${symbols.ok} ${sentence(result.detail) ?? done}`;
  }
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
  return `${symbols.fail} The Textbutler menu didn't start.\n${symbols.next} textbutler doctor`;
}
