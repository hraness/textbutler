import { expect, test } from "bun:test";
import { JAVASCRIPT_LIMITS, runJavascriptTool } from "./javascript-tool.ts";

const run = (code: string, input: unknown = null) => runJavascriptTool(code, input, new AbortController().signal);

test("pure calculations copy JSON input and isolate every execution", async () => {
  const input = { values: [2, 5, 8] };
  expect(await run("input.values.push(11); globalThis.secret = 42; return {sum: input.values.reduce((a,b)=>a+b,0)};", input)).toEqual({ ok: true, value: { sum: 26 } });
  expect(input).toEqual({ values: [2, 5, 8] });
  expect(await run("return typeof secret;")).toEqual({ ok: true, value: "undefined" });
});

test("the interpreter has no host capabilities or module loader", async () => {
  expect(await run("return [typeof process,typeof Bun,typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof require,typeof Deno,typeof Worker,typeof console,typeof setTimeout,typeof Date,typeof Math.random,Function('return typeof process')()];"))
    .toEqual({ ok: true, value: Array.from({ length: 13 }, () => "undefined") });
  expect((await run("return import('node:fs');")).ok).toBe(false);
});

test("guest delimiters cannot skip trusted hardening or expose disabled clocks", async () => {
  const escaped = `}); }); (() => { const encode = JSON.stringify; const value = (() => { return [typeof Date, typeof Math.random];`;
  const result = await run(escaped);
  expect(result).not.toEqual({ ok: true, value: ["function", "function"] });
});

test("only one JavaScript worker is admitted at a time", async () => {
  const first = run("return 1;");
  expect(await run("return 2;")).toEqual({ ok: false, error: "resource-limit" });
  expect(await first).toEqual({ ok: true, value: 1 });
});

test("code, input and output bounds reject oversized or non-JSON values", async () => {
  expect(await run(" ".repeat(JAVASCRIPT_LIMITS.codeBytes) + "return 1;")).toEqual({ ok: false, error: "invalid-input" });
  expect(await run("return input;", "x".repeat(JAVASCRIPT_LIMITS.inputBytes))).toEqual({ ok: false, error: "invalid-input" });
  expect(await run("return input;", { get value() { throw Error("Host getter must not run"); } })).toEqual({ ok: false, error: "invalid-input" });
  expect(await run("return input;", { toJSON() { throw Error("Host toJSON must not run"); } })).toEqual({ ok: false, error: "invalid-input" });
  const recursive: unknown[] = []; recursive.push(recursive);
  expect(await run("return input;", recursive)).toEqual({ ok: false, error: "invalid-input" });
  expect(await run("return input;", new Array(1_000_000))).toEqual({ ok: false, error: "invalid-input" });
  for (const code of ["return 'x'.repeat(4097);", "return undefined;", "return 1n;", "return Promise.resolve(1);", "return (()=>{ const x={};x.self=x;return x; })();", "return Array.from({length:1025},()=>0);"]) {
    expect((await run(code)).ok).toBe(false);
  }
});

test("CPU, memory and stack exhaustion terminate and leave the next runtime usable", async () => {
  const started = performance.now();
  expect(await run("while (true) {}")).toEqual({ ok: false, error: "resource-limit" });
  expect(performance.now() - started).toBeLessThan(2000);
  expect((await run("return new ArrayBuffer(128 * 1024 * 1024);")).ok).toBe(false);
  expect((await run("function recurse(){return 1+recurse()} return recurse();")).ok).toBe(false);
  expect(await run("return 6 * 7;")).toEqual({ ok: true, value: 42 });
});

test("an aborted run never executes and guest errors cannot expose host details", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(runJavascriptTool("return 1;", null, controller.signal)).rejects.toThrow();
  expect(await run("throw Error('private guest text');")).toEqual({ ok: false, error: "execution-failed" });
});

test("the embedded interpreter bundles into one runtime without external assets or imports", async () => {
  const workerBuilt = await Bun.build({ entrypoints: [import.meta.dir + "/javascript-worker-entry.ts"], target: "bun", format: "iife", splitting: false, minify: true });
  expect(workerBuilt.success).toBe(true); expect(workerBuilt.outputs).toHaveLength(1);
  const workerSource = await workerBuilt.outputs[0]!.text();
  const built = await Bun.build({ entrypoints: [import.meta.dir + "/javascript-tool.ts"], target: "bun", format: "esm", splitting: false, minify: true,
    define: { __TEXTBUTLER_JAVASCRIPT_WORKER_SOURCE: JSON.stringify(workerSource) } });
  expect(built.success).toBe(true); expect(built.outputs).toHaveLength(1);
  const code = await built.outputs[0]!.text();
  const external = new Bun.Transpiler({ loader: "js" }).scan(code).imports.map(item => item.path).filter(path => !["node:worker_threads", "worker_threads"].includes(path));
  expect(external).toEqual([]);
  const moduleUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const bundled = await import(moduleUrl) as typeof import("./javascript-tool.ts");
    expect(await bundled.runJavascriptTool("return input + 1;", 41, new AbortController().signal)).toEqual({ ok: true, value: 42 });
  } finally { URL.revokeObjectURL(moduleUrl); }
});

test("worker watchdog bounds native QuickJS operations", async () => {
  const started = performance.now();
  expect(await run("return new Array(1_000_000_000) + ''; ")).toEqual({ ok: false, error: "resource-limit" });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(await run("return 6 * 7;")).toEqual({ ok: false, error: "resource-limit" });
});
