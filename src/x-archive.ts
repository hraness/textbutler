import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { extractXArchiveFileAuto } from "./x-archive-zip-rust.ts";
import {
  MAX_X_ZIP_ARCHIVE_BYTES,
  MAX_X_ZIP_MEMBER_BYTES,
  type ExtractedXArchiveMember,
  type XArchiveMembers,
} from "./x-archive-zip.ts";

const MAX_CONVERSATIONS = 500_000;
const MAX_EVENTS = 2_000_000;
const MAX_EVENT_PARTICIPANTS = 512;
const MAX_TWEETS = 2_000_000;
const MAX_TWEET_MENTIONS = 100_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_URLS = 100;
const MAX_MEDIA = 100;
const MAX_REACTIONS = 1_000;
const MAX_EDITS = 100;
const PROVIDER_ID = /^[1-9][0-9]{0,39}$/u;
const OPAQUE_PROVIDER_ID = /^-?[0-9]{1,40}$/u;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/u;

export type XArchiveAccount = Readonly<{
  providerUserId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  createdAt: string | null;
  createdVia: string | null;
}>;

export type XArchiveEdit = Readonly<{
  createdAtSec: string;
  createdAt: string;
  editedText: string;
}>;

export type XArchiveReaction = Readonly<{
  eventId: string;
  senderId: string;
  reactionKey: string;
  createdAt: string;
}>;

export type XArchiveMessageCreate = Readonly<{
  kind: "message-create";
  id: string;
  senderId: string;
  recipientId: string | null;
  createdAt: string;
  text: string | null;
  urlCount: number;
  mediaCount: number;
  editHistory: readonly XArchiveEdit[];
  activeReactions: readonly XArchiveReaction[];
  replyToMessageId: null;
}>;

export type XArchiveMembershipEvent = Readonly<{
  kind: "join-conversation" | "participants-join" | "participants-leave";
  initiatingUserId: string | null;
  participantSnapshotIds: readonly string[];
  userIds: readonly string[];
  createdAt: string;
}>;

export type XArchiveConversationNameUpdate = Readonly<{
  kind: "conversation-name-update";
  initiatingUserId: string | null;
  name: string;
  createdAt: string;
}>;

export type XArchiveConversationEvent =
  | XArchiveMessageCreate
  | XArchiveMembershipEvent
  | XArchiveConversationNameUpdate;

export type XArchiveConversation = Readonly<{
  conversationId: string;
  kind: "direct" | "group";
  participantIds: readonly string[];
  events: readonly XArchiveConversationEvent[];
}>;

export type XArchiveIdentityObservation = Readonly<{
  kind: "reply" | "mention";
  providerUserId: string;
  username: string;
  displayName: string | null;
  observedAt: string;
  sourceMember: "data/tweets.js" | "data/deleted-tweets.js" | "data/community-tweet.js";
  sourceRecord: number;
  identityRecord: number;
}>;

export type XArchiveEvidence = Readonly<{
  format: "message-like-me.x-archive-evidence";
  version: 1;
  archive: Readonly<{
    sha256: string;
    manifestSha256: string;
    sizeBytes: number;
    declaredSizeBytes: number;
    mtimeNs: string;
    mtime: string;
    generationDate: string;
    isPartialArchive: boolean;
  }>;
  account: XArchiveAccount;
  conversations: readonly XArchiveConversation[];
  identityObservations: readonly XArchiveIdentityObservation[];
}>;

type ParsedManifest = Readonly<{
  generationDate: string;
  isPartialArchive: boolean;
  declaredSizeBytes: number;
  userInfo: Readonly<{ accountId: string; username: string; displayName: string }>;
  declarations: Readonly<{
    account: ManifestFile;
    directMessages: ManifestFile | null;
    groupDirectMessages: ManifestFile | null;
    directMessageHeaders: ManifestFile | null;
    groupDirectMessageHeaders: ManifestFile | null;
  }>;
}>;

type ManifestFile = Readonly<{ fileName: string; globalName: string; count: number }>;
type ParsedConversations = Readonly<{
  recordCount: number;
  conversations: readonly XArchiveConversation[];
  headerSignatures: ReadonlyMap<string, readonly string[]>;
}>;
type ParsedHeaders = Readonly<{
  recordCount: number;
  signatures: ReadonlyMap<string, readonly string[]>;
}>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const reviewed = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !reviewed.has(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unreviewed property ${unexpected}`);
}

function dense(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds its item limit`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label} must not be sparse`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = MAX_TEXT_BYTES, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new Error(`${label} must be an exact X user ID string`);
  }
  return value;
}

function optionalProviderId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return providerId(value, label);
}

function optionalOpaqueProviderId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !OPAQUE_PROVIDER_ID.test(value)) {
    throw new Error(`${label} is not a reviewed X user ID string`);
  }
  return value;
}

function username(value: unknown, label: string): string {
  const parsed = text(value, label, 64, true)!;
  if (!HANDLE.test(parsed)) throw new Error(`${label} is not an exact X username`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 128, true)!;
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a timestamp`);
  return new Date(milliseconds).toISOString();
}

