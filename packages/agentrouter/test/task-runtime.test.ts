import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteAccountLeases } from "../src/accounts.ts";
import { createCapabilityBroker, createCapabilityProfile, type CapabilityTool } from "../src/capabilities.ts";
import { AgentStoppedError } from "../src/runtime.ts";
import { assertAgentTaskAccountLease, runAgentTask, type AgentTaskAdapter, type AgentTaskBinding, type AgentTaskCompletion, type AgentTaskExecutionRequest,
  type AgentTaskRequest, type AgentTaskStopEvidence, type TaskRuntimeQualification } from "../src/task-runtime.ts";

const hash = (char: string) => char.repeat(64);
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
function setup(tools: readonly CapabilityTool[] = []) {
  const db = new Database(":memory:"), leases = new SqliteAccountLeases(db);
  const capability = createCapabilityProfile({ id: "synthetic.research", version: 1, tools });
  const profile = { id: capability.id, version: capability.version, digest: capability.digest };
  const controller = new AbortController();
  const request: AgentTaskRequest = { route: { id: "codex-subscription", provider: "codex", authentication: "subscription" },
    accountId: "account-one", workspaceId: "workspace-one", runId: "run-one", profile,
    model: { id: "synthetic-model", reasoningEffort: "ultra", serviceTier: "priority" }, purpose: "research",
    prompt: "Synthetic bounded task", limits: { maxRunMs: 10_000, maxCleanupMs: 1_000, maxOutputBytes: 64 }, signal: controller.signal };
  let now = 1_000;
  const broker = createCapabilityBroker({ profile: capability, workspaceId: request.workspaceId, runId: request.runId, isActive: () => true });
  const qualification: TaskRuntimeQualification = { status: "qualified", route: request.route, profile,
    runtimeVersion: "synthetic-only", runtimeDigest: hash("a"), evidenceDigest: hash("b"), expiresAt: 100_000,
    controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
      isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } };
  const binding = (r: AgentTaskExecutionRequest): AgentTaskBinding => ({ route: r.route, accountId: r.accountId, workspaceId: r.workspaceId,
    runId: r.runId, profile: r.profile, model: r.model, runtime: r.runtime, accountLease: r.accountLease });
  const complete = (r: AgentTaskExecutionRequest): AgentTaskCompletion => ({ ...binding(r), output: "synthetic answer",
    outcome: { status: "completed", code: null }, usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null } });
  const stopped = (r: AgentTaskExecutionRequest): AgentTaskStopEvidence => ({ ...binding(r), processStopped: true, controllersStopped: true,
    joined: true, stoppedAtUnixMs: now, proofDigest: hash("c") });
  let runs = 0, stops = 0;
  const adapter: AgentTaskAdapter = { route: request.route, runtime: { version: "synthetic-only", digest: hash("a") }, qualification,
    async run(r) { runs++; return complete(r); }, async stop(r) { stops++; return stopped(r); } };
  return { db, leases, request, broker, adapter, controller, complete, stopped, binding,
    options: { adapters: [adapter], leases, now: () => now }, setNow(value: number) { now = value; }, counts: () => ({ runs, stops }) };
}

