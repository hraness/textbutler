import { expect, test } from "bun:test";
import { createToolBroker, type AgentTaskRequest } from "@hraness/agentmixer";
import { createXcbSubscriptionHost } from "./xcb-host.ts";
import { parseXcbCapabilities, parseXcbResult, XcbNotStarted, type XcbCapabilities, type XcbClient, type XcbGenerateRequest, type XcbResult } from "./xcb-client.ts";
import { contactCapabilityIdentity, createContactCapabilityBroker } from "./contact-capabilities.ts";
import { RunJournal } from "./journal.ts";
import type { XcbHostConfig } from "./host-config.ts";
import type { XcbIntegrationAdmission } from "./xcb-integration.ts";

const NOW = 1_000_000;
const integration: XcbIntegrationAdmission = { version: 1, evidenceDigest: "d".repeat(64), sourceDigest: "e".repeat(64),
  profiles: { classify: contactCapabilityIdentity("classify"), respond: contactCapabilityIdentity("respond") } };
const config: XcbHostConfig = { executable: "/synthetic/xcb", stateHome: "/synthetic/state", sha256: "a".repeat(64),
  accounts: [{ provider: "claude", accountId: "account-one", model: "claude/observed" }] };
const capabilities = (): XcbCapabilities => ({ version: 1, supported: true, zeroTools: true, zeroHooks: true, ephemeral: true,
  accounts: [{ id: "account-one", label: "Synthetic", provider: "claude", enabled: true, busy: false, connected: true, runtimeAdmitted: true, available: true, reason: null,
    models: [{ key: "claude/observed", label: "Observed", observedAtMs: NOW }],
    qualification: { runtimeVersion: "synthetic-v1", runtimeDigest: config.sha256, evidenceDigest: "b".repeat(64), expiresAt: NOW + 600_000 } }] });
