import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateSnapshot, type MenuItem, type Snapshot } from "@hraness/desktop-foundation";
import { runTextbutlerCli } from "./cli.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";
import { companionOptions, menuLabel, snapshotItems } from "./menubar.ts";
import { disconnectedSnapshot, type DesktopSnapshot } from "../../control/src/index.ts";

const roots: string[] = [], daemons: RunningDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> { const path = await mkdtemp(join(await realpath("/tmp"), "textbutler-menubar-")); roots.push(path); return path; }
async function start(dataDir: string): Promise<RunningDaemon> { const daemon = await startDaemon({ dataDir }); daemons.push(daemon); return daemon; }

/** The produced items must satisfy the shared runner's wire contract. */
function wire(items: readonly MenuItem[]): ReadonlyMap<string, boolean> {
  return validateSnapshot({ version: 1, type: "snapshot", appId: "textbutler", name: "Textbutler", title: "Tb", revision: 1, items } satisfies Snapshot);
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