function countString(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an exact decimal count string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} exceeds its count bound`);
  }
  return parsed;
}

function assignment(member: ExtractedXArchiveMember, prefix: string): unknown {
  if (member.bytes.byteLength > MAX_X_ZIP_MEMBER_BYTES) {
    throw new Error(`X archive member exceeds its limit: ${member.logicalName}`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(member.bytes);
  } catch (error) {
    throw new Error(`X archive member is not UTF-8: ${member.logicalName}`, { cause: error });
  }
  if (!source.startsWith(prefix)) {
    throw new Error(`X archive member has an unexpected assignment: ${member.logicalName}`);
  }
  let payload = source.slice(prefix.length).trim();
  if (payload.endsWith(";")) payload = payload.slice(0, -1).trimEnd();
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(`X archive member contains invalid assignment JSON: ${member.logicalName}`, { cause: error });
  }
}

function ytdAssignment(member: ExtractedXArchiveMember, binding: string): unknown {
  return assignment(member, `window.YTD.${binding}.part0 = `);
}

function manifestFile(
  dataTypes: Record<string, unknown>,
  key: string,
  expectedFileName: string,
  expectedGlobalName: string,
  maximum: number,
  required: boolean,
  media: boolean,
): ManifestFile | null {
  const raw = dataTypes[key];
  if (raw === undefined) {
    if (required) throw new Error(`X manifest is missing dataTypes.${key}`);
    return null;
  }
  const declaration = plain(raw, `X manifest dataTypes.${key}`);
  exactKeys(declaration, media ? ["mediaDirectory", "files"] : ["files"], `X manifest dataTypes.${key}`);
  if (media) text(declaration.mediaDirectory, `X manifest dataTypes.${key}.mediaDirectory`, 1_024, true);
  const files = dense(declaration.files, `X manifest dataTypes.${key}.files`, 2);
  if (files.length !== 1) {
    throw new Error(`X manifest dataTypes.${key} declares unsupported additional parts`);
  }
  const file = plain(files[0], `X manifest dataTypes.${key}.files[0]`);
  exactKeys(file, ["fileName", "globalName", "count"], `X manifest dataTypes.${key}.files[0]`);
  const fileName = text(file.fileName, `X manifest dataTypes.${key}.files[0].fileName`, 1_024, true)!;
  const globalName = text(file.globalName, `X manifest dataTypes.${key}.files[0].globalName`, 1_024, true)!;
  if (fileName !== expectedFileName || globalName !== expectedGlobalName) {
    throw new Error(`X manifest dataTypes.${key} declares an unsupported part`);
  }
  return {
    fileName,
    globalName,
    count: countString(file.count, `X manifest dataTypes.${key}.files[0].count`, maximum),
  };
}

function parseManifest(member: ExtractedXArchiveMember): ParsedManifest {
  const root = plain(assignment(member, "window.__THAR_CONFIG = "), "X manifest");
  exactKeys(root, ["userInfo", "archiveInfo", "readmeInfo", "dataTypes"], "X manifest");
  const userInfo = plain(root.userInfo, "X manifest userInfo");
  exactKeys(userInfo, ["accountId", "userName", "displayName"], "X manifest userInfo");
  const accountId = providerId(userInfo.accountId, "X manifest userInfo.accountId");
  const handle = username(userInfo.userName, "X manifest userInfo.userName");
  const displayName = text(userInfo.displayName, "X manifest userInfo.displayName", 1_024, true)!;

  const archiveInfo = plain(root.archiveInfo, "X manifest archiveInfo");
  exactKeys(
    archiveInfo,
    ["sizeBytes", "generationDate", "isPartialArchive", "maxPartSizeBytes"],
    "X manifest archiveInfo",
  );
  const declaredSizeBytes = countString(
    archiveInfo.sizeBytes,
    "X manifest archiveInfo.sizeBytes",
    MAX_X_ZIP_ARCHIVE_BYTES * 4,
  );
  countString(
    archiveInfo.maxPartSizeBytes,
    "X manifest archiveInfo.maxPartSizeBytes",
    MAX_X_ZIP_ARCHIVE_BYTES * 16,
  );
  const generationDate = timestamp(archiveInfo.generationDate, "X manifest archiveInfo.generationDate");
  if (typeof archiveInfo.isPartialArchive !== "boolean") {
    throw new Error("X manifest archiveInfo.isPartialArchive must be a boolean");
  }

  const readmeInfo = plain(root.readmeInfo, "X manifest readmeInfo");
  exactKeys(readmeInfo, ["fileName", "directory", "name"], "X manifest readmeInfo");
  for (const key of ["fileName", "directory", "name"] as const) {
    text(readmeInfo[key], `X manifest readmeInfo.${key}`, 1_024, true);
  }
  const dataTypes = plain(root.dataTypes, "X manifest dataTypes");
  const account = manifestFile(
    dataTypes,
    "account",
    "data/account.js",
    "YTD.account.part0",
    1,
    true,
    false,
  )!;
  if (account.count !== 1) throw new Error("X manifest must declare exactly one account record");
  const directMessages = manifestFile(
    dataTypes,
    "directMessages",
    "data/direct-messages.js",
    "YTD.direct_messages.part0",
    MAX_CONVERSATIONS,
    false,
    true,
  );
  const groupDirectMessages = manifestFile(
    dataTypes,
    "directMessagesGroup",
    "data/direct-messages-group.js",
    "YTD.direct_messages_group.part0",
    MAX_CONVERSATIONS,
    false,
    true,
  );
  if (directMessages === null && groupDirectMessages === null) {
    throw new Error("X manifest must declare at least one direct-message member");
  }
  return {
    generationDate,
    isPartialArchive: archiveInfo.isPartialArchive,
    declaredSizeBytes,
    userInfo: { accountId, username: handle, displayName },
    declarations: {
      account,
      directMessages,
      groupDirectMessages,
      directMessageHeaders: manifestFile(
        dataTypes,
        "directMessageHeaders",
        "data/direct-message-headers.js",
        "YTD.direct_message_headers.part0",
        MAX_CONVERSATIONS,
        false,
        false,
      ),
      groupDirectMessageHeaders: manifestFile(
        dataTypes,
        "directMessageGroupHeaders",
        "data/direct-message-group-headers.js",
        "YTD.direct_message_group_headers.part0",
        MAX_CONVERSATIONS,
        false,
        false,
      ),
    },
  };
}

function parseAccount(member: ExtractedXArchiveMember): XArchiveAccount {
  const values = dense(ytdAssignment(member, "account"), `${member.logicalName} root`, 1);
  if (values.length !== 1) throw new Error("X archive must contain exactly one account record");
  const wrapper = plain(values[0], `${member.logicalName}[0]`);
  exactKeys(wrapper, ["account"], `${member.logicalName}[0]`);
  const account = plain(wrapper.account, `${member.logicalName}[0].account`);
  exactKeys(
    account,
    ["email", "createdVia", "username", "accountId", "createdAt", "accountDisplayName"],
    `${member.logicalName}[0].account`,
  );
  return {
    providerUserId: providerId(account.accountId, `${member.logicalName}.accountId`),
    username: username(account.username, `${member.logicalName}.username`),
    displayName: text(account.accountDisplayName, `${member.logicalName}.accountDisplayName`, 1_024),
    email: text(account.email, `${member.logicalName}.email`, 8_192),
    createdAt: account.createdAt === undefined || account.createdAt === null || account.createdAt === ""
      ? null
      : timestamp(account.createdAt, `${member.logicalName}.createdAt`),
    createdVia: text(account.createdVia, `${member.logicalName}.createdVia`, 1_024),
  };
}

function idArray(value: unknown, label: string): string[] {
  const ids = dense(value, label, MAX_EVENT_PARTICIPANTS)
    .map((item, index) => providerId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} repeats an X user ID`);
  return ids.sort();
}

