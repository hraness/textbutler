import { expect, test } from "bun:test";
import type { EffectRequest } from "@hraness/algal";
import { RunJournal } from "./journal.ts";
import { createFastDriver, parseFastDriverConfig } from "./fast-driver.ts";

const now = Date.parse("2026-09-20T12:00:00.000Z");
const config = { kind: "gateway", model: "alibaba/qwen3.5-flash", credentialFile: "fast-driver", dailyBudgetUsd: 1 } as const;
const request: EffectRequest = { contract: "algal.effect.v1", cellId: "model", kind: "agent", prompt: "Synthetic only", context: {}, output: { kind: "json", schema: { type: "object" } }, budget: { maxContextBytes: 4096, maxOutputBytes: 4096 } };

test("Gateway driver pins destination/provider, disables reasoning and never includes credentials in evidence", async () => {
  const journal = RunJournal.memory(); const requests: { url: string; body: Record<string, unknown> }[] = [];
  try {
    const driver = createFastDriver(config, { journal, now: () => now, credential: async () => "synthetic-key-never-in-evidence", fetch: async (url, init) => {
      expect(init?.redirect).toBe("error");
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ model: config.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value: { answer: "Synthetic" } }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    } });
    const result = await driver.executor("operation-1").executeEffect!(request);
    expect(result.output).toEqual({ answer: "Synthetic" });
    expect(requests[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(requests[0]?.body.reasoning).toEqual({ effort: "none" });
    expect(requests[0]?.body.providerOptions).toEqual({ gateway: { only: ["alibaba"] } });
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
    await expect(driver.executor("operation-1").execute(request)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  } finally { journal.close(); }
});

test("daily admission is global, atomic, persistent and retains uncertain reservations", async () => {
  const journal = RunJournal.memory();
  try {
    let calls = 0;
    const driver = createFastDriver(config, { journal, now: () => now, credential: async () => "synthetic-private-key", fetch: async () => { calls++; throw Error("Private upstream error body"); } });
    for (let i = 0; i < 40; i++) await expect(driver.executor(`operation-${i}`).execute(request)).rejects.toThrow("Fast driver request failed");
    await expect(driver.executor("over-budget").execute(request)).rejects.toThrow("budget");
    expect(calls).toBe(40); expect(journal.apiUsage(now)).toBe(1_000_000);
    expect(journal.apiUsage(now + 86_400_000)).toBe(0);
  } finally { journal.close(); }
});

test("provider-reported generation cost settles the conservative reservation once", async () => {
  const journal = RunJournal.memory();
  try {
    const driver = createFastDriver(config, { journal, now: () => now, credential: async () => "synthetic-private-key", fetch: async () => Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ value: { answer: "Synthetic" } }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0004 }, generationId: "gen_synthetic" }) });
    await driver.executor("operation-settle").executeEffect!(request);
    expect(journal.apiUsage(now)).toBe(400);
    journal.settleApiUsage("operation-settle", "gen_synthetic", 400);
    expect(journal.apiUsage(now)).toBe(400);
    expect(() => journal.settleApiUsage("operation-settle", "gen_other", 400)).toThrow();
    expect(() => journal.settleApiUsage("operation-unknown", "gen_synthetic", 1)).toThrow();
  } finally { journal.close(); }
});

test("truncated output, redirects, malformed usage and unapproved local destinations fail closed", async () => {
  expect(() => parseFastDriverConfig({ ...config, model: "unapproved/model" })).toThrow();
  expect(() => parseFastDriverConfig({ ...config, dailyBudgetUsd: 0 })).toThrow();
  expect(() => parseFastDriverConfig({ kind: "local", model: "qwen", baseUrl: "http://169.254.169.254/v1" })).toThrow();
  expect(parseFastDriverConfig({ kind: "local", model: "qwen3.5:4b", baseUrl: "http://127.0.0.1:11434/v1" }).kind).toBe("local");
  const journal = RunJournal.memory();
  try {
    const driver = createFastDriver(config, { journal, now: () => now, credential: async () => "synthetic-private-key", fetch: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"value":{}}' } }] }) });
    await expect(driver.executor("truncated").execute(request)).rejects.toThrow();
    expect(journal.apiUsage(now)).toBe(25_000);
  } finally { journal.close(); }
});
