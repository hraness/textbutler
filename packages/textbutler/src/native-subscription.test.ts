import { afterEach, expect, test } from "bun:test";
import { assertAgentTaskAccountLease, createToolBroker, type AgentTaskAdapter, type AgentTaskExecutionRequest, type AgentTaskRequest,
  type CodexAccountSnapshot, type ManagedCodexAccountController } from "@hraness/agentmixer";
import { createNativeSubscriptionHost, type NativeSubscriptionAccount } from "./native-subscription.ts";
import { createProviderHost } from "./provider-host.ts";
import { contactCapabilityIdentity, createContactCapabilityBroker, type ButlerPurpose } from "./contact-capabilities.ts";
import { newContact } from "./config.ts";
import { RunJournal } from "./journal.ts";

const NOW = 1_000_000, cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(provider: "claude" | "codex" | "devin" = "claude", withManagedCodex = false) {
  const id: NativeSubscriptionAccount = provider === "codex" ? "native-codex" : provider === "devin" ? "native-devin" : "native-claude-code";
  let managedChecks = 0;
  const journal = RunJournal.memory(), leases = journal.accountLeases(), runs: AgentTaskExecutionRequest[] = [], stops: AgentTaskExecutionRequest[] = [];
  let checks = 0, closes = 0, signedIn = true, clock = NOW, failStop = false, acquired = 0;
  let holdRun: ReturnType<typeof deferred> | undefined, holdStop: ReturnType<typeof deferred> | undefined;
  const started = deferred(), stopping = deferred(), acquire = leases.acquire.bind(leases);
  leases.acquire = input => { acquired++; return acquire(input); };
  const binding = (r: AgentTaskExecutionRequest) => ({ route: r.route, accountId: r.accountId, workspaceId: r.workspaceId, runId: r.runId,
    profile: r.profile, model: r.model, runtime: r.runtime, accountLease: r.accountLease,
    ...(r.authority === undefined ? {} : { authority: r.authority }) });
  const adapters: AgentTaskAdapter[] = (["classify", "respond"] as const).map(purpose => {
    const route = { id: `synthetic-${provider}-${purpose}`, provider, authentication: "subscription" as const };
    return { route, runtime: { version: "synthetic-only", digest: "a".repeat(64) },
      qualification: { status: "qualified", route, profile: contactCapabilityIdentity(purpose), runtimeVersion: "synthetic-only",
        runtimeDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), expiresAt: NOW + 600_000,
        controls: { noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true, workspaceWriteIsolation: true,
          isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } },
      async run(request) {
        expect(assertAgentTaskAccountLease(request)).toBe(request.accountLease);
        expect(leases.inspect(provider, id)).toEqual(request.accountLease);
        runs.push(request); started.resolve(); if (holdRun) await holdRun.promise;
        return { ...binding(request), output: "{}", usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }, outcome: { status: "completed", code: null } };
      },
      async stop(request) {
        expect(assertAgentTaskAccountLease(request, "stop")).toBe(request.accountLease);
        stops.push(request); stopping.resolve(); if (holdStop) await holdStop.promise;
        if (failStop) throw Error("Synthetic missing stop proof");
        return { ...binding(request), processStopped: true, controllersStopped: true, joined: true, stoppedAtUnixMs: clock, proofDigest: "c".repeat(64) };
      },
    };
  });
  const native = createNativeSubscriptionHost({ adapters, now: () => clock,
    accounts: () => [{ id, provider, route: provider === "codex" ? "codex" : provider === "devin" ? "devin" : "claude-code", label: "Synthetic subscription", status: signedIn ? "ready" : "setup-required",
      detail: "Synthetic account metadata only", defaultReplyModel: "observed-model", classifierModel: "observed-model" }],
    async check() { checks++; }, async selection(_id, purpose) {
      return { route: adapters[purpose === "classify" ? 0 : 1]!.route, modelCatalog: { provider, observedAt: NOW,
        models: [{ id: "observed-model", available: true, classifierEligible: true, supportsStructuredOutput: true, inputUsdPerMillion: 0, outputUsdPerMillion: 0 }] }, defaultReplyModel: "observed-model" };
    }, async close() { closes++; },
  });
  /** Account administration only; it never executes a contact task. */
  const managedCodex = (input: { accountId: string }): ManagedCodexAccountController => {
    const snapshot = (): CodexAccountSnapshot => ({ accountId: input.accountId, state: "unchecked", accountGeneration: 0,
      processGeneration: 1, models: [], pendingLoginId: null });
    return { snapshot, async check() { managedChecks++; return snapshot(); },
      async startLogin() { throw Error("Synthetic login is unavailable"); },
      async cancelLogin() { return { status: "notFound" as const }; }, async logout() { return snapshot(); },
      async close() { return { released: true, state: "closed" as const }; } };
  };
  const host = createProviderHost({ dataDir: "/synthetic-unused", config: { schemaVersion: 1 }, leases, now: () => clock,
    nativeSubscriptions: native, ...(withManagedCodex ? { managedCodex } : {}) });
  const contact = { ...newContact("contact-one", "Synthetic", "conversation-one"), provider, accountId: id };
  function request(purpose: ButlerPurpose = "respond"): AgentTaskRequest {
    return { route: adapters[purpose === "classify" ? 0 : 1]!.route, accountId: id, workspaceId: contact.id, runId: `synthetic-${purpose}`,
      profile: contactCapabilityIdentity(purpose), model: { id: "observed-model", reasoningEffort: null, serviceTier: null }, purpose, prompt: "Synthetic task",
      limits: { maxRunMs: 10_000, maxCleanupMs: 1000, maxOutputBytes: 1024 }, signal: new AbortController().signal };
  }
  const broker = (r: AgentTaskRequest) => createContactCapabilityBroker({ purpose: r.purpose as ButlerPurpose, signal: r.signal, isActive: () => true,
    broker: createToolBroker({ workspaceId: r.workspaceId, runId: r.runId, signal: r.signal, isActive: () => true,
      ...(r.purpose === "classify" ? { allowedTools: [] } : {}), files: { async read() { throw Error("No files"); }, async write() { throw Error("No files"); } },
      web: { async fetchPublic() { throw Error("No network"); } }, messaging: { async stage() { throw Error("No messages"); } } }) });
  cleanups.push(async () => { holdRun?.resolve(); holdStop?.resolve(); await host.close().catch(() => {}); journal.close(); });
  return { native, host, contact, adapters, request, broker, runs, stops, leases, started, stopping, id,
    counts: () => ({ checks, closes, acquired, managedChecks }), signOut() { signedIn = false; }, age() { clock = NOW + 86_400_001; }, failStop() { failStop = true; },
    holdRun() { return holdRun = deferred(); }, holdStop() { return holdStop = deferred(); } };
}

