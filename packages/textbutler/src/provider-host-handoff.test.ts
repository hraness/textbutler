import { afterEach, expect, test } from "bun:test";
import { createCapabilityBroker, createCapabilityProfile } from "@hraness/agentmixer";
import { createManagedCodexAccountController, type CodexAccountCloseReceipt, type CodexAccountRequest } from "@hraness/agentmixer";
import { assertAgentTaskAccountLease, type AgentTaskAdapter, type AgentTaskBinding, type AgentTaskExecutionRequest, type AgentTaskRequest } from "@hraness/agentmixer";
import { createProviderHost } from "./provider-host.ts";
import { RunJournal } from "./journal.ts";

const deferred = <T>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const hash = (c: string) => c.repeat(64);

/** Real controller, router, capability broker and SQLite leases; no native,
 * credential, network, filesystem or provider calls occur in this fixture. */
function fixture(options: { adapters?: boolean; controls?: boolean; failRun?: boolean; failStop?: boolean;
  ownerCloseFault?: "released-false" | "wrong-state" | "unchanged-snapshot" | "throw" } = {}) {
  const journal = RunJournal.memory(), leases = journal.accountLeases(), acquired: string[] = [];
  const acquire = leases.acquire.bind(leases); leases.acquire = input => { acquired.push(input.owner); return acquire(input); };
  const profile = createCapabilityProfile({ id: "synthetic.handoff", version: 1, tools: [] });
  const route = { id: "synthetic-codex-respond", provider: "codex", authentication: "subscription" } as const;
  const runs: AgentTaskExecutionRequest[] = [], stops: AgentTaskExecutionRequest[] = [], factories: string[] = [];
  const runStarted = deferred<AgentTaskExecutionRequest>(), stopStarted = deferred<void>(), closeStarted = deferred<void>();
  let runGate: ReturnType<typeof deferred<void>> | undefined, stopGate: ReturnType<typeof deferred<void>> | undefined;
  let accountCloseGate: ReturnType<typeof deferred<boolean>> | undefined, closeHook: (() => void) | undefined;
  let accountCheckGate: ReturnType<typeof deferred<void>> | undefined;
  let closeCalls = 0;
  const binding = (r: AgentTaskExecutionRequest): AgentTaskBinding => ({ route: r.route, accountId: r.accountId, workspaceId: r.workspaceId,
    runId: r.runId, profile: r.profile, model: r.model, runtime: r.runtime, accountLease: r.accountLease,
    ...(r.authority === undefined ? {} : { authority: r.authority }) });
  const adapter: AgentTaskAdapter = { route, runtime: { version: "synthetic-only", digest: hash("a") },
    qualification: { status: "qualified", route, profile: { id: profile.id, version: profile.version, digest: profile.digest }, runtimeVersion: "synthetic-only", runtimeDigest: hash("a"), evidenceDigest: hash("b"), expiresAt: 1_000_000,
      controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
        isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } },
    async run(request) {
      expect(assertAgentTaskAccountLease(request)).toBe(request.accountLease);
      expect(leases.inspect("codex", request.accountId)).toEqual(request.accountLease);
      runs.push(request); runStarted.resolve(request); if (runGate) await runGate.promise;
      if (options.failRun) throw Error("synthetic uncertain adapter failure");
      return { ...binding(request), output: "synthetic answer", usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }, outcome: { status: "completed", code: null } };
    },
    async stop(request) {
      expect(assertAgentTaskAccountLease(request, "stop")).toBe(request.accountLease);
      stops.push(request); stopStarted.resolve(); if (stopGate) await stopGate.promise;
      if (options.failStop) throw Error("synthetic stop proof unavailable");
      return { ...binding(request), processStopped: true, controllersStopped: true, joined: true, stoppedAtUnixMs: 1_000, proofDigest: hash("c") };
    },
  };
  const reply = (request: CodexAccountRequest, value: unknown) => ({ binding: request.binding, accountGeneration: request.accountGeneration, value });
  const host = createProviderHost({ dataDir: "/synthetic-unused", config: { schemaVersion: 1, providerAccounts: [{ id: "other-codex", label: "Synthetic other", route: "codex" }] }, leases,
    now: () => 1_000, taskAdapters: options.adapters === false ? [] : [adapter],
    ...(options.controls === false ? {} : { managedCodex: ({ accountId, leases }: Parameters<NonNullable<Parameters<typeof createProviderHost>[0]["managedCodex"]>>[0]) => {
      factories.push(accountId); const controller = createManagedCodexAccountController({ accountId, owner: `controller-${factories.length}`, processGeneration: factories.length, leases, now: () => 1_000,
        transportFactory: () => ({
          async accountRead(r) { if (accountCheckGate) await accountCheckGate.promise; return reply(r, { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "pro" } }); },
          async startLogin(r) { return reply(r, { type: "chatgptDeviceCode", loginId: "synthetic-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" }); },
          async cancelLogin(r) { return reply(r, { status: "canceled" }); },
          async logout(r) { return reply(r, {}); },
          async listModels(r) { return reply(r, { data: [{ id: "synthetic-model", model: "synthetic-model", displayName: "Synthetic model", hidden: false, isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Synthetic" }], defaultReasoningEffort: "high", serviceTiers: [], defaultServiceTier: null }], nextCursor: null }); },
          async close({ binding }): Promise<CodexAccountCloseReceipt> {
            closeCalls++; closeStarted.resolve(); closeHook?.();
            const joined = accountCloseGate ? await accountCloseGate.promise : true;
            return { binding, processExited: joined, processGroupStopped: joined, stdoutEnded: joined, stderrEnded: joined,
              writesSettled: joined, requestsSettled: joined, notificationsSettled: joined };
          },
        }),
      });
      if (!options.ownerCloseFault) return controller;
      return { ...controller, async close() {
        if (options.ownerCloseFault === "throw") throw Error("synthetic private close error");
        if (options.ownerCloseFault === "unchanged-snapshot") return { released: true, state: "closed" as const };
        const receipt = await controller.close();
        return options.ownerCloseFault === "released-false" ? { ...receipt, released: false } : { ...receipt, state: "recovery-required" as const };
      } };
    } }),
  });
  const signal = new AbortController().signal;
  const request = (runId = "synthetic-run", accountId = "native-codex", inputSignal = signal): AgentTaskRequest => ({ route: { ...route }, accountId, workspaceId: "contact-one", runId,
    profile: { id: profile.id, version: profile.version, digest: profile.digest }, model: { id: "synthetic-model", reasoningEffort: "high", serviceTier: "default" },
    purpose: "respond", prompt: "Synthetic task", limits: { maxRunMs: 10_000, maxCleanupMs: 1_000, maxOutputBytes: 1024 }, signal: inputSignal });
  const broker = (r: AgentTaskRequest) => createCapabilityBroker({ profile, workspaceId: r.workspaceId, runId: r.runId, isActive: () => true });
  cleanups.push(async () => {
    runGate?.resolve(); stopGate?.resolve(); accountCloseGate?.resolve(true); accountCheckGate?.resolve();
    await host.close().catch(() => {}); journal.close(); // Any retained lease is wholly synthetic; no native owner exists.
  });
  return { host, leases, acquired, runs, stops, factories, runStarted, stopStarted, closeStarted, adapter, request, broker, signal,
    holdRun() { return runGate = deferred<void>(); }, holdStop() { return stopGate = deferred<void>(); },
    holdAccountClose() { return accountCloseGate = deferred<boolean>(); }, holdAccountCheck() { return accountCheckGate = deferred<void>(); },
    clearAccountClose() { accountCloseGate = undefined; }, onAccountClose(hook: () => void) { closeHook = hook; }, closes: () => closeCalls };
}

test("joins the exact owner before the runtime acquires its one task lease", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal);
  const release = f.holdAccountClose(), r = f.request(), b = f.broker(r);
  const task = f.host.runManagedTask(r, b); await f.closeStarted.promise;
  expect(f.acquired).toEqual(["controller-1"]); expect(f.runs).toHaveLength(0);
  expect(f.leases.inspect("codex", "native-codex")?.owner).toBe("controller-1");
  release.resolve(true); const result = await task;
  expect(f.acquired).toEqual(["controller-1", r.runId]); expect(result.accountLease.generation).toBe(2);
  expect(f.runs[0]!.authority).toMatchObject({ kind: "codex-managed", accountGeneration: 2 });
  expect(f.runs[0]!.authority?.modelCatalogDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(f.stops[0]!.accountLease).toBe(f.runs[0]!.accountLease); expect(result.custody).toBe("released");
  expect(f.leases.inspect("codex", "native-codex")).toBeNull(); expect(() => b.assertActive()).toThrow();
  await f.host.check("native-codex", f.signal); expect(f.factories).toEqual(["native-codex", "native-codex"]);
});

test("owner calls and overlapping tasks fail busy through handoff, execution and joined stop", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal);
  const release = f.holdAccountClose(), run = f.holdRun(), stop = f.holdStop(), r = f.request();
  const task = f.host.runManagedTask(r, f.broker(r)); await f.closeStarted.promise;
  async function busy() {
    await expect(f.host.check("native-codex", f.signal)).rejects.toThrow("busy");
    await expect(f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal)).rejects.toThrow("busy");
    await expect(f.host.cancelLogin("native-codex", "synthetic-login", f.signal)).rejects.toThrow("busy");
    await expect(f.host.logout("native-codex", f.signal)).rejects.toThrow("busy");
    const other = f.request("other-run"), b = f.broker(other);
    await expect(f.host.runManagedTask(other, b)).rejects.toThrow("busy"); expect(() => b.assertActive()).toThrow();
  }
  await busy(); release.resolve(true); await f.runStarted.promise; await busy();
  run.resolve(); await f.stopStarted.promise; await busy(); expect(f.factories).toHaveLength(1);
  stop.resolve(); await task; await f.host.check("native-codex", f.signal); expect(f.factories).toHaveLength(2);
});

