import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryFailureDetail } from "./automation-owner.ts";
import { symbolsFor } from "./cli-style.ts";
import { formatNotice, formatRecovery, MESSAGES_AUTOMATION, MESSAGES_FDA, recoverySentence, renderPrePrompt, SETTINGS_URLS, settingsUrl } from "./permission-copy.ts";
import { prePrompt, recover, type Key, type PromptIO } from "./permission-prompt.ts";
import { macosAccessStep, shellWord } from "./permission-readiness.ts";

const UTF8 = symbolsFor({ LANG: "en_US.UTF-8" }), ASCII = symbolsFor({ TERM: "dumb" });

describe("permission copy follows the shared templates", () => {
  test("pre-prompt notices", () => {
    expect(formatNotice(renderPrePrompt(MESSAGES_FDA, true), UTF8)).toMatchSnapshot("fda interactive");
    expect(formatNotice(renderPrePrompt(MESSAGES_FDA, false), UTF8)).toMatchSnapshot("fda non-interactive");
    expect(formatNotice(renderPrePrompt(MESSAGES_AUTOMATION, true), UTF8)).toMatchSnapshot("automation interactive");
    expect(formatNotice(renderPrePrompt(MESSAGES_AUTOMATION, false), ASCII)).toMatchSnapshot("automation ascii");
    // SPEC Appendix B worked examples, verbatim.
    expect(formatNotice(renderPrePrompt(MESSAGES_FDA, true), UTF8)).toBe("🔐 Textbutler needs Full Disk Access to read your Messages.\n"
      + "   macOS doesn't ask for this. Turn on Textbutler in System Settings › Privacy & Security › Full Disk Access. Only the chats you pick are read.\n"
      + "   Press Enter to open Settings · s to skip\n");
    expect(formatNotice(renderPrePrompt(MESSAGES_AUTOMATION, true), UTF8)).toBe("🔐 macOS will ask to let Textbutler control Messages.\n"
      + "   Textbutler only sends replies in chats you turn on. Change this any time in System Settings › Privacy & Security › Automation.\n"
      + "   Press Enter to continue · s to skip\n");
  });
  test("recovery after a denial or an unconfirmed result", () => {
    for (const need of [MESSAGES_FDA, MESSAGES_AUTOMATION]) {
      expect(formatRecovery(need, "denied", true, UTF8)).toMatchSnapshot(`${need.kind} denied interactive`);
      expect(formatRecovery(need, "denied", false, ASCII)).toMatchSnapshot(`${need.kind} denied ascii`);
      expect(formatRecovery(need, "unknown", false, UTF8)).toMatchSnapshot(`${need.kind} unknown`);
    }
    expect(recoverySentence(MESSAGES_FDA, "unknown")).toBe("Textbutler couldn't read your Messages. macOS may be blocking Textbutler. Check System Settings › Privacy & Security › Full Disk Access.");
  });
  test("only the two privacy panes can be opened", () => {
    expect(SETTINGS_URLS).toEqual([settingsUrl("full-disk-access"), settingsUrl("automation")]);
    for (const url of SETTINGS_URLS) expect(url).toStartWith("x-apple.systempreferences:com.apple.preference.security?Privacy_");
  });
  test("an unreadable Messages database points to Full Disk Access, never Ghostget", () => {
    const fda = discoveryFailureDetail("imessage", "iMessage", { stage: "provider", code: "remote-unavailable", native: { phase: "native-chats", code: "database-unreadable" } });
    expect(fda).toContain("Full Disk Access");
    expect(fda).not.toContain("Ghostget");
    expect(discoveryFailureDetail("whatsapp", "WhatsApp", { stage: "transport", code: "transport-unavailable" }))
      .toBe("WhatsApp conversations are unavailable. Check its connection and sign-in in Ghostget, then refresh.");
  });
});

function fakeIO(options: { env?: Record<string, string>; tty?: boolean; key?: Key } = {}): PromptIO & { out: string; opened: string[]; asked: number } {
  const io = {
    env: { LANG: "en_US.UTF-8", ...options.env }, stdinIsTTY: options.tty ?? true, stderrIsTTY: options.tty ?? true, out: "", opened: [] as string[], asked: 0,
    write(text: string) { io.out += text; },
    async readKey() { io.asked++; return options.key ?? "enter"; },
    async openUrl(url: string) { io.opened.push(url); return true; },
  };
  return io;
}

