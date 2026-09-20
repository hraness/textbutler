import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { CONTROL_PROTOCOL, type ControlRequest, type ControlResponse } from "../../control/src/index.ts";
import { parseActionIntent, type ActionIntent } from "../../transport/src/index.ts";
import { awaitOwnerJob, OwnerCliError, pendingJobOutput, resolveOwnerContact, type OwnerControlClient } from "./owner-cli.ts";
import { ContactWorkspace } from "./workspace.ts";
import { parseXcbJson } from "./xcb-client.ts";

export const MESSAGES_COMMAND_HELP = `Agent messaging commands (JSON):
  messages history CONTACT [--limit 1..200]
  messages summarize CONTACT [--limit 1..200]
  messages capabilities CONTACT
  messages compose CONTACT --text TEXT
  messages compose CONTACT --actions /absolute/actions.json
  messages react CONTACT MESSAGE_ID EMOJI [--remove]
  messages attach CONTACT /absolute/media [--caption TEXT]
  messages send CONTACT --text TEXT

Compose, react and attach create unsent drafts. Send a reviewed draft with
replies send DRAFT DIGEST. Summary uses the selected subscription account.
Inspect capabilities first; threaded message targeting is not supported by
the current connector. Reaction/media availability depends on the connection.`;

const MAX_MEDIA = 16 * 1024 * 1024;
export async function readOwnerInputFile(path: string, maximum: number): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/u.test(path) || await realpath(path) !== path)
    throw new OwnerCliError("Use an absolute physical file path.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n || (before.mode & 0o022n) !== 0n || before.size < 1n || before.size > BigInt(maximum))
      throw new OwnerCliError(`Use an owned regular file of 1 to ${maximum} bytes, without links or group/public write access.`);
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw new OwnerCliError("The input file changed while reading."); offset += part.bytesRead; }
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    for (const key of ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"] as const)
      if (before[key] !== after[key] || before[key] !== named[key]) throw new OwnerCliError("The input file changed while reading.");
    return bytes;
  } finally { await file.close(); }
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  pdf: "application/pdf", txt: "text/plain", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };
export async function importOwnerMedia(dataDir: string, contactId: string, path: string): Promise<ActionIntent> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(contactId)) throw new OwnerCliError("Use an exact enrolled contact.");
  const root = join(dataDir, "contacts", contactId);
  if (await realpath(root) !== root) throw new OwnerCliError("The selected contact workspace is unavailable.");
  const name = basename(path);
  if (Buffer.byteLength(name) > 255 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new OwnerCliError("Use a media filename without control characters, at most 255 UTF-8 bytes.");
  const bytes = await readOwnerInputFile(path, MAX_MEDIA), suffix = extname(path).slice(1).toLowerCase();
  const extension = /^[a-z0-9]{1,10}$/u.test(suffix) ? suffix : "bin";
  const workspace = await ContactWorkspace.create(root), asset = await workspace.importAsset(bytes, extension);
  return { kind: "attachment", file: asset.path, name, mimeType: MIME[extension] ?? "application/octet-stream" };
}

export async function handleMessagesCommand(args: readonly string[], options: {
  request: OwnerControlClient; print(value: unknown): void; dataDir: string;
  readFile?: typeof readOwnerInputFile; importMedia?: typeof importOwnerMedia;
}): Promise<number | undefined> {
  if (args[0] !== "messages") return undefined;
  if (args.length === 2 && args[1] === "--help") { options.print({ ok: true, help: MESSAGES_COMMAND_HELP }); return 0; }
  const [, verb, target, option, value, extra] = args;
  const read = (verb === "history" || verb === "summarize") && (args.length === 3 || args.length === 5 && option === "--limit" && /^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u.test(value ?? ""));
  const capabilities = verb === "capabilities" && args.length === 3;
  const text = (verb === "compose" || verb === "send") && args.length === 5 && option === "--text";
  const actionsFile = verb === "compose" && args.length === 5 && option === "--actions";
  const react = verb === "react" && (args.length === 5 || args.length === 6 && extra === "--remove");
  const attach = verb === "attach" && (args.length === 4 || args.length === 6 && value === "--caption");
  if (!target || !(read || capabilities || text || actionsFile || react || attach)) throw new OwnerCliError(MESSAGES_COMMAND_HELP);
  let actions: ActionIntent[] | undefined;
  if (text) actions = [parseActionIntent({ kind: "text", text: value })];
  if (react) actions = [parseActionIntent({ kind: "reaction", messageId: option, emoji: value, action: extra === "--remove" ? "remove" : "add" })];
  if (actionsFile) {
    const bytes = await (options.readFile ?? readOwnerInputFile)(value!, 65_536);
    const input = parseXcbJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(input) || input.length < 1 || input.length > 7) throw new OwnerCliError("The actions file must contain 1 to 7 messaging actions.");
    actions = input.map(parseActionIntent);
  }
  const snapshot = await options.request({ protocol: CONTROL_PROTOCOL, command: "snapshot" });
  if (!snapshot.ok || snapshot.kind !== "snapshot") { options.print(snapshot); return 1; }
  const contact = resolveOwnerContact(snapshot.snapshot, target);
  const report = (response: ControlResponse): number => {
    options.print(response.ok && response.kind === "job" ? pendingJobOutput(response) : response);
    return response.ok && response.kind !== "job" && (response.kind !== "reply-sent" || response.state === "submitted") ? 0 : 1;
  };
  const send = (request: ControlRequest) => awaitOwnerJob(request, options.request);
  if (read) return report(await send({ protocol: CONTROL_PROTOCOL, command: verb === "history" ? "messages.history" : "messages.summarize", contactId: contact.id, limit: value === undefined ? 100 : Number(value) }));
  if (capabilities) return report(await send({ protocol: CONTROL_PROTOCOL, command: "messages.capabilities", contactId: contact.id }));
  if (verb === "send") return report(await send({ protocol: CONTROL_PROTOCOL, command: "replies.send", contactId: contact.id, text: value!, expectedRevision: snapshot.snapshot.revision }));
  if (attach) {
    // Capability preflight precedes file import. The daemon rechecks it again
    // when composing and sending, so this observation grants no send authority.
    const observed = await send({ protocol: CONTROL_PROTOCOL, command: "messages.capabilities", contactId: contact.id });
    if (!observed.ok || observed.kind === "job") return report(observed);
    if (observed.kind !== "message-capabilities") throw new OwnerCliError("Current media capabilities could not be confirmed. No media was imported.");
    if (!observed.actions.attachment?.available) { options.print({ ok: false, code: "unavailable", message: observed.actions.attachment?.reason ?? "Attachments are unavailable for this conversation." }); return 1; }
    const asset = await (options.importMedia ?? importOwnerMedia)(options.dataDir, contact.id, option!);
    actions = [...(extra ? [parseActionIntent({ kind: "text", text: extra })] : []), asset];
  }
  return report(await send({ protocol: CONTROL_PROTOCOL, command: "replies.compose", contactId: contact.id,
    summary: "Owner-specified message draft", actions: actions! }));
}
