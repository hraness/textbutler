import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

import { handleCompanionCommand, openBrowser, type CompanionOptions, type MenuItem } from "@hraness/desktop-foundation";
import { CONTROL_PROTOCOL, disconnectedSnapshot, type ControlRequest, type ControlResponse, type DesktopSnapshot, type ConversationCandidate } from "../../control/src/index.ts";
import { requestDaemon } from "./daemon.ts";
import { TRAY_ICON } from "./menubar-icon.ts";
import { awaitOwnerJob, type OwnerControlClient } from "./owner-cli.ts";
import { createLaunchAgentLifecycle, defaultLaunchAgentHost, isolatedBunInvocation } from "./launch-agent.ts";

const WEBSITE = "https://textbutler.app/";
const SUPPORT = "https://account.hraness.com/support?product=message-like-me&source=desktop#support";

/** Presentation never lets daemon text add lines, bidi overrides or unbounded menus. */
export function menuLabel(text: string, limit = 72): string {
  const clean = [...text]
    .map(character => /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(character) ? " " : character)
    .join("").split(/\s+/u).filter(part => part.length > 0).join(" ");
  const scalars = [...clean];
  return scalars.length > limit ? `${scalars.slice(0, Math.max(0, limit - 1)).join("")}…` : clean;
}

/** Long daemon prose becomes a few bounded read-only rows inside a submenu. */
function detailItems(detail: string): MenuItem[] {
  const words = menuLabel(detail, 216).split(" ");
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if ([...next].length <= 72) current = next;
    else { if (current) rows.push(current); current = word; }
  }
  if (current) rows.push(current);
  const bounded = rows.slice(0, 3);
  return bounded.length ? bounded.map(line => ({ kind: "label" as const, label: menuLabel(line, 72) })) : [{ kind: "label" as const, label: "No additional detail." }];
}

function contactItems(contacts: DesktopSnapshot["contacts"], accounts: DesktopSnapshot["providerAccounts"] = []): MenuItem[] {
  const rows: MenuItem[] = contacts.slice(0, 20).map(contact => ({
    kind: "submenu" as const,
    label: menuLabel(`${contact.name} · ${contact.settings.enabled ? "Enabled" : "Off"}`) || "Contact",
    items: [{ kind: "label" as const, label: contact.settings.enabled ? "Automatic replies on" : "Automatic replies off" }, ...detailItems(contact.subtitle),
      { kind: "action" as const, id: `contact.toggle:${contact.id}`, label: contact.settings.enabled ? "Disable automatic replies" : "Enable automatic replies" },
      { kind: "submenu" as const, label: "Agent account", items: accounts.length ? accounts.map(account => ({ kind: "action" as const,
        id: `contact.account:${contact.id}:${account.id}`, label: menuLabel(`${account.label} · ${account.status}`), checked: contact.settings.accountId === account.id,
        enabled: !contact.settings.enabled && account.status === "ready" })) : [{ kind: "label" as const, label: "No qualified agent account" }] },
    ],
  }));
  if (!contacts.length) rows.push({ kind: "label", label: "No contacts configured" });
  if (contacts.length > 20) rows.push({ kind: "label", label: `${contacts.length - 20} more contacts` });
  return rows;
}

function accountItems(snapshot: DesktopSnapshot): MenuItem[] {
  const accounts = snapshot.providerAccounts ?? [];
  if (!accounts.length) return [{ kind: "label", label: "No agent accounts reported" }];
  return accounts.map(account => {
    const state = account.status === "ready" ? "Ready" : account.status === "setup-required" ? "Setup required" : "Unavailable";
    return { kind: "submenu" as const, label: menuLabel(`${account.label} · ${state}`) || "Agent account", items: detailItems(account.detail) };
  });
}

function capabilityItems(snapshot: DesktopSnapshot): MenuItem[] {
  if (!snapshot.capabilities.length) return [{ kind: "label", label: "No capabilities reported" }];
  return snapshot.capabilities.map(capability => {
    const state = capability.status === "available" ? "Available" : capability.status === "setup-required" ? "Setup required" : "Unsupported";
    const name = capability.id.charAt(0).toUpperCase() + capability.id.slice(1);
    return { kind: "submenu" as const, label: menuLabel(`${name} · ${state}`), items: detailItems(capability.detail) };
  });
}

