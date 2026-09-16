import { disclosedText, type ContactSettings } from "./config.ts";
import type { RunJournal } from "./journal.ts";
import type { AutomationMessage } from "../../transport/src/automation.ts";

export type MessageAuthor = "contact" | "owner" | "butler" | "unknown";

/** Trusted journal provenance covers disclosure-free sends; the configured
 * visible wrap covers sends that predate this journal. With every marker
 * cleared, journal provenance is the only distinction from owner text. */
export function messageAuthor(message: { id: string; direction: "incoming" | "outgoing" | "unknown"; text: string | null }, contact: ContactSettings, journal?: RunJournal): MessageAuthor {
  if (message.direction === "incoming") return "contact";
  if (message.direction !== "outgoing") return "unknown";
  if (journal?.isButlerMessage(contact.id, message.id)) return "butler";
  return message.text !== null && disclosedText(message.text, contact.disclosure) ? "butler" : "owner";
}

export interface PendingCluster {
  readonly messageIds: readonly string[];
  readonly latestId: string;
  readonly latestAt: number;
  readonly preview: string | null;
  readonly count: number;
}

/** The trailing inbound text run: unanswered contact messages at the
 * conversation tail. Reactions, edits and deletes between texts do not
 * answer them; an outgoing text ends the run. */
export function pendingCluster(messages: readonly AutomationMessage[], contact: ContactSettings, journal?: RunJournal, limit = 20): PendingCluster | null {
  const collected: AutomationMessage[] = [];
  for (let index = messages.length - 1; index >= 0 && collected.length < limit; index -= 1) {
    const message = messages[index]!;
    if (message.kind !== "message") continue;
    if (messageAuthor(message, contact, journal) !== "contact") break;
    collected.push(message);
  }
  if (!collected.length) return null;
  const latest = collected[0]!;
  return { messageIds: collected.map(message => message.id).reverse(), latestId: latest.id, latestAt: Date.parse(latest.occurredAt), preview: latest.text, count: collected.length };
}
