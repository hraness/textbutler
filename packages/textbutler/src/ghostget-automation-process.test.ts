import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGhostgetAutomationProcess, createSupervisedGhostgetAutomation, GhostgetTransportRecovering, AUTOMATION_CUSTODY_FILE, probeGroupCpuMs } from "./ghostget-automation-process.ts";
import { automationFailure, type AutomationFailure, type GhostgetAutomationClient } from "../../transport/src/automation.ts";
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

test("polls run through a bounded parallel lane beside the serialized ordinary lane", async () => {
  const process = await createGhostgetAutomationProcess(await options("poll-lane"));
  try {
    // Eight lane calls at once — one set-poll plus seven singles: the lane
    // admits six frames over the wire and holds the rest client-side; a
    // serialized chain could never show held > 1.
    const setPoll = process.client.pollSet(["enrollment:a", "enrollment:b"]);
    const polls = Array.from({ length: 7 }, (_unused, index) => process.client.poll(`enrollment:${index}`));
    // Ordinary and priority work do not wait behind the held poll lane.
    expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
      .toEqual({ stage: "response-schema", code: "response-schema" });
    expect(await process.invoke("cancel", { planId: "plan:none" })).toMatchObject({ cancelled: true });
    expect(await process.invoke("lane-stats", {})).toEqual({ held: 6, maxHeld: 6, totalPolls: 6 });
    await process.invoke("release-polls", {});
    // The two queued polls reach the wire only after released slots freed.
    expect(await process.invoke("lane-stats", {})).toEqual({ held: 2, maxHeld: 6, totalPolls: 8 });
    await process.invoke("release-polls", {});
    const set = await setPoll; expect([...set.keys()].sort()).toEqual(["enrollment:a", "enrollment:b"]);
    for (const [index, poll] of polls.entries()) expect((await poll).id).toBe(`enrollment:${index}`);
  } finally { await process.close(); }
});

test("bounded child request queue reports capacity without bypassing cancellation or close", async () => {
  // The fixture never answers `conversations`: the first call occupies the
  // serialized ordinary chain forever, so queued ordinary work proves its
  // bound while priority cancellation and scoped polls still bypass it.
  const process = await createGhostgetAutomationProcess(await options("hold-conversations"));
  const calls = Array.from({ length: 16 }, () => process.client.conversations("imessage").catch(error => automationFailure(error)));
  expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
    .toEqual({ stage: "transport", code: "queue-capacity" });
  expect(await process.invoke("cancel", { planId: "plan:none" })).toMatchObject({ cancelled: true });
  expect((await process.client.poll("enrollment:during-queue")).id).toBe("enrollment:during-queue");
  await process.close().catch(() => undefined);
  // The held call and everything queued behind it fail closed on shutdown.
  for (const failure of await Promise.all(calls)) expect(failure).toEqual({ stage: "transport", code: "transport-unavailable" });
});