test("per-account exclusion preserves independent account progress and owner serialization", async () => {
  const f = fixture(), checking = f.holdAccountCheck();
  const owner = f.host.check("native-codex", f.signal);
  const r = f.request(); await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("busy");
  await expect(f.host.logout("native-codex", f.signal)).rejects.toThrow("busy");
  checking.resolve(); await owner;
  const run = f.holdRun(), task = f.host.runManagedTask(r, f.broker(r)); await f.runStarted.promise;
  await f.host.check("other-codex", f.signal); expect(f.leases.inspect("codex", "other-codex")?.owner).toBe("controller-2");
  run.resolve(); await task;
});

test("a pending login stays active and cannot be silently canceled for task handoff", async () => {
  const f = fixture(); await f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal);
  const r = f.request(); await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow(/sign-in is pending|account is not ready/);
  expect(f.closes()).toBe(0); expect(f.runs).toHaveLength(0); expect(f.acquired).toEqual(["controller-1"]);
  expect(f.host.accounts()[0]!.managedAccount?.pendingLoginId).toBe("synthetic-login");
  await f.host.cancelLogin("native-codex", "synthetic-login", f.signal);
  await f.host.check("native-codex", f.signal);
  expect((await f.host.runManagedTask(r, f.broker(r))).custody).toBe("released");
});

