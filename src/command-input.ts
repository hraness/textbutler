import { isAbsolute, resolve } from "node:path";
import { integerOption, type ParsedArguments } from "./args.ts";
import { CliError } from "./errors.ts";
import type { EnsoulMessagesSubjectRole } from "./ensoul-source-v1.ts";
import type { ContactMetrics } from "./types.ts";
import { MESSAGE_LIKE_ME_VERSION } from "./version.ts";

export const HELP = `Message Like Me ${MESSAGE_LIKE_ME_VERSION}

Usage:
  messagelikeme support [protocol --json|offer --json|shown ID|release ID|dismiss|snooze|enable|status --json]
    Optional support; agents use support protocol --json at closeout.
  messagelikeme [--data-dir PATH] init [--json]
  messagelikeme [--data-dir PATH] ingest imessage [--database PATH] [--json]
  messagelikeme [--data-dir PATH] ingest bundle --input ABS_PATH
                    [--overlap-source SOURCE_ID] [--json]
  messagelikeme [--data-dir PATH] ingest x-archive --input ABS_PATH
                    [--overlap-source SOURCE_ID] [--json]
  messagelikeme [--data-dir PATH] ingest contacts [--addressbook PATH] [--json]
  messagelikeme [--data-dir PATH] sources list [--private] [--json]
  messagelikeme [--data-dir PATH] sources show SOURCE_ID [--private] [--json]
  messagelikeme [--data-dir PATH] contacts list [--min-outgoing N] [--limit N] [--private] [--json]
  messagelikeme [--data-dir PATH] contacts show CONTACT_ID [--private] [--json]
  messagelikeme [--data-dir PATH] contacts resolve QUERY --private [--limit N] [--json]
  messagelikeme [--data-dir PATH] routes list CONTACT_ID --output FILE [--private] [--json]
  messagelikeme [--data-dir PATH] inspect tempo CONTACT_ID [--session-gap N] [--burst-gap N] [--json]
  messagelikeme [--data-dir PATH] inspect sessions CONTACT_ID [--limit N] [--session-gap N] [--burst-gap N] [--json]
  messagelikeme [--data-dir PATH] study prepare CONTACT_ID --output FILE [--limit N]
                    [--after ISO_TIMESTAMP] [--before ISO_TIMESTAMP]
                    [--session-gap N] [--burst-gap N] [--json]
  messagelikeme [--data-dir PATH] ensoul prepare CONTACT_ID --subject owner|contact
                    --output FILE [--limit N]
                    [--after ISO_TIMESTAMP] [--before ISO_TIMESTAMP]
                    [--session-gap N] [--burst-gap N] [--json]
  messagelikeme [--data-dir PATH] evaluate prepare CONTACT_ID --after ISO_TIMESTAMP
                    --prompt-output FILE --reference-output FILE [--before ISO_TIMESTAMP]
                    [--limit N] [--session-gap N] [--burst-gap N] [--json]
  messagelikeme [--data-dir PATH] profile apply FILE [--json]
  messagelikeme [--data-dir PATH] profile show CONTACT_ID [--json]
  messagelikeme [--data-dir PATH] profile export CONTACT_ID --output FILE [--json]
  messagelikeme [--data-dir PATH] context CONTACT_ID [--json]
  messagelikeme [--data-dir PATH] handoff prepare CONTACT_ID --request FILE
                    --ghostget-context FILE --draft FILE --output FILE [--json]
  messagelikeme [--data-dir PATH] handoff verify FILE [--json]
  messagelikeme [--data-dir PATH] handoff record HANDOFF_ID --ghostget-receipt FILE [--json]
  messagelikeme [--data-dir PATH] handoffs show HANDOFF_ID [--json]
  messagelikeme skill path [--json]
  messagelikeme skill install [--target codex|claude|agents] [--scope user|project]
                    [--project PATH] [--force] [--json]
  messagelikeme [--data-dir PATH] doctor [--json]

Message Like Me reads caller-owned macOS Messages, official X archives,
optional Contacts data, and strict private local message bundles, then stores
private analysis locally. It has no network, account, AI-provider, or
message-sending surface.
`;

export function metricOptions(parsed: ParsedArguments): Readonly<{
  sessionGapSeconds: number;
  burstGapSeconds: number;
}> {
  return {
    sessionGapSeconds: integerOption(parsed, "session-gap", 8 * 60 * 60, 1, 30 * 24 * 60 * 60),
    burstGapSeconds: integerOption(parsed, "burst-gap", 5 * 60, 1, 30 * 24 * 60 * 60),
  };
}

export function canonicalTimestampOption(
  parsed: ParsedArguments,
  key: "after" | "before",
  required = false,
): string | null {
  const value = parsed.options.get(key);
  if (value === undefined) {
    if (required) throw new CliError("usage", `--${key} is required`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CliError("usage", `--${key} must be a canonical ISO timestamp`);
  }
  return value;
}

export function ensoulSubjectOption(parsed: ParsedArguments): EnsoulMessagesSubjectRole {
  const value = parsed.options.get("subject");
  if (value === undefined) throw new CliError("usage", "--subject is required");
  if (value !== "owner" && value !== "contact") {
    throw new CliError("usage", "--subject must be owner or contact");
  }
  return value;
}

export function compactMetrics(metrics: ContactMetrics): unknown {
  return {
    schemaVersion: metrics.schemaVersion,
    corpusRevision: metrics.corpusRevision,
    contactId: metrics.contactId,
    firstMessageAt: metrics.firstMessageAt,
    lastMessageAt: metrics.lastMessageAt,
    messageCount: metrics.messageCount,
    incomingCount: metrics.incomingCount,
    outgoingCount: metrics.outgoingCount,
    textMessageCount: metrics.textMessageCount,
    sessionGapSeconds: metrics.sessionGapSeconds,
    burstGapSeconds: metrics.burstGapSeconds,
    sessionCount: metrics.sessions.length,
    burstCount: metrics.bursts.length,
    reactions: metrics.reactions,
    tempo: metrics.tempo,
    surface: metrics.surface,
  };
}

export function absolutePrivatePath(value: string | undefined, label: string): string {
  if (value === undefined) throw new CliError("usage", `${label} is required`);
  if (!isAbsolute(value)) throw new CliError("unsafe-path", `${label} must be an absolute private path`);
  return resolve(value);
}

/** Computes a bound from supplied canonical times; it never samples a clock. */
export function handoffExpiry(createdAt: string, contextExpiresAt: string, lifetimeMilliseconds: number): string {
  return new Date(Math.min(Date.parse(createdAt) + lifetimeMilliseconds, Date.parse(contextExpiresAt))).toISOString();
}
