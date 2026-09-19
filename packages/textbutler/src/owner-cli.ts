import { CONTROL_PROTOCOL, validateContactSettings, type Contact, type ControlRequest, type ControlResponse, type DesktopSnapshot } from "../../control/src/index.ts";

export type OwnerControlClient = (request: ControlRequest) => Promise<ControlResponse>;

/** Only explicit, bounded diagnostics may be displayed by the CLI entrypoint. */
export class OwnerCliError extends Error {}

export const OWNER_COMMAND_HELP = `Owner controls:
  status                              Show the daemon's current state
  pause | resume                      Pause or resume automatic replies
  messaging list                      Show configured messaging connections
  messaging start PROVIDER            Connect imessage, whatsapp, or beeper
  conversations list                  List recent direct conversations
  contacts list                       Show contacts and their settings
  contacts add CANDIDATE [--history]   Add the exact candidate, disabled
  contacts account CONTACT ACCOUNT   Select an explicit agent account
  contacts enable CONTACT            Enable replies for this contact
  contacts disable CONTACT           Disable replies and revoke its grant
  contacts mode CONTACT smart|keyword [--keyword WORD]
  jobs show JOB_ID                    Read a pending operation's result

Use an exact contact ID or a unique contact name. Adding a contact keeps
automatic replies off. History is imported only with --history.
Account selection never enables a contact; resume never enables contacts.`;

const ownerFamilies = new Set(["status", "pause", "resume", "messaging", "conversations", "contacts", "jobs"]);
const identity = (value: string | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value);
const knownProvider = (value: string | undefined): value is "imessage" | "whatsapp" | "beeper" => value === "imessage" || value === "whatsapp" || value === "beeper";

/** Poll only the accepted job. A timeout or disconnected poll retains its ID;
 * it never repeats a mutation, enrollment, grant request or send. */
export async function awaitOwnerJob(request: ControlRequest, client: OwnerControlClient, options: {
  waitMs?: number; now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
} = {}): Promise<ControlResponse> {
  const waitMs = options.waitMs ?? 120_000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 120_000) throw new OwnerCliError("Job waiting must be between 0 and 120 seconds.");
  let response = await client(request);
  if (!response.ok || response.kind !== "job") return response;
  const pending = response;
  const now = options.now ?? Date.now, sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + waitMs;
  for (let polls = 0; polls < 480 && now() < deadline; polls++) {
    await sleep(Math.min(250, Math.max(0, deadline - now())));
    try { response = await client({ protocol: CONTROL_PROTOCOL, command: "owner.job.read", jobId: pending.jobId }); }
    catch { return pending; }
    if (!response.ok && response.code === "disconnected") return pending;
    if (!response.ok || response.kind !== "job") return response;
    if (response.jobId !== pending.jobId) return pending;
  }
  return pending;
}

export function pendingJobOutput(response: Extract<ControlResponse, { kind: "job" }>): unknown {
  return { ...response, status: "pending", detail: "The operation's final result is not confirmed. Read this job with the same data directory. Do not repeat the original command: it may already have taken effect.",
    nextCommand: ["textbutler", "jobs", "show", response.jobId] };
}