test("failed owner cleanup preserves the original controller and lease", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); const close = f.holdAccountClose(); close.resolve(false);
  const r = f.request(); await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("handoff needs recovery");
  expect(f.factories).toHaveLength(1); expect(f.acquired).toEqual(["controller-1"]); expect(f.runs).toHaveLength(0);
  expect(f.host.accounts()[0]!.managedAccount?.state).toBe("recovery-required");
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("unavailable");
  f.clearAccountClose(); await f.host.close(); expect(f.leases.inspect("codex", "native-codex")).toBeNull();
});

test.each(["released-false", "wrong-state", "unchanged-snapshot", "throw"] as const)("contradictory owner close %s latches recovery instead of reopening controls", async ownerCloseFault => {
  const f = fixture({ ownerCloseFault }); await f.host.check("native-codex", f.signal); const r = f.request();
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("handoff needs recovery");
  expect(f.acquired).toEqual(["controller-1"]); expect(f.runs).toEqual([]); expect(f.factories).toHaveLength(1);
  expect(f.host.accounts()[0]!.managedAccount?.state).toBe("recovery-required");
  await expect(f.host.check("native-codex", f.signal)).rejects.toThrow("unavailable");
  await expect(f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal)).rejects.toThrow("unavailable");
  expect(f.factories).toHaveLength(1); await f.host.close().catch(() => {});
  expect(f.host.accounts()[0]!.managedAccount?.state).toBe("recovery-required");
  expect(JSON.stringify(f.host.accounts())).not.toContain("synthetic private close error");
});

