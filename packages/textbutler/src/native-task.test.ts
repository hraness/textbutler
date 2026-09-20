import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCapabilityBroker, createCapabilityProfile, runAgentTask, SqliteAccountLeases } from "@hraness/agentmixer";
import type { AgentTaskExecutionRequest, AgentTaskRoute, AgentTaskStopEvidence, CapabilityProfileIdentity,
  TaskRuntimeQualification } from "@hraness/agentmixer";
import { createNativeTaskAdapter, NATIVE_TASK_LIMITS, parseNativeStep } from "./native-task.ts";

const NOW = 1_000_000, databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture(provider: "codex" | "claude" = "codex", outputs: unknown[] = [{ kind: "final", output: "synthetic" }], qualified = true) {
  const db = new Database(":memory:"); databases.push(db);
  const leases = new SqliteAccountLeases(db), signal = new AbortController();
  const route: AgentTaskRoute = { id: `native-${provider}-test`, provider, authentication: "subscription" };
  let effects = 0, launches = 0, stops = 0, steps = 0;
  const prompts: string[] = [];
  const profile = createCapabilityProfile({ id: "native-test", version: 1, tools: [{ name: "files.read", description: "Synthetic scoped read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parseInput(value) { if (Object.keys(value).length) throw Error("Invalid input"); return value; },
    execute() { effects++; return { text: "synthetic contact fact" }; } }] });
  // The task runtime binds the profile identity; the executable profile stays with the broker.
  const identity: CapabilityProfileIdentity = { id: profile.id, version: profile.version, digest: profile.digest };
  const qualification: TaskRuntimeQualification = { status: "qualified", route, profile: identity, runtimeVersion: "synthetic-only",
    runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), expiresAt: NOW + 600_000,
    controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
      isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } };
  const requests: AgentTaskExecutionRequest[] = [];
  let onNext: (() => void) | undefined, stopReceipt: (value: AgentTaskStopEvidence) => AgentTaskStopEvidence = value => value;
  const adapter = createNativeTaskAdapter({ route, runtime: { version: "synthetic-only", digest: "a".repeat(64) },
    ...(qualified ? { qualification } : {}), now: () => NOW, createController(request) {
      launches++; requests.push(request);
      return { async next(input) {
        expect(input.signal).toBe(request.signal); expect(input.step).toBe(steps++); prompts.push(input.prompt); onNext?.();
        return outputs.shift();
      }, async stopAndJoin(stopping) {
        stops++;
        expect(stopping.accountLease).toBe(request.accountLease);
        return stopReceipt({ route: stopping.route, accountId: stopping.accountId, workspaceId: stopping.workspaceId,
          runId: stopping.runId, profile: stopping.profile, model: stopping.model, runtime: stopping.runtime,
          accountLease: stopping.accountLease, processStopped: true, controllersStopped: true, joined: true,
          stoppedAtUnixMs: NOW, proofDigest: "c".repeat(64) });
      } };
    } });
  const broker = createCapabilityBroker({ profile, workspaceId: "contact-one", runId: "run-one", signal: signal.signal, isActive: () => !signal.signal.aborted });
  const run = () => runAgentTask({ adapters: [adapter], leases, now: () => NOW }, { route, accountId: "native-account", workspaceId: "contact-one",
    runId: "run-one", profile: identity, model: { id: "synthetic", reasoningEffort: null, serviceTier: null }, purpose: "respond", prompt: "Synthetic task",
    limits: { maxRunMs: 120_000, maxCleanupMs: 15_000, maxOutputBytes: 1024 }, signal: signal.signal }, broker);
  // A joined native failure is reported as a released, failed run, never as a
  // resolved reply: routed-agent rejects every outcome that is not "completed".
  const stopped = async () => {
    const result = await run();
    expect(result.custody).toBe("released"); expect(result.output).toBeNull();
    expect(result.outcome.status).not.toBe("completed");
    return result;
  };
  return { run, stopped, adapter, leases, route, requests, signal, prompts, broker, count: () => ({ effects, launches, stops, steps }),
    onNext(value: () => void) { onNext = value; }, changeReceipt(value: typeof stopReceipt) { stopReceipt = value; } };
}