function parseEdits(value: unknown, label: string): XArchiveEdit[] {
  if (value === undefined) return [];
  const edits = dense(value, label, MAX_EDITS).map((item, index): XArchiveEdit => {
    const editLabel = `${label}[${index}]`;
    const edit = plain(item, editLabel);
    exactKeys(edit, ["createdAtSec", "editedText"], editLabel);
    const seconds = text(edit.createdAtSec, `${editLabel}.createdAtSec`, 16, true)!;
    const parsed = Number(seconds);
    if (
      !/^[0-9]{1,16}$/u.test(seconds)
      || !Number.isSafeInteger(parsed)
      || parsed > 253_402_300_799
    ) throw new Error(`${editLabel}.createdAtSec is invalid`);
    return {
      createdAtSec: seconds,
      createdAt: new Date(parsed * 1_000).toISOString(),
      editedText: text(edit.editedText, `${editLabel}.editedText`, MAX_TEXT_BYTES, true)!,
    };
  });
  return edits.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.editedText.localeCompare(right.editedText));
}

function countedUrls(value: unknown, label: string): number {
  if (value === undefined) return 0;
  const urls = dense(value, label, MAX_URLS);
  for (const [index, value] of urls.entries()) {
    const url = plain(value, `${label}[${index}]`);
    exactKeys(url, ["url", "expanded", "display"], `${label}[${index}]`);
    for (const key of Object.keys(url)) text(url[key], `${label}[${index}].${key}`, 8_192, true);
  }
  return urls.length;
}

function countedMedia(value: unknown, label: string): number {
  if (value === undefined) return 0;
  const media = dense(value, label, MAX_MEDIA);
  for (const [index, item] of media.entries()) text(item, `${label}[${index}]`, 8_192, true);
  return media.length;
}

function parseReactions(value: unknown, label: string, seenReactionIds: Set<string>): XArchiveReaction[] {
  if (value === undefined) return [];
  const reactions = dense(value, label, MAX_REACTIONS).map((item, index): XArchiveReaction => {
    const reactionLabel = `${label}[${index}]`;
    const reaction = plain(item, reactionLabel);
    exactKeys(reaction, ["senderId", "reactionKey", "eventId", "createdAt"], reactionLabel);
    const eventId = providerId(reaction.eventId, `${reactionLabel}.eventId`);
    if (seenReactionIds.has(eventId)) throw new Error(`${reactionLabel} repeats an X reaction event ID`);
    seenReactionIds.add(eventId);
    return {
      eventId,
      senderId: providerId(reaction.senderId, `${reactionLabel}.senderId`),
      reactionKey: text(reaction.reactionKey, `${reactionLabel}.reactionKey`, 128, true)!,
      createdAt: timestamp(reaction.createdAt, `${reactionLabel}.createdAt`),
    };
  });
  return reactions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.eventId.localeCompare(right.eventId));
}

