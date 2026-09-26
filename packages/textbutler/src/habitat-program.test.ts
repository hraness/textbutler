import { expect, test } from "bun:test";
import { MemoryStore, manifestToJson, verifyReceipt, type JsonValue } from "@hraness/algal";
import { DEFAULT_HABITAT_PLAN } from "./contact-habitat.ts";
import { executeHabitatProgram } from "./habitat-program.ts";

test("the contact driver executes a real bounded Algal organism with replayable evidence", async () => {
  let calls = 0;
  const result = await executeHabitatProgram({ phase: "respond", plan: DEFAULT_HABITAT_PLAN, context: { message: "Synthetic request" }, signal: new AbortController().signal,
    executor: { id: "synthetic-driver", async execute() { calls++; return { summary: "Synthetic", actions: [{ kind: "text", text: "Hello" }] }; } } });
  expect(calls).toBe(1); expect(result.receipt.outcome).toBe("complete");
  expect(result.receipt.work.agentCalls).toBe(1);
  expect(result.output).toEqual({ summary: "Synthetic", actions: [{ kind: "text", text: "Hello" }] });
  const replay = await verifyReceipt(result.receipt as unknown as JsonValue, manifestToJson(result.manifest), new MemoryStore(), new Map());
  expect(replay.ok).toBe(true); expect(calls).toBe(1);
  const stored = JSON.parse(JSON.stringify(result));
  expect((await verifyReceipt(stored.receipt, stored.manifest, new MemoryStore(), new Map())).ok).toBe(true);
  const changed = await executeHabitatProgram({ phase: "respond", plan: { ...DEFAULT_HABITAT_PLAN, guidance: "Prefer a short example." }, context: { message: "Synthetic request" }, signal: new AbortController().signal,
    executor: { id: "synthetic-driver", async execute() { return { answer: "Example" }; } } });
  expect(changed.receipt.manifestDigest).not.toBe(result.receipt.manifestDigest);
});

test("cancellation before dispatch starts no model and over-bound inputs fail closed", async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const options = { phase: "respond" as const, plan: DEFAULT_HABITAT_PLAN, context: {}, signal: controller.signal, executor: { id: "synthetic", async execute() { calls++; return {}; } } };
  await expect(executeHabitatProgram(options)).rejects.toThrow();
  await expect(executeHabitatProgram({ ...options, signal: new AbortController().signal, context: { text: "x".repeat(200_000) } })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("the respond instructions require an explicit ask and treat shares without one as context", async () => {
  const result = await executeHabitatProgram({ phase: "respond", plan: DEFAULT_HABITAT_PLAN, context: {}, signal: new AbortController().signal,
    executor: { id: "synthetic-silence", async execute(request) {
      expect(request.prompt).toContain("explicitly asks a question, requests a task, or directly addresses");
      expect(request.prompt).toContain("bare link, document, media item, or forwarded material");
      expect(request.prompt).toContain("keeps confidence below 0.85");
      return { respond: false, confidence: 0.2, reason: "not_needed", actions: [] };
    } } });
  expect(result.output).toMatchObject({ respond: false });
});

test("structured personality remains style data and is bound into the replayable manifest", async () => {
  const personality = { tone: "warm" as const, formality: "casual" as const };
  const result = await executeHabitatProgram({ phase: "respond", plan: { ...DEFAULT_HABITAT_PLAN, personality }, context: {}, signal: new AbortController().signal,
    executor: { id: "synthetic-personality", async execute(request) {
      expect(request.prompt).toContain("personality tone/formality adjust style only");
      expect(request.prompt).toContain(JSON.stringify(personality));
      return { text: "Hello" };
    } } });
  const stored = JSON.parse(JSON.stringify(result));
  expect((await verifyReceipt(stored.receipt, stored.manifest, new MemoryStore(), new Map())).ok).toBe(true);
});