function completed(r: XcbGenerateRequest, text = '{"kind":"final","output":"synthetic reply"}', id = "request-one"): XcbResult {
  return { version: 1, status: "completed", requestId: id, account: r.account, model: r.model, text,
    outcome: { terminal: "completed", joined: true, effects: "none" } };
}
async function fixture(generate?: XcbClient["generate"], caps = capabilities()) {
  const seen: XcbGenerateRequest[] = [], journal = RunJournal.memory();
  const host = await createXcbSubscriptionHost(config, { now: () => NOW, integration, client: {
    async capabilities() { return caps; }, async generate(r, signal) { seen.push(r); return generate ? await generate(r, signal) : completed(r); },
  } });
  await host.check("native-claude-code", new AbortController().signal);
  const request: AgentTaskRequest = { route: { id: "xcb-claude-respond", provider: "claude", authentication: "subscription" },
    accountId: "native-claude-code", workspaceId: "contact-one", runId: "run-one", profile: contactCapabilityIdentity("respond"),
    model: { id: "claude/observed", reasoningEffort: null, serviceTier: null }, purpose: "respond", prompt: "Synthetic input",
    signal: new AbortController().signal, limits: { maxRunMs: 120_000, maxCleanupMs: 15_000, maxOutputBytes: 65_536 } };
  let operations = 0;
  const broker = () => createContactCapabilityBroker({ purpose: "respond", signal: request.signal, isActive: () => true,
    broker: createToolBroker({ workspaceId: request.workspaceId, runId: request.runId, signal: request.signal, isActive: () => true,
      files: { async read() { operations++; throw Error("Synthetic no files"); }, async write() { operations++; throw Error("Synthetic no writes"); } },
      web: { async fetchPublic() { operations++; throw Error("Synthetic no web"); } }, messaging: { async stage() { operations++; throw Error("Synthetic no sends"); } } }) });
  return { host, request, broker, seen, journal, operations: () => operations,
    run: () => host.runTask(request, broker(), { leases: journal.accountLeases(), now: () => NOW }),
    async close() { await host.close().catch(() => {}); journal.close(); } };
}
test("XCB subscription host binds an explicit account/model and releases only settled work", async () => {
  const f = await fixture();
  try { expect(f.host.accounts()[0]?.status).toBe("ready"); const result = await f.run();
    expect(result.output).toBe("synthetic reply"); expect(result.custody).toBe("released"); expect(f.operations()).toBe(0);
    expect(f.seen[0]).toMatchObject({ version: 1, account: "account-one", model: "claude/observed" });
    expect(Object.keys(f.seen[0]!).sort()).toEqual(["account", "maxOutputBytes", "model", "prompt", "timeoutMs", "version"]);
    expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull();
  } finally { await f.close(); }
});
test.each(["missing", "expired", "wrong-runtime", "unsupported", "busy", "stale-model"])("XCB %s evidence remains unavailable without a model call", async kind => {
  const caps = capabilities(), account = caps.accounts[0]!;
  if (kind === "missing") delete account.qualification;
  if (kind === "expired") account.qualification!.expiresAt = NOW;
  if (kind === "wrong-runtime") account.qualification!.runtimeDigest = "c".repeat(64);
  if (kind === "unsupported") caps.supported = false;
  if (kind === "busy") account.busy = true;
  if (kind === "stale-model") account.models[0]!.observedAtMs = NOW + 1;
  const f = await fixture(undefined, caps);
  try { expect(f.host.accounts()[0]?.status).toBe("unavailable"); await expect(f.run()).rejects.toThrow(); expect(f.seen).toEqual([]); }
  finally { await f.close(); }
});
test("malformed generated JSON is a settled failure, never an operation", async () => {
  const f = await fixture(async r => completed(r, "not JSON"));
  try { expect((await f.run()).outcome.status).toBe("failed"); expect(f.operations()).toBe(0); expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull(); }
  finally { await f.close(); }
});
test("unproven wrapper exit retains Textbutler account custody", async () => {
  const f = await fixture(async () => { throw Error("Wrapper exited without receipt"); });
  try { await expect(f.run()).rejects.toThrow(); expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).not.toBeNull(); }
  finally { await f.close(); }
});
test("pre-spawn failure and explicit joined cancellation do not strand custody", async () => {
  for (const generate of [async () => { throw new XcbNotStarted("synthetic"); },
    async (): Promise<XcbResult> => ({ version: 1, status: "failed", code: "cancelled", joined: true, effects: "none" })]) {
    const f = await fixture(generate);
    try { expect((await f.run()).outcome.status).toBe("failed"); expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull(); }
    finally { await f.close(); }
  }
});
test("XCB success envelopes reject wrong binding, unjoined output and unknown fields", () => {
  const r: XcbGenerateRequest = { version: 1, account: "account-one", model: "claude/observed", prompt: "synthetic", timeoutMs: 1000, maxOutputBytes: 1024 };
  expect(parseXcbResult(completed(r), r, 0).status).toBe("completed");
  for (const result of [{ ...completed(r), account: "other" }, { ...completed(r), model: "other" },
    { ...completed(r), extra: true }, { ...completed(r), outcome: { terminal: "completed", joined: false, effects: "none" } }]) {
    expect(() => parseXcbResult(result, r, 0)).toThrow();
  }
  expect(() => parseXcbResult(completed(r), r, 1)).toThrow();
  expect(() => parseXcbResult({ version: 1, status: "failed", code: "busy", text: "must not leak" }, r, 1)).toThrow();
  expect(() => parseXcbResult({ version: 1, status: "failed", code: "busy", joined: true, effects: "none" }, r, null)).toThrow();
  expect(() => parseXcbResult({ version: 1, status: "failed", code: "custody_unproven", joined: true, effects: "none" }, r, 1)).toThrow();
});
test("capabilities require an exact no-tool no-hook ephemeral API", () => {
  const caps = { ...capabilities(), limits: { maxInputBytes: 1_048_576, maxOutputBytes: 262_144, minTimeoutMs: 1000, maxTimeoutMs: 120_000 } };
  expect(parseXcbCapabilities(caps).supported).toBe(true);
  for (const change of [{ zeroTools: false }, { zeroHooks: false }, { ephemeral: false }, { version: 2 }, { exec: true }]) {
    expect(() => parseXcbCapabilities({ ...caps, ...change })).toThrow();
  }
});
test("XCB inference evidence cannot qualify unreviewed Textbutler source", async () => {
  let calls = 0;
  const host = await createXcbSubscriptionHost(config, { now: () => NOW, client: {
    async capabilities() { return capabilities(); }, async generate(r) { calls++; return completed(r); },
  } });
  try { await host.check("native-claude-code", new AbortController().signal); expect(host.accounts()[0]?.status).toBe("unavailable");
    await expect(host.selection("native-claude-code", "respond")).rejects.toThrow(); expect(calls).toBe(0); }
  finally { await host.close(); }
});
test("classification and reply qualifications bind distinct contact profiles and composition evidence", async () => {
  const f = await fixture();
  try {
    const classify = await f.host.selection("native-claude-code", "classify"), respond = await f.host.selection("native-claude-code", "respond");
    expect(classify.qualification.status).toBe("qualified"); expect(respond.qualification.status).toBe("qualified");
    if (classify.qualification.status !== "qualified" || respond.qualification.status !== "qualified") throw Error("Synthetic admission missing");
    expect(classify.qualification.profile).toEqual(contactCapabilityIdentity("classify"));
    expect(respond.qualification.profile).toEqual(contactCapabilityIdentity("respond"));
    expect(classify.qualification.evidenceDigest).not.toBe(respond.qualification.evidenceDigest);
    expect(respond.qualification.evidenceDigest).not.toBe(capabilities().accounts[0]!.qualification!.evidenceDigest);
  } finally { await f.close(); }
});
test("unadvertised tool proposals and duplicate JSON keys cannot reach the contact broker", async () => {
  for (const text of ['{"kind":"tool","name":"exec","input":{"command":"touch /tmp/no"}}',
    '{"kind":"tool","kind":"final","output":"no"}']) {
    const f = await fixture(async r => completed(r, text));
    try { expect((await f.run()).outcome.status).toBe("failed"); expect(f.operations()).toBe(0);
      expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull(); }
    finally { await f.close(); }
  }
});
test("host shutdown retains its lease until the XCB supervisor returns physical settlement", async () => {
  let started!: () => void, joined!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; }), joining = new Promise<void>(resolve => { joined = resolve; });
  const f = await fixture(async (_r, signal) => {
    started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    await joining; return { version: 1, status: "failed", requestId: "joined-cancel", code: "cancelled", joined: true, effects: "none" };
  });
  try { const running = f.run(); await starting; const closing = f.host.close();
    expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).not.toBeNull();
    joined(); expect((await running).custody).toBe("released"); await closing;
    expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull();
  } finally { joined(); await f.close(); }
});
test("restart primes both profiles without a model turn and expired metadata refreshes once", async () => {
  let clock = NOW, calls = 0, busy = false;
  const client: XcbClient = { async capabilities() { calls++; const value = capabilities(); value.accounts[0]!.busy = busy; return value; },
    async generate() { throw Error("Readiness must never run a model"); } };
  for (let restart = 0; restart < 2; restart++) {
    const host = await createXcbSubscriptionHost(config, { client, integration, now: () => clock });
    try {
      expect(host.accounts()[0]?.status).toBe("ready"); const before = calls;
      await host.selection("native-claude-code", "respond"); expect(calls).toBe(before);
      clock += 30_001; busy = true;
      await Promise.allSettled([host.selection("native-claude-code", "classify"), host.selection("native-claude-code", "respond")]);
      expect(calls).toBe(before + 1); expect(host.accounts()[0]?.status).toBe("unavailable");
      clock += 30_001; busy = false;
      await host.selection("native-claude-code", "respond"); expect(host.accounts()[0]?.status).toBe("ready");
    } finally { await host.close(); }
  }
});
test("shutdown cancels an in-flight stale capability refresh before waiting for selections", async () => {
  let clock = NOW, refreshStarted!: () => void, aborted = false;
  const started = new Promise<void>(resolve => { refreshStarted = resolve; });
  const host = await createXcbSubscriptionHost(config, { integration, now: () => clock, client: {
    async capabilities(signal) {
      if (clock === NOW) return capabilities();
      refreshStarted(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      signal.throwIfAborted(); return capabilities();
    }, async generate() { throw Error("Metadata refresh must not start inference"); },
  } });
  clock += 30_001;
  const selection = host.selection("native-claude-code", "respond"); void selection.catch(() => {});
  await started; await host.close(); expect(aborted).toBe(true); await expect(selection).rejects.toThrow();
});