function parseMessageCreate(
  value: unknown,
  label: string,
  seenMessageIds: Set<string>,
  seenReactionIds: Set<string>,
): XArchiveMessageCreate {
  const message = plain(value, label);
  exactKeys(
    message,
    ["recipientId", "text", "reactions", "urls", "mediaUrls", "senderId", "id", "createdAt", "editHistory"],
    label,
  );
  const id = providerId(message.id, `${label}.id`);
  if (seenMessageIds.has(id)) throw new Error(`${label} repeats an X message ID`);
  seenMessageIds.add(id);
  return {
    kind: "message-create",
    id,
    senderId: providerId(message.senderId, `${label}.senderId`),
    recipientId: optionalProviderId(message.recipientId, `${label}.recipientId`),
    createdAt: timestamp(message.createdAt, `${label}.createdAt`),
    text: text(message.text, `${label}.text`),
    urlCount: countedUrls(message.urls, `${label}.urls`),
    mediaCount: countedMedia(message.mediaUrls, `${label}.mediaUrls`),
    editHistory: parseEdits(message.editHistory, `${label}.editHistory`),
    activeReactions: parseReactions(message.reactions, `${label}.reactions`, seenReactionIds),
    // The reviewed X DM export has no reply-target coordinate. Do not infer one
    // from ordering, quoted text, or URLs.
    replyToMessageId: null,
  };
}

function parseMembershipEvent(
  value: unknown,
  label: string,
  sourceKind: "joinConversation" | "participantsJoin" | "participantsLeave",
): XArchiveMembershipEvent {
  const event = plain(value, label);
  const allowed = sourceKind === "participantsLeave"
    ? ["userIds", "createdAt"]
    : ["initiatingUserId", "participantsSnapshot", "userIds", "createdAt"];
  exactKeys(event, allowed, label);
  const participantSnapshotIds = event.participantsSnapshot === undefined
    ? []
    : idArray(event.participantsSnapshot, `${label}.participantsSnapshot`);
  const userIds = event.userIds === undefined ? [] : idArray(event.userIds, `${label}.userIds`);
  if (sourceKind === "participantsLeave" && event.userIds === undefined) {
    throw new Error(`${label}.userIds is required`);
  }
  if (sourceKind !== "participantsLeave" && participantSnapshotIds.length === 0 && userIds.length === 0) {
    throw new Error(`${label} has no participant inventory`);
  }
  return {
    kind: sourceKind === "joinConversation"
      ? "join-conversation"
      : sourceKind === "participantsJoin"
        ? "participants-join"
        : "participants-leave",
    initiatingUserId: optionalProviderId(event.initiatingUserId, `${label}.initiatingUserId`),
    participantSnapshotIds,
    userIds,
    createdAt: timestamp(event.createdAt, `${label}.createdAt`),
  };
}

function parseNameUpdate(value: unknown, label: string): XArchiveConversationNameUpdate {
  const event = plain(value, label);
  exactKeys(event, ["initiatingUserId", "name", "createdAt"], label);
  return {
    kind: "conversation-name-update",
    initiatingUserId: optionalProviderId(event.initiatingUserId, `${label}.initiatingUserId`),
    name: text(event.name, `${label}.name`, 1_024, true)!,
    createdAt: timestamp(event.createdAt, `${label}.createdAt`),
  };
}

function eventSortKey(event: XArchiveConversationEvent): string {
  if (event.kind === "message-create") return `0\0${event.id}`;
  if (event.kind === "conversation-name-update") return `4\0${event.initiatingUserId ?? ""}\0${event.name}`;
  return `${event.kind === "join-conversation" ? "1" : event.kind === "participants-join" ? "2" : "3"}\0${event.initiatingUserId ?? ""}\0${event.userIds.join("\0")}`;
}

function headerSignature(message: Readonly<{
  id: string;
  senderId: string;
  recipientId: string | null;
  createdAt: string;
}>): string {
  return JSON.stringify([message.id, message.senderId, message.recipientId, message.createdAt]);
}

function eventHeaderSignature(event: XArchiveConversationEvent): string {
  if (event.kind === "message-create") return `message\0${headerSignature(event)}`;
  if (event.kind === "conversation-name-update") {
    return JSON.stringify([event.kind, event.initiatingUserId, event.name, event.createdAt]);
  }
  return JSON.stringify([
    event.kind,
    event.initiatingUserId,
    event.participantSnapshotIds,
    event.userIds,
    event.createdAt,
  ]);
}