describe("pre-prompt and recovery by audience", () => {
  test("a person at a terminal confirms; Enter opens Full Disk Access settings", async () => {
    const io = fakeIO();
    expect(await prePrompt(MESSAGES_FDA, io)).toBe("continue");
    expect(io.out).toContain("Press Enter to open Settings · s to skip");
    expect(io.opened).toEqual([settingsUrl("full-disk-access")]);
  });
  test("Automation continues on Enter without opening anything; macOS asks next", async () => {
    const io = fakeIO();
    expect(await prePrompt(MESSAGES_AUTOMATION, io)).toBe("continue");
    expect(io.opened).toEqual([]);
  });
  test("s or a timeout skips", async () => {
    for (const key of ["s", "timeout"] as const) {
      const io = fakeIO({ key });
      expect(await prePrompt(MESSAGES_AUTOMATION, io)).toBe("skip");
      expect(io.opened).toEqual([]);
    }
  });
  test("an agent gets one JSON line and nothing waits", async () => {
    const io = fakeIO({ env: { CLAUDECODE: "1" } });
    expect(await prePrompt({ ...MESSAGES_AUTOMATION, whenUnattended: "proceed" }, io)).toBe("unattended-proceed");
    expect(io.asked).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ type: "permission-notice", product: "Textbutler", kind: "automation",
      message: "macOS will ask to let Textbutler control Messages. Textbutler only sends replies in chats you turn on. Change this any time in System Settings › Privacy & Security › Automation." });
  });
  test("no terminal prints nothing and never waits", async () => {
    const io = fakeIO({ tty: false });
    expect(await prePrompt(MESSAGES_FDA, io)).toBe("unattended-stop");
    expect(io.out).toBe("");
    expect(io.asked).toBe(0);
  });
  test("recovery offers o to open the pane only after a denial at a terminal", async () => {
    const denied = fakeIO({ key: "o" });
    await recover(MESSAGES_AUTOMATION, "denied", denied);
    expect(denied.out).toMatchSnapshot("automation denied recovery");
    expect(denied.opened).toEqual([settingsUrl("automation")]);
    const unknown = fakeIO({ key: "o" });
    await recover(MESSAGES_AUTOMATION, "unknown", unknown);
    expect(unknown.asked).toBe(0);
    const agent = fakeIO({ env: { AI_AGENT: "x" } });
    await recover(MESSAGES_AUTOMATION, "denied", agent);
    expect(agent.out).toBe("");
  });
});

describe("doctor's macOS access step", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function dataDir(files: Record<string, unknown> = {}): Promise<string> {
    const root = await mkdtemp(join(await realpath(tmpdir()), "textbutler-access-")); roots.push(root);
    await mkdir(join(root, "state"), { mode: 0o700 });
    for (const [name, value] of Object.entries(files)) { const path = join(root, "state", name); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600); }
    return root;
  }
  test("is absent unless iMessage is set up on a Mac", async () => {
    const dir = await dataDir();
    expect(await macosAccessStep({ dataDir: dir, imessageConfigured: false, platform: "darwin" })).toBeUndefined();
    expect(await macosAccessStep({ dataDir: dir, imessageConfigured: true, platform: "linux" })).toBeUndefined();
  });
  test("walks from installing the app to a finished setup", async () => {
    const app = { schemaVersion: 1 };
    const rows = [];
    for (const files of [{}, { "macos-app.json": app }, { "macos-app.json": app, "imessage-setup-result.json": { status: "blocked", automationPermission: "denied" } },
      { "macos-app.json": app, "imessage-setup-result.json": { status: "blocked", automationPermission: "unavailable" } },
      { "macos-app.json": app, "imessage-setup-result.json": { status: "recovery-required", automationPermission: "allowed" } },
      { "macos-app.json": app, "imessage-setup-result.json": { status: "completed", automationPermission: "allowed" } }]) {
      const dir = await dataDir(files);
      const step = (await macosAccessStep({ dataDir: dir, imessageConfigured: true, platform: "darwin" }))!;
      expect(step.detail).not.toContain("Ghostget");
      rows.push({ ...step, ...(step.command ? { command: step.command.replace(dir, "<data-dir>") } : {}) });
    }
    expect(rows.map(row => row.status)).toEqual(["action-needed", "action-needed", "blocked", "blocked", "action-needed", "done"]);
    expect(rows[2]!.settingsUrl).toBe(settingsUrl("automation"));
    expect(rows).toMatchSnapshot("access steps");
  });
  test("the suggested setup command survives a data folder with a space or quote", () => {
    expect(shellWord("/Volumes/Data/Application Support/Textbutler")).toBe("'/Volumes/Data/Application Support/Textbutler'");
    expect(shellWord("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellWord("/private/data")).toBe("/private/data");
  });
  test("a group-readable app record is reported, not trusted", async () => {
    const dir = await dataDir({ "macos-app.json": { schemaVersion: 1 } });
    await chmod(join(dir, "state", "macos-app.json"), 0o644);
    expect((await macosAccessStep({ dataDir: dir, imessageConfigured: true, platform: "darwin" }))!.status).toBe("blocked");
  });
});
