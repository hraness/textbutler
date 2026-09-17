import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { SqliteAccountLeases } from "@hraness/agentmixer";
import type { ManagedCodexAccountController } from "@hraness/agentmixer";
import type { CodexAccountProcessPort } from "@hraness/agentmixer";
import type { CodexAccountProcessOptions } from "@hraness/agentmixer";
import { createManagedCodexAccountFactory, type ManagedCodexFactoryOptions } from "./managed-codex.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function options(): ManagedCodexFactoryOptions {
  return { runtime: { executablePath: "/synthetic/native-codex", version: "synthetic-version", sha256: "a".repeat(64), schemaSha256: "b".repeat(64), parentRuntime: { expectedSha256: "c".repeat(64) } },
    deviceCodeAdmission: { profile: "codex-account-device-code-tcp443-dns-v1", nativeSha256: "a".repeat(64), schemaSha256: "b".repeat(64), parentSha256: "c".repeat(64) } };
}
type Message = { id?: number; method: string; params?: Record<string, unknown> };
async function fixture(input: { ready?: Promise<void>; badBinding?: boolean; throwProcess?: boolean; joined?: boolean; profile?: ManagedCodexFactoryOptions["deviceCodeAdmission"]["profile"] } = {}) {
  const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-managed-factory-")); await chmod(dataDir, 0o700);
  const database = new Database(":memory:"), leases = new SqliteAccountLeases(database), controllers: ManagedCodexAccountController[] = [];
  const calls: CodexAccountProcessOptions[] = [], messages: Message[] = [], exits: (() => void)[] = [], outputs: PassThrough[] = [];
  let stops = 0, signedIn = false, joined = input.joined ?? true;
  const baseline = options(), admitted = { ...baseline, deviceCodeAdmission: { ...baseline.deviceCodeAdmission, profile: input.profile ?? baseline.deviceCodeAdmission.profile } };
  const factory = createManagedCodexAccountFactory(admitted, processOptions => {
    calls.push(processOptions); if (input.throwProcess) throw new Error("synthetic uncertain construction");
    const stdout = new PassThrough(), stderr = new PassThrough(), exit = deferred<void>(); outputs.push(stdout);
    const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()) as Message; messages.push(request);
      const respond = (result: unknown) => send({ id: request.id, result });
      if (request.method === "initialize") respond({ userAgent: "synthetic", codexHome: join(processOptions.stateRoot, "synthetic-home"), platformFamily: "unix", platformOs: "macos" });
      else if (request.method === "account/read") respond({ requiresOpenaiAuth: true, account: signedIn ? { type: "chatgpt", email: "private@example.invalid", planType: "plus" } : null });
      else if (request.method === "account/login/start") respond({ type: "chatgptDeviceCode", loginId: "synthetic-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "FAKE-ONLY" });
      else if (request.method === "account/login/cancel") respond({ status: "canceled" });
      else if (request.method === "account/logout") { signedIn = false; respond({}); }
      else if (request.method === "model/list") respond({ data: [], nextCursor: null });
      else if (request.method !== "initialized") respond({ unexpected: true });
      done();
    } });
    const finish = () => { stdin.end(); stdout.end(); stderr.end(); exit.resolve(); }; exits.push(finish);
    const port: CodexAccountProcessPort = { binding: input.badBinding ? { ...processOptions.binding, accountId: "foreign" } : processOptions.binding,
      stdout, stderr, ready: input.ready ?? Promise.resolve(), exited: exit.promise, operationCompleted: exit.promise,
      async write(bytes) { return await new Promise(resolve => stdin.write(Buffer.from(bytes), error => resolve(error
        ? { outcome: "indeterminate" as const, acceptedBytes: 0 }
        : { outcome: "accepted-full" as const, acceptedBytes: bytes.byteLength }))); },
      async stopAndJoin(request) { stops++; expect(request.binding).toEqual(processOptions.binding); finish();
        return { binding: request.binding, processExited: true, processGroupStopped: joined, stdoutEnded: true, stderrEnded: true }; },
    }; return port;
  });
  const create = (accountId = "native-codex", directory = dataDir) => { const controller = factory({ accountId, dataDir: directory, leases }); controllers.push(controller); return controller; };
  cleanup.push(async () => { joined = true; for (const finish of exits) finish(); for (const controller of controllers) await controller.close(); database.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, admitted, factory, create, calls, messages, leases, outputs, stops: () => stops, signIn() { signedIn = true; }, join() { joined = true; } };
}

