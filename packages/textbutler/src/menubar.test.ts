import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planAutostart, validateSnapshot, type MenuItem, type Snapshot } from "@hraness/desktop-foundation";
import { runTextbutlerCli } from "./cli.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";
import { companionForeground, companionOptions, menuLabel, snapshotItems } from "./menubar.ts";
import { TRAY_ICON } from "./menubar-icon.ts";
import { disconnectedSnapshot, type DesktopSnapshot } from "../../control/src/index.ts";

const roots: string[] = [], daemons: RunningDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> { const path = await mkdtemp(join(await realpath("/tmp"), "textbutler-menubar-")); roots.push(path); return path; }
async function start(dataDir: string): Promise<RunningDaemon> { const daemon = await startDaemon({ dataDir }); daemons.push(daemon); return daemon; }

/** The produced items must satisfy the shared runner's wire contract. */
function wire(items: readonly MenuItem[]): ReadonlyMap<string, boolean> {
  return validateSnapshot({ version: 1, type: "snapshot", appId: "textbutler", name: "Textbutler", title: "\u{1f916}", icon: TRAY_ICON, revision: 1, items } satisfies Snapshot);
}
function labels(items: readonly MenuItem[]): string[] {
  return items.flatMap(item => item.kind === "separator" ? [] : item.kind === "submenu" ? [item.label, ...labels(item.items)] : [item.label]);
}
function action(items: readonly MenuItem[], id: string): Extract<MenuItem, { kind: "action" }> {
  const found = items.find(item => item.kind === "action" && item.id === id);
  if (!found || found.kind !== "action") throw new Error(`missing action ${id}`);
  return found;
}
function base(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return { ...disconnectedSnapshot(), connection: "connected", revision: 7, ...overrides };
}

describe("menu label presentation", () => {
  test("sanitizes control, newline and bidi text before it reaches a menu row", () => {
    expect(menuLabel("a\u202Ab\nc\u0000d\u2066e")).toBe("a b c d e");
    expect(menuLabel("  spaced   out ")).toBe("spaced out");
    expect(menuLabel("\u202e\u2067\u0007")).toBe("");
  });
  test("truncates by unicode scalar values at the bound", () => {
    const result = menuLabel("x".repeat(100));
    expect([...result].length).toBe(72);
    expect(result.endsWith("…")).toBe(true);
    expect(menuLabel("emoji 😀 ".repeat(30), 10)).toBe("emoji 😀 e…");
  });
});

describe("companion identity", () => {
  test("carries the robot status mark and bundled 32x32 tray art", () => {
    const options = companionOptions(join(roots[0] ?? "/tmp/tb-menubar-test", "data"), () => Promise.resolve());
    expect(options.title).toBe("\u{1f916}");
    expect(options.icon).toBe(TRAY_ICON);
    expect(TRAY_ICON.width).toBe(32);
    expect(TRAY_ICON.height).toBe(32);
    expect(Buffer.from(TRAY_ICON.rgba, "base64").length).toBe(32 * 32 * 4);
  });
  test("immediate and login restarts share isolated argv despite planted Bun configuration", async () => {
    const directory = await root(), home = join(directory, "home"), cwd = join(directory, "untrusted-cwd"), dataDir = join(directory, "data");
    await mkdir(home); await mkdir(cwd);
    const entrypoint = join(directory, "synthetic-entrypoint.mjs"), injected = join(directory, "injected.js");
    await writeFile(injected, 'process.stdout.write("UNSAFE-PRELOAD\\n");');
    await writeFile(entrypoint, 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), home: process.env.HOME, inherited: process.env.TEXTBUTLER_INJECTED }) + "\\n");');
    for (const file of [join(cwd, "bunfig.toml"), join(home, ".bunfig.toml")]) await writeFile(file, `preload = [${JSON.stringify(injected)}]\n`);
    await writeFile(join(cwd, ".env"), "TEXTBUTLER_INJECTED=from-file\n");
    const command = companionForeground(dataDir, entrypoint, { home, runtime: await realpath(process.execPath) });
    const plan = planAutostart({ id: "textbutler", label: "Textbutler", platform: "darwin", home, executable: command.executable, args: [...command.args] });
    const array = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/su.exec(plan.contents)?.[1];
    const args = [...array!.matchAll(/<string>(.*?)<\/string>/gsu)].map(match => match[1]!.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
    expect(args).toEqual([command.executable, ...command.args]);
    const child = Bun.spawn(args, { cwd, env: { HOME: home, BUN_OPTIONS: `--preload=${injected}`, NODE_OPTIONS: `--require=${injected}`, TEXTBUTLER_INJECTED: "from-environment" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).toBe(""); expect(stdout).not.toContain("UNSAFE-PRELOAD");
    expect(JSON.parse(stdout)).toEqual({ cwd: "/", home, args: ["menubar", "--foreground", "--data-dir", dataDir] });
  });
});

