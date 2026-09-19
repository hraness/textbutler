import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONTROL_PROTOCOL, disconnectedSnapshot, type ControlRequest, type ControlResponse } from "../../control/src/index.ts";
import { runTerminalSession, terminalDashboard, terminalText, terminalDraft } from "./tui.ts";
const snapshot = { ...disconnectedSnapshot(), connection: "connected" as const, revision: 7 };
const view: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot };
function session(answers: (string | null)[]) { const output: string[] = []; return { output, io: { write: (text: string) => output.push(text), ask: async () => answers.shift() ?? null } }; }
test("terminal dashboard has explicit next actions and escapes untrusted terminal controls", () => {
  expect(terminalDashboard(null)).toContain("Setup & readiness");
  expect(terminalDashboard(snapshot)).toContain("Automatic replies paused");
  expect(terminalText("hello\x1b[2J\u202eattack\nnext")).toBe("hello\\u001b[2J\\u202eattack\nnext");
});
test("opening and quitting terminal only reads snapshots", async () => {
  const calls: ControlRequest[] = [], { io } = session(["q"]);
  expect(await runTerminalSession("/unused", io, async request => { calls.push(request); return view; })).toBe(0);
  expect(calls.map(request => request.command)).toEqual(["snapshot"]);
});
test("first setup configures messaging before offering a service that would lock configuration", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "textbutler-first-run-"));
  const output: string[] = [], prompts: string[] = [], answers = ["1", "q"];
  try {
    await runTerminalSession(root, { write: value => output.push(value), ask: async prompt => { prompts.push(prompt); return answers.shift() ?? null; } },
      async () => ({ protocol: CONTROL_PROTOCOL, ok: false, code: "unavailable", message: "Disconnected" }));
    expect(prompts).toEqual(["Choose an action: ", "Choose an action: "]);
    expect(output.join("")).toContain("Next choose Connect messaging apps (2)");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("cancelling conversation selection never enrolls or imports history", async () => {
  const calls: ControlRequest[] = [], { io } = session(["3", "", "q"]);
  await runTerminalSession("/unused", io, async request => {
    calls.push(request);
    return request.command === "conversations.list" ? { protocol: CONTROL_PROTOCOL, ok: true, kind: "conversations", candidates: [{ id: "candidate", name: "Alex", subtitle: "Beeper", eligible: true, reason: "" }], detail: "Choose a conversation" } : view;
  });
  expect(calls.some(request => request.command === "contact.enroll")).toBe(false);
});
test("pause is explicit and revision checked; cancelled resume has no mutation", async () => {
  const calls: ControlRequest[] = [], { io } = session(["6", "7", "n", "q"]);
  await runTerminalSession("/unused", io, async request => { calls.push(request); return view; });
  expect(calls.filter(request => request.command === "global.settings.update")).toEqual([
    { protocol: CONTROL_PROTOCOL, command: "global.settings.update", expectedRevision: 7, settings: snapshot.settings },
  ]);
});

test("typed reply review uses the captured revision and disclosed content", async () => {
  const contact = { id: "contact-1", name: "Alex\nspoof", subtitle: "Beeper", settings: { enabled: false, responseMode: "smart" as const, keyword: "butler", provider: "codex" as const, disclosure: { character: "🤖", begin: "{", end: "}" } } };
  const state = { ...snapshot, contacts: [contact] }, calls: ControlRequest[] = [];
  const { io, output } = session(["4", "1", "t", " hello ", "send", "q"]);
  await runTerminalSession("/unused", io, async request => {
    calls.push(request);
    if (request.command === "replies.scan") return { protocol: CONTROL_PROTOCOL, ok: true, kind: "replies", scannedAt: "2026-09-19T00:00:00Z", checked: 1, unreadable: 0,
      pending: [{ contactId: contact.id, name: contact.name, provider: "beeper", enabled: false, pendingCount: 1, lastInboundAt: null, preview: "Hello", sendable: true, reason: null }], drafts: [] };
    if (request.command === "replies.send") return { protocol: CONTROL_PROTOCOL, ok: false, code: "conflict", message: "Review changed settings." };
    return { protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: state };
  });
  expect(calls.filter(request => request.command === "replies.send")).toEqual([{ protocol: CONTROL_PROTOCOL, command: "replies.send", contactId: "contact-1", text: " hello ", expectedRevision: 7 }]);
  expect(output.join("")).toContain("To: Alex spoof\n🤖{ hello }");
  expect(output.join("")).toContain("Review changed settings.");
});

test("full draft review shows every outgoing text beyond preview length", () => {
  const first = "A".repeat(2000), second = "second message\nwith a new line";
  const output = terminalDraft({ id: "draft:test", contactId: "contact-1", name: "Alex", provider: "beeper", conversationId: "chat-1", summary: "Two messages",
    actions: [{ kind: "text", text: first }, { kind: "text", text: second }], assets: [], digest: "a".repeat(64), expiresAt: "2026-09-19T01:00:00Z" });
  expect(output).toContain(first);
  expect(output).toContain(second);
  expect(output).toContain("2. Message");
});

test("rich-action review preserves complete target identifiers and escapes terminal controls", () => {
  const target = "message-" + "x".repeat(1500) + "\n\tend\u202e";
  const filename = "a".repeat(400) + ".png";
  const output = terminalDraft({ id: "draft:test", contactId: "contact-1", name: "Alex", provider: "imessage", conversationId: "chat-1", summary: "Three actions",
    actions: [{ kind: "reaction", action: "add", emoji: "👍", messageId: target }, { kind: "sticker", file: "assets/sticker.png", messageId: target },
      { kind: "attachment", file: "assets/file.png", name: filename, mimeType: "image/png" }, { kind: "sticker", file: "assets/new.png", messageId: null }], assets: [], digest: "a".repeat(64), expiresAt: "2026-09-19T01:00:00Z" });
  expect(output).toContain(terminalText(JSON.stringify(target)));
  expect(output).toContain(JSON.stringify(filename));
  expect(output).not.toContain("\u202e");
  expect(output).toContain("3. attachment");
  expect(output).toContain("On message: new message");
});