test("reentrant owner calls cannot enter while the old close is being dispatched", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); let result: Promise<unknown> | undefined;
  f.onAccountClose(() => { result = f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal).catch(error => error); });
  const r = f.request(); await f.host.runManagedTask(r, f.broker(r));
  expect(await result).toBeInstanceOf(Error); expect((await result as Error).message).toContain("busy"); expect(f.factories).toHaveLength(1);
});

test("cancellation during handoff joins the owner and never starts or acquires a task", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); const close = f.holdAccountClose(), controller = new AbortController();
  const r = f.request("cancel-before-task", "native-codex", controller.signal), b = f.broker(r);
  const outcome = f.host.runManagedTask(r, b).catch(error => error); await f.closeStarted.promise; controller.abort();
  await expect(f.host.check("native-codex", f.signal)).rejects.toThrow("busy"); close.resolve(true);
  expect(await outcome).toBeInstanceOf(Error); expect(f.acquired).toEqual(["controller-1"]); expect(f.runs).toHaveLength(0);
  expect(f.leases.inspect("codex", "native-codex")).toBeNull(); expect(() => b.assertActive()).toThrow();
});

test("an already cancelled handoff leaves account controls untouched and closes its broker", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); const controller = new AbortController(); controller.abort();
  const r = f.request("already-cancelled", "native-codex", controller.signal), b = f.broker(r);
  await expect(f.host.runManagedTask(r, b)).rejects.toThrow(); expect(f.closes()).toBe(0); expect(f.acquired).toEqual(["controller-1"]);
  expect(() => b.assertActive()).toThrow(); expect(f.host.accounts()[0]!.managedAccount?.state).toBe("signed-in");
});

test("shutdown revokes the task, keeps its lease through raw joins and publishes one reentrant close", async () => {
  const f = fixture(), run = f.holdRun(), stop = f.holdStop(), r = f.request();
  const task = f.host.runManagedTask(r, f.broker(r)), executing = await f.runStarted.promise;
  let reentrant: Promise<void> | undefined; executing.signal.addEventListener("abort", () => { reentrant = f.host.close(); });
  let closed = false; const closing = f.host.close(); void closing.then(() => { closed = true; });
  expect(reentrant).toBe(closing); await f.stopStarted.promise;
  expect(f.leases.inspect("codex", "native-codex")?.owner).toBe(r.runId);
  await expect(f.host.check("native-codex", f.signal)).rejects.toThrow();
  stop.resolve(); await Promise.resolve(); expect(closed).toBe(false); run.resolve();
  expect((await task).outcome.status).toBe("cancelled"); await closing; expect(f.leases.inspect("codex", "native-codex")).toBeNull();
});

