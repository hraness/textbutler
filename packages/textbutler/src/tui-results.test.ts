import { expect, test } from "bun:test";
import { CONTROL_PROTOCOL, disconnectedSnapshot, type ControlRequest, type ControlResponse } from "../../control/src/index.ts";
import { symbolsFor } from "./cli-style.ts";
import { runTerminalSession } from "./tui.ts";
import { describeControlResult, describeMenuBarResult, describeServiceInstall } from "./tui-results.ts";
import type { LaunchAgentStatus } from "./launch-agent.ts";

const UTF8 = symbolsFor({ LANG: "en_US.UTF-8" }), ASCII = symbolsFor({ TERM: "dumb" });
const snapshot = { ...disconnectedSnapshot(), connection: "connected" as const, revision: 7 };
const contact = { id: "contact-1", name: "Alex\nspoof", subtitle: "Beeper", settings: { enabled: false, responseMode: "smart" as const, keyword: "butler", provider: "codex" as const,
  disclosure: { character: "🤖", begin: "{", end: "}" } } };
const P = { protocol: CONTROL_PROTOCOL, ok: true } as const;

test("control results read as one plain line, never JSON", () => {
  const rows: Record<string, string> = {};
  const cases: Record<string, unknown> = {
    enrolled: { ...P, kind: "enrolled", snapshot: { ...snapshot, contacts: [contact] }, contactId: "contact-1", historyCount: 42, historyOmittedCount: 3, historyShortenedCount: 0, historyInitialized: true },
    "enrolled without history": { ...P, kind: "enrolled", snapshot, contactId: "gone", historyCount: 0, historyOmittedCount: 0, historyShortenedCount: 0, historyInitialized: false },
    "reply sent": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "submitted", detail: "Sent to Alex." },
    "reply uncertain": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "indeterminate", detail: "Messages didn't confirm the send. Don't send it again; check the chat first." },
    "reply failed": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "failed", detail: "Messages rejected the reply." },
    "settings changed": { ...P, kind: "snapshot", snapshot },
    pending: { ...P, kind: "job", jobId: "job-1" },
    "pending (owner output)": { ...P, kind: "job", jobId: "job-2", status: "pending", detail: "not shown" },
    refused: { protocol: CONTROL_PROTOCOL, ok: false, code: "conflict", message: "Settings changed. Review them and try again." },
  };
  for (const [name, value] of Object.entries(cases)) {
    const text = describeControlResult(value, UTF8, "Automatic replies are paused.");
    expect(text).not.toMatch(/[{}]|"[a-z]+":/u);
    expect(text).not.toContain("\n");
    rows[name] = text;
  }
  expect(rows).toMatchSnapshot();
  expect(describeControlResult(cases.refused, ASCII)).toBe("FAIL Settings changed. Review them and try again.");
});

test("service and menu bar results", () => {
  const status = (installation: LaunchAgentStatus["installation"], detail: string): LaunchAgentStatus =>
    ({ label: "app.textbutler.daemon", installation, service: "running", plistPath: "/private/p.plist", pid: 1, detail } as LaunchAgentStatus);
  expect({
    installed: describeServiceInstall(status("installed", "The background service starts at login and is running."), UTF8),
    conflict: describeServiceInstall(status("conflict", "Another background service uses this name. Nothing was changed."), UTF8),
    started: describeMenuBarResult("start", { appId: "textbutler", running: true, state: "running" }, UTF8),
    already: describeMenuBarResult("start", { running: true, alreadyRunning: true }, UTF8),
    "not started": describeMenuBarResult("start", { running: false, diagnostics: [] }, UTF8),
    login: describeMenuBarResult("install", { loginStartup: "enabled", takesEffect: "next-login" }, UTF8),
    stopped: describeMenuBarResult("stop", { appId: "textbutler", running: false, state: "stopped" }, ASCII),
  }).toMatchSnapshot();
});

test("the guided terminal shows plain results for pause and enrollment", async () => {
  const output: string[] = [], answers = ["6", "3", "1", "n", "y", "q"];
  const state = { ...snapshot, contacts: [contact] };
  await runTerminalSession("/unused", { write: text => output.push(text), ask: async () => answers.shift() ?? null }, async (request: ControlRequest): Promise<ControlResponse> => {
    if (request.command === "conversations.list") return { ...P, kind: "conversations", candidates: [{ id: "candidate", name: "Alex", subtitle: "Beeper", eligible: true, reason: "" }], detail: "Recent chats." };
    if (request.command === "contact.enroll") return { ...P, kind: "enrolled", snapshot: state, contactId: "contact-1", historyCount: 0, historyOmittedCount: 0, historyShortenedCount: 0, historyInitialized: false };
    return { ...P, kind: "snapshot", snapshot: state };
  });
  const text = output.join("");
  expect(text).toContain("Automatic replies are paused.");
  expect(text).toContain("Added Alex spoof. Automatic replies are off.");
  expect(text).not.toContain("\"protocol\"");
});