/** Exact IDs win; name lookup must have one result and never guesses a target. */
export function resolveOwnerContact(snapshot: DesktopSnapshot, name: string): Contact {
  if (!name.trim() || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new OwnerCliError("Use a contact ID or a nonempty contact name from textbutler contacts list.");
  const exact = snapshot.contacts.find(contact => contact.id === name);
  if (exact) return exact;
  const lowered = name.toLowerCase();
  const matches = snapshot.contacts.filter(contact => contact.name.toLowerCase().includes(lowered));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new OwnerCliError(`No configured contact matches "${name}". Run textbutler contacts list.`);
  throw new OwnerCliError(`"${name}" matches more than one contact. Use an exact ID from textbutler contacts list.`);
}

/** Returns undefined for another command family; malformed owner commands fail
 * before reading state or sending any mutation. */
export async function handleOwnerCommand(args: readonly string[], options: {
  request: OwnerControlClient; print: (value: unknown) => void;
}): Promise<number | undefined> {
  if (!ownerFamilies.has(args[0] ?? "")) return undefined;
  const [family, verb, target, value] = args;
  const status = family === "status" && args.length === 1;
  const pause = (family === "pause" || family === "resume") && args.length === 1;
  const messagingList = family === "messaging" && verb === "list" && args.length === 2;
  const messagingStart = family === "messaging" && verb === "start" && args.length === 3 && knownProvider(target);
  const conversations = family === "conversations" && verb === "list" && args.length === 2;
  const contactsList = family === "contacts" && verb === "list" && args.length === 2;
  const add = family === "contacts" && verb === "add" && identity(target) && (args.length === 3 || args.length === 4 && value === "--history");
  const account = family === "contacts" && verb === "account" && args.length === 4 && identity(value);
  const activation = family === "contacts" && (verb === "enable" || verb === "disable") && args.length === 3;
  const mode = family === "contacts" && verb === "mode" && (value === "smart" || value === "keyword")
    && (args.length === 4 || args.length === 6 && args[4] === "--keyword" && typeof args[5] === "string");
  const job = family === "jobs" && verb === "show" && args.length === 3 && identity(target);
  if (!(status || pause || messagingList || messagingStart || conversations || contactsList || add || account || activation || mode || job)) {
    throw new OwnerCliError(`Unrecognized owner command.\n\n${OWNER_COMMAND_HELP}`);
  }
  const { request, print } = options;
  const report = (response: ControlResponse): number => {
    print(response.ok && response.kind === "job" ? pendingJobOutput(response) : response);
    return response.ok && response.kind !== "job" ? 0 : 1;
  };
  if (job) return report(await request({ protocol: CONTROL_PROTOCOL, command: "owner.job.read", jobId: target! }));
  if (messagingStart) return report(await awaitOwnerJob({ protocol: CONTROL_PROTOCOL, command: "messaging.start", provider: target as "imessage" | "whatsapp" | "beeper" }, request));
  if (conversations) return report(await awaitOwnerJob({ protocol: CONTROL_PROTOCOL, command: "conversations.list" }, request));
  const response = await request({ protocol: CONTROL_PROTOCOL, command: "snapshot" });
  if (!response.ok) return report(response);
  if (response.kind !== "snapshot") throw new OwnerCliError("The daemon did not return current settings. Run textbutler doctor before making a change.");
  const snapshot = response.snapshot;
  if (status) return report(response);
  if (messagingList) {
    print({ ok: true, providers: snapshot.messagingProviders ?? [], detail: "These connections are configured. Start a connection to check it; configuration alone does not prove it is connected.",
      capabilities: snapshot.capabilities.filter(capability => capability.id === "messages") }); return 0;
  }
  if (contactsList) { print({ ok: true, revision: snapshot.revision, paused: snapshot.settings.paused, contacts: snapshot.contacts }); return 0; }
  if (pause) return report(await awaitOwnerJob({ protocol: CONTROL_PROTOCOL, command: "global.settings.update", expectedRevision: snapshot.revision,
    settings: { ...snapshot.settings, paused: family === "pause" } }, request));
  if (add) return report(await awaitOwnerJob({ protocol: CONTROL_PROTOCOL, command: "contact.enroll", candidateId: target!, expectedRevision: snapshot.revision,
    initializeHistory: value === "--history" }, request));
  const contact = resolveOwnerContact(snapshot, target!);
  const settings = { ...contact.settings, disclosure: { ...contact.settings.disclosure } };
  if (account) {
    const selected = snapshot.providerAccounts?.find(candidate => candidate.id === value);
    if (!selected) throw new OwnerCliError("That agent account is not configured. Run textbutler providers list and choose an exact account ID.");
    settings.accountId = selected.id; settings.provider = selected.provider;
  } else if (activation) settings.enabled = verb === "enable";
  else if (mode) {
    settings.responseMode = value as "smart" | "keyword";
    if (args[5] !== undefined) settings.keyword = args[5];
  }
  const invalid = validateContactSettings(settings);
  if (invalid) throw new OwnerCliError(invalid);
  return report(await awaitOwnerJob({ protocol: CONTROL_PROTOCOL, command: "contact.settings.update", contactId: contact.id,
    expectedRevision: snapshot.revision, settings }, request));
}