test.each(["run", "stop"] as const)("unproven task %s custody remains visible and forbids owner replacement even after shutdown", async failure => {
  const f = fixture({ failRun: failure === "run", failStop: failure === "stop" }), r = f.request();
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow();
  expect(f.leases.inspect("codex", "native-codex")?.owner).toBe(r.runId);
  expect(f.host.accounts()[0]!.managedAccount?.state).toBe("recovery-required");
  await expect(f.host.check("native-codex", f.signal)).rejects.toThrow("unavailable"); expect(f.factories).toHaveLength(0);
  await expect(f.host.close()).rejects.toThrow("recovery"); expect(f.host.accounts()[0]!.managedAccount?.state).toBe("recovery-required");
});

test("missing or unqualified task adapters reject without fabricating retained lease custody", async () => {
  const f = fixture({ adapters: false }), r = f.request();
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("TASK_ROUTE_UNAVAILABLE");
  expect(f.acquired).toEqual([]); await f.host.check("native-codex", f.signal); expect(f.factories).toHaveLength(1);
  const g = fixture(); (g.adapter as { qualification: unknown }).qualification = { status: "unqualified", reason: "synthetic unavailable" };
  const input = g.request(); await expect(g.host.runManagedTask(input, g.broker(input))).rejects.toThrow(); expect(g.acquired).toEqual([]);
});

test("the public legacy router cannot bypass managed handoff", async () => {
  const f = fixture(), r = f.request(); await expect(f.host.router.runTask(r, f.broker(r))).rejects.toThrow("TASK_ROUTE_UNAVAILABLE");
  expect(f.acquired).toEqual([]); expect(f.runs).toHaveLength(0);
});

test.each(["unknown-account", "api", "claude", "missing-controls"] as const)("managed entry rejects %s without default activation or fallback", async kind => {
  const f = fixture({ controls: kind !== "missing-controls" }), base = f.request();
  const r: AgentTaskRequest = kind === "unknown-account" ? { ...base, accountId: "not-configured" }
    : kind === "api" ? { ...base, route: { ...base.route, authentication: "api" } }
    : kind === "claude" ? { ...base, route: { ...base.route, provider: "claude" } } : base;
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow("unavailable"); expect(f.acquired).toEqual([]); expect(f.factories).toEqual([]);
});

test("handoff snapshots caller values before waiting for controller cleanup", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); const close = f.holdAccountClose(), r = f.request();
  const task = f.host.runManagedTask(r, f.broker(r)); await f.closeStarted.promise;
  (r as { accountId: string }).accountId = "other-codex"; (r.model as { id: string }).id = "changed"; (r.route as { id: string }).id = "changed";
  close.resolve(true); await task; expect(f.runs[0]!.accountId).toBe("native-codex"); expect(f.runs[0]!.model.id).toBe("synthetic-model");
});

test("managed handoff rejects a model absent from the generation-bound catalog before task lease admission", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal);
  const r = f.request("stale-model");
  (r as { model: { id: string } }).model.id = "model-no-longer-in-catalog";
  const b = f.broker(r);
  await expect(f.host.runManagedTask(r, b)).rejects.toThrow("model is unavailable");
  expect(f.acquired).toEqual(["controller-1"]); expect(f.runs).toEqual([]); expect(() => b.assertActive()).toThrow();
  expect(f.leases.inspect("codex", "native-codex")?.owner).toBe("controller-1");
});

test("handoff rejects accessor authority before reading it or closing a controller", async () => {
  const f = fixture(); await f.host.check("native-codex", f.signal); const r = f.request(), b = f.broker(r); let invoked = false;
  Object.defineProperty(r, "route", { enumerable: true, get() { invoked = true; return {}; } });
  await expect(f.host.runManagedTask(r, b)).rejects.toThrow("REQUEST_INVALID"); expect(invoked).toBe(false); expect(f.closes()).toBe(0);
});