test("factory is lazy, device-only, and composes account protocol using fixed private host storage", async () => {
  const f = await fixture(); expect(await readdir(f.dataDir)).toEqual([]); expect(f.calls).toHaveLength(0);
  const controller = f.create(); expect(controller.snapshot().state).toBe("unchecked"); expect(f.calls).toHaveLength(0); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
  for (const method of ["chatgpt", "apiKey", "chatgptAuthTokens", "other"]) await expect(controller.startLogin(method as any)).rejects.toThrow("DEVICE_CODE_REQUIRED");
  expect(f.calls).toHaveLength(0); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
  const challenge = await controller.startLogin("chatgptDeviceCode"); expect(challenge).toMatchObject({ type: "chatgptDeviceCode", userCode: "FAKE-ONLY" });
  expect(f.calls).toHaveLength(1); const call = f.calls[0]!;
  expect(call.stateRoot).toBe(join(f.dataDir, "state", "codex-accounts")); expect(call.mode).toBe("device-code"); expect(call.deviceCodeAdmission).toEqual(f.admitted.deviceCodeAdmission);
  expect(call.runtime).toEqual(f.admitted.runtime); expect(Object.isFrozen(call)).toBe(true); expect(Object.isFrozen(call.runtime.parentRuntime)).toBe(true); expect(Object.isFrozen(call.deviceCodeAdmission)).toBe(true);
  expect(f.messages.map(message => message.method)).toEqual(["initialize", "initialized", "account/login/start"]);
  expect(f.messages.at(-1)!.params).toEqual({ type: "chatgptDeviceCode" });
  for (const directory of [f.dataDir, join(f.dataDir, "state"), call.stateRoot]) expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect(JSON.stringify(controller.snapshot())).not.toMatch(/FAKE-ONLY|verificationUrl|authUrl|private@example/);
  expect((await controller.check()).state).toBe("signing-in"); expect(await controller.cancelLogin(challenge.loginId)).toEqual({ status: "canceled" });
  expect(await controller.close()).toEqual({ released: true, state: "closed" }); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
  expect((await readdir(join(f.dataDir, "state"))).sort()).toEqual(["codex-accounts"]);
});

test("pins are copied before future controller creation and cannot drift through caller mutation", async () => {
  const f = await fixture(), original = structuredClone(f.admitted);
  (f.admitted.runtime as any).executablePath = "/mutated"; (f.admitted.runtime as any).sha256 = "d".repeat(64);
  (f.admitted.runtime.parentRuntime as any).expectedSha256 = "e".repeat(64); (f.admitted.deviceCodeAdmission as any).nativeSha256 = "f".repeat(64);
  const controller = f.create(); await controller.check(); expect(f.calls[0]!.runtime).toEqual(original.runtime); expect(f.calls[0]!.deviceCodeAdmission).toEqual(original.deviceCodeAdmission);
});

test("explicit v2 factory admission stays lazy and forwards the exact immutable selection without execution authority", async () => {
  const f = await fixture({ profile: "codex-account-device-code-tcp443-dns-v2" }), original = structuredClone(f.admitted.deviceCodeAdmission);
  expect(f.calls).toEqual([]); expect(await readdir(f.dataDir)).toEqual([]);
  (f.admitted.deviceCodeAdmission as any).profile = "codex-account-device-code-tcp443-dns-v1";
  const controller = f.create(); expect(f.calls).toEqual([]);
  await controller.check(); expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.deviceCodeAdmission).toEqual(original); expect(Object.isFrozen(f.calls[0]!.deviceCodeAdmission)).toBe(true);
  expect(f.calls[0]!.mode).toBe("device-code");
  expect(f.messages.map(message => message.method)).toEqual(["initialize", "initialized", "account/read"]);
  expect(controller.snapshot().state).toBe("signed-out");
  expect(await controller.close()).toEqual({ released: true, state: "closed" });
});

test("both factory profile variants require exact pins and reject missing or accessor-based selection", () => {
  for (const profile of ["codex-account-device-code-tcp443-dns-v1", "codex-account-device-code-tcp443-dns-v2"] as const) {
    for (const key of ["nativeSha256", "schemaSha256", "parentSha256"] as const) {
      const baseline = options(), value = { ...baseline, deviceCodeAdmission: { ...baseline.deviceCodeAdmission, profile, [key]: "d".repeat(64) } };
      expect(() => createManagedCodexAccountFactory(value)).toThrow("ADMISSION_INVALID");
    }
  }
  for (const profile of [undefined, "codex-account-device-code-tcp443-dns-v3", "offline"]) {
    const value = options(); (value.deviceCodeAdmission as any).profile = profile;
    expect(() => createManagedCodexAccountFactory(value)).toThrow("ADMISSION_INVALID");
  }
  let accessed = false; const value = options();
  Object.defineProperty(value.deviceCodeAdmission, "profile", { get() { accessed = true; return "codex-account-device-code-tcp443-dns-v2"; } });
  expect(() => createManagedCodexAccountFactory(value)).toThrow("ADMISSION_INVALID"); expect(accessed).toBe(false);
});

