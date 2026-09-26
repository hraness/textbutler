import { describe, expect, test } from "bun:test";
import { CONTROL_PROTOCOL, type ControlRequest, type ControlResponse, type DesktopSnapshot } from "../../control/src/index.ts";
import { awaitOwnerJob, handleOwnerCommand, OwnerCliError, pendingJobOutput, resolveOwnerContact } from "./owner-cli.ts";
import { CliUsageError } from "./cli-style.ts";
/** Usage errors point at help; other owner errors explain the refusal. Both are shown to the owner. */
const ownerFacing = (error: unknown): boolean => error instanceof OwnerCliError || error instanceof CliUsageError;
const rejectsOwnerFacing = async (pending: Promise<unknown>): Promise<void> => {
  const error = await pending.then(() => undefined, (reason: unknown) => reason);
  expect(ownerFacing(error)).toBe(true);
};
import { DEFAULT_HABITAT_PLAN } from "./contact-habitat.ts";

function snapshot(): DesktopSnapshot {
  return { protocol: CONTROL_PROTOCOL, revision: 19, connection: "connected", detail: "Synthetic owner state",
    settings: { paused: true, activeContactLimit: 5 }, capabilities: [], activity: [],
    messagingProviders: ["imessage", "whatsapp", "beeper"],
    contacts: [{ id: "contact-1", name: "Alice Example", subtitle: "Synthetic iMessage contact", settings: {
      enabled: false, responseMode: "smart", keyword: "butler", provider: "codex", accountId: "old-account",
      disclosure: { character: "🤖", begin: "{", end: "}" },
    } }],
    providerAccounts: [{ id: "owner-api", label: "Owner API", provider: "claude", route: "claude-api", status: "setup-required", detail: "Synthetic account",
      defaultReplyModel: "synthetic-model", classifierModel: null }],
  };
}
function fixture(state = snapshot(), mutate?: (request: ControlRequest) => ControlResponse) {
  const calls: ControlRequest[] = [], output: unknown[] = [];
  const result: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: true, kind: "snapshot", snapshot: state };
  return { calls, output, run: (args: string[]) => handleOwnerCommand(args, {
    request: async request => { calls.push(request); return request.command === "snapshot" ? result : mutate?.(request) ?? result; },
    print: value => output.push(value),
  }) };
}

