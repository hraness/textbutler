import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_PROTOCOL, DEFAULT_CONTACT_SETTINGS, disconnectedSnapshot, type ControlRequest, type ControlResponse } from "../../control/src/index.ts";
import { handleMessagesCommand, importOwnerMedia, readOwnerInputFile } from "./messages-cli.ts";
import { ContactWorkspace } from "./workspace.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
  const snapshot = { ...disconnectedSnapshot("Synthetic"), revision: 3,
    contacts: [{ id: "contact-one", name: "Synthetic contact", subtitle: "Synthetic", settings: { ...DEFAULT_CONTACT_SETTINGS } }] };
  const calls: ControlRequest[] = [], output: unknown[] = [];
  let response: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: false, code: "unavailable", message: "Synthetic no transport" };
  const options = { dataDir: "/synthetic/data", print(value: unknown) { output.push(value); },
    async request(request: ControlRequest): Promise<ControlResponse> { calls.push(request); return request.command === "snapshot" ? { protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot } : response; } };
  return { calls, output, options, response(value: ControlResponse) { response = value; } };
}
test("history and summaries select one exact contact and bound the requested sample", async () => {
  for (const verb of ["history", "summarize"] as const) {
    const f = fixture(); await handleMessagesCommand(["messages", verb, "Synthetic", "--limit", "200"], f.options);
    expect(f.calls).toEqual([{ protocol: CONTROL_PROTOCOL, command: "snapshot" }, { protocol: CONTROL_PROTOCOL, command: `messages.${verb}`, contactId: "contact-one", limit: 200 }]);
  }
  for (const limit of ["0", "201", "1.5", "-1", "01"]) {
    const f = fixture(); await expect(handleMessagesCommand(["messages", "history", "Synthetic", "--limit", limit], f.options)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
});
test("reaction and text composition never send and preserve the explicit target", async () => {
  const f = fixture();
  await handleMessagesCommand(["messages", "react", "contact-one", "message:one", "👍", "--remove"], f.options);
  expect(f.calls[1]).toMatchObject({ command: "replies.compose", contactId: "contact-one", actions: [{ kind: "reaction", messageId: "message:one", emoji: "👍", action: "remove" }] });
  expect(f.calls.some(request => request.command === "replies.send")).toBe(false);
  const draft = fixture(); await handleMessagesCommand(["messages", "compose", "Synthetic", "--text", "Exact\ntext"], draft.options);
  expect(draft.calls[1]).toMatchObject({ command: "replies.compose", actions: [{ kind: "text", text: "Exact\ntext" }] });
});
test("explicit send uses the observed settings revision and returns failure on uncertain dispatch", async () => {
  const f = fixture(); f.response({ protocol: CONTROL_PROTOCOL, ok: true, kind: "reply-sent", contactId: "contact-one", runId: "synthetic", state: "indeterminate", detail: "Unknown" });
  expect(await handleMessagesCommand(["messages", "send", "Synthetic", "--text", "Exact text"], f.options)).toBe(1);
  expect(f.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "replies.send", contactId: "contact-one", text: "Exact text", expectedRevision: 3 });
  expect(f.calls).toHaveLength(2);
});
test("unsupported thread targeting never silently becomes an ordinary send", async () => {
  const f = fixture();
  await expect(handleMessagesCommand(["messages", "send", "Synthetic", "--text", "Text", "--reply-to", "message:one"], f.options)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test("action input rejects extra target fields before any control request", async () => {
  const f = fixture();
  await expect(handleMessagesCommand(["messages", "compose", "Synthetic", "--actions", "/synthetic/actions.json"], {
    ...f.options, async readFile() { return Buffer.from(JSON.stringify([{ kind: "text", text: "Text", recipient: "other" }])); },
  })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test("media cannot be imported until this contact reports attachment support", async () => {
  const f = fixture(); let imports = 0;
  expect(await handleMessagesCommand(["messages", "attach", "Synthetic", "/synthetic/photo.jpg"], {
    ...f.options, async importMedia() { imports++; throw Error("Must not import"); },
  })).toBe(1);
  expect(imports).toBe(0); expect(f.calls[1]?.command).toBe("messages.capabilities");
});
test("explicit media import snapshots private contact bytes and rejects unsafe source files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-owner-media-"))); roots.push(root);
  const workspace = await ContactWorkspace.create(join(root, "contacts", "contact-one"));
  const path = join(root, "photo.jpg"), bytes = Buffer.from([0, 255, 1, 2]); await writeFile(path, bytes, { mode: 0o600 });
  const action = await importOwnerMedia(root, "contact-one", path);
  if (action.kind !== "attachment") throw Error("Expected attachment");
  expect(action).toMatchObject({ name: "photo.jpg", mimeType: "image/jpeg" });
  expect((await workspace.admitAsset(action.file)).bytes).toEqual(bytes);
  await writeFile(path, "Changed", { mode: 0o600 });
  expect((await workspace.admitAsset(action.file)).bytes).toEqual(bytes);
  const linked = join(root, "linked.jpg"); await symlink(path, linked);
  await expect(readOwnerInputFile(linked, 16_777_216)).rejects.toThrow();
  await chmod(path, 0o666);
  await expect(readOwnerInputFile(path, 16_777_216)).rejects.toThrow();
  await expect(importOwnerMedia(root, "../other", path)).rejects.toThrow();
});
test("pending media capability jobs retain their identity without importing or composing", async () => {
  const f = fixture(); let imports = 0;
  const pending: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: true, kind: "job", jobId: "capabilities-job" };
  const request = f.options.request;
  expect(await handleMessagesCommand(["messages", "attach", "Synthetic", "/synthetic/photo.jpg"], {
    ...f.options,
    async request(input) {
      if (input.command === "owner.job.read") throw Error("Synthetic disconnect");
      if (input.command === "messages.capabilities") { f.calls.push(input); return pending; }
      return request(input);
    },
    async importMedia() { imports++; throw Error("Must not import"); },
  })).toBe(1);
  expect(imports).toBe(0);
  expect(f.calls.some(input => input.command === "replies.compose")).toBe(false);
  expect(f.output[0]).toMatchObject({ kind: "job", jobId: "capabilities-job", status: "pending", nextCommand: ["textbutler", "jobs", "show", "capabilities-job"] });
});