describe("snapshot menu mapping", () => {
  test("reflects paused, running, setup and disconnected states in the wire contract", () => {
    for (const [snapshot, state, checked, enabled] of [
      [base(), "Automatic replies paused", true, true],
      [base({ settings: { paused: false, activeContactLimit: 5 }, automation: { state: "running", detail: "Replies are live." } }), "Automatic replies running", false, true],
      [base({ settings: { paused: false, activeContactLimit: 5 } }), "Automatic replies need setup", false, true],
      [disconnectedSnapshot(), "Daemon disconnected", true, false],
    ] as const) {
      const items = snapshotItems(snapshot, { confirmedAgeSeconds: 3, fresh: true });
      const actions = wire(items);
      expect(items[0]).toMatchObject({ kind: "label", label: state });
      const toggle = action(items, "toggle-pause");
      expect(toggle.checked).toBe(checked);
      expect(toggle.enabled).toBe(enabled);
      expect(actions.get("toggle-pause")).toBe(enabled);
      expect(action(items, "refresh").enabled).not.toBe(false);
      expect(actions.get("product.support")).toBe(true);
      expect(actions.has("product.updates")).toBe(false);
      expect(items.at(-1)).toMatchObject({ kind: "quit", label: "Quit Textbutler" });
    }
  });
  test("bounds contact rows and reports the remainder", () => {
    const contacts = Array.from({ length: 23 }, (_, index) => ({
      id: `contact-${index}`, name: `Contact ${index}\u202a`, subtitle: `Subtitle ${index}`,
      settings: { enabled: index % 2 === 0, responseMode: "smart" as const, keyword: "butler", provider: "codex" as const, disclosure: { character: "🤖", begin: "{", end: "}" } },
    }));
    const items = snapshotItems(base({ contacts }), { confirmedAgeSeconds: 0, fresh: true });
    wire(items);
    const contactsMenu = items.find(item => item.kind === "submenu" && item.label === "Contacts");
    if (contactsMenu?.kind !== "submenu") throw new Error("missing contacts submenu");
    expect(contactsMenu.items.filter(item => item.kind === "submenu").length).toBe(20);
    expect(labels(contactsMenu.items)).toContain("3 more contacts");
    expect(labels(items).some(label => /[\u202a-\u202e]/u.test(label))).toBe(false);
    expect(items[1]).toMatchObject({ label: "12 enabled of 23 contacts · limit 5" });
  });
  test("summarizes accounts, capabilities and newest-first activity", () => {
    const items = snapshotItems(base({
      providerAccounts: [
        { id: "claude-main", label: "Claude primary", provider: "claude", route: "claude-api", status: "ready", detail: "Ready detail", defaultReplyModel: "m", classifierModel: "c" },
        { id: "codex-main", label: "Codex primary", provider: "codex", route: "codex", status: "setup-required", detail: "Setup detail", defaultReplyModel: null, classifierModel: null },
      ],
      activity: [
        { id: "old", at: "2026-01-01T00:00:00Z", contactId: null, title: "Old event", detail: "old detail" },
        { id: "new", at: "2026-03-01T00:00:00Z", contactId: null, title: "New event", detail: "new detail" },
      ],
    }), { confirmedAgeSeconds: 61, fresh: true });
    wire(items);
    const all = labels(items);
    expect(all).toContain("Agent accounts · 1 of 2 ready");
    expect(all).toContain("Claude primary · Ready");
    expect(all).toContain("Codex primary · Setup required");
    expect(all).toContain("Messages · Setup required");
    expect(all.indexOf("New event")).toBeLessThan(all.indexOf("Old event"));
    expect(all).toContain("Updated 1m ago");
  });
  test("marks unconfirmed and stale states distinctly", () => {
    expect(labels(snapshotItems(disconnectedSnapshot(), { confirmedAgeSeconds: null, fresh: false }))).toContain("Daemon status not confirmed");
    expect(labels(snapshotItems(disconnectedSnapshot(), { confirmedAgeSeconds: 90, fresh: false }))).toContain("Last confirmed 1m ago");
  });
});