test.each(["claude", "codex", "devin"] as const)("native %s checks both profiles and uses exactly one real shared task lease", async provider => {
  const f = fixture(provider);
  expect(f.host.accounts().find(row => row.id === f.id)?.status).toBe("unavailable");
  await f.host.check(f.id, new AbortController().signal);
  expect(f.host.accounts().find(row => row.id === f.id)?.status).toBe("ready");
  expect((await f.host.selection(f.contact, "classify")).kind).toBe("managed");
  for (const purpose of ["classify", "respond"] as const) {
    const r = f.request(purpose), b = f.broker(r), result = await f.host.runManagedTask(r, b);
    expect(result.custody).toBe("released"); expect(result.brokerJoined).toBe(true); expect(() => b.assertActive()).toThrow();
    expect(f.leases.inspect(provider, f.id)).toBeNull();
  }
  expect(f.counts().acquired).toBe(2); expect(f.runs).toHaveLength(2); expect(f.stops).toHaveLength(2);
});

test("owner settings and forged hosts cannot supply native execution authority", async () => {
  const journal = RunJournal.memory();
  try {
    expect(() => createProviderHost({ dataDir: "/synthetic-unused", config: { schemaVersion: 1 }, leases: journal.accountLeases(), nativeSubscriptions: {} as never })).toThrow("HOST_REQUIRED");
    const host = createProviderHost({ dataDir: "/synthetic-unused", config: { schemaVersion: 1, providerAccounts: [{ id: "named", label: "Configured only", route: "codex" }] }, leases: journal.accountLeases() });
    expect(host.accounts().every(row => row.status === "unavailable")).toBe(true);
    await expect(host.selection({ ...newContact("contact", "Synthetic", "conversation"), accountId: "native-codex" })).rejects.toThrow("no API substitution");
    await host.close();
  } finally { journal.close(); }
});

