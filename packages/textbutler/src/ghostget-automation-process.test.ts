import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createGhostgetAutomationProcess, AUTOMATION_CUSTODY_FILE } from "./ghostget-automation-process.ts";
import { automationFailure } from "../../transport/src/automation.ts";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function options(mode = "normal") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-automation-child-"))); roots.push(root);
  return { executable: fileURLToPath(new URL("../test-fixtures/ghostget-automation.ts", import.meta.url)), runtimeExecutable: process.execPath, custodyDirectory: root, stateHome: join(root, mode), providers: [{ provider: "imessage" as const, authId: "fixture" }] };
}
test("private Ghostget process handshake and verified close release exact custody", async () => {
  const config = await options(); const process = await createGhostgetAutomationProcess(config);
  expect((await lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);
  await process.close(); await expect(lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});
test("priority cancellation reaches a child that is waiting on its send result", async () => {
  const process = await createGhostgetAutomationProcess(await options());
  try {
    const controller = new AbortController();
    const submitting = process.client.submit("plan:fixture", "grant:fixture", controller.signal);
    // Queue submission is asynchronous; cancellation after one event-loop turn
    // drives the real child protocol while preserving the original response.
    await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
    expect(await submitting).toMatchObject({ state: "partial", totalActions: 2, accepted: [{ messageId: "sent:fixture", providerReceiptId: null }] });
  } finally { await process.close(); }
});
test("an invalid child response retains durable custody and blocks another process", async () => {
  const config = await options("wrong-id");
  await expect(createGhostgetAutomationProcess(config)).rejects.toThrow();
  expect((await lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);
  await expect(createGhostgetAutomationProcess(config)).rejects.toThrow("recovery");
});

test("child discovery rejections retain only closed error codes and preserve normal cleanup", async () => {
  for (const code of ["invalid-request", "not-ready", "unavailable"] as const) {
    const config = await options(`remote-${code}`), process = await createGhostgetAutomationProcess(config);
    try {
      const error = await process.client.conversations("imessage").catch(error => error);
      expect(automationFailure(error)).toEqual({ stage: "provider", code: `remote-${code}` });
      expect(String(error)).not.toContain("private fixture");
      expect(String(error)).not.toContain("/synthetic");
    } finally { await process.close(); }
    await expect(lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("invalid successful discovery data is local schema failure and does not change child custody", async () => {
  const config = await options("invalid-result"), process = await createGhostgetAutomationProcess(config);
  try {
    const error = await process.client.conversations("imessage").catch(error => error);
    expect(automationFailure(error)).toEqual({ stage: "response-schema", code: "response-schema" });
    expect(String(error)).not.toContain("Must never");
  } finally { await process.close(); }
  await expect(lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
    .toEqual({ stage: "transport", code: "transport-unavailable" });
});

test("remote recovery-required remains distinct while retaining failed child custody", async () => {
  const config = await options("remote-recovery-required"), process = await createGhostgetAutomationProcess(config);
  const error = await process.client.conversations("imessage").catch(error => error);
  expect(automationFailure(error)).toEqual({ stage: "provider", code: "remote-recovery-required" });
  await expect(process.close()).rejects.toThrow();
  expect((await lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);
});

test("reviewed native discovery marker crosses the real child frame without provider text", async () => {
  const config = await options("native-diagnostic"), process = await createGhostgetAutomationProcess(config);
  try {
    const error = await process.client.conversations("imessage").catch(error => error);
    expect(automationFailure(error)).toEqual({ stage: "provider", code: "remote-unavailable", native: { phase: "native-chats", code: "response-invalid" } });
    expect(String(error)).not.toContain("ghostget.discovery.v1");
  } finally { await process.close(); }
});

test("non-string remote codes reject the pending request and retain custody instead of stranding it", async () => {
  const config = await options("non-string-error"), process = await createGhostgetAutomationProcess(config);
  expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
    .toEqual({ stage: "transport", code: "transport-unavailable" });
  await expect(process.close()).rejects.toThrow();
  expect((await lstat(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);
});

test("bounded child request queue reports capacity without bypassing cancellation or close", async () => {
  const process = await createGhostgetAutomationProcess(await options());
  try {
    const controller = new AbortController();
    const submitting = process.client.submit("plan:fixture", "grant:fixture", controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    const queued = Array.from({ length: 15 }, () => process.client.conversations("imessage").catch(error => automationFailure(error)));
    expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
      .toEqual({ stage: "transport", code: "queue-capacity" });
    controller.abort(); await submitting;
    await Promise.all(queued);
  } finally { await process.close(); }
});