function parseConversations(
  member: ExtractedXArchiveMember,
  selfId: string,
  group: boolean,
  seenConversationIds: Set<string>,
  seenMessageIds: Set<string>,
  seenReactionIds: Set<string>,
): ParsedConversations {
  const binding = group ? "direct_messages_group" : "direct_messages";
  const values = dense(ytdAssignment(member, binding), `${member.logicalName} root`, MAX_CONVERSATIONS);
  const combined = new Map<string, {
    participants: Set<string>;
    events: XArchiveConversationEvent[];
  }>();
  let totalEvents = 0;
  for (const [recordIndex, value] of values.entries()) {
    const label = `${member.logicalName}[${recordIndex}]`;
    const wrapper = plain(value, label);
    exactKeys(wrapper, ["dmConversation"], label);
    const conversation = plain(wrapper.dmConversation, `${label}.dmConversation`);
    exactKeys(conversation, ["conversationId", "messages"], `${label}.dmConversation`);
    const conversationId = text(
      conversation.conversationId,
      `${label}.dmConversation.conversationId`,
      256,
      true,
    )!;
    if (!/^[0-9]+(?:-[0-9]+)?$/u.test(conversationId)) {
      throw new Error(`${label}.dmConversation.conversationId is invalid`);
    }
    let state = combined.get(conversationId);
    if (state === undefined) {
      if (seenConversationIds.has(conversationId)) {
        throw new Error(`${label} repeats an X conversation across direct and group members`);
      }
      seenConversationIds.add(conversationId);
      state = { participants: new Set<string>([selfId]), events: [] };
      combined.set(conversationId, state);
    }
    const participants = state.participants;
    const directIds = group
      ? null
      : conversationId.split("-").map((id, index) => providerId(id, `${label}.conversationId[${index}]`));
    if (directIds !== null) {
      if (directIds.length !== 2 || !directIds.includes(selfId)) {
        throw new Error(`${label}.conversationId is not bound to the archive account`);
      }
      for (const id of directIds) participants.add(id);
      if (participants.size !== 2) throw new Error(`${label}.conversationId does not identify a direct-message peer`);
    }
    for (const [eventIndex, item] of dense(
      conversation.messages,
      `${label}.dmConversation.messages`,
      MAX_EVENTS,
    ).entries()) {
      totalEvents += 1;
      if (totalEvents > MAX_EVENTS) throw new Error(`${member.logicalName} exceeds its event limit`);
      const eventLabel = `${label}.dmConversation.messages[${eventIndex}]`;
      const event = plain(item, eventLabel);
      const keys = Object.keys(event);
      if (keys.length !== 1) throw new Error(`${eventLabel} must contain exactly one event`);
      const sourceKind = keys[0]!;
      let parsed: XArchiveConversationEvent;
      if (sourceKind === "messageCreate") {
        parsed = parseMessageCreate(event.messageCreate, `${eventLabel}.messageCreate`, seenMessageIds, seenReactionIds);
        participants.add(parsed.senderId);
        if (parsed.recipientId !== null) participants.add(parsed.recipientId);
        for (const reaction of parsed.activeReactions) participants.add(reaction.senderId);
      } else if (
        sourceKind === "joinConversation"
        || sourceKind === "participantsJoin"
        || sourceKind === "participantsLeave"
      ) {
        parsed = parseMembershipEvent(event[sourceKind], `${eventLabel}.${sourceKind}`, sourceKind);
        if (parsed.initiatingUserId !== null) participants.add(parsed.initiatingUserId);
        for (const id of [...parsed.participantSnapshotIds, ...parsed.userIds]) participants.add(id);
      } else if (sourceKind === "conversationNameUpdate") {
        parsed = parseNameUpdate(event.conversationNameUpdate, `${eventLabel}.conversationNameUpdate`);
        if (parsed.initiatingUserId !== null) participants.add(parsed.initiatingUserId);
      } else {
        throw new Error(`${eventLabel} contains unreviewed event ${sourceKind}`);
      }
      if (directIds !== null && [...participants].some((id) => !directIds.includes(id))) {
        throw new Error(`${eventLabel} names a user outside its direct conversation`);
      }
      state.events.push(parsed);
    }
  }
  const signatures = new Map<string, readonly string[]>();
  const conversations = [...combined.entries()].map(([conversationId, state]): XArchiveConversation => {
    const orderedEvents = state.events.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || eventSortKey(left).localeCompare(eventSortKey(right)));
    signatures.set(
      conversationId,
      orderedEvents
        .filter((event): event is XArchiveMessageCreate => event.kind === "message-create")
        .map(eventHeaderSignature)
        .sort(),
    );
    return {
      conversationId,
      kind: group ? "group" : "direct",
      participantIds: [...state.participants].sort(),
      events: orderedEvents,
    };
  });
  return {
    recordCount: values.length,
    conversations: conversations.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
    headerSignatures: signatures,
  };
}

