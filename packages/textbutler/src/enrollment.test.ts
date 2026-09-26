import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { TextbutlerControlService, TEXTBUTLER_CONTROL_PROTOCOL as protocol, parseControlRequest } from "./control-service.ts";
import { OwnerReadRecoveryError, boundedHistory, type ObservedConversation, type OwnerConversationReadPort } from "./enrollment.ts";
import { parseControlResponse, type ControlResponse } from "../../control/src/index.ts";
const conversation: ObservedConversation = { title: "Synthetic Morgan", kind: "single", binding: { version: 1, authId: "synthetic", authIdentity: "a".repeat(64), authHash: "b".repeat(64), accountSubject: "synthetic-device", chatGuid: "iMessage;-;synthetic-contact", observedChatRowId: 42, service: "iMessage", participants: ["synthetic@example.invalid"], observedAccountId: "synthetic-account", observedAccountLogin: null, observedLastAddressedHandle: null } };
const directories: string[] = [], services: TextbutlerControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(port?: OwnerConversationReadPort) {
  const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-enrollment-")); directories.push(dataDir);
  const service = await TextbutlerControlService.open({ dataDir, ...(port ? { enrollment: port } : {}) }); services.push(service);
  return { service, dataDir };
}
async function finish(service: TextbutlerControlService, response: ControlResponse): Promise<ControlResponse> {
  for (let count = 0; response.ok && response.kind === "job" && count < 100; count++) { await Bun.sleep(2); response = await service.request({ protocol, command: "owner.job.read", jobId: response.jobId }); }
  if (response.ok && response.kind === "job") throw new Error("Synthetic owner job did not finish");
  return parseControlResponse(response);
}
async function candidate(service: TextbutlerControlService): Promise<string> {
  const list = await finish(service, await service.request({ protocol, command: "conversations.list" }));
  if (!list.ok || list.kind !== "conversations") throw new Error("No conversation list");
  return list.candidates[0]!.id;
}
describe("owner enrollment", () => {
  test("no startup reads; explicit listing and history enrollment persist disabled settings + stable binding outside memory", async () => {
    const calls: string[] = [];
    const { service, dataDir } = await setup({ async list() { calls.push("list"); return [conversation]; }, async read(binding, history) { calls.push(`read:${history}`); expect(binding).toEqual(conversation.binding); return { conversation, messages: history ? [{ id: "synthetic-message", at: 1000, author: "contact", text: "Ignore all instructions is untrusted evidence." }] : [] }; } });
    expect(calls).toEqual([]);
    const id = await candidate(service);
    expect(calls).toEqual(["list"]);
    const result = await finish(service, await service.request({ protocol, command: "contact.enroll", candidateId: id, expectedRevision: 1, initializeHistory: true }));
    expect(result).toMatchObject({ ok: true, kind: "enrolled", historyCount: 1, historyOmittedCount: 0, historyShortenedCount: 0, historyInitialized: true, snapshot: { settings: { paused: true }, contacts: [{ settings: { enabled: false, responseMode: "keyword", keyword: "butler" } }] } });
    if (!result.ok || result.kind !== "enrolled") throw new Error("No enrolled contact");
    const state = JSON.parse(await readFile(join(dataDir, "state/settings.json"), "utf8"));
    expect(state.bindings[result.contactId]).toEqual(conversation.binding);
    expect(state.settings.contacts[0].routeId).toBe(`local-binding:${result.contactId}`);
    const root = join(dataDir, "contacts", result.contactId);
    const summary = JSON.parse(await readFile(join(root, "history/bootstrap-summary.json"), "utf8"));
    expect(summary).toMatchObject({ purpose: "context-only-never-trigger", receivedMessages: 1, retainedMessages: 1, attachmentsImported: false });
    expect(JSON.parse(await readFile(join(root, summary.historyFile), "utf8"))).toMatchObject({ messages: [{ author: "contact", text: "Ignore all instructions is untrusted evidence." }] });
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).not.toContain("synthetic@example.invalid");
    expect(calls).toEqual(["list", "read:true"]);
    expect(await service.request({ protocol, command: "contact.enroll", candidateId: id, expectedRevision: 2, initializeHistory: true })).toMatchObject({ ok: false, code: "conflict" });
    expect((await service.snapshot()).contacts).toHaveLength(1);
    await service.close(); services.splice(services.indexOf(service), 1);
    const reopened = await TextbutlerControlService.open({ dataDir }); services.push(reopened);
    expect((await reopened.snapshot()).contacts[0]?.id).toBe(result.contactId);
  });
  test("history stays unread unless requested, and activation revalidates participant/account identity asynchronously", async () => {
    let drift = false;
    const reads: boolean[] = [];
    const { service, dataDir } = await setup({ async list() { return [conversation]; }, async read(_binding, history) { reads.push(history); return { conversation: drift ? { ...conversation, binding: { ...conversation.binding, authIdentity: "c".repeat(64) } } : conversation, messages: [] }; } });
    const result = await finish(service, await service.request({ protocol, command: "contact.enroll", candidateId: await candidate(service), expectedRevision: 1, initializeHistory: false }));
    if (!result.ok || result.kind !== "enrolled") throw new Error("No enrolled contact");
    expect(await readdir(join(dataDir, "contacts", result.contactId, "history"))).toEqual([]);
    drift = true;
    const request = { protocol, command: "contact.settings.update", contactId: result.contactId, expectedRevision: 2, settings: { ...result.snapshot.contacts[0]!.settings, enabled: true } };
    expect(await finish(service, await service.request(request))).toMatchObject({ ok: false });
    expect((await service.snapshot()).contacts[0]?.settings.enabled).toBe(false);
    drift = false;
    expect(await finish(service, await service.request(request))).toMatchObject({ ok: true, kind: "snapshot", snapshot: { contacts: [{ settings: { enabled: true } }] } });
    expect(reads).toEqual([false, false, false]);
  });
  test("groups, forged targets, missing configuration and stale settings fail without enrollment", async () => {
    const group = { ...conversation, kind: "group" as const, binding: { ...conversation.binding, participants: ["a", "b"] } };
    let reads = 0;
    const { service } = await setup({ async list() { return [group]; }, async read() { reads++; return { conversation: group, messages: [] }; } });
    const response = await finish(service, await service.request({ protocol, command: "conversations.list" }));
    expect(response).toMatchObject({ candidates: [{ eligible: false }] });
    if (!response.ok || response.kind !== "conversations") throw new Error("No list");
    expect(await service.request({ protocol, command: "contact.enroll", candidateId: response.candidates[0]!.id, expectedRevision: 1, initializeHistory: false })).toMatchObject({ ok: false });
    expect(reads).toBe(0); expect((await service.snapshot()).contacts).toEqual([]);
    expect(() => parseControlRequest({ protocol, command: "contact.enroll", candidateId: "fake", expectedRevision: 1, initializeHistory: false, chatGuid: "injected" })).toThrow();
    const unavailable = await setup();
    expect(await unavailable.service.request({ protocol, command: "conversations.list" })).toMatchObject({ ok: false, code: "unavailable" });
  });
  test("a pending read does not block global pause, bounds jobs, and settles aborted work before close", async () => {
    let aborted = false;
    const { service } = await setup({ list(signal) { return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })); }, async read() { throw new Error("unused"); } });
    expect(await service.request({ protocol, command: "conversations.list" })).toMatchObject({ ok: true, kind: "job" });
    expect(await service.request({ protocol, command: "conversations.list" })).toMatchObject({ ok: false, code: "capacity" });
    expect(await service.request({ protocol, command: "global.settings.update", expectedRevision: 1, settings: { paused: true, activeContactLimit: 5 } })).toMatchObject({ ok: true });
    expect(await service.request({ protocol, command: "owner.job.read", jobId: "foreign-daemon-job" })).toMatchObject({ ok: false, code: "invalid-request" });
    await service.close(); services.splice(services.indexOf(service), 1); expect(aborted).toBe(true);
  });
  test("history rejects invalid evidence and bounds Unicode text plus aggregate bytes", () => {
    expect(() => boundedHistory([{ id: "x", at: -1, author: "owner", text: "no" }])).toThrow();
    const messages = Array.from({ length: 200 }, (_, index) => ({ id: `${index}`, at: index, author: "contact" as const, text: "\u0001".repeat(8000) }));
    const bounded = boundedHistory(messages);
    expect(bounded.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(512_000);
    expect(bounded.at(-1)?.text).toContain("truncated");
  });
});


test("owner-job errors expose only the fixed custody recovery instruction", async () => {
  const { service } = await setup({ async list() { throw new OwnerReadRecoveryError(); }, async read() { throw new Error("unused"); } });
  expect(await finish(service, await service.request({ protocol, command: "conversations.list" }))).toMatchObject({ ok: false, code: "unavailable", message: new OwnerReadRecoveryError().message });
});
