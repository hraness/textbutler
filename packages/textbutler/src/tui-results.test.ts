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
    "reply sent": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "submitted", detail: "Reply sent." },
    "reply uncertain": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "indeterminate", detail: "The send outcome is unknown. Reconcile the journaled intent before another reply." },
    "reply failed": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "failed", detail: "The provider rejected this reply." },
    "reply partial": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "partial", detail: "The send needs reconciliation." },
    "reply cancelled by code": { ...P, kind: "reply-sent", contactId: "c", runId: "r", state: "cancelled", detail: "extension-veto" },
    "no suggestion": { ...P, kind: "reply-suggestion", draft: null, pending: { contactId: "c", name: "Sam", provider: "beeper", enabled: true, pendingCount: 0, lastInboundAt: null, preview: null, sendable: false, reason: "Nothing new since your last reply." } },
    "shortened history": { ...P, kind: "enrolled", snapshot: { ...snapshot, contacts: [contact] }, contactId: "contact-1", historyCount: 10, historyOmittedCount: 0, historyShortenedCount: 2, historyInitialized: true },
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
  // Uncertain or partial sends always warn against sending again; a bare code never shows.
  for (const name of ["reply partial", "reply uncertain"]) expect(rows[name]).toContain("Don't send it again.");
  expect(rows["reply cancelled by code"]).not.toContain("extension-veto");
  expect(rows["no suggestion"]).not.toContain("Settings updated");
  // A pending job points at the same data folder as the TUI.
  expect(describeControlResult(cases.pending, UTF8, "x", { dataDir: "/Volumes/Data/Application Support/Textbutler" }))
    .toContain("textbutler --data-dir '/Volumes/Data/Application Support/Textbutler' jobs show job-1");
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
    "not started with reason": describeMenuBarResult("start", { running: false, diagnostics: [
      { code: "arch", severity: "error", message: "This Mac's processor isn't supported.", guidance: "Use an Apple silicon Mac." },
      { code: "note", severity: "info", message: "Not shown." }] }, UTF8),
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