function parseHeaders(
  member: ExtractedXArchiveMember,
  group: boolean,
): ParsedHeaders {
  const binding = group ? "direct_message_group_headers" : "direct_message_headers";
  const values = dense(ytdAssignment(member, binding), `${member.logicalName} root`, MAX_CONVERSATIONS);
  const result = new Map<string, readonly string[]>();
  let total = 0;
  for (const [recordIndex, value] of values.entries()) {
    const label = `${member.logicalName}[${recordIndex}]`;
    const wrapper = plain(value, label);
    exactKeys(wrapper, ["dmConversation"], label);
    const conversation = plain(wrapper.dmConversation, `${label}.dmConversation`);
    exactKeys(conversation, ["conversationId", "messages"], `${label}.dmConversation`);
    const id = text(conversation.conversationId, `${label}.conversationId`, 256, true)!;
    if (!/^[0-9]+(?:-[0-9]+)?$/u.test(id)) throw new Error(`${label}.conversationId is invalid`);
    const signatures = [...(result.get(id) ?? [])];
    for (const [eventIndex, item] of dense(conversation.messages, `${label}.messages`, MAX_EVENTS).entries()) {
      total += 1;
      if (total > MAX_EVENTS) throw new Error(`${member.logicalName} exceeds its event limit`);
      const eventLabel = `${label}.messages[${eventIndex}]`;
      const event = plain(item, eventLabel);
      const keys = Object.keys(event);
      if (keys.length !== 1) throw new Error(`${eventLabel} must contain exactly one event`);
      const sourceKind = keys[0]!;
      let parsed: XArchiveConversationEvent;
      if (sourceKind === "messageCreate") {
        const message = plain(event.messageCreate, `${eventLabel}.messageCreate`);
        exactKeys(
          message,
          group ? ["id", "senderId", "createdAt"] : ["id", "senderId", "recipientId", "createdAt"],
          `${eventLabel}.messageCreate`,
        );
        parsed = {
          kind: "message-create",
          id: providerId(message.id, `${eventLabel}.messageCreate.id`),
          senderId: providerId(message.senderId, `${eventLabel}.messageCreate.senderId`),
          recipientId: optionalProviderId(message.recipientId, `${eventLabel}.messageCreate.recipientId`),
          createdAt: timestamp(message.createdAt, `${eventLabel}.messageCreate.createdAt`),
          text: null,
          urlCount: 0,
          mediaCount: 0,
          editHistory: [],
          activeReactions: [],
          replyToMessageId: null,
        };
      } else if (
        sourceKind === "joinConversation"
        || sourceKind === "participantsJoin"
        || sourceKind === "participantsLeave"
      ) {
        parsed = parseMembershipEvent(event[sourceKind], `${eventLabel}.${sourceKind}`, sourceKind);
      } else if (sourceKind === "conversationNameUpdate") {
        parsed = parseNameUpdate(event.conversationNameUpdate, `${eventLabel}.conversationNameUpdate`);
      } else {
        throw new Error(`${eventLabel} contains unreviewed event ${sourceKind}`);
      }
      // X's header files mirror message-create coordinates. They can also
      // contain membership/name events, but historical header generation has
      // omitted a small number of those non-message events. Validate their
      // reviewed shapes without treating them as a completeness oracle.
      if (parsed.kind === "message-create") signatures.push(eventHeaderSignature(parsed));
    }
    result.set(id, signatures.sort());
  }
  return { recordCount: values.length, signatures: result };
}

function assertHeaderParity(
  body: ReadonlyMap<string, readonly string[]>,
  header: ReadonlyMap<string, readonly string[]>,
  label: string,
): void {
  if (body.size !== header.size) throw new Error(`${label} conversation count disagrees with its DM body`);
  for (const [conversationId, bodyMessages] of body) {
    const headerMessages = header.get(conversationId);
    if (headerMessages === undefined) {
      throw new Error(`${label} omits body conversation ${conversationId}`);
    }
    if (bodyMessages.length !== headerMessages.length) {
      throw new Error(
        `${label} disagrees with its DM body for conversation ${conversationId}: ${headerMessages.length} header events versus ${bodyMessages.length} body events`,
      );
    }
    if (bodyMessages.some((value, index) => value !== headerMessages[index])) {
      throw new Error(`${label} disagrees with its DM body event coordinates for conversation ${conversationId}`);
    }
  }
}

const REVIEWED_TWEET_KEYS = [
  "community_id", "community_id_str", "contributors", "coordinates", "created_at", "deleted_at",
  "display_text_range", "edit_info", "entities", "extended_entities", "extended_tweet",
  "favorite_count", "favorited", "filter_level", "full_text", "geo", "id", "id_str",
  "in_reply_to_screen_name", "in_reply_to_status_id", "in_reply_to_status_id_str",
  "in_reply_to_user_id", "in_reply_to_user_id_str", "is_quote_status", "lang", "matching_rules",
  "place", "possibly_sensitive", "possibly_sensitive_appealable", "quoted_status", "quoted_status_id",
  "quoted_status_id_str", "quoted_status_permalink", "retweet_count", "retweeted", "retweeted_status",
  "scopes", "source", "text", "truncated", "withheld_copyright", "withheld_in_countries",
  "withheld_scope",
] as const;
const REVIEWED_ENTITY_KEYS = ["hashtags", "media", "symbols", "timestamps", "urls", "user_mentions"] as const;
const REVIEWED_MENTION_KEYS = ["id", "id_str", "indices", "name", "screen_name"] as const;

function tweetBinding(member: ExtractedXArchiveMember): {
  binding: string;
  source: XArchiveIdentityObservation["sourceMember"];
} {
  if (member.logicalName === "data/tweets.js") return { binding: "tweets", source: member.logicalName };
  if (member.logicalName === "data/deleted-tweets.js") return { binding: "deleted_tweets", source: member.logicalName };
  if (member.logicalName === "data/community-tweet.js") return { binding: "community_tweet", source: member.logicalName };
  throw new Error(`X archive identity member is not allowlisted: ${member.logicalName}`);
}