for (const provider of ["codex", "claude"] as const) test(`${provider} subscription task keeps one runtime lease and host-only tools`, async () => {
  const f = fixture(provider, [{ kind: "tool", name: "files.read", input: {} }, { kind: "final", output: "Final synthetic answer" }]);
  const result = await f.run();
  expect(result.output).toBe("Final synthetic answer"); expect(result.custody).toBe("released");
  expect(f.count()).toEqual({ effects: 1, launches: 1, stops: 1, steps: 2 });
  expect(f.prompts[1]).toContain("synthetic contact fact");
  expect(f.leases.inspect(provider, "native-account")).toBeNull();
  await expect(f.broker.invoke("files.read", {})).rejects.toThrow();
});
test("candidate defaults to unqualified before a controller or lease is acquired", async () => {
  const f = fixture("claude", [], false);
  expect(f.adapter.qualification.status).toBe("unqualified"); await expect(f.run()).rejects.toThrow();
  expect(f.count().launches).toBe(0); expect(f.leases.inspect("claude", "native-account")).toBeNull();
});
test("native output cannot add a tool or a recipient to host capabilities", async () => {
  for (const output of [{ kind: "tool", name: "shell", input: { command: "pwd" } },
    { kind: "tool", name: "files.read", input: { recipient: "another-contact" } }]) {
    const f = fixture("codex", [output]);
    expect((await f.stopped()).outcome.code).toBe("TASK_ADAPTER_STOPPED");
    expect(f.count().effects).toBe(0); expect(f.count().stops).toBe(1); expect(f.leases.inspect("codex", "native-account")).toBeNull();
  }
});
test("revocation during native inference rejects late output before any host operation", async () => {
  const f = fixture("claude", [{ kind: "tool", name: "files.read", input: {} }]); f.onNext(() => f.signal.abort());
  expect((await f.stopped()).outcome.status).toBe("cancelled");
  expect(f.count().effects).toBe(0); expect(f.count().stops).toBe(1);
  expect(f.leases.inspect("claude", "native-account")).toBeNull();
});
test("host operation and transcript budgets stop a looping model", async () => {
  const f = fixture("codex", Array.from({ length: NATIVE_TASK_LIMITS.steps }, () => ({ kind: "tool", name: "files.read", input: {} })));
  await f.stopped(); expect(f.count().effects).toBe(NATIVE_TASK_LIMITS.toolCalls); expect(f.count().stops).toBe(1);
});
test("final output remains bounded by the runtime, even inside a valid envelope", async () => {
  const f = fixture("claude", [{ kind: "final", output: "x".repeat(1025) }]);
  await f.stopped(); expect(f.count().stops).toBe(1);
});
test("an invalid physical stop receipt retains the actual account lease", async () => {
  const f = fixture(); f.changeReceipt(value => ({ ...value, joined: false as unknown as true }));
  await expect(f.run()).rejects.toThrow(); expect(f.leases.inspect("codex", "native-account")).not.toBeNull();
});
test("steps are closed, plain JSON and reject getters without invoking them", () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "x", { enumerable: true, get() { reads++; return "unsafe"; } });
  const array = Object.defineProperty([null], "0", { enumerable: true, get() { reads++; return "unsafe"; } });
  for (const value of [{ kind: "final", output: "ok", extra: true }, { kind: "tool", name: "files.read", input: getter },
    { kind: "tool", name: "files.read", input: { array } }, { kind: "tool", name: "files.read", input: { value: NaN } },
    { kind: "tool", name: "files.read", input: JSON.parse('{"__proto__":{}}') }]) expect(() => parseNativeStep(value)).toThrow();
  expect(reads).toBe(0);
});
test("JSON depth, cycles and bytes are bounded before broker dispatch", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const input of [cyclic, { text: "x".repeat(NATIVE_TASK_LIMITS.stepBytes + 1) }, { array: Array(4097).fill(null) }]) {
    expect(() => parseNativeStep({ kind: "tool", name: "files.read", input })).toThrow();
  }
});