test("wrong account, provider, purpose, profile, model and route fail before adapter execution", async () => {
  const f = fixture();
  const changes: Partial<AgentTaskRequest>[] = [
    { accountId: "native-codex" }, { accountId: "owner-defined" }, { route: { ...f.request().route, provider: "codex" } },
    { route: { ...f.request().route, authentication: "api" } }, { route: { ...f.request().route, id: "different-route" } },
    { profile: contactCapabilityIdentity("classify") }, { model: { id: "unobserved", reasoningEffort: null, serviceTier: null } },
  ];
  for (const change of changes) { const original = f.request(), b = f.broker(original);
    await expect(f.host.runManagedTask({ ...original, ...change }, b)).rejects.toThrow(); expect(() => b.assertActive()).toThrow(); }
  expect(f.runs).toEqual([]); expect(f.counts().acquired).toBe(0);
});

test("missing purpose qualification, expired evidence and signed-out accounts remain unavailable", async () => {
  const f = fixture();
  (f.adapters[0] as { qualification: AgentTaskAdapter["qualification"] }).qualification = { status: "unqualified", reason: "Synthetic classifier has no evidence" };
  await f.host.check(f.id, new AbortController().signal);
  expect(f.host.accounts().find(row => row.id === f.id)?.status).toBe("unavailable");
  await expect(f.host.selection(f.contact, "classify")).rejects.toThrow();
  f.age(); const r = f.request(); await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow();
  f.signOut(); await expect(f.host.selection(f.contact, "respond")).rejects.toThrow("ACCOUNT_UNAVAILABLE");
  expect(f.runs).toEqual([]);
});

test("native stop uncertainty keeps the shared lease and blocks account reuse", async () => {
  const f = fixture(); f.failStop(); const r = f.request();
  await expect(f.host.runManagedTask(r, f.broker(r))).rejects.toThrow();
  expect(f.leases.inspect("claude", f.id)).not.toBeNull();
  await expect(f.host.check(f.id, new AbortController().signal)).rejects.toThrow("recovery");
  await expect(f.host.selection(f.contact)).rejects.toThrow("unavailable");
  await expect(f.host.close()).rejects.toThrow("recovery");
});

test("shutdown aborts native work and joins pending execution and stop before closing", async () => {
  const f = fixture(), run = f.holdRun(), stop = f.holdStop(), r = f.request();
  const task = f.host.runManagedTask(r, f.broker(r)); void task.catch(() => {}); await f.started.promise;
  const closing = f.host.close(); await f.stopping.promise;
  expect(f.runs[0]!.signal.aborted).toBe(true); expect(f.counts().closes).toBe(0);
  expect(f.leases.inspect("claude", f.id)).not.toBeNull(); run.resolve(); stop.resolve();
  await task.catch(() => {}); await closing; expect(f.counts().closes).toBe(1);
  expect(f.leases.inspect("claude", f.id)).toBeNull();
});

test("a supplied managed Codex factory keeps its own account away from the native host", async () => {
  const f = fixture("claude", true), signal = new AbortController().signal;
  const codex = f.host.accounts().find(row => row.id === "native-codex");
  expect(codex).toMatchObject({ status: "unavailable", managedAccount: { state: "unchecked" } });
  await f.host.check("native-codex", signal);
  expect(f.counts()).toMatchObject({ managedChecks: 1, checks: 0 });
  await f.host.check("native-claude-code", signal);
  expect(f.counts()).toMatchObject({ managedChecks: 1, checks: 1 });
  expect(f.host.accounts().find(row => row.id === "native-claude-code")?.status).toBe("ready");
  await expect(f.host.selection({ ...f.contact, provider: "codex", accountId: "native-codex" })).rejects.toThrow("no API substitution");
  const request = { ...f.request(), accountId: "native-codex", route: { ...f.request().route, provider: "codex" as const } };
  // The managed Codex owner answers, so the native host never sees this task.
  await expect(f.host.runManagedTask(request, f.broker(request))).rejects.toThrow("Managed Codex account is not ready.");
  expect(f.runs).toEqual([]);
});