describe("generic task admission", () => {
  test("passes the one acquired account lease unchanged through execution and stop", async () => {
    const f = setup();
    try {
      const old = f.leases.acquire({ provider: "codex", accountId: f.request.accountId, owner: "previous-run", now: 0, ttlMs: 1_000 });
      expect(f.leases.release(old)).toBe(true);
      let acquisitions = 0, stopLease: unknown;
      let seen!: AgentTaskExecutionRequest["accountLease"];
      const acquire = f.leases.acquire.bind(f.leases);
      f.leases.acquire = input => { acquisitions++; return acquire(input); };
      f.adapter.run = async r => { seen = r.accountLease;
        expect(f.leases.inspect("codex", f.request.accountId)).toEqual(seen); return f.complete(r); };
      f.adapter.stop = async r => { stopLease = r.accountLease; return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(acquisitions).toBe(1); expect(stopLease).toBe(seen); expect(Object.isFrozen(seen)).toBe(true);
      expect(seen).toMatchObject({ generation: 2, owner: f.request.runId, expiresAt: 12_000 });
      expect(result.stop.accountLease).toEqual(seen);
      expect(f.leases.inspect("codex", f.request.accountId)).toBeNull();
    } finally { f.db.close(); }
  });
  test("routes explicitly, snapshots exact settings, preserves unknown usage and releases only after joined stop", async () => {
    const f = setup();
    try {
      let seen!: AgentTaskExecutionRequest;
      f.adapter.run = async r => { seen = r; return f.complete(r); };
      const promise = runAgentTask(f.options, f.request, f.broker);
      (f.request.model as { id: string }).id = "mutated-after-dispatch";
      (f.request.limits as { maxOutputBytes: number }).maxOutputBytes = 1;
      const result = await promise;
      expect(seen.model.id).toBe("synthetic-model"); expect(seen.limits.maxOutputBytes).toBe(64);
      expect(Object.isFrozen(seen)).toBe(true); expect(Object.isFrozen(seen.model)).toBe(true);
      expect(Object.isFrozen(seen.route)).toBe(true); expect(Object.isFrozen(seen.profile)).toBe(true);
      expect(seen.executionDeadlineUnixMs).toBe(11_000); expect(seen.cleanupDeadlineUnixMs).toBe(12_000);
      expect(seen.runtime.evidenceDigest).toBe(hash("b")); expect(result.usage.costUsd).toBeNull();
      expect(result.outcome.status).toBe("completed"); expect(result.stop.proofDigest).toBe(hash("c"));
      expect(result.brokerJoined).toBe(true); expect(result.custody).toBe("released");
      expect(f.leases.inspect("codex", "account-one")).toBeNull(); expect(() => f.broker.assertActive()).toThrow("REVOKED");
    } finally { f.db.close(); }
  });
  test("API never substitutes for subscription and absent adapters are refused before account acquisition", async () => {
    for (const kind of ["absent", "api", "unqualified", "wrong-runtime", "wrong-profile", "expiry", "missing-control", "duplicate"] as const) {
      const f = setup();
      try {
        if (kind === "absent") f.options.adapters = [];
        if (kind === "api") (f.adapter as { route: unknown }).route = { ...f.request.route, authentication: "api" };
        if (kind === "unqualified") (f.adapter as { qualification: unknown }).qualification = { status: "unqualified", reason: "not qualified" };
        if (kind === "wrong-runtime") (f.adapter.runtime as { digest: string }).digest = hash("d");
        if (kind === "wrong-profile") (f.adapter.qualification as { profile: unknown }).profile = { ...f.request.profile, version: 2 };
        if (kind === "expiry") (f.adapter.qualification as { expiresAt: number }).expiresAt = 11_999;
        if (kind === "missing-control") (f.adapter.qualification as { controls: { noCommandTools: boolean } }).controls.noCommandTools = false;
        if (kind === "duplicate") f.options.adapters.push(f.adapter);
        await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow();
        expect(f.counts()).toEqual({ runs: 0, stops: 0 }); expect(f.leases.inspect("codex", "account-one")).toBeNull();
        expect(() => f.broker.assertActive()).toThrow("REVOKED");
      } finally { f.db.close(); }
    }
  });
  test("requires bounded total, full model settings and exact broker binding", async () => {
    const changes = [{ limits: { maxRunMs: 3_600_000, maxCleanupMs: 1_000, maxOutputBytes: 1 } },
      { limits: { maxRunMs: 1, maxCleanupMs: 1, maxOutputBytes: 1 } },
      { model: { id: "synthetic-model", reasoningEffort: "ultra" } }, { workspaceId: "other" }, { runId: "other" },
      { profile: { id: "synthetic.research", version: 2, digest: hash("a") } }];
    for (const change of changes) {
      const f = setup(); try {
        await expect(runAgentTask(f.options, { ...f.request, ...change } as AgentTaskRequest, f.broker)).rejects.toThrow();
        expect(f.counts().runs).toBe(0); expect(f.leases.inspect("codex", "account-one")).toBeNull();
      } finally { f.db.close(); }
    }
  });
  test("qualification and preflight cover the whole original deadline, and lease TTL cannot be stolen", async () => {
    const f = setup(), gate = deferred<void>();
    try {
      f.adapter.run = async r => { await gate.promise; return f.complete(r); };
      const task = runAgentTask(f.options, f.request, f.broker);
      expect(f.leases.inspect("codex", "account-one")?.expiresAt).toBe(12_000);
      expect(() => f.leases.acquire({ provider: "codex", accountId: "account-one", owner: "other", now: 999_999, ttlMs: 1_000 })).toThrow("RECOVERY_REQUIRED");
      gate.resolve(); await task;
    } finally { f.db.close(); }
    const g = setup(); try {
      let reads = 0; g.options.now = () => ++reads === 1 ? 1_000 : 11_000;
      await expect(runAgentTask(g.options, g.request, g.broker)).rejects.toThrow("ADMISSION_DEADLINE");
      expect(g.counts().runs).toBe(0); expect(g.leases.inspect("codex", "account-one")).toBeNull();
    } finally { g.db.close(); }
  });
});

describe("runtime-created lease authority", () => {
  test("authority requires the original lease object and immutable request, then retires after settlement", async () => {
    const f = setup(); let retained!: AgentTaskExecutionRequest, getterCalls = 0;
    try {
      f.adapter.run = async request => {
        retained = request;
        expect(assertAgentTaskAccountLease(request)).toBe(request.accountLease);
        expect(assertAgentTaskAccountLease({ ...request })).toBe(request.accountLease);
        expect(() => assertAgentTaskAccountLease({ ...request, accountLease: { ...request.accountLease } })).toThrow("UNTRUSTED");
        for (const changed of [{ accountId: "other-account" }, { runId: "other-run" }, { workspaceId: "other-workspace" },
          { prompt: "other-prompt" }, { signal: new AbortController().signal }, { cleanupDeadlineUnixMs: request.cleanupDeadlineUnixMs + 1 }])
          expect(() => assertAgentTaskAccountLease({ ...request, ...changed })).toThrow("BINDING_MISMATCH");
        const accessor = { ...request };
        Object.defineProperty(accessor, "accountLease", { enumerable: true, get() { getterCalls++; return request.accountLease; } });
        expect(() => assertAgentTaskAccountLease(accessor)).toThrow("RECORD_INVALID");
        return f.complete(request);
      };
      f.adapter.stop = async request => {
        expect(assertAgentTaskAccountLease(request, "stop")).toBe(retained.accountLease);
        expect(() => assertAgentTaskAccountLease(retained)).toThrow("BINDING_MISMATCH");
        return f.stopped(request);
      };
      await runAgentTask(f.options, f.request, f.broker);
      expect(getterCalls).toBe(0);
      expect(() => assertAgentTaskAccountLease(retained, "stop")).toThrow("UNTRUSTED");
    } finally { f.db.close(); }
  });
  test("mutating a lease-store alias cannot relabel execution or its eventual release", async () => {
    const f = setup(), gate = deferred<void>();
    let alias!: { provider: "codex" | "claude"; accountId: string; owner: string; generation: number; expiresAt: number };
    const acquire = f.leases.acquire.bind(f.leases);
    f.leases.acquire = input => { alias = { ...acquire(input) }; return alias; };
    try {
      f.adapter.run = async request => { await gate.promise;
        expect(request.accountLease).toMatchObject({ owner: "run-one", generation: 1, expiresAt: 12_000 });
        expect(assertAgentTaskAccountLease(request)).toBe(request.accountLease); return f.complete(request); };
      const running = runAgentTask(f.options, f.request, f.broker);
      alias.owner = "forged-owner"; alias.generation = 2; alias.expiresAt = 999_999;
      gate.resolve(); expect((await running).custody).toBe("released");
      expect(f.leases.inspect("codex", f.request.accountId)).toBeNull();
    } finally { gate.resolve(); f.db.close(); }
  });
  test("a prior generation's stop receipt cannot release the same account and run after reacquisition", async () => {
    const f = setup();
    try {
      const first = await runAgentTask(f.options, f.request, f.broker);
      const secondBroker = createCapabilityBroker({ profile: f.broker.profile, workspaceId: f.request.workspaceId, runId: f.request.runId, isActive: () => true });
      f.adapter.stop = async () => first.stop;
      await expect(runAgentTask(f.options, f.request, secondBroker)).rejects.toThrow("RECEIPT_BINDING_MISMATCH");
      expect(f.leases.inspect("codex", f.request.accountId)?.generation).toBe(first.accountLease.generation + 1);
    } finally { f.db.close(); }
  });
  test("uncertain cleanup retires execution authority while retaining the acquired lease", async () => {
    const f = setup(); let retained!: AgentTaskExecutionRequest;
    try {
      f.adapter.run = async request => { retained = request; return f.complete(request); };
      f.adapter.stop = async () => { throw Error("synthetic uncertain stop"); };
      await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow("CUSTODY_UNPROVEN");
      expect(() => assertAgentTaskAccountLease(retained, "stop")).toThrow("UNTRUSTED");
      expect(f.leases.inspect("codex", f.request.accountId)).toEqual(retained.accountLease);
    } finally { f.db.close(); }
  });
});

describe("exact receipt and custody", () => {
  test("mismatched route/model/profile/usage/output and stop bindings retain custody after stop attempt", async () => {
    for (const kind of ["route", "model", "profile", "runtime", "usage", "output", "null", "stop"] as const) {
      const f = setup(); let stopCalls = 0;
      try {
        f.adapter.run = async r => {
          const value = f.complete(r);
          if (kind === "route") return { ...value, route: { ...value.route, authentication: "api" } };
          if (kind === "model") return { ...value, model: { ...value.model, reasoningEffort: "low" } };
          if (kind === "profile") return { ...value, profile: { ...value.profile, version: 2 } };
          if (kind === "runtime") return { ...value, runtime: { ...value.runtime, evidenceDigest: hash("d") } };
          if (kind === "usage") return { ...value, usage: { ...value.usage, inputTokens: -1 } };
          if (kind === "output") return { ...value, output: "é".repeat(33) };
          if (kind === "null") return null as unknown as AgentTaskCompletion;
          return value;
        };
        f.adapter.stop = async r => { stopCalls++; return { ...f.stopped(r), runId: kind === "stop" ? "other" : r.runId }; };
        await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow();
        expect(stopCalls).toBe(1); expect(f.leases.inspect("codex", "account-one")?.owner).toBe("run-one");
      } finally { f.db.close(); }
    }
  });
  test("typed stopped failures and AgentStoppedError keep honest failure outcomes; arbitrary errors retain custody", async () => {
    for (const kind of ["typed", "stopped-error", "uncertain"] as const) {
      const f = setup(); try {
        f.adapter.run = async r => {
          if (kind === "stopped-error") throw new AgentStoppedError("private-error");
          if (kind === "uncertain") throw new Error("private-error");
          return { ...f.complete(r), output: null, outcome: { status: "failed", code: "MODEL_FAILED" } };
        };
        if (kind === "uncertain") {
          await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow("CUSTODY_RETAINED");
          expect(f.leases.inspect("codex", "account-one")).not.toBeNull();
        } else {
          const result = await runAgentTask(f.options, f.request, f.broker);
          expect(result.outcome.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("private-error");
          expect(f.leases.inspect("codex", "account-one")).toBeNull();
        }
      } finally { f.db.close(); }
    }
  });
  test("stop rejection retains custody and cannot manufacture completion", async () => {
    const f = setup(); try {
      f.adapter.stop = async () => { throw Error("private-stop-error"); };
      await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow("CUSTODY_UNPROVEN");
      expect(f.leases.inspect("codex", "account-one")).not.toBeNull();
    } finally { f.db.close(); }
  });
});

describe("deadline and cancellation join", () => {
  test("cancel immediately revokes, invokes stop once and waits for run plus stop", async () => {
    const f = setup(), runGate = deferred<void>(), stopGate = deferred<void>();
    let stopCalls = 0, settled = false, seenSignal!: AbortSignal;
    try {
      f.adapter.run = async r => { seenSignal = r.signal; await runGate.promise; return f.complete(r); };
      f.adapter.stop = async r => { stopCalls++; await stopGate.promise; return f.stopped(r); };
      const task = runAgentTask(f.options, f.request, f.broker).then(result => { settled = true; return result; });
      f.controller.abort(); await tick();
      expect(seenSignal.aborted).toBe(true); expect(stopCalls).toBe(1); expect(() => f.broker.assertActive()).toThrow("REVOKED");
      expect(settled).toBe(false); expect(f.leases.inspect("codex", "account-one")).not.toBeNull();
      stopGate.resolve(); await tick(); expect(settled).toBe(false);
      runGate.resolve(); const result = await task;
      expect(result.outcome.status).toBe("cancelled"); expect(result.output).toBeNull(); expect(stopCalls).toBe(1);
      expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });
  test("execution timer requests stop and returns a typed deadline after actual joins", async () => {
    const f = setup(), runGate = deferred<void>();
    try {
      f.request = { ...f.request, limits: { maxRunMs: 10, maxCleanupMs: 1_000, maxOutputBytes: 64 } };
      f.adapter.run = async r => { await runGate.promise; return f.complete(r); };
      f.adapter.stop = async r => { f.setNow(1_010); runGate.resolve(); return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(result.outcome.status).toBe("deadline-exceeded"); expect(result.output).toBeNull();
      expect(result.timing.cleanupDeadlineExceeded).toBe(false); expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });
  test("broker handler closure is joined even when provider run and stop already settled", async () => {
    const handlerGate = deferred<void>(), started = deferred<void>();
    const f = setup([{ name: "read", description: "Synthetic", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      parseInput: value => value, async execute(_value, context) { started.resolve(); await handlerGate.promise; context.assertActive(); return null; } }]);
    let settled = false;
    try {
      f.adapter.run = async (r, b) => { b.invoke("read", {}).catch(() => {}); await started.promise; return f.complete(r); };
      const task = runAgentTask(f.options, f.request, f.broker).then(value => { settled = true; return value; });
      await started.promise; await tick(); expect(settled).toBe(false);
      expect(f.leases.inspect("codex", "account-one")).not.toBeNull();
      handlerGate.resolve(); await task; expect(settled).toBe(true); expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });
  test("late known closure releases custody only with a failed cleanup outcome", async () => {
    const f = setup(); try {
      f.adapter.stop = async r => { f.setNow(12_001); return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(result.outcome).toEqual({ status: "failed", code: "TASK_CLEANUP_DEADLINE_EXCEEDED" });
      expect(result.timing.cleanupDeadlineExceeded).toBe(true); expect(result.output).toBeNull();
      expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });
  test("early cleanup has its own deadline and does not consume the remaining execution allowance", async () => {
    const f = setup(); try {
      let stopDeadline = 0;
      f.adapter.stop = async r => { stopDeadline = r.cleanupDeadlineUnixMs; f.setNow(2_001); return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(stopDeadline).toBe(2_000); expect(result.timing.outerDeadlineUnixMs).toBe(12_000);
      expect(result.timing.cleanupDeadlineUnixMs).toBe(2_000);
      expect(result.outcome.code).toBe("TASK_CLEANUP_DEADLINE_EXCEEDED");
    } finally { f.db.close(); }
  });
  test("execution timer ends when run settles, while cleanup still joins", async () => {
    const f = setup(); try {
      f.request = { ...f.request, limits: { maxRunMs: 10, maxCleanupMs: 1_000, maxOutputBytes: 64 } };
      f.adapter.stop = async r => { await new Promise(resolve => setTimeout(resolve, 20)); f.setNow(1_020); return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(result.outcome.status).toBe("completed"); expect(result.timing.cleanupDeadlineExceeded).toBe(false);
    } finally { f.db.close(); }
  });
  test("lease acquisition crossing the deadline, cancellation or broker revocation never starts adapter", async () => {
    for (const kind of ["deadline", "cancel", "revoke"] as const) {
      const f = setup(); try {
        const acquire = f.leases.acquire.bind(f.leases);
        f.leases.acquire = value => { const lease = acquire(value);
          if (kind === "deadline") f.setNow(11_000);
          if (kind === "cancel") f.controller.abort("private-reason");
          if (kind === "revoke") f.broker.revoke();
          return lease;
        };
        await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow(kind === "deadline" ? "ADMISSION_DEADLINE" : kind === "cancel" ? "CANCELLED_BEFORE" : "BROKER_REVOKED");
        expect(f.counts()).toEqual({ runs: 0, stops: 0 }); expect(f.leases.inspect("codex", "account-one")).toBeNull();
      } finally { f.db.close(); }
    }
  });
  test("captured signal and host service references survive caller alias mutation", async () => {
    const f = setup(), gate = deferred<void>();
    const originalSignal = f.request.signal;
    let removed = 0;
    const remove = originalSignal.removeEventListener.bind(originalSignal);
    originalSignal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => { removed++; remove(type, listener, options); };
    try {
      f.adapter.run = async r => { await gate.promise; return f.complete(r); };
      const task = runAgentTask(f.options, f.request, f.broker);
      (f.request as { signal: AbortSignal }).signal = new AbortController().signal;
      f.options.now = () => { throw Error("mutated-clock"); };
      (f.options as { leases: unknown }).leases = { release() { throw Error("mutated-store"); } };
      f.controller.abort(); gate.resolve();
      const result = await task;
      expect(result.outcome.status).toBe("cancelled"); expect(removed).toBe(1);
      expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });
  test("already cancelled admission emits only a fixed code", async () => {
    const f = setup(); try {
      f.controller.abort("private-cancellation-text");
      await expect(runAgentTask(f.options, f.request, f.broker)).rejects.toThrow("TASK_CANCELLED_BEFORE_ADAPTER");
      expect(f.counts()).toEqual({ runs: 0, stops: 0 }); expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });

  test("synchronous abort callbacks cannot create another stop or reset the cleanup budget", async () => {
    const f = setup(); let stops = 0, deadline = 0;
    try {
      f.adapter.run = async r => {
        r.signal.addEventListener("abort", () => { f.setNow(1_050); f.controller.abort(); }, { once: true });
        return f.complete(r);
      };
      f.adapter.stop = async r => { stops++; deadline = r.cleanupDeadlineUnixMs; return f.stopped(r); };
      const result = await runAgentTask(f.options, f.request, f.broker);
      expect(stops).toBe(1); expect(deadline).toBe(2_000);
      expect(result.outcome.status).toBe("cancelled"); expect(f.leases.inspect("codex", "account-one")).toBeNull();
    } finally { f.db.close(); }
  });

});