function parseIdentityObservations(member: ExtractedXArchiveMember): XArchiveIdentityObservation[] {
  const source = tweetBinding(member);
  const values = dense(ytdAssignment(member, source.binding), `${member.logicalName} root`, MAX_TWEETS);
  const observations: XArchiveIdentityObservation[] = [];
  let mentionTotal = 0;
  for (const [recordIndex, value] of values.entries()) {
    const label = `${member.logicalName}[${recordIndex}]`;
    const wrapper = plain(value, label);
    exactKeys(wrapper, ["tweet"], label);
    const tweet = plain(wrapper.tweet, `${label}.tweet`);
    exactKeys(tweet, REVIEWED_TWEET_KEYS, `${label}.tweet`);
    const observedAt = timestamp(tweet.created_at, `${label}.tweet.created_at`);
    let identityRecord = 0;
    const replyId = optionalOpaqueProviderId(tweet.in_reply_to_user_id, `${label}.tweet.in_reply_to_user_id`);
    const replyIdString = optionalOpaqueProviderId(
      tweet.in_reply_to_user_id_str,
      `${label}.tweet.in_reply_to_user_id_str`,
    );
    if (replyId !== null && replyIdString !== null && replyId !== replyIdString) {
      throw new Error(`${label}.tweet reply user IDs disagree`);
    }
    const rawReplyHandle = text(tweet.in_reply_to_screen_name, `${label}.tweet.in_reply_to_screen_name`, 64);
    const replyHandle = rawReplyHandle === null
      ? null
      : username(rawReplyHandle, `${label}.tweet.in_reply_to_screen_name`);
    const effectiveReplyId = replyIdString ?? replyId;
    if (effectiveReplyId !== null && replyHandle !== null && PROVIDER_ID.test(effectiveReplyId)) {
      identityRecord += 1;
      observations.push({
        kind: "reply",
        providerUserId: effectiveReplyId,
        username: replyHandle,
        displayName: null,
        observedAt,
        sourceMember: source.source,
        sourceRecord: recordIndex + 1,
        identityRecord,
      });
    }
    if (tweet.entities === undefined || tweet.entities === null) continue;
    const entities = plain(tweet.entities, `${label}.tweet.entities`);
    exactKeys(entities, REVIEWED_ENTITY_KEYS, `${label}.tweet.entities`);
    if (entities.user_mentions === undefined || entities.user_mentions === null) continue;
    const mentions = dense(
      entities.user_mentions,
      `${label}.tweet.entities.user_mentions`,
      MAX_TWEET_MENTIONS,
    );
    mentionTotal += mentions.length;
    if (mentionTotal > MAX_TWEET_MENTIONS) throw new Error(`${member.logicalName} exceeds its mention limit`);
    for (const [mentionIndex, value] of mentions.entries()) {
      const mentionLabel = `${label}.tweet.entities.user_mentions[${mentionIndex}]`;
      const mention = plain(value, mentionLabel);
      exactKeys(mention, REVIEWED_MENTION_KEYS, mentionLabel);
      const id = optionalOpaqueProviderId(mention.id, `${mentionLabel}.id`);
      const idString = optionalOpaqueProviderId(mention.id_str, `${mentionLabel}.id_str`);
      if (id === null || idString === null) {
        throw new Error(`${mentionLabel} must contain both X user ID coordinates`);
      }
      if (id !== idString) throw new Error(`${mentionLabel} X user IDs disagree`);
      if (!PROVIDER_ID.test(idString)) continue;
      identityRecord += 1;
      observations.push({
        kind: "mention",
        providerUserId: idString,
        username: username(mention.screen_name, `${mentionLabel}.screen_name`),
        displayName: text(mention.name, `${mentionLabel}.name`, 1_024),
        observedAt,
        sourceMember: source.source,
        sourceRecord: recordIndex + 1,
        identityRecord,
      });
    }
  }
  return observations;
}

function memberParity(
  declaration: ManifestFile | null,
  member: ExtractedXArchiveMember | null,
  label: string,
): void {
  if ((declaration === null) !== (member === null)) {
    throw new Error(`X manifest and ZIP inventory disagree for ${label}`);
  }
}