/** Owner reply inbox: pending conversations to triage and drafts awaiting an
 * explicit send. The menu can trigger a scan or suggestion and send only the
 * exact reviewed draft — free-text replies stay on the CLI. */
function replyItems(snapshot: DesktopSnapshot): MenuItem[] {
  const replies = snapshot.replies;
  if (!replies) return [{ kind: "label", label: "Messaging automation is not configured" }];
  const rows: MenuItem[] = [{ kind: "action", id: "replies.scan", label: "Check for replies" }];
  for (const item of replies.pending.slice(0, 10)) {
    const draft = replies.drafts.find(candidate => candidate.contactId === item.contactId);
    rows.push({ kind: "submenu", label: menuLabel(`${item.name} · ${item.pendingCount} to answer`) || "Conversation", items: [
      { kind: "label" as const, label: menuLabel(item.enabled ? "Automatic replies on" : "Automatic replies off") },
      ...(item.preview ? detailItems(item.preview) : []),
      ...(item.reason ? detailItems(item.reason) : []),
      ...(item.sendable ? [{ kind: "action" as const, id: `replies.suggest:${item.contactId}`, label: draft ? "Suggest a fresh reply" : "Suggest a reply" }]
        : []),
    ]});
  }
  for (const draft of replies.drafts.slice(0, 10)) {
    rows.push({ kind: "submenu", label: menuLabel(`Draft · ${draft.name}`) || "Draft", items: [
      ...detailItems(draft.preview),
      ...(draft.actionCount > 1 ? [{ kind: "label" as const, label: `Includes ${draft.actionCount} actions` }] : []),
      { kind: "label" as const, label: menuLabel(`Expires ${draft.expiresAt.slice(11, 16)} UTC`) },
      { kind: "label" as const, label: "Preview only · full review in textbutler tui" },
      { kind: "action" as const, id: `replies.discard:${draft.id}`, label: "Discard suggestion" },
    ]});
  }
  if (replies.pending.length === 0 && replies.drafts.length === 0) {
    rows.push({ kind: "label", label: replies.scannedAt === null ? "Check for replies to scan enrolled conversations" : "Nothing waiting for a reply" });
  }
  return rows;
}

function activityItems(activity: DesktopSnapshot["activity"]): MenuItem[] {
  const recent = [...activity].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 8);
  if (!recent.length) return [{ kind: "label", label: "No recent activity" }];
  return recent.map(event => ({
    kind: "submenu" as const,
    label: menuLabel(event.title) || "Activity",
    items: [{ kind: "label" as const, label: menuLabel(event.at) }, ...detailItems(event.detail)],
  }));
}

/** The shared native runner accepts at most 256 nodes across the whole
 * tree. Reserve the final quit item and an overflow hint, even for large inboxes. */
export function boundedMenu(items: readonly MenuItem[]): MenuItem[] {
  let remaining = 248;
  let truncated = false;
  const trim = (rows: readonly MenuItem[]): MenuItem[] => {
    const result: MenuItem[] = [];
    for (const row of rows) {
      if (row.kind === "quit") continue;
      if (remaining < (row.kind === "submenu" ? 2 : 1)) { truncated = true; continue; }
      remaining--;
      if (row.kind === "submenu") result.push({ ...row, items: trim(row.items) });
      else result.push(row);
    }
    return result;
  };
  const result = trim(items);
  if (truncated) result.push({ kind: "label", label: "More options and full replies in textbutler tui" });
  result.push({ kind: "quit", label: "Quit Textbutler" });
  return result;
}

/** Map one owner daemon snapshot onto the shared menu contract. The daemon
 * stays the authority; product browser actions require explicit menu clicks. */