describe("owner CLI commands", () => {
  test("unknown families pass through and malformed commands do no work", async () => {
    const f = fixture();
    expect(await f.run(["inbox"])).toBeUndefined();
    for (const args of [
      ["pause", "all"], ["status", "extra"], ["messaging", "start", "telegram"], ["messaging"],
      ["contacts", "add", "candidate", "--enable"], ["contacts", "account", "Alice"],
      ["contacts", "mode", "Alice", "auto"], ["contacts", "enable"], ["jobs", "show", "../job"],
    ]) await rejectsOwnerFacing(f.run(args));
    expect(f.calls).toEqual([]);
  });

  test("pause and resume preserve limits, contacts and the exact observed revision", async () => {
    for (const command of ["pause", "resume"]) {
      const f = fixture();
      expect(await f.run([command])).toBe(0);
      expect(f.calls).toEqual([{ protocol: CONTROL_PROTOCOL, command: "snapshot" }, {
        protocol: CONTROL_PROTOCOL, command: "global.settings.update", expectedRevision: 19,
        settings: { paused: command === "pause", activeContactLimit: 5 },
      }]);
    }
  });

  test("listing configured connections is read-only and start selects exactly one provider", async () => {
    const f = fixture();
    expect(await f.run(["messaging", "list"])).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.output[0]).toMatchObject({ providers: ["imessage", "whatsapp", "beeper"] });
    const start = fixture();
    expect(await start.run(["messaging", "start", "beeper"])).toBe(0);
    expect(start.calls).toEqual([{ protocol: CONTROL_PROTOCOL, command: "messaging.start", provider: "beeper" }]);
  });

  test("enrollment uses an exact candidate and history is an explicit opt-in", async () => {
    for (const history of [false, true]) {
      const f = fixture();
      expect(await f.run(["contacts", "add", "candidate-1", ...(history ? ["--history"] : [])])).toBe(0);
      expect(f.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "contact.enroll", candidateId: "candidate-1", expectedRevision: 19, initializeHistory: history });
      expect(f.calls).toHaveLength(2);
    }
  });

  test("account choice is explicit, preserves disabled state and matches account provider", async () => {
    const state = snapshot(), f = fixture(state);
    expect(await f.run(["contacts", "account", "Alice", "owner-api"])).toBe(0);
    expect(f.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "contact.settings.update", contactId: "contact-1", expectedRevision: 19,
      settings: { ...state.contacts[0]!.settings, provider: "claude", accountId: "owner-api" } });
    const missing = fixture();
    await expect(missing.run(["contacts", "account", "Alice", "unknown"])).rejects.toThrow("not configured");
    expect(missing.calls).toHaveLength(1);
  });

  test("ambiguous contact names fail without writing; exact ids win", async () => {
    const state = snapshot();
    state.contacts.push({ ...state.contacts[0]!, id: "contact-2", name: "Alicia Sample" });
    expect(() => resolveOwnerContact(state, "ali")).toThrow("more than one");
    expect(resolveOwnerContact(state, "contact-1").name).toBe("Alice Example");
    const f = fixture(state);
    await expect(f.run(["contacts", "enable", "ali"])).rejects.toThrow("exact ID");
    expect(f.calls).toHaveLength(1);
    await expect(f.run(["contacts", "enable", ""])).rejects.toThrow("nonempty");
    expect(f.calls).toHaveLength(2);
  });

  test("mode and activation change only the selected contact settings", async () => {
    const state = snapshot(), f = fixture(state);
    expect(await f.run(["contacts", "mode", "contact-1", "keyword", "--keyword", "help"])).toBe(0);
    expect(f.calls[1]).toMatchObject({ command: "contact.settings.update", expectedRevision: 19,
      settings: { ...state.contacts[0]!.settings, responseMode: "keyword", keyword: "help" } });
    const enabled = fixture();
    expect(await enabled.run(["contacts", "enable", "contact-1"])).toBe(0);
    expect(enabled.calls[1]).toMatchObject({ command: "contact.settings.update", settings: { enabled: true, accountId: "old-account" } });
    const disabled = fixture();
    expect(await disabled.run(["contacts", "disable", "contact-1"])).toBe(0);
    expect(disabled.calls[1]).toMatchObject({ command: "contact.settings.update", settings: { enabled: false } });
    const invalid = fixture();
    await expect(invalid.run(["contacts", "mode", "Alice", "keyword", "--keyword", ""])).rejects.toThrow("keyword");
    expect(invalid.calls).toHaveLength(1);
  });

  test("a revision conflict is reported once without retrying the mutation", async () => {
    const f = fixture(snapshot(), () => ({ protocol: CONTROL_PROTOCOL, ok: false, code: "conflict", message: "Settings changed. Reload before saving." }));
    expect(await f.run(["contacts", "enable", "Alice"])).toBe(1);
    expect(f.calls).toHaveLength(2);
    expect(f.output[0]).toMatchObject({ ok: false, code: "conflict" });
  });

  test("habitat configuration resolves one contact and sends the complete plan at its observed habitat revision", async () => {
    const plan = { ...DEFAULT_HABITAT_PLAN, guidance: "Give one useful example.", personality: { tone: "warm" as const, formality: "casual" as const }, webSearch: true };
    const f = fixture();
    expect(await f.run(["habitats", "configure", "Alice", "0", JSON.stringify(plan)])).toBe(0);
    expect(f.calls).toEqual([{ protocol: CONTROL_PROTOCOL, command: "snapshot" }, {
      protocol: CONTROL_PROTOCOL, command: "habitat.configure", contactId: "contact-1", expectedRevision: 0, plan,
    }]);
    const read = fixture(); await read.run(["habitats", "show", "contact-1"]);
    expect(read.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "habitat.read", contactId: "contact-1" });
    const rollback = fixture(); await rollback.run(["habitats", "rollback", "Alice", "7"]);
    expect(rollback.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "habitat.rollback", contactId: "contact-1", expectedRevision: 7 });
    const clear = fixture(); await clear.run(["habitats", "memory-clear", "Alice", "7"]);
    expect(clear.calls[1]).toEqual({ protocol: CONTROL_PROTOCOL, command: "habitat.memory.clear", contactId: "contact-1", expectedRevision: 7 });
  });

  test("malformed habitat plans and revisions fail before reading state", async () => {
    const f = fixture();
    for (const plan of ["{", "null", "[]", "{}", JSON.stringify({ ...DEFAULT_HABITAT_PLAN, tools: ["shell"] }),
      JSON.stringify({ ...DEFAULT_HABITAT_PLAN, personality: { tone: "intense", formality: "casual" } }),
      JSON.stringify({ ...DEFAULT_HABITAT_PLAN, personality: { tone: "warm", formality: "casual", account: "other" } }),
      JSON.stringify({ ...DEFAULT_HABITAT_PLAN, guidance: "x".repeat(8193) })]) {
      await rejectsOwnerFacing(f.run(["habitats", "configure", "Alice", "0", plan]));
    }
    for (const revision of ["-1", "1.5", "01", "9007199254740992"]) {
      await rejectsOwnerFacing(f.run(["habitats", "configure", "Alice", revision, JSON.stringify(DEFAULT_HABITAT_PLAN)]));
      await rejectsOwnerFacing(f.run(["habitats", "memory-clear", "Alice", revision]));
    }
    await rejectsOwnerFacing(f.run(["habitats", "configure", "Alice", "0"]));
    expect(f.calls).toEqual([]);
  });

  test("a stale habitat revision is reported without retry or a settings mutation", async () => {
    const f = fixture(snapshot(), () => ({ protocol: CONTROL_PROTOCOL, ok: false, code: "conflict", message: "Read the current habitat before saving." }));
    expect(await f.run(["habitats", "configure", "Alice", "3", JSON.stringify(DEFAULT_HABITAT_PLAN)])).toBe(1);
    expect(f.calls.map(call => call.command)).toEqual(["snapshot", "habitat.configure"]);
    expect(f.output[0]).toMatchObject({ ok: false, code: "conflict" });
  });

  test("pending jobs remain addressable and jobs show performs only a read", async () => {
    const f = fixture(snapshot(), () => ({ protocol: CONTROL_PROTOCOL, ok: true, kind: "job", jobId: "job-1" }));
    expect(await f.run(["jobs", "show", "job-1"])).toBe(1);
    expect(f.calls).toEqual([{ protocol: CONTROL_PROTOCOL, command: "owner.job.read", jobId: "job-1" }]);
    expect(f.output[0]).toMatchObject({ kind: "job", jobId: "job-1", status: "pending", nextCommand: ["textbutler", "jobs", "show", "job-1"] });
  });
});

