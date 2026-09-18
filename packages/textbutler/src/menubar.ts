import { join } from "node:path";

import { handleCompanionCommand, openBrowser, type CompanionOptions, type MenuItem } from "@hraness/desktop-foundation";
import { CONTROL_PROTOCOL, disconnectedSnapshot, type ControlRequest, type ControlResponse, type DesktopSnapshot } from "../../control/src/index.ts";
import { requestDaemon } from "./daemon.ts";
import { TRAY_ICON } from "./menubar-icon.ts";

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

function contactItems(contacts: DesktopSnapshot["contacts"]): MenuItem[] {
  const rows: MenuItem[] = contacts.slice(0, 20).map(contact => ({
    kind: "submenu" as const,
    label: menuLabel(`${contact.name} · ${contact.settings.enabled ? "Enabled" : "Off"}`) || "Contact",
    items: [{ kind: "label" as const, label: contact.settings.enabled ? "Enabled" : "Disabled" }, ...detailItems(contact.subtitle)],
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
      { kind: "action" as const, id: `replies.send:${draft.id}`, label: "Send this reply" },
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
  return [
    { kind: "label", label: menuLabel(state) },
    { kind: "label", label: menuLabel(`${active} enabled of ${snapshot.contacts.length} contacts · limit ${snapshot.settings.activeContactLimit}`) },
    { kind: "submenu", label: "Status detail", items: detailItems(snapshot.automation?.detail ?? snapshot.detail) },
    { kind: "separator" },
    { kind: "action", id: "toggle-pause", label: "Automatic replies paused", checked: paused, enabled: connected },
    { kind: "submenu", label: `Replies · ${snapshot.replies ? snapshot.replies.pending.reduce((count, item) => count + item.pendingCount, 0) : 0} waiting`, items: replyItems(snapshot) },
    { kind: "submenu", label: "Contacts", items: contactItems(snapshot.contacts) },
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
  ];
}

/** The Textbutler menu companion is a disposable client of the owner daemon.
 * All state reads and mutations use the existing owner-only control socket;
 * the shared runner renders them and enforces revision-checked dispatch. */
export function companionOptions(dataDir: string, open: typeof openBrowser = openBrowser): CompanionOptions {
  let lastSnapshot: DesktopSnapshot | null = null;
  let confirmedAt: number | null = null;
  /** Job-backed control calls resolve their stored result before returning. */
  const daemonJob = async (request: ControlRequest): Promise<ControlResponse> => {
    let response = await requestDaemon({ dataDir, request });
    const deadline = Date.now() + 90_000;
    while (response.ok && response.kind === "job" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      response = await requestDaemon({ dataDir, request: { protocol: CONTROL_PROTOCOL, command: "owner.job.read", jobId: response.jobId } });
    }
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
        const response = await requestDaemon({ dataDir, request: { protocol: CONTROL_PROTOCOL, command: "snapshot" } });
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
      return snapshotItems(snapshot, { confirmedAgeSeconds: confirmedAt === null ? null : Math.max(0, Math.floor((Date.now() - confirmedAt) / 1000)), fresh });
    },
    onAction: async id => {
      if (id === "open-website") { await open(WEBSITE); return; }
      if (id === "product.support") { await open(SUPPORT); return; }
      if (id === "refresh") return; // the runner re-reads state after every action
      if (id === "replies.scan") {
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "replies.scan" });
        if (!response.ok) throw new Error(`replies-scan-${response.code}`);
        return;
      }
      if (id.startsWith("replies.suggest:")) {
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "replies.suggest", contactId: id.slice(16) });
        if (!response.ok) throw new Error(`replies-suggest-${response.code}`);
        return;
      }
      if (id.startsWith("replies.send:")) {
        // Sends only ever target an exact reviewed draft; there is no free-text path here.
        const response = await daemonJob({ protocol: CONTROL_PROTOCOL, command: "replies.send", draftId: id.slice(13) });
        if (!response.ok) throw new Error(`replies-send-${response.code}`);
        if (response.kind === "reply-sent" && response.state !== "submitted") throw new Error(`replies-send-${response.state}`);
        return;
      }
      if (id.startsWith("replies.discard:")) {
        const response = await requestDaemon({ dataDir, request: { protocol: CONTROL_PROTOCOL, command: "replies.discard", draftId: id.slice(16) } });
        if (!response.ok) throw new Error(`replies-discard-${response.code}`);
        return;
      }
      if (id === "toggle-pause") {
        const current = lastSnapshot;
        if (!current || current.connection !== "connected") return;
        const response = await requestDaemon({
          dataDir,
          request: {
            protocol: CONTROL_PROTOCOL, command: "global.settings.update",
            expectedRevision: current.revision,
            settings: { paused: !current.settings.paused, activeContactLimit: current.settings.activeContactLimit },
          },
        });
        // The runner re-reads state after this callback; a daemon rejection or
        // indeterminate mutation is observed there, never retried here.
        if (!response.ok) throw new Error(`settings-update-${response.code}`);
      }
    },
  };
}

/** Delegate the product `menubar` command family to the shared lifecycle. */
export async function runMenuBarCommand(args: readonly string[], dataDir: string, entrypoint: string, write: (result: unknown) => void): Promise<number> {
  return await handleCompanionCommand(companionOptions(dataDir), {
    args,
    foreground: { executable: process.execPath, args: [entrypoint, "menubar", "--foreground", "--data-dir", dataDir] },
    write,
  });
}