const custodyRecord = (hostPid: number, processGroup: number | null) => JSON.stringify({ schemaVersion: 1, operationId: randomUUID(), hostPid, processGroup, configurationSha256: "0".repeat(64), startedAt: new Date().toISOString(), status: "in-flight-or-unreconciled" }) + "\n";
const immediate = () => Promise.resolve();
async function groupGone(pgid: number): Promise<void> {
  // A dead group leader's id is reusable evidence only once the group is gone.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-pgid, 0); await new Promise<void>(resolve => setTimeout(resolve, 10)); }
    catch { return; }
  }
}
async function untilResponseSchema(client: Pick<GhostgetAutomationClient, "conversations">): Promise<AutomationFailure> {
  // The fixture answers `conversations` with schema-invalid data: reaching that
  // failure proves an invoke completed a full round trip on a healthy child.
  let failure: AutomationFailure = { stage: "unknown", code: "unknown" };
  for (let attempt = 0; attempt < 600 && failure.code !== "response-schema"; attempt++) {
    failure = automationFailure(await client.conversations("imessage").catch(error => error));
    if (failure.code !== "response-schema") await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  return failure;
}
test("a supervised client recreates a crashed child and recovers its own custody with evidence", async () => {
  const config = await options();
  const supervised = await createSupervisedGhostgetAutomation(config, { delay: immediate });
  try {
    // "run" is unhandled by the fixture: the child exits and faults its transport.
    expect(automationFailure(await supervised.client.run("run:fixture").catch(error => error)))
      .toEqual({ stage: "transport", code: "transport-unavailable" });
    expect(supervised.recovery()).not.toBeNull();
    expect(await untilResponseSchema(supervised.client)).toEqual({ stage: "response-schema", code: "response-schema" });
    const names = await readdir(config.custodyDirectory);
    expect(names.includes(AUTOMATION_CUSTODY_FILE)).toBe(true);
    const recovered = names.filter(name => name.startsWith(`${AUTOMATION_CUSTODY_FILE}.recovered-`));
    expect(recovered.length).toBe(1);
    // The reclaimed record is this same daemon's own earlier claim.
    expect(JSON.parse(await readFile(join(config.custodyDirectory, recovered[0]!), "utf8")).hostPid).toBe(process.pid);
    expect(supervised.recovery()).toBeNull();
  } finally { await supervised.close(); }
});
test("invokes reject fast while the supervised transport is recovering", async () => {
  const config = await options();
  let release: (() => void) | undefined, waits = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const supervised = await createSupervisedGhostgetAutomation(config, { delay: () => { waits++; return waits === 1 ? gate : Promise.resolve(); } });
  try {
    await supervised.client.run("run:fixture").catch(() => undefined);
    const recovering = await supervised.client.conversations("imessage").catch(error => error);
    expect(recovering).toBeInstanceOf(GhostgetTransportRecovering);
    expect(automationFailure(recovering)).toEqual({ stage: "unknown", code: "unknown" });
    expect(supervised.recovery()?.detail).toContain("recovering");
    release!();
    expect(await untilResponseSchema(supervised.client)).toEqual({ stage: "response-schema", code: "response-schema" });
  } finally { release!(); await supervised.close(); }
});
test("custody from a provably dead owner is reclaimed with its evidence preserved", async () => {
  const config = await options();
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  await new Promise<void>(resolve => dead.once("exit", () => resolve()));
  await groupGone(dead.pid!);
  await writeFile(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE), custodyRecord(dead.pid!, dead.pid!), { mode: 0o600 });
  const supervised = await createSupervisedGhostgetAutomation(config, { delay: immediate });
  try {
    expect(await untilResponseSchema(supervised.client)).toEqual({ stage: "response-schema", code: "response-schema" });
    const recovered = (await readdir(config.custodyDirectory)).filter(name => name.startsWith(`${AUTOMATION_CUSTODY_FILE}.recovered-`));
    expect(recovered.length).toBe(1);
    const preserved = JSON.parse(await readFile(join(config.custodyDirectory, recovered[0]!), "utf8"));
    expect(preserved.hostPid).toBe(dead.pid); expect(preserved.status).toBe("in-flight-or-unreconciled");
  } finally { await supervised.close(); }
});
test("a stalled initialize survives while its child answers probes, dies on the hard cap or probe silence", async () => {
  // The fixture answers initialize late but probes at once: each answered
  // probe re-arms the watchdog, so the late response is adopted rather than
  // orphaned. Before liveness probing this child was killed mid-initialize.
  const slow = await options("slow-initialize");
  const process = await createGhostgetAutomationProcess(slow, { requestWatchdogMs: 250, probeWatchdogMs: 1_000, invokeHardCapMs: 30_000 });
  await process.close();

  // A child that answers probes but never completes the invoke is abandoned
  // at the invoke hard cap: the caller is released and the child is stopped.
  const deaf = await options("deaf-initialize");
  await expect(createGhostgetAutomationProcess(deaf, { requestWatchdogMs: 200, probeWatchdogMs: 200, invokeHardCapMs: 500 })).rejects.toThrow();
  expect((await lstat(join(deaf.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);

  // A genuinely frozen child cannot answer even a priority probe: the probe's
  // own bounded window stops it while the initialize is still outstanding.
  const frozen = await options("frozen-child");
  await expect(createGhostgetAutomationProcess(frozen, { requestWatchdogMs: 200, probeWatchdogMs: 200 })).rejects.toThrow();
  expect((await lstat(join(frozen.custodyDirectory, AUTOMATION_CUSTODY_FILE))).isFile()).toBe(true);
});
test("a slow invoke outlives the request watchdog while the child answers probes", async () => {
  // The poll response arrives past the request watchdog; the answered probe
  // proves the frame loop is alive, so the invoke resolves instead of dying.
  const process = await createGhostgetAutomationProcess(await options("slow-op"), { requestWatchdogMs: 250, probeWatchdogMs: 250 });
  try {
    expect((await process.client.poll("enrollment:slow")).id).toBe("enrollment:slow");
    // The surviving child still serves later requests on the same transport.
    expect(automationFailure(await process.client.conversations("imessage").catch(error => error)))
      .toEqual({ stage: "response-schema", code: "response-schema" });
  } finally { await process.close(); }
});
test("a held send does not starve concurrent lane reads, and a caller abort stays matched", async () => {
  const process = await createGhostgetAutomationProcess(await options(), { requestWatchdogMs: 60_000 });
  try {
    const controller = new AbortController();
    const submitting = process.client.submit("plan:fixture", "grant:fixture", controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    // The fixture holds the send, yet a poll through the scoped lane answers:
    // a serialized chain could never let this read complete first.
    expect((await process.client.poll("enrollment:during-send")).id).toBe("enrollment:during-send");
    controller.abort(); expect((await submitting).state).toBe("partial");

    // An aborted caller is released at once; the late wire response still
    // matches its frame instead of tripping protocol checks.
    const aborted = new AbortController();
    const held = process.client.poll("enrollment:abandoned", aborted.signal).catch(error => error);
    aborted.abort();
    expect(String(await held)).toContain("cancelled");
    expect((await process.client.poll("enrollment:after-abort")).id).toBe("enrollment:after-abort");
  } finally { await process.close(); }
});
test("the group CPU probe observes real process-group work", async () => {
  // A detached burner over one second: macOS ps shows centisecond progress
  // quickly while Linux whole-second granularity still moves within the burn.
  const burner = spawn(process.execPath, ["-e", "const s=Date.now();while(Date.now()-s<2000);"], { detached: true, stdio: "ignore" });
  try {
    const first = probeGroupCpuMs(burner.pid!);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const later = probeGroupCpuMs(burner.pid!);
    expect(first).not.toBeUndefined();
    expect(later).toBeGreaterThan(first!);
  } finally { try { process.kill(-burner.pid!, "SIGKILL"); } catch { /* test cleanup only */ } }
});
test("a same-group survivor of a closed child meets SIGKILL escalation and is never orphaned", async () => {
  const config = await options("leave-sibling");
  const process = await createGhostgetAutomationProcess(config, { cleanupGraceMs: 60 });
  await expect(process.close()).rejects.toThrow();
  const record = JSON.parse(await readFile(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE), "utf8"));
  expect(Number.isSafeInteger(record.processGroup)).toBe(true);
  await groupGone(record.processGroup);
});
test("custody from a live owner is never reclaimed", async () => {
  const config = await options();
  const live = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  try {
    await writeFile(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE), custodyRecord(live.pid!, live.pid!), { mode: 0o600 });
    await expect(createSupervisedGhostgetAutomation(config, { delay: immediate })).rejects.toThrow("recovery");
    expect(JSON.parse(await readFile(join(config.custodyDirectory, AUTOMATION_CUSTODY_FILE), "utf8")).hostPid).toBe(live.pid);
    expect((await readdir(config.custodyDirectory)).some(name => name.includes(".recovered-"))).toBe(false);
  } finally { try { process.kill(-live.pid!, "SIGKILL"); } catch { /* test cleanup only */ } }
});
