import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { automationContextId, automationBindingDigest, automationHash, automationFailure, automationRemoteError, AutomationOperationError, createGhostgetAutomationClient, createGhostgetAutomationTransport, parseAutomationCoordinate, parseAutomationEnrollment, type AutomationEnrollment, type AutomationPlan, type GhostgetAutomationInvoker } from "./automation";
import { parseActionIntent } from "./validation";

const now = Date.parse("2026-09-11T00:00:00.000Z");
export function automationFixture() {
  const identity = { provider: "whatsapp" as const, authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "whatsapp:pn:15550000000", implementationIdentity: "2".repeat(64), sourceGeneration: "fixture-generation" };
  const conversation = { coordinate: { provider: "whatsapp" as const, conversationJid: "15551234567@s.whatsapp.net" }, title: "Synthetic", kind: "single" as const, participants: ["15551234567@s.whatsapp.net"] };
  const enrollment: AutomationEnrollment = { id: "enrollment:fixture", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 1, ready: true, reason: null };
  const calls: { method: string; params: Readonly<Record<string, unknown>> }[] = [];
  const plans = new Map<string, AutomationPlan>();
  let altered = false, lost = false, blocked = false, cancelled = false, release: (() => void) | undefined, refusal: "none" | "no-run" | "accepted-run" | "failed-run" | "active-run" | "blind" = "none", planTtlMs = 120000;
  const fixtureRun = (intentId: string, state: string, accepted: { messageId: string | null; providerReceiptId: string | null }[]) =>
    ({ id: "run:fixture", planId: "plan:fixture", intentId, enrollmentId: enrollment.id, state, accepted, totalActions: 1, reason: state === "accepted" ? null : "Synthetic provider outcome", retryable: false });
  const invoke: GhostgetAutomationInvoker = async (method, params) => {
    calls.push({ method, params });
    if (method === "history") return { enrollment, messages: [] };
    if (method === "poll") return enrollment;
    if (method === "status") return { identity, connected: true, events: { available: true, reason: null }, actions: Object.fromEntries(["text", "attachment", "reaction", "sticker", "link", "poll", "app-clip", "experience"].map(kind => [kind, { available: !["app-clip", "experience"].includes(kind), reason: ["app-clip", "experience"].includes(kind) ? "Unavailable" : null }])) };
    if (method === "asset") return { assetId: "asset:fixture", sha256: params.sha256, bytes: Buffer.from(String(params.bytesBase64), "base64").length, expiresAt: new Date(now + 300000).toISOString() };
    if (method === "prepare") {
      const bound = { ...params, bindingDigest: enrollment.bindingDigest, expiresAt: new Date(now + planTtlMs).toISOString() };
      const digest = automationHash(bound), plan = { ...bound, id: `plan:${digest}`, digest } as AutomationPlan; plans.set(plan.id, plan);
      return altered ? { ...plan, actions: [{ kind: "text", text: "Changed provider content" }] } : plan;
    }
    if (method === "cancel") { cancelled = true; release?.(); return { cancelled: true }; }
    if (method === "run.by-intent") {
      if (refusal === "blind") throw new Error("Synthetic arbiter outage");
      const intentId = String(params.intentId);
      if (refusal === "accepted-run") return { run: fixtureRun(intentId, "accepted", [{ messageId: "sent:fixture", providerReceiptId: "receipt:fixture" }]) };
      if (refusal === "failed-run") return { run: fixtureRun(intentId, "failed", []) };
      if (refusal === "active-run") return { run: fixtureRun(intentId, "started", []) };
      return { run: null };
    }
    if (method === "submit") {
      if (refusal !== "none") throw new AutomationOperationError("remote-unavailable");
      if (lost) throw new Error("Synthetic missing response");
      if (blocked) await new Promise<void>(resolve => { release = resolve; });
      const plan = plans.get(String(params.planId))!;
      return { id: "run:fixture", planId: plan.id, intentId: plan.intentId, enrollmentId: enrollment.id, state: cancelled ? "partial" : "accepted", accepted: plan.actions.slice(0, cancelled ? 1 : undefined).map(() => ({ messageId: null, providerReceiptId: null })), totalActions: plan.actions.length, reason: cancelled ? "Stopped" : null, retryable: false };
    }
    throw new Error("Unexpected synthetic operation");
  };
  const client = createGhostgetAutomationClient(invoke, () => now), bytes = Buffer.from("Synthetic attachment");
  const transport = createGhostgetAutomationTransport({ client, enrollmentId: enrollment.id, now: () => now, admitAsset: async path => { if (path !== "outbox/fixture.txt") throw new Error("Foreign file"); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; } });
  return { client, transport, enrollment, calls, state: { altered(value: boolean) { altered = value; }, lost(value: boolean) { lost = value; }, blocked(value: boolean) { blocked = value; }, refuse(value: typeof refusal) { refusal = value; }, planTtl(value: number) { planTtlMs = value; } } };
}
test("automation binds a disclosed rich turn and its attachment bytes to one enrollment", async () => {
  const f = automationFixture();
  const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [
    { kind: "text", text: "🤖{ Here it is }" }, { kind: "attachment", file: "outbox/fixture.txt", name: "fixture.txt", mimeType: "text/plain" },
    { kind: "reaction", messageId: "message:1", emoji: "👍", action: "add" }, { kind: "poll", question: "Which day?", options: ["Saturday", "Sunday"], maximumSelections: null },
  ] });
  expect(plan.ok).toBe(true); if (!plan.ok) return;
  const prepared = f.calls.find(call => call.method === "prepare")!;
  expect(prepared.params.actions).toEqual([{ kind: "text", text: "🤖{ Here it is }" }, { kind: "attachment", assetId: "asset:fixture", name: "fixture.txt", mimeType: "text/plain" }, { kind: "reaction", messageId: "message:1", emoji: "👍", remove: false }, { kind: "poll", question: "Which day?", options: ["Saturday", "Sunday"], maximumSelections: null }]);
  const sent = await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" }); expect(sent).toMatchObject({ ok: true, value: { state: "submitted", submittedCount: 4, delivery: "unknown", retryable: false } });
  expect((await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" })).ok).toBe(false);
  expect(f.calls.filter(call => call.method === "submit")).toHaveLength(1);
});
test("foreign coordinates, changed content and changed revisions never become send plans", async () => {
  for (const mode of ["foreign", "content", "revision"] as const) {
    const f = automationFixture(); if (mode === "content") f.state.altered(true);
    const result = await f.transport.prepare({ conversationId: mode === "foreign" ? "other-contact" : f.enrollment.id, contextId: mode === "revision" ? "old-context" : automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Synthetic" }] });
    expect(result.ok).toBe(false); expect(f.calls.some(call => call.method === "submit")).toBe(false);
  }
});
test("missing send receipts remain indeterminate and consumed", async () => {
  const f = automationFixture(); const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Synthetic" }] }); if (!plan.ok) throw new Error("Fixture plan failed");
  f.state.lost(true); expect(await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" })).toMatchObject({ ok: false, error: { code: "indeterminate", retryable: false } });
  expect((await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" })).ok).toBe(false); expect(f.calls.filter(call => call.method === "submit")).toHaveLength(1);
  // A local transport fault never reaches the intent arbiter: only remote
  // refusals justify the ledger read.
  expect(f.calls.some(call => call.method === "run.by-intent")).toBe(false);
});
test("a provider refusal the intent ledger proves unsent fails clean instead of blocking", async () => {
  const f = automationFixture(); const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Synthetic" }] }); if (!plan.ok) throw new Error("Fixture plan failed");
  f.state.refuse("no-run");
  // No intent row means the run insert never committed: the send provably did
  // not start, so a retry is legal and the contact is not blocked.
  expect(await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" }))
    .toMatchObject({ ok: false, error: { code: "dispatch-failed" } });
});
test("a terminal provider row on the refused intent returns its recorded outcome", async () => {
  const f = automationFixture(); const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Synthetic" }] }); if (!plan.ok) throw new Error("Fixture plan failed");
  f.state.refuse("accepted-run");
  expect(await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" }))
    .toMatchObject({ ok: true, value: { state: "submitted", acceptedMessageIds: ["sent:fixture"] } });
  f.state.refuse("failed-run");
  const second = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:other", actions: [{ kind: "text", text: "Synthetic" }] }); if (!second.ok) throw new Error("Fixture plan failed");
  expect(await f.transport.submit(second.value, { mode: "delegated", grantId: "grant:fixture" }))
    .toMatchObject({ ok: true, value: { state: "failed" } });
});
test("an unresolved provider row or a blind arbiter keeps the refusal indeterminate", async () => {
  for (const mode of ["active-run", "blind"] as const) {
    const f = automationFixture(); const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: `intent:${mode}`, actions: [{ kind: "text", text: "Synthetic" }] }); if (!plan.ok) throw new Error("Fixture plan failed");
    f.state.refuse(mode);
    // A started row may still settle, and an unreachable ledger proves
    // nothing: both stay indeterminate rather than risking a double send.
    expect(await f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" }))
      .toMatchObject({ ok: false, error: { code: "indeterminate" } });
  }
});
test("plans inside the extended dispatch window still prepare and bind", async () => {
  const f = automationFixture(); f.state.planTtl(250_000);
  // The serve issues plans that outlive congested dispatch lanes; the client
  // accepts the wider window while still rejecting anything beyond it.
  expect((await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Synthetic" }] })).ok).toBe(true);
  f.state.planTtl(400_000);
  expect((await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:other", actions: [{ kind: "text", text: "Synthetic" }] })).ok).toBe(false);
});
test("cancellation interrupts an admitted batch while retaining its partial result", async () => {
  const f = automationFixture(); const plan = await f.transport.prepare({ conversationId: f.enrollment.id, contextId: automationContextId(f.enrollment), intentId: "intent:fixture", actions: [{ kind: "text", text: "Disclosure" }, { kind: "reaction", messageId: "message:1", emoji: "👍", action: "add" }] }); if (!plan.ok) throw new Error("Fixture plan failed");
  f.state.blocked(true); const controller = new AbortController(); const sending = f.transport.submit(plan.value, { mode: "delegated", grantId: "grant:fixture" }, controller.signal); controller.abort();
  expect(await sending).toMatchObject({ ok: true, value: { state: "partial", submittedCount: 1, retryable: false } });
  expect(f.calls.some(call => call.method === "cancel")).toBe(true);
});
test("native poll intent is bounded and keeps provider-default selection explicit", () => {
  expect(parseActionIntent({ kind: "poll", question: "Tea?", options: ["Yes", "No"], maximumSelections: null })).toMatchObject({ kind: "poll", maximumSelections: null });
  for (const options of [["Same", "Same"], ["One"]]) expect(() => parseActionIntent({ kind: "poll", question: "Tea?", options, maximumSelections: null })).toThrow();
  expect(() => parseActionIntent({ kind: "poll", question: "Tea?", options: ["Yes", "No"], maximumSelections: 3 })).toThrow();
});

test("iMessage coordinates preserve literal native prefixes and retain service, byte and row bounds", () => {
  for (const prefix of ["iMessage;", "any;"]) {
    const coordinate = { provider: "imessage" as const, chatGuid: `${prefix}-;fixture@example.test`, service: "iMessage" as const, observedChatRowId: 1 };
    expect(parseAutomationCoordinate(coordinate)).toEqual(coordinate);
    const bounded = `${prefix}${"é".repeat(Math.floor((1024 - prefix.length) / 2))}${"x".repeat((1024 - prefix.length) % 2)}`;
    expect(Buffer.byteLength(bounded)).toBe(1024);
    expect(parseAutomationCoordinate({ ...coordinate, chatGuid: bounded, observedChatRowId: Number.MAX_SAFE_INTEGER })).toMatchObject({ chatGuid: bounded, observedChatRowId: Number.MAX_SAFE_INTEGER });
    for (const patch of [
      { chatGuid: `${bounded}x` }, { chatGuid: `${prefix}-;fixture\0other` },
      ...["SMS", "RCS", "any", "imessage", null, undefined].map(service => ({ service })),
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined].map(observedChatRowId => ({ observedChatRowId })),
      { additional: true },
    ]) expect(() => parseAutomationCoordinate({ ...coordinate, ...patch })).toThrow();
  }
  for (const chatGuid of ["SMS;-;fixture", "RCS;-;fixture", "Any;-;fixture", "imessage;-;fixture", "anywhere;-;fixture", "any", "prefixany;-;fixture"])
    expect(() => parseAutomationCoordinate({ provider: "imessage", chatGuid, service: "iMessage", observedChatRowId: 1 })).toThrow();
});

test("literal iMessage GUIDs survive discovery and enrollment without becoming interchangeable", async () => {
  for (const prefix of ["iMessage;", "any;"]) {
    const identity = { ...automationFixture().enrollment.identity, provider: "imessage" as const, accountSubject: "synthetic-imessage" };
    const coordinate = { provider: "imessage" as const, chatGuid: `${prefix}-;fixture@example.test`, service: "iMessage" as const, observedChatRowId: 1 };
    const conversation = { coordinate, title: "Synthetic", kind: "single" as const, participants: ["fixture@example.test"] };
    const enrollment: AutomationEnrollment = { id: "enrollment:imessage", identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 1, ready: true, reason: null };
    let historyCoordinate = coordinate;
    const client = createGhostgetAutomationClient(async (method, params) => {
      if (method === "conversations") return { identity, conversations: [conversation], complete: true };
      if (method === "enroll") { expect(params.coordinate).toEqual(coordinate); return enrollment; }
      if (method === "history") return { enrollment, messages: [{ id: "message:fixture", coordinate: historyCoordinate, direction: "incoming", occurredAt: new Date(now).toISOString(), text: "Synthetic", kind: "message", relatedMessageId: null, attachments: [] }] };
      throw new Error("Unexpected synthetic operation");
    });
    expect((await client.conversations("imessage")).conversations[0]!.coordinate).toEqual(coordinate);
    expect(await client.enroll("imessage", coordinate)).toEqual(enrollment);
    expect((await client.history(enrollment.id)).messages[0]!.coordinate).toEqual(coordinate);
    for (const changed of [
      { ...coordinate, chatGuid: `${prefix === "any;" ? "iMessage;" : "any;"}-;fixture@example.test` },
      { ...coordinate, observedChatRowId: 2 },
    ]) {
      const changedConversation = { ...conversation, coordinate: changed }, changedDigest = automationBindingDigest(identity, changedConversation);
      expect(changedDigest).not.toBe(enrollment.bindingDigest);
      expect(() => parseAutomationEnrollment({ ...enrollment, conversation: changedConversation })).toThrow("Changed enrollment binding");
      const changedClient = createGhostgetAutomationClient(async () => ({ ...enrollment, conversation: changedConversation, bindingDigest: changedDigest }));
      await expect(changedClient.enroll("imessage", coordinate)).rejects.toThrow("Enrollment target changed");
      historyCoordinate = changed;
      await expect(client.history(enrollment.id)).rejects.toThrow("History changed enrollment");
    }
  }
});

test("discovery distinguishes rejected remote requests from invalid successful response data", async () => {
  const f = automationFixture();
  for (const code of ["invalid-request", "not-ready", "unavailable", "recovery-required"] as const) {
    const remote = automationRemoteError(code); let calls = 0;
    const client = createGhostgetAutomationClient(async () => { calls++; throw remote; });
    await expect(client.conversations("whatsapp")).rejects.toBe(remote);
    expect(automationFailure(remote)).toEqual({ stage: "provider", code: `remote-${code}` });
    expect(calls).toBe(1);
  }
  for (const value of [
    { identity: f.enrollment.identity, conversations: [f.enrollment.conversation], complete: true, privatePath: "/synthetic/private" },
    { identity: f.enrollment.identity, conversations: [{ ...f.enrollment.conversation, participants: ["private\0handle"] }], complete: true },
    { identity: f.enrollment.identity, conversations: [], complete: "private-body" },
    { identity: { ...f.enrollment.identity, provider: "beeper" }, conversations: [], complete: true },
  ]) {
    const client = createGhostgetAutomationClient(async () => value);
    const error = await client.conversations("whatsapp").catch(error => error);
    expect(automationFailure(error)).toEqual({ stage: "response-schema", code: "response-schema" });
    expect(String(error)).not.toContain("private");
  }
  const client = createGhostgetAutomationClient(async () => { throw new Error("private upstream body/path"); });
  expect(automationFailure(await client.conversations("whatsapp").catch(error => error))).toEqual({ stage: "unknown", code: "unknown" });
});

test("a set-poll answers exactly the requested enrollments and nothing else", async () => {
  const f = automationFixture();
  const ok = (id: string) => ({ enrollmentId: id, enrollment: { ...f.enrollment, id }, error: null });
  const client = createGhostgetAutomationClient(async () => ({ results: [ok("enrollment:a"), { enrollmentId: "enrollment:b", enrollment: null, error: "unavailable" }] }));
  const results = await client.pollSet(["enrollment:a", "enrollment:b"]);
  expect(results.get("enrollment:a")?.enrollment?.id).toBe("enrollment:a");
  expect(results.get("enrollment:b")).toEqual({ enrollment: null, error: "unavailable" });
  // Attributed entry faults degrade to that enrollment's error result — the
  // same blast radius a single failing per-contact poll used to have.
  for (const bad of [
    { enrollmentId: "enrollment:b", enrollment: null, error: null },
    { enrollmentId: "enrollment:b", enrollment: { ...f.enrollment, id: "enrollment:c" }, error: null },
    { enrollmentId: "enrollment:b", enrollment: { ...f.enrollment, ready: "yes" }, error: null },
  ]) {
    const client = createGhostgetAutomationClient(async () => ({ results: [ok("enrollment:a"), bad] }));
    const degraded = await client.pollSet(["enrollment:a", "enrollment:b"]);
    expect(degraded.get("enrollment:a")?.enrollment?.id).toBe("enrollment:a");
    expect(degraded.get("enrollment:b")?.enrollment).toBeNull();
    expect(degraded.get("enrollment:b")?.error).toBe("Poll result could not be verified.");
  }
  // Envelope faults — duplicates, escapes, missing ids — stay fatal because
  // they break the whole response contract and cannot be attributed.
  for (const results of [
    [ok("enrollment:a"), ok("enrollment:a")],
    [ok("enrollment:a")],
    [ok("enrollment:a"), ok("enrollment:z")],
  ]) {
    const client = createGhostgetAutomationClient(async () => ({ results }));
    await expect(client.pollSet(["enrollment:a", "enrollment:b"])).rejects.toThrow();
  }
});

test("only complete allowlisted native markers survive remote unavailable classification", () => {
  const phases = ["admission", "native-preflight", "native-status", "native-chats", "native-projection", "reauthorization", "native-finalization", "host-status", "host-identity", "host-response"] as const;
  const codes = ["failed", "cancelled", "deadline", "cleanup-unverified", "process-failed", "process-stderr", "streams-failed", "response-invalid", "rpc-rejected", "rpc-invalid-params", "rpc-method-unavailable", "schema-invalid", "coordinate-invalid", "identity-changed", "database-unreadable"] as const;
  for (const phase of phases) for (const code of codes) {
    const marker = `ghostget.discovery.v1:${phase}:${code}`;
    expect(automationFailure(automationRemoteError("unavailable", marker))).toEqual({ stage: "provider", code: "remote-unavailable", native: { phase, code } });
  }
  for (const message of ["ghostget.discovery.v1:native-chats:response-invalid\n", "ghostget.discovery.v1:native-chats:response-invalid\r", "ghostget.discovery.v1:unknown:failed",
    "ghostget.discovery.v1:native-chats:unknown", "prefix ghostget.discovery.v1:native-chats:failed", "ghostget.discovery.v1:native-chats:failed /synthetic/private",
    { phase: "native-chats", code: "failed" }, "Sensitive handle and body", "x".repeat(1024)]) {
    expect(automationFailure(automationRemoteError("unavailable", message))).toEqual({ stage: "provider", code: "remote-unavailable" });
  }
  for (const code of ["not-ready", "recovery-required", "invalid-request"] as const) {
    expect(automationFailure(automationRemoteError(code, "ghostget.discovery.v1:native-chats:failed"))).toEqual({ stage: "provider", code: `remote-${code}` });
  }
  expect(() => automationRemoteError("private-code")).toThrow("contract changed");
});