export function snapshotItems(snapshot: DesktopSnapshot, status: { confirmedAgeSeconds: number | null; fresh: boolean }): MenuItem[] {
  const connected = snapshot.connection === "connected";
  const paused = snapshot.settings.paused;
  const running = snapshot.automation?.state === "running";
  const state = connected ? (paused ? "Automatic replies paused" : running ? "Automatic replies running" : "Automatic replies need setup") : "Daemon disconnected";
  const active = snapshot.contacts.filter(contact => contact.settings.enabled).length;
  const accounts = snapshot.providerAccounts ?? [];
  const ready = accounts.filter(account => account.status === "ready").length;
  const age = status.confirmedAgeSeconds;
  const ageText = age !== null && age < 60 ? `${age}s ago` : `${Math.floor((age ?? 0) / 60)}m ago`;
  const updated = age === null ? "Daemon status not confirmed" : status.fresh ? `Updated ${ageText}` : `Last confirmed ${ageText}`;
  return boundedMenu([
    { kind: "label", label: menuLabel(state) },
    { kind: "label", label: menuLabel(`${active} enabled of ${snapshot.contacts.length} contacts · limit ${snapshot.settings.activeContactLimit}`) },
    { kind: "submenu", label: "Status detail", items: detailItems(snapshot.automation?.detail ?? snapshot.detail) },
    { kind: "separator" },
    { kind: "action", id: "toggle-pause", label: "Automatic replies paused", checked: paused, enabled: connected },
    { kind: "submenu", label: "Get started", items: [
      { kind: "label", label: "1. Connect an app  2. Add a conversation" },
      { kind: "label", label: "3. Try the inbox with automatic replies off" },
      { kind: "label", label: "Guided setup: textbutler tui" },
      ...(!connected ? [{ kind: "action" as const, id: "daemon.install", label: "Start background service" }] : []),
      { kind: "action", id: "open-guide", label: "Read the setup guide…" },
    ] },
    { kind: "submenu", label: "Messaging apps", items: [
      ...(snapshot.messagingProviders ?? []).map(provider => ({ kind: "action" as const, id: `messaging.start:${provider}`,
        label: provider === "beeper" ? "Connect Beeper (linked apps)" : provider === "imessage" ? "Connect iMessage" : "Start WhatsApp sync", enabled: connected })),
      ...(!(snapshot.messagingProviders?.length) ? [{ kind: "label" as const, label: "Add your app connections in textbutler tui" }] : []),
      { kind: "action", id: "contacts.discover", label: "Find conversations to add…", enabled: connected },
    ] },
    { kind: "submenu", label: `Replies · ${snapshot.replies ? snapshot.replies.pending.reduce((count, item) => count + item.pendingCount, 0) : 0} waiting`, items: replyItems(snapshot) },
    { kind: "submenu", label: "Contacts", items: contactItems(snapshot.contacts, snapshot.providerAccounts) },
    { kind: "submenu", label: `Agent accounts · ${ready} of ${accounts.length} ready`, items: accountItems(snapshot) },
    { kind: "submenu", label: "Capabilities", items: capabilityItems(snapshot) },
    { kind: "submenu", label: "Recent activity", items: activityItems(snapshot.activity) },
    { kind: "separator" },
    { kind: "label", label: menuLabel(updated) },
    { kind: "action", id: "refresh", label: "Refresh status" },
    { kind: "action", id: "open-website", label: "Open Textbutler…" },
    { kind: "action", id: "product.support", label: "Support Textbutler development (optional paid)…" },
    { kind: "separator" },
    { kind: "quit", label: "Quit Textbutler" },
  ]);
}

/** The Textbutler menu companion is a disposable client of the owner daemon.
 * All state reads and mutations use the existing owner-only control socket;
 * the shared runner renders them and enforces revision-checked dispatch. */
