import { describe, expect, test } from "bun:test";
import { runImessageSetupWithNotices } from "./macos-textbutler-app.ts";
import type { Key, PromptIO } from "../packages/textbutler/src/permission-prompt.ts";

// A fake launcher and fake terminal: nothing here touches launchd, Messages
// or System Settings.
function harness(options: { tty?: boolean; key?: Key; env?: Record<string, string>; code?: string; status?: "completed" | "blocked" }) {
  const state = { stderr: "", stdout: "", launched: 0, opened: [] as string[] };
  const io: PromptIO = {
    env: { LANG: "en_US.UTF-8", ...options.env }, stdinIsTTY: options.tty ?? true, stderrIsTTY: options.tty ?? true,
    write: text => { state.stderr += text; },
    readKey: async () => options.key ?? "enter",
    openUrl: async url => { state.opened.push(url); return true; },
  };
  const launch = async () => { state.launched++; return { status: options.status ?? "completed", resultPath: "/private/state/imessage-setup-result.json", ...(options.code ? { code: options.code } : {}) }; };
  return { state, io, launch, write: (text: string) => { state.stdout += text; } };
}

describe("iMessage app setup notices", () => {
  test("warns before macOS asks, then prints the one JSON result", async () => {
    const { state, io, launch, write } = harness({});
    expect(await runImessageSetupWithNotices("/private/data", io, launch, write)).toBe(0);
    expect(state.launched).toBe(1);
    expect(state.stderr).toStartWith("🔐 macOS will ask to let Textbutler control Messages.\n");
    expect(JSON.parse(state.stdout)).toEqual({ ok: true, status: "completed", resultPath: "/private/state/imessage-setup-result.json" });
  });
  test("s skips setup without launching it", async () => {
    const { state, io, launch, write } = harness({ key: "s" });
    expect(await runImessageSetupWithNotices("/private/data", io, launch, write)).toBe(1);
    expect(state.launched).toBe(0);
    expect(JSON.parse(state.stdout)).toEqual({ ok: false, status: "skipped", detail: "App setup was skipped. Nothing changed." });
  });
  test("a denial explains where to turn it on and offers the pane", async () => {
    const { state, io, launch, write } = harness({ key: "enter", code: "automation-permission-denied", status: "blocked" });
    let calls = 0; io.readKey = async () => (calls++ === 0 ? "enter" : "o");
    expect(await runImessageSetupWithNotices("/private/data", io, launch, write)).toBe(1);
    expect(state.stderr).toMatchSnapshot("denied");
    expect(state.opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"]);
  });
  test("an agent run proceeds with one JSON notice and no recovery prose", async () => {
    const { state, io, launch, write } = harness({ env: { CLAUDECODE: "1" }, code: "automation-permission-denied", status: "blocked" });
    expect(await runImessageSetupWithNotices("/private/data", io, launch, write)).toBe(1);
    expect(state.launched).toBe(1);
    expect(state.stderr.trim().split("\n").map(line => JSON.parse(line).type)).toEqual(["permission-notice"]);
    expect(JSON.parse(state.stdout).code).toBe("automation-permission-denied");
  });
  test("without a terminal it proceeds silently", async () => {
    const { state, io, launch, write } = harness({ tty: false, code: "automation-permission-unavailable", status: "blocked" });
    expect(await runImessageSetupWithNotices("/private/data", io, launch, write)).toBe(1);
    expect(state.launched).toBe(1);
    expect(state.stderr).toBe("");
  });
});

test("the committed app icon is a bounded .icns rendered from the canonical mark", async () => {
  const icon = Buffer.from(await Bun.file(new URL("../native/AppIcon.icns", import.meta.url)).arrayBuffer());
  expect(icon.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(icon.readUInt32BE(4)).toBe(icon.length);
  expect(icon.length).toBeLessThan(1024 * 1024);
  expect(await Bun.file(new URL("../native/app-icon.svg", import.meta.url)).text()).toStartWith("<svg ");
});