export function parseXArchiveMembers(
  members: XArchiveMembers,
): Omit<XArchiveEvidence, "archive"> & Readonly<{
  manifest: Pick<XArchiveEvidence["archive"], "manifestSha256" | "declaredSizeBytes" | "generationDate" | "isPartialArchive">;
}> {
  const manifest = parseManifest(members.manifest);
  const account = parseAccount(members.account);
  if (
    manifest.userInfo.accountId !== account.providerUserId
    || manifest.userInfo.username !== account.username
    || manifest.userInfo.displayName !== account.displayName
  ) throw new Error("X manifest userInfo disagrees with data/account.js");
  memberParity(manifest.declarations.directMessages, members.directMessages, "direct messages");
  memberParity(manifest.declarations.groupDirectMessages, members.groupDirectMessages, "group direct messages");
  memberParity(manifest.declarations.directMessageHeaders, members.directMessageHeaders, "direct-message headers");
  memberParity(
    manifest.declarations.groupDirectMessageHeaders,
    members.groupDirectMessageHeaders,
    "group direct-message headers",
  );

  const seenConversationIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const seenReactionIds = new Set<string>();
  const conversations: XArchiveConversation[] = [];
  let direct: ParsedConversations | null = null;
  let group: ParsedConversations | null = null;
  if (members.directMessages !== null) {
    direct = parseConversations(
      members.directMessages,
      account.providerUserId,
      false,
      seenConversationIds,
      seenMessageIds,
      seenReactionIds,
    );
    if (direct.recordCount !== manifest.declarations.directMessages!.count) {
      throw new Error("X manifest directMessages count disagrees with its member");
    }
    conversations.push(...direct.conversations);
  }
  if (members.groupDirectMessages !== null) {
    group = parseConversations(
      members.groupDirectMessages,
      account.providerUserId,
      true,
      seenConversationIds,
      seenMessageIds,
      seenReactionIds,
    );
    if (group.recordCount !== manifest.declarations.groupDirectMessages!.count) {
      throw new Error("X manifest directMessagesGroup count disagrees with its member");
    }
    conversations.push(...group.conversations);
  }
  if (members.directMessageHeaders !== null) {
    const headers = parseHeaders(members.directMessageHeaders, false);
    if (headers.recordCount !== manifest.declarations.directMessageHeaders!.count) {
      throw new Error("X manifest directMessageHeaders count disagrees with its member");
    }
    if (direct === null) throw new Error("X direct-message headers have no DM body");
    assertHeaderParity(direct.headerSignatures, headers.signatures, "X direct-message headers");
  }
  if (members.groupDirectMessageHeaders !== null) {
    const headers = parseHeaders(members.groupDirectMessageHeaders, true);
    if (headers.recordCount !== manifest.declarations.groupDirectMessageHeaders!.count) {
      throw new Error("X manifest directMessageGroupHeaders count disagrees with its member");
    }
    if (group === null) throw new Error("X group direct-message headers have no DM body");
    assertHeaderParity(group.headerSignatures, headers.signatures, "X group direct-message headers");
  }
  const identityObservations = members.identityMetadata.flatMap(parseIdentityObservations)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt)
      || left.providerUserId.localeCompare(right.providerUserId)
      || left.kind.localeCompare(right.kind)
      || left.username.localeCompare(right.username)
      || (left.displayName ?? "").localeCompare(right.displayName ?? "")
      || left.sourceMember.localeCompare(right.sourceMember)
      || left.sourceRecord - right.sourceRecord
      || left.identityRecord - right.identityRecord);
  return {
    format: "message-like-me.x-archive-evidence",
    version: 1,
    manifest: {
      manifestSha256: sha256(members.manifest.bytes),
      declaredSizeBytes: manifest.declaredSizeBytes,
      generationDate: manifest.generationDate,
      isPartialArchive: manifest.isPartialArchive,
    },
    account,
    conversations: conversations.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
    identityObservations,
  };
}

function sha256Descriptor(descriptor: number, size: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
    if (count < 1) throw new Error("X archive changed while being hashed");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function sameStat(
  left: ReturnType<typeof fstatSync> & { mtimeNs?: bigint; ctimeNs?: bigint },
  right: ReturnType<typeof fstatSync> & { mtimeNs?: bigint; ctimeNs?: bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

/** Read a private, owner-only official X archive without evaluation, network, or persistence. */
export async function readXArchive(path: unknown): Promise<XArchiveEvidence> {
  if (
    typeof path !== "string"
    || path.length < 1
    || path.includes("\u0000")
    || !isAbsolute(path)
    || resolve(path) !== path
  ) throw new Error("X archive path must be a normalized absolute path");
  let physical: string;
  try {
    physical = realpathSync(path);
  } catch (error) {
    throw new Error("X archive path cannot be resolved", { cause: error });
  }
  if (physical !== path) throw new Error("X archive path must not traverse a symbolic link");
  const pathBefore = lstatSync(path, { bigint: true });
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (
      !before.isFile()
      || before.nlink !== 1n
      || (uid !== null && before.uid !== uid)
      || (before.mode & 0o077n) !== 0n
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino
    ) throw new Error("X archive must be one private current-user-owned physical file");
    if (before.size < 1n || before.size > BigInt(MAX_X_ZIP_ARCHIVE_BYTES)) {
      throw new Error("X archive size is invalid");
    }
    const size = Number(before.size);
    const digest = sha256Descriptor(descriptor, size);
    const members = extractXArchiveFileAuto(descriptor, size);
    const parsed = parseXArchiveMembers(members);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameStat(before, after)
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || realpathSync(path) !== path
    ) throw new Error("X archive changed while being read");
    const mtimeNs = before.mtimeNs.toString();
    return {
      format: parsed.format,
      version: parsed.version,
      archive: {
        sha256: digest,
        manifestSha256: parsed.manifest.manifestSha256,
        sizeBytes: size,
        declaredSizeBytes: parsed.manifest.declaredSizeBytes,
        mtimeNs,
        mtime: new Date(Number(before.mtimeNs / 1_000_000n)).toISOString(),
        generationDate: parsed.manifest.generationDate,
        isPartialArchive: parsed.manifest.isPartialArchive,
      },
      account: parsed.account,
      conversations: parsed.conversations,
      identityObservations: parsed.identityObservations,
    };
  } finally {
    closeSync(descriptor);
  }
}