test("fresh controllers receive monotonic process generations and independent bounded owner identities", async () => {
  const f = await fixture(), first = f.create(); await first.check(); await first.close();
  const second = f.create(); await second.check(); const third = f.create("second-account"); await third.check();
  expect(f.calls.map(call => call.binding.processGeneration)).toEqual([1, 2, 3]);
  expect(new Set(f.calls.map(call => call.binding.owner)).size).toBe(3);
  for (const call of f.calls) expect(call.binding.owner).toMatch(/^textbutler-account-[a-f0-9]{32}$/u);
  expect(f.calls[1]!.binding.leaseGeneration).toBeGreaterThan(f.calls[0]!.binding.leaseGeneration);
});

test("a busy account cannot construct a competing process and joined close enables a fresh generation", async () => {
  const f = await fixture(), first = f.create(), contender = f.create(); await first.check();
  await expect(contender.check()).rejects.toThrow(); expect(f.calls).toHaveLength(1); expect(f.stops()).toBe(0);
  await first.close(); await contender.check(); expect(f.calls).toHaveLength(2); expect(f.calls[1]!.binding.owner).not.toBe(f.calls[0]!.binding.owner);
});

test("signed-in account metadata remains credential-free and emits no model turns", async () => {
  const f = await fixture(), controller = f.create(); f.signIn(); expect((await controller.check()).state).toBe("signed-in");
  expect(JSON.stringify(controller.snapshot())).not.toContain("private@example.invalid");
  expect(f.messages.map(message => message.method)).toEqual(["initialize", "initialized", "account/read", "model/list"]);
  expect((await controller.logout()).state).toBe("signed-out");
  expect(Object.keys(controller).sort()).toEqual(["cancelLogin", "check", "close", "logout", "snapshot", "startLogin"]);
});

test("a returned foreign process port remains retained for cleanup and never releases the account lease", async () => {
  const f = await fixture({ badBinding: true }), controller = f.create(); await expect(controller.check()).rejects.toThrow();
  expect(await controller.close()).toEqual({ released: false, state: "recovery-required" }); expect(f.stops()).toBe(1);
  expect(f.leases.inspect("codex", "native-codex")).not.toBeNull(); expect(f.messages).toEqual([]);
});

test("an uncertain process constructor failure keeps the lease fenced", async () => {
  const f = await fixture({ throwProcess: true }), controller = f.create(); await expect(controller.check()).rejects.toThrow();
  expect(await controller.close()).toEqual({ released: false, state: "recovery-required" }); expect(f.leases.inspect("codex", "native-codex")).not.toBeNull(); expect(f.calls).toHaveLength(1);
});

test("a failed process join cannot release custody and a later joined retry can", async () => {
  const f = await fixture({ joined: false }), controller = f.create(); await controller.check();
  expect(await controller.close()).toEqual({ released: false, state: "recovery-required" }); expect(f.leases.inspect("codex", "native-codex")).not.toBeNull();
  f.join(); expect(await controller.close()).toEqual({ released: true, state: "closed" }); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
});

test.each(["root-mode", "root-link", "state-link", "account-root-link"])("unsafe %s cannot start transport or acquire an account lease", async kind => {
  const f = await fixture(); let directory = f.dataDir;
  if (kind === "root-mode") await chmod(f.dataDir, 0o755);
  else if (kind === "root-link") { directory = join(f.dataDir, "linked-root"); await symlink(f.dataDir, directory); }
  else { const target = join(f.dataDir, "target"); await mkdir(target, { mode: 0o700 });
    if (kind === "state-link") await symlink(target, join(f.dataDir, "state"));
    else { await mkdir(join(f.dataDir, "state"), { mode: 0o700 }); await symlink(target, join(f.dataDir, "state", "codex-accounts")); }
  }
  expect(() => f.create("native-codex", directory)).toThrow(); expect(f.calls).toHaveLength(0); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
});

test("factory rejects unknown fields, stale pins and accessors before effects", async () => {
  for (const key of ["nativeSha256", "schemaSha256", "parentSha256"]) { const value = options(); (value.deviceCodeAdmission as any)[key] = "d".repeat(64); expect(() => createManagedCodexAccountFactory(value)).toThrow("ADMISSION_INVALID"); }
  for (const key of ["env", "argv", "accessToken", "mode"]) expect(() => createManagedCodexAccountFactory({ ...options(), [key]: "denied" } as any)).toThrow("ADMISSION_INVALID");
  let accessed = false; const value = options(); Object.defineProperty(value.runtime, "executablePath", { get() { accessed = true; return "/denied"; } });
  expect(() => createManagedCodexAccountFactory(value)).toThrow("ADMISSION_INVALID"); expect(accessed).toBe(false);
});

test("aborted owner operations do not start a native transport", async () => {
  const f = await fixture(), controller = f.create(), abort = new AbortController(); abort.abort();
  await expect(controller.startLogin("chatgptDeviceCode", abort.signal)).rejects.toThrow("ABORTED"); await expect(controller.check(abort.signal)).rejects.toThrow("ABORTED");
  expect(f.calls).toHaveLength(0); expect(f.leases.inspect("codex", "native-codex")).toBeNull(); expect(await controller.close()).toEqual({ released: true, state: "closed" });
});