describe("bounded owner job waiting", () => {
  const pending: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: true, kind: "job", jobId: "job-1" };
  const request: ControlRequest = { protocol: CONTROL_PROTOCOL, command: "messaging.start", provider: "beeper" };

  test("timeout retains the accepted job and never repeats the original mutation", async () => {
    let at = 0;
    const calls: ControlRequest[] = [];
    const result = await awaitOwnerJob(request, async value => { calls.push(value); return pending; }, { waitMs: 500, now: () => at, sleep: async ms => { at += ms; } });
    expect(result).toEqual(pending);
    expect(calls.map(value => value.command)).toEqual(["messaging.start", "owner.job.read", "owner.job.read"]);
    expect(pendingJobOutput(pending)).toMatchObject({ jobId: "job-1", detail: expect.stringContaining("Do not repeat") });
  });

  test("a disconnected poll retains the job identity", async () => {
    const calls: ControlRequest[] = [];
    const result = await awaitOwnerJob(request, async value => {
      calls.push(value); if (calls.length > 1) throw new Error("socket disconnected"); return pending;
    }, { sleep: async () => {} });
    expect(result).toEqual(pending);
    expect(calls).toHaveLength(2);
  });

  test("invalid wait configuration fails before a mutation and disconnected responses retain the job", async () => {
    let calls = 0;
    await expect(awaitOwnerJob(request, async () => { calls++; return pending; }, { waitMs: -1 })).rejects.toThrow("between 0 and 120");
    expect(calls).toBe(0);
    expect(await awaitOwnerJob(request, async () => ++calls === 1 ? pending : { protocol: CONTROL_PROTOCOL, ok: false, code: "disconnected", message: "Disconnected" },
      { sleep: async () => {} })).toEqual(pending);
    expect(calls).toBe(2);
  });

  test("a terminal job response is returned, and zero wait only starts the command once", async () => {
    const terminal: ControlResponse = { protocol: CONTROL_PROTOCOL, ok: false, code: "unavailable", message: "Synthetic connection unavailable" };
    let calls = 0;
    expect(await awaitOwnerJob(request, async () => ++calls === 1 ? pending : terminal, { sleep: async () => {} })).toEqual(terminal);
    expect(calls).toBe(2);
    calls = 0;
    expect(await awaitOwnerJob(request, async () => { calls++; return pending; }, { waitMs: 0 })).toEqual(pending);
    expect(calls).toBe(1);
  });
});