describe("owner replies submenu", () => {
  const replies = (overrides: Partial<import("../../control/src/index.ts").RepliesView> = {}) => ({
    scannedAt: "2026-03-01T00:00:00Z", pending: [], drafts: [], ...overrides,
  });
  const pending = {
    contactId: "contact-1", name: "Alice Example", provider: "imessage" as const, enabled: true,
    pendingCount: 2, lastInboundAt: "2026-03-01T00:00:00Z", preview: "Dinner at 7?\u202e", sendable: true, reason: null,
  };
  const draft = {
    id: "draft:abc", contactId: "contact-1", name: "Alice Example", summary: "Suggestion",
    preview: "\ud83e\udd16{ Yes, 7 works. }", actionCount: 1, expiresAt: "2026-03-01T00:15:00Z",
  };
  function repliesMenu(items: readonly MenuItem[]): Extract<MenuItem, { kind: "submenu" }> {
    const menu = items.find(item => item.kind === "submenu" && item.label.startsWith("Replies"));
    if (menu?.kind !== "submenu") throw new Error("missing replies submenu");
    return menu;
  }
  test("pending conversations offer a scan and a suggest action only when sendable", () => {
    const items = snapshotItems(base({ replies: replies({ pending: [pending] }) }), { confirmedAgeSeconds: 0, fresh: true });
    wire(items);
    const menu = repliesMenu(items);
    expect(menu.label).toBe("Replies · 2 waiting");
    const all = labels(menu.items);
    expect(all).toContain("Alice Example · 2 to answer");
    expect(all.some(label => label.includes("\u202e"))).toBe(false);
    expect(all.some(label => label.includes("Dinner at 7?"))).toBe(true);
    const conversation = menu.items.find(item => item.kind === "submenu" && item.label.includes("Alice Example"));
    if (conversation?.kind !== "submenu") throw new Error("missing conversation row");
    expect(conversation.items.some(item => item.kind === "action" && item.id === "replies.suggest:contact-1")).toBe(true);
    const blocked = snapshotItems(base({ replies: replies({ pending: [{ ...pending, sendable: false, reason: "A previous send needs reconciliation." }], drafts: [] }) }), { confirmedAgeSeconds: 0, fresh: true });
    const blockedMenu = repliesMenu(blocked);
    const blockedConversation = blockedMenu.items.find(item => item.kind === "submenu" && item.label.includes("Alice Example"));
    if (blockedConversation?.kind !== "submenu") throw new Error("missing blocked row");
    expect(labels(blockedConversation.items)).toContain("A previous send needs reconciliation.");
    expect(blockedConversation.items.some(item => item.kind === "action" && item.id === "replies.suggest:contact-1")).toBe(false);
  });
  test("draft previews require full terminal review and only expose discard", () => {
    const items = snapshotItems(base({ replies: replies({ pending: [pending], drafts: [draft] }) }), { confirmedAgeSeconds: 0, fresh: true });
    wire(items);
    const menu = repliesMenu(items);
    const draftRow = menu.items.find(item => item.kind === "submenu" && item.label === "Draft · Alice Example");
    if (draftRow?.kind !== "submenu") throw new Error("missing draft row");
    expect(labels(draftRow.items)).toContain("\ud83e\udd16{ Yes, 7 works. }");
    expect(draftRow.items.some(item => item.kind === "action" && item.id === "replies.send:draft:abc")).toBe(false);
    expect(labels(draftRow.items)).toContain("Preview only · full review in textbutler tui");
    expect(draftRow.items.some(item => item.kind === "action" && item.id === "replies.discard:draft:abc")).toBe(true);
    // The menu never offers a free-text send path.
    const ids = JSON.stringify(items);
    expect(ids).not.toContain("replies.text");
    expect(ids.match(/"replies.send:[^"]*"/g)).toBeNull();
  });
  test("empty and unconfigured reply states stay explanatory", () => {
    const fresh = repliesMenu(snapshotItems(base({ replies: replies() }), { confirmedAgeSeconds: 0, fresh: true }));
    expect(fresh.label).toBe("Replies · 0 waiting");
    expect(labels(fresh.items)).toContain("Nothing waiting for a reply");
    const unscanned = repliesMenu(snapshotItems(base({ replies: replies({ scannedAt: null }) }), { confirmedAgeSeconds: 0, fresh: true }));
    expect(labels(unscanned.items)).toContain("Check for replies to scan enrolled conversations");
    const missing = repliesMenu(snapshotItems(base(), { confirmedAgeSeconds: 0, fresh: true }));
    expect(labels(missing.items)).toContain("Messaging automation is not configured");
  });
  test("stale menu send actions cannot bypass full draft review", async () => {
    const dataDir = await root();
    await start(dataDir);
    const options = companionOptions(dataDir);
    const signal = new AbortController().signal;
    // No messaging automation: every replies action fails closed at the daemon.
    await expect(options.onAction("replies.send:draft:abc", signal)).rejects.toThrow("full-draft-review-required");
    await expect(options.onAction("replies.suggest:contact-1", signal)).rejects.toThrow("replies-suggest-unconfirmed");
    await expect(options.onAction("replies.discard:draft:abc", signal)).rejects.toThrow("replies-discard-unavailable");
  });
});

describe("daemon-backed companion options", () => {
  test("support stays available offline and opens only after an explicit action", async () => {
    const dataDir = await root();
    const destinations: string[] = [];
    const options = companionOptions(dataDir, async address => { destinations.push(address); });
    const signal = new AbortController().signal;
    const items = await options.snapshot(signal);
    expect(wire(items).get("product.support")).toBe(true);
    expect(destinations).toEqual([]);
    await options.onAction("unknown.action", signal);
    expect(destinations).toEqual([]);
    await options.onAction("product.support", signal);
    expect(destinations).toEqual(["https://account.hraness.com/support?product=message-like-me&source=desktop#support"]);
    expect(items.some(item => item.kind === "action" && item.id === "product.updates")).toBe(false);
  });
  test("snapshot maps a live owner daemon response and marks it fresh", async () => {
    const dataDir = await root();
    const daemon = await start(dataDir);
    const options = companionOptions(dataDir);
    const items = await options.snapshot(new AbortController().signal);
    wire(items);
    expect(items[0]).toMatchObject({ label: "Automatic replies paused" });
    expect(labels(items)).toContain("Updated 0s ago");
    expect((await daemon.service.snapshot()).revision).toBe(1);
  });
  test("an unreachable daemon degrades to a bounded disconnected menu", async () => {
    const dataDir = await root();
    const options = companionOptions(dataDir);
    const items = await options.snapshot(new AbortController().signal);
    wire(items);
    expect(items[0]).toMatchObject({ label: "Daemon disconnected" });
    expect(action(items, "toggle-pause").enabled).toBe(false);
    expect(labels(items)).toContain("Daemon status not confirmed");
  });
  test("toggle-pause applies one revision-checked daemon mutation and never retries", async () => {
    const dataDir = await root();
    const daemon = await start(dataDir);
    const options = companionOptions(dataDir);
    const signal = new AbortController().signal;
    await options.snapshot(signal);
    expect((await daemon.service.snapshot()).settings.paused).toBe(true);
    await options.onAction("toggle-pause", signal);
    expect((await daemon.service.snapshot()).settings.paused).toBe(false);
    // A stale in-memory revision is rejected by the daemon, not retried.
    await expect(options.onAction("toggle-pause", signal)).rejects.toThrow("settings-update-conflict");
    expect((await daemon.service.snapshot()).settings.paused).toBe(false);
    await options.snapshot(signal); // the runner re-reads state after an action
    await options.onAction("toggle-pause", signal);
    expect((await daemon.service.snapshot()).settings.paused).toBe(true);
  });
});

describe("menubar CLI routing", () => {
  test("status reports the shared companion lifecycle, not a LaunchAgent", async () => {
    const dataDir = await root();
    const lines: string[] = [];
    expect(await runTextbutlerCli(["menubar", "status", "--data-dir", dataDir], { write: text => lines.push(text) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ appId: "textbutler", running: false, state: "stopped" });
    expect(lines[0]).not.toContain("launchAgent");
  });
  test("unknown menubar verbs and extra arguments are rejected", async () => {
    await expect(runTextbutlerCli(["menubar", "bogus"], { write: () => {} })).rejects.toThrow();
    await expect(runTextbutlerCli(["menubar", "status", "extra"], { write: () => {} })).rejects.toThrow();
  });
});

test("fully populated menu stays within the native runner's total node budget", () => {
  const contacts = Array.from({ length: 20 }, (_, index) => ({ id: `contact-${index}`, name: `Contact ${index}`, subtitle: "Long relationship detail ".repeat(15),
    settings: { enabled: false, responseMode: "smart" as const, keyword: "butler", provider: "claude" as const, disclosure: { character: "🤖", begin: "{", end: "}" } } }));
  const accounts = Array.from({ length: 10 }, (_, index) => ({ id: `account-${index}`, label: `Account ${index}`, provider: "claude" as const, route: "claude-api" as const,
    status: "ready" as const, detail: "Long account diagnostic ".repeat(15), defaultReplyModel: "model", classifierModel: "model" }));
  const items = snapshotItems(base({ contacts, providerAccounts: accounts, messagingProviders: ["imessage", "whatsapp", "beeper"], replies: { scannedAt: "2026-09-19T00:00:00Z",
    pending: contacts.slice(0, 10).map(contact => ({ contactId: contact.id, name: contact.name, provider: "beeper", enabled: false, pendingCount: 2,
      lastInboundAt: "2026-09-19T00:00:00Z", preview: "long preview ".repeat(40), sendable: true, reason: null })),
    drafts: contacts.slice(0, 10).map(contact => ({ id: `draft:${contact.id}`, contactId: contact.id, name: contact.name, summary: "Reply", preview: "long draft ".repeat(40), actionCount: 3, expiresAt: "2026-09-19T01:00:00Z" })) },
    activity: Array.from({ length: 8 }, (_, index) => ({ id: `event-${index}`, at: "2026-09-19T00:00:00Z", contactId: null, title: "Activity", detail: "Long detail ".repeat(40) })) }),
    { confirmedAgeSeconds: 0, fresh: true });
  const actions = wire(items);
  expect(actions.get("toggle-pause")).toBe(true);
  expect(items.at(-1)?.kind).toBe("quit");
  expect(labels(items)).toContain("More options and full replies in textbutler tui");
});

test("pending menu operations keep the job ID and a terminal failure clears the busy state", async () => {
  const calls: string[] = [], signal = new AbortController().signal;
  const options = companionOptions("/unused", async () => {}, "/unused/cli.ts", { jobWaitMs: 0, request: async request => {
    calls.push(request.command);
    if (request.command === "snapshot") return { protocol: "textbutler.control.v1", ok: true, kind: "snapshot", snapshot: base() };
    if (request.command === "owner.job.read") return { protocol: "textbutler.control.v1", ok: false, code: "conflict", message: "The contact changed." };
    return { protocol: "textbutler.control.v1", ok: true, kind: "job", jobId: "job-123" };
  } });
  await options.snapshot(signal);
  await expect(options.onAction("contacts.discover", signal)).rejects.toThrow("unconfirmed");
  const pending = await options.snapshot(signal);
  expect(labels(pending)).toContain("textbutler jobs show job-123");
  await expect(options.onAction("contacts.discover", signal)).rejects.toThrow("previous-operation-pending");
  expect(calls.filter(command => command === "conversations.list")).toHaveLength(1);
  await options.onAction("job.refresh", signal);
  expect(labels(await options.snapshot(signal))).not.toContain("An operation is still pending");
  await expect(options.onAction("contacts.discover", signal)).rejects.toThrow("unconfirmed");
  expect(calls.filter(command => command === "conversations.list")).toHaveLength(2);
});
