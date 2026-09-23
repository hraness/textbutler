import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonSocketPath, MAX_CONTROL_FRAME_BYTES, requestDaemon, startDaemon, type RunningDaemon } from "./daemon.ts";
import { TEXTBUTLER_CONTROL_PROTOCOL as protocol } from "./control-service.ts";
import { runTextbutlerCli } from "./cli.ts";
import { createNativeSubscriptionHost } from "./native-subscription.ts";

const roots: string[] = [], daemons: RunningDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> { const path = await mkdtemp(join(await realpath("/tmp"), "textbutler-daemon-")); roots.push(path); return path; }
async function start(dataDir: string): Promise<RunningDaemon> { const daemon = await startDaemon({ dataDir }); daemons.push(daemon); return daemon; }
describe("foreground owner-only control socket", () => {
  test("CLI help is a successful read-only command", async () => {
    const lines: string[] = [];
    expect(await runTextbutlerCli(["--help"], { write: text => lines.push(text) })).toBe(0);
    expect(lines[0]).toContain("daemon run");
  });
  test("real NDJSON round trips update persistent owner settings", async () => {
    const dataDir = await root(); const daemon = await start(dataDir);
    const info = await lstat(daemon.socketPath); expect(info.isSocket()).toBe(true); expect(info.mode & 0o777).toBe(0o600);
    expect(await requestDaemon({ dataDir, request: { protocol, command: "snapshot" } })).toMatchObject({ ok: true, snapshot: { contacts: [], revision: 1 } });
    expect(await requestDaemon({ dataDir, request: { protocol, command: "global.settings.update", expectedRevision: 1, settings: { paused: false, activeContactLimit: 3 } } })).toMatchObject({ ok: true, snapshot: { revision: 2 } });
    await daemon.close(); daemons.splice(daemons.indexOf(daemon), 1);
    const restarted = await start(dataDir);
    expect((await restarted.service.snapshot()).settings).toEqual({ paused: false, activeContactLimit: 3 });
  });
  test("a second daemon cannot remove or replace the active socket", async () => {
    const dataDir = await root(); const daemon = await start(dataDir); const before = await lstat(daemon.socketPath);
    await expect(startDaemon({ dataDir })).rejects.toThrow("already exists");
    expect((await lstat(daemon.socketPath)).ino).toBe(before.ino);
    expect((await requestDaemon({ dataDir, request: { protocol, command: "snapshot" } })).ok).toBe(true);
  });
  test("owner conversation jobs cross the real socket and never read at startup", async () => {
    const dataDir = await root(); let lists = 0;
    const daemon = await startDaemon({ dataDir, enrollment: {
      async list() { lists++; return []; },
      async read() { throw new Error("No conversation was selected"); },
    } }); daemons.push(daemon);
    expect(lists).toBe(0);
    const begun = await requestDaemon({ dataDir, request: { protocol, command: "conversations.list" } });
    expect(begun).toMatchObject({ ok: true, kind: "job" });
    if (!begun.ok || begun.kind !== "job") throw new Error("Expected owner job");
    let result = await requestDaemon({ dataDir, request: { protocol, command: "owner.job.read", jobId: begun.jobId } });
    for (let attempt = 0; result.ok && result.kind === "job" && attempt < 10; attempt++) result = await requestDaemon({ dataDir, request: { protocol, command: "owner.job.read", jobId: begun.jobId } });
    expect(result).toMatchObject({ ok: true, kind: "conversations" });
    expect(lists).toBe(1);
    expect((await daemon.service.snapshot()).contacts).toEqual([]);
  });
  test("unknown socket-path entries are preserved", async () => {
    const dataDir = await root(); const path = daemonSocketPath(dataDir);
    await writeFile(path, "owner sentinel", { mode: 0o600 });
    await expect(startDaemon({ dataDir })).rejects.toThrow("already exists");
    expect(await readFile(path, "utf8")).toBe("owner sentinel");
  });
  test("oversized unfinished frames are disconnected without service work", async () => {
    const dataDir = await root(); const daemon = await start(dataDir);
    await new Promise<void>((resolve_, reject) => {
      const socket = connect(daemon.socketPath); const timer = setTimeout(() => { socket.destroy(); reject(new Error("Socket did not enforce frame bound")); }, 2000);
      socket.on("error", () => {}); socket.on("data", () => {});
      socket.once("connect", () => socket.write(Buffer.alloc(MAX_CONTROL_FRAME_BYTES, 65)));
      socket.once("close", () => { clearTimeout(timer); resolve_(); });
    });
    expect((await daemon.service.snapshot()).revision).toBe(1);
  });
  test("CLI init and status perform real local work without installing a background service", async () => {
    const dataDir = await root(), lines: string[] = []; const output = { write: (value: string) => lines.push(value) };
    expect(await runTextbutlerCli(["init", "--data-dir", dataDir], output)).toBe(0);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ status: "initialized", automation: "unchanged" });
    expect(await runTextbutlerCli(["daemon", "status", "--data-dir", dataDir], output)).toBe(1);
    await start(dataDir);
    expect(await runTextbutlerCli(["doctor", "--data-dir", dataDir], output)).toBe(process.platform === "darwin" ? 0 : 1);
    expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: process.platform === "darwin", daemonConnected: true, automaticReplies: "unavailable" });
  });
  test("configured Ghostget automation runs supervised and reports its messaging detail", async () => {
    const dataDir = await root();
    await mkdir(join(dataDir, "state"), { mode: 0o700 });
    await writeFile(join(dataDir, "state/host.json"), JSON.stringify({ schemaVersion: 1, ghostget: {
      executable: fileURLToPath(new URL("../test-fixtures/ghostget-automation.ts", import.meta.url)),
      runtimeExecutable: process.execPath, authId: "fixture", stateHome: join(dataDir, "ghostget-state"),
      automationAccounts: [{ provider: "imessage", authId: "fixture" }] } }), { mode: 0o600 });
    const daemon = await startDaemon({ dataDir }); daemons.push(daemon);
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await daemon.service.snapshot();
      if (snapshot.automation?.state !== "unavailable") break;
      await new Promise<void>(resolve => setTimeout(resolve, 200));
    }
    // Fresh settings are paused; the supervised messaging client must still
    // connect, claim custody and drive the reply loop's status surface.
    expect((await daemon.service.snapshot()).automation).toMatchObject({ state: "paused" });
    expect((await daemon.service.snapshot()).automation?.detail).not.toContain("attention");
    expect((await readdir(join(dataDir, "state"))).includes("ghostget-automation-custody.json")).toBe(true);
  });
  test("explicit native hosts override XCB configuration and close with daemon custody", async () => {
    const dataDir = await root(); let closed = 0, checks = 0;
    await mkdir(join(dataDir, "state"), { mode: 0o700 });
    await writeFile(join(dataDir, "state/host.json"), JSON.stringify({ schemaVersion: 1, xcb: {
      executable: join(dataDir, "does-not-exist"), stateHome: join(dataDir, "unused-xcb-state"), sha256: "a".repeat(64),
      accounts: [{ provider: "codex", accountId: "synthetic", model: "codex/synthetic-model" }],
    } }), { mode: 0o600 });
    const nativeSubscriptions = createNativeSubscriptionHost({ adapters: [], accounts: () => [], async check() { checks++; },
      async selection() { throw Error("No synthetic selection"); }, async close() { closed++; } });
    const daemon = await startDaemon({ dataDir, nativeSubscriptions }); daemons.push(daemon);
    expect(checks).toBe(0);
    expect((await daemon.service.snapshot()).providerAccounts?.every(account => account.status !== "ready")).toBe(true);
    await daemon.close();
    expect(closed).toBe(1);
  });
  test("native host custody is closed if later daemon startup fails", async () => {
    const dataDir = await root(); let closed = 0;
    await mkdir(join(dataDir, "state"), { mode: 0o700 });
    await writeFile(join(dataDir, "state/settings.json"), "invalid synthetic settings", { mode: 0o600 });
    const nativeSubscriptions = createNativeSubscriptionHost({ adapters: [], accounts: () => [], async check() {},
      async selection() { throw Error("No synthetic selection"); }, async close() { closed++; } });
    await expect(startDaemon({ dataDir, nativeSubscriptions })).rejects.toThrow();
    expect(closed).toBe(1);
    await expect(lstat(daemonSocketPath(dataDir))).rejects.toThrow();
  });
});