export function companionOptions(dataDir: string, open: typeof openBrowser = openBrowser, entrypoint: string = fileURLToPath(new URL("cli.ts", import.meta.url)), options: { request?: OwnerControlClient; jobWaitMs?: number } = {}): CompanionOptions {
  const request = options.request ?? ((value: ControlRequest) => requestDaemon({ dataDir, request: value }));
  let lastSnapshot: DesktopSnapshot | null = null;
  let confirmedAt: number | null = null;
  let candidates: readonly ConversationCandidate[] = [];
  let candidateRevision: number | null = null;
  let discoveryDetail = "";
  let pendingJobId: string | null = null;
  let lastOperationDetail: string | null = null;
  /** Job-backed control calls resolve their stored result before returning. */
  const daemonJob = async (operation: ControlRequest): Promise<ControlResponse> => {
    if (pendingJobId !== null) throw new Error("previous-operation-pending");
    const response = await awaitOwnerJob(operation, request, { waitMs: options.jobWaitMs ?? 90_000 });
    if (response.ok && response.kind === "job") pendingJobId = response.jobId;
    return response;
  };
  return {
    appId: "textbutler",
    name: "Textbutler",
    title: "\u{1f916}",
    icon: TRAY_ICON,
    tooltip: "Textbutler status and controls",
    stateDir: join(dataDir, "menubar"),
    refreshMs: 15_000,
    snapshot: async () => {
      let snapshot: DesktopSnapshot, fresh = false;
      try {
        const response = await request({ protocol: CONTROL_PROTOCOL, command: "snapshot" });
        if (!response.ok) {
          snapshot = disconnectedSnapshot(menuLabel(response.message, 180));
        } else if (response.kind !== "snapshot" || lastSnapshot !== null && response.snapshot.revision < lastSnapshot.revision) {
          // A late or replayed response must never undo a newer owner revision.
          snapshot = disconnectedSnapshot("The daemon returned unreadable status.");
        } else {
          snapshot = response.snapshot;
          lastSnapshot = snapshot;
          confirmedAt = Date.now();
          fresh = true;
        }
      } catch {
        snapshot = disconnectedSnapshot();
        lastSnapshot = null;
      }
      const items = snapshotItems(snapshot, { confirmedAgeSeconds: confirmedAt === null ? null : Math.max(0, Math.floor((Date.now() - confirmedAt) / 1000)), fresh });
      if (candidateRevision !== null && candidateRevision === snapshot.revision) {
        items.splice(7, 0, { kind: "submenu", label: "Add a conversation", items: [
          ...detailItems(discoveryDetail),
          ...candidates.slice(0, 12).map(candidate => ({ kind: "submenu" as const, label: menuLabel(candidate.name) || "Conversation", items: [
            ...detailItems(candidate.subtitle), ...(!candidate.eligible ? detailItems(candidate.reason) : []),
            { kind: "action" as const, id: `contact.add:${candidate.id}`, label: "Add with automatic replies off", enabled: candidate.eligible },
          ] })),
          ...(candidates.length > 12 ? [{ kind: "label" as const, label: "More conversations in textbutler tui" }] : []),
        ] });
      }
      if (lastOperationDetail) items.splice(1, 0, { kind: "submenu", label: "Last operation", items: detailItems(lastOperationDetail) });
      if (pendingJobId) items.splice(1, 0, { kind: "submenu", label: "An operation is still pending", items: [
        { kind: "label", label: "Do not repeat it; inspect its final result." },
        { kind: "label", label: menuLabel(`textbutler jobs show ${pendingJobId}`) },
        { kind: "action", id: "job.refresh", label: "Check pending operation" },
      ] });
      return boundedMenu(items);
    },
    onAction: async id => {
      if (id === "job.refresh" && pendingJobId) {
        const response = await request({ protocol: CONTROL_PROTOCOL, command: "owner.job.read", jobId: pendingJobId });
        if (response.ok && response.kind === "job" || !response.ok && response.code === "disconnected") throw new Error("operation-not-yet-confirmed");
        const completedJob = pendingJobId;
        pendingJobId = null;
        if (!response.ok) { lastOperationDetail = `Job ${completedJob}: ${response.message} Inspect the outcome before repeating the original action.`; return; }
        if (response.kind === "conversations") { candidates = response.candidates; candidateRevision = lastSnapshot?.revision ?? null; discoveryDetail = response.detail; }
        if (response.kind === "snapshot" || response.kind === "enrolled") { lastSnapshot = response.snapshot; candidates = []; candidateRevision = null; }
        lastOperationDetail = response.kind === "reply-sent" ? `Reply outcome: ${response.state}. ${response.detail}` : "The pending operation completed. Refresh to see its current state.";
        return;
      }
      if (id === "open-guide") { await open("https://github.com/hraness/textbutler/blob/main/docs/textbutler/getting-started.md"); return; }
      if (id === "daemon.install") { await createLaunchAgentLifecycle(defaultLaunchAgentHost(entrypoint)).install(dataDir); return; }
      if (id === "contacts.discover") {
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "conversations.list" });
        if (!response.ok || response.kind !== "conversations") throw new Error("conversation-discovery-unconfirmed");
        candidates = response.candidates; candidateRevision = lastSnapshot?.revision ?? null; discoveryDetail = response.detail;
        return;
      }
      if (id.startsWith("messaging.start:")) {
        const provider = id.slice(16);
        if (provider !== "imessage" && provider !== "whatsapp" && provider !== "beeper" || !lastSnapshot?.messagingProviders?.includes(provider)) return;
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "messaging.start", provider });
        if (!response.ok || response.kind === "job") throw new Error("messaging-connection-unconfirmed");
        return;
      }
      if (id.startsWith("contact.add:")) {
        const candidate = candidates.find(candidate => candidate.id === id.slice(12));
        if (!candidate?.eligible || !lastSnapshot || candidateRevision !== lastSnapshot.revision) throw new Error("refresh-conversation-selection");
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "contact.enroll", candidateId: candidate.id,
          expectedRevision: lastSnapshot.revision, initializeHistory: false });
        candidates = []; candidateRevision = null;
        if (!response.ok || response.kind !== "enrolled") throw new Error("contact-enrollment-unconfirmed");
        return;
      }
      if (id.startsWith("contact.toggle:") || id.startsWith("contact.account:")) {
        const snapshot = lastSnapshot;
        if (!snapshot) return;
        const contact = snapshot.contacts.find(contact => id === `contact.toggle:${contact.id}` ||
          snapshot.providerAccounts?.some(account => id === `contact.account:${contact.id}:${account.id}`));
        if (!contact) return;
        const account = snapshot.providerAccounts?.find(account => id === `contact.account:${contact.id}:${account.id}`);
        if (account && (contact.settings.enabled || account.status !== "ready")) return;
        const settings = account ? { ...contact.settings, accountId: account.id, provider: account.provider }
          : { ...contact.settings, enabled: !contact.settings.enabled };
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "contact.settings.update", contactId: contact.id,
          expectedRevision: snapshot.revision, settings });
        if (!response.ok || response.kind === "job") throw new Error("contact-settings-unconfirmed");
        return;
      }
      if (id === "open-website") { await open(WEBSITE); return; }
      if (id === "product.support") { await open(SUPPORT); return; }
      if (id === "refresh") return; // the runner re-reads state after every action
      if (id === "replies.scan") {
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "replies.scan" });
        if (!response.ok || response.kind === "job") throw new Error("replies-scan-unconfirmed");
        return;
      }
      if (id.startsWith("replies.suggest:")) {
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "replies.suggest", contactId: id.slice(16) });
        if (!response.ok || response.kind === "job") throw new Error("replies-suggest-unconfirmed");
        return;
      }
      // The menu exposes previews only. Full ordered actions and their digest
      // are reviewed in the TUI/CLI before a draft can be sent.
      if (id.startsWith("replies.send:")) throw new Error("full-draft-review-required");
      if (id.startsWith("replies.discard:")) {
        const response = await request({ protocol: CONTROL_PROTOCOL, command: "replies.discard", draftId: id.slice(16) });
        if (!response.ok) throw new Error(`replies-discard-${response.code}`);
        return;
      }
      if (id === "toggle-pause") {
        const current = lastSnapshot;
        if (!current || current.connection !== "connected") return;
        const response = await request({
            protocol: CONTROL_PROTOCOL, command: "global.settings.update",
            expectedRevision: current.revision,
            settings: { paused: !current.settings.paused, activeContactLimit: current.settings.activeContactLimit },
        });
        // The runner re-reads state after this callback; a daemon rejection or
        // indeterminate mutation is observed there, never retried here.
        if (!response.ok) throw new Error(`settings-update-${response.code}`);
      }
    },
  };
}

/** Delegate the product `menubar` command family to the shared lifecycle. */
export function companionForeground(dataDir: string, entrypoint: string, host: { home: string; runtime: string } = { home: homedir(), runtime: process.execPath }): { executable: string; args: readonly string[] } {
  return isolatedBunInvocation({ ...host, entrypoint, args: ["menubar", "--foreground", "--data-dir", dataDir] });
}
export async function runMenuBarCommand(args: readonly string[], dataDir: string, entrypoint: string, write: (result: unknown) => void): Promise<number> {
  return await handleCompanionCommand(companionOptions(dataDir, openBrowser, entrypoint), {
    args,
    foreground: companionForeground(dataDir, entrypoint),
    write,
  });
}
