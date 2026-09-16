import { afterEach, expect, test } from "bun:test";
import { unwatchFile, watchFile } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GHOSTGET_OWNER_CLEANUP_GRACE_MS, GHOSTGET_OWNER_CUSTODY_FILE, createGhostgetOwnerReadPort } from "./ghostget-owner-read.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(authId = "synthetic") {
  const stateHome = await mkdtemp(join(await realpath("/tmp"), "textbutler-owner-cli-")); roots.push(stateHome);
  return { stateHome, port: createGhostgetOwnerReadPort({ executable: resolve(import.meta.dir, "../test-fixtures/ghostget-owner.ts"), runtimeExecutable: process.execPath, authId, stateHome, custodyDirectory: stateHome }) };
}
test("public R1 CLI uses exact coordinates, incarnation before/after, and never reads history until requested", async () => {
  const { stateHome, port } = await fixture(); const signal = new AbortController().signal;
  await expect(readFile(join(stateHome, "calls.jsonl"))).rejects.toThrow();
  const list = await port.list(signal); expect(list).toHaveLength(1);
  const binding = list[0]!.binding;
  expect((await port.read(binding, false, signal)).messages).toEqual([]);
  let calls = (await readFile(join(stateHome, "calls.jsonl"), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  expect(calls).toHaveLength(6);
  expect(calls.every(call => call.runtimeArgs.includes("--no-env-file"))).toBe(true);
  expect(calls.every(call => call.supportAudience === "off" && call.supportEmail === "off")).toBe(true);
  expect(calls.every(call => !call.args.includes("messaging.read") && !call.args.includes("messaging.send"))).toBe(true);
  expect(calls[3].input).toEqual({ chat_guid: "synthetic-chat", observed_chat_row_id: 42, service: "iMessage" });
  const history = await port.read(binding, true, signal);
  expect(history.messages.map(value => value.author)).toEqual(["contact", "contact", "butler"]);
  expect(history.messages[1]?.text).toBe("");
  calls = (await readFile(join(stateHome, "calls.jsonl"), "utf8")).trim().split("\n").map(value => JSON.parse(value));
  expect(calls.at(-1).input.limit).toBe(200);
  expect(calls.filter(call => call.args.includes("--projection-identity-only"))).toHaveLength(8);
});
test("cached reads and replaced account lifetimes fail closed", async () => {
  const { port: cached } = await fixture("cache");
  await expect(cached.list(new AbortController().signal)).rejects.toThrow("owner recovery");
  const { port } = await fixture("drift"), signal = new AbortController().signal;
  const list = await port.list(signal);
  await expect(port.read(list[0]!.binding, false, signal)).rejects.toThrow("changed");
});
test("abort settles the owned process before reporting failure", async () => {
  const { port } = await fixture("slow"); const controller = new AbortController();
  const started = Date.now(); const result = port.list(controller.signal);
  const timer = setTimeout(() => controller.abort(), 50);
  await expect(result).rejects.toThrow("owner recovery"); clearTimeout(timer);
  expect(Date.now() - started).toBeLessThan(2000);
});


test("an interrupted uncertain read retains a private fence across a fresh adapter and starts no replacement child", async () => {
  const { port, stateHome } = await fixture("slow"); const controller = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const readyPath = join(stateHome, "slow-ready");
  watchFile(readyPath, { interval: 10 }, current => { if (current.size > 0) markReady(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Synthetic child readiness timed out")), 1500); });
  const pending = port.list(controller.signal);
  try {
    await Promise.race([ready, deadline, pending.then(() => { throw new Error("Synthetic slow child completed before interruption"); })]);
    controller.abort();
    await expect(pending).rejects.toThrow("owner recovery");
    const marker = JSON.parse(await readFile(join(stateHome, GHOSTGET_OWNER_CUSTODY_FILE), "utf8"));
    expect(marker).toMatchObject({ schemaVersion: 1, status: "in-flight-or-unreconciled", operation: "messaging.list", identityOnly: true });
    expect(Object.keys(marker).some(key => /auth|input|message|credential/i.test(key))).toBe(false);
    const calls = await readFile(join(stateHome, "calls.jsonl"), "utf8");
    const fresh = createGhostgetOwnerReadPort({ executable: resolve(import.meta.dir, "../test-fixtures/ghostget-owner.ts"), runtimeExecutable: process.execPath, authId: "synthetic", stateHome, custodyDirectory: stateHome });
    await expect(fresh.list(new AbortController().signal)).rejects.toThrow("owner recovery");
    expect(await readFile(join(stateHome, "calls.jsonl"), "utf8")).toBe(calls);
  } finally {
    clearTimeout(timer); unwatchFile(readyPath); controller.abort(); await pending.catch(() => {});
  }
});

test("documented cleanup grace allows the public CLI to reap its detached child before settlement", async () => {
  expect(GHOSTGET_OWNER_CLEANUP_GRACE_MS).toBeGreaterThanOrEqual(35_000);
  const { port, stateHome } = await fixture("graceful"); const controller = new AbortController();
  const pending = port.list(controller.signal); let descendant = 0;
  try {
    for (let attempt = 0; attempt < 150 && !descendant; attempt++) {
      try { descendant = JSON.parse(await readFile(join(stateHome, "descendant.json"), "utf8")).pid; } catch { await Bun.sleep(10); }
    }
    expect(descendant).toBeGreaterThan(0);
    const started = Date.now(); controller.abort();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    expect(() => process.kill(descendant, 0)).toThrow();
    await expect(readFile(join(stateHome, GHOSTGET_OWNER_CUSTODY_FILE))).rejects.toThrow();
  } finally {
    controller.abort(); await pending.catch(() => {});
    if (descendant) { try { process.kill(-descendant, "SIGKILL"); } catch { /* already joined */ } }
  }
}, 10_000);


test.each(["overflow", "stderr-overflow"])("a valid success prefix cannot release custody after %s", async authId => {
  const { port, stateHome } = await fixture(authId);
  await expect(port.list(new AbortController().signal)).rejects.toThrow("owner recovery");
  expect(JSON.parse(await readFile(join(stateHome, GHOSTGET_OWNER_CUSTODY_FILE), "utf8"))).toMatchObject({ operation: "messaging.list", identityOnly: false });
});


test("matching before/after probes cannot hide different actual invocation account metadata", async () => {
  const { port } = await fixture("receipt-drift");
  await expect(port.list(new AbortController().signal)).rejects.toThrow("account changed");
});
