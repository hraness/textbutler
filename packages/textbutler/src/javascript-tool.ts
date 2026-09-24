import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { Worker } from "node:worker_threads";
import type { JsonValue } from "@hraness/algal";

export const JAVASCRIPT_LIMITS = Object.freeze({ codeBytes: 8192, inputBytes: 16_384, outputBytes: 4096,
  memoryBytes: 8 * 1024 * 1024, stackBytes: 256 * 1024, cpuMs: 50, workerMs: 250, startupMs: 2000,
  queueWaitMs: 1000, queuedWorkers: 4, interruptChecks: 5000, jsonDepth: 16, jsonNodes: 1024 });
export type JavascriptResult = { ok: true; value: JsonValue } | { ok: false; error: "invalid-input" | "execution-failed" | "resource-limit" | "invalid-output" };
let activeWorker: Worker | undefined;
let workerSlotBusy = false;
type WorkerWaiter = { signal: AbortSignal; resolve: (admitted: boolean) => void; timer: ReturnType<typeof setTimeout>; abort: () => void };
const workerQueue: WorkerWaiter[] = [];
function clearWaiter(waiter: WorkerWaiter) { clearTimeout(waiter.timer); waiter.signal.removeEventListener("abort", waiter.abort); }
async function acquireWorker(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (!workerSlotBusy) { workerSlotBusy = true; return true; }
  if (workerQueue.length >= JAVASCRIPT_LIMITS.queuedWorkers) return false;
  return new Promise(resolve => {
    let waiter!: WorkerWaiter;
    const remove = (admitted: boolean) => { const index = workerQueue.indexOf(waiter); if (index >= 0) workerQueue.splice(index, 1); clearWaiter(waiter); resolve(admitted); };
    const abort = () => remove(false);
    const timer = setTimeout(() => remove(false), JAVASCRIPT_LIMITS.queueWaitMs);
    waiter = { signal, resolve, timer, abort };
    workerQueue.push(waiter); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function releaseWorkerSlot() {
  while (workerQueue.length) {
    const next = workerQueue.shift()!; clearWaiter(next);
    if (next.signal.aborted) { next.resolve(false); continue; }
    next.resolve(true); return;
  }
  workerSlotBusy = false;
}

/** Reject getters, non-JSON values and recursive/oversized structures before
 * host JSON serialization. Only copied JSON enters the interpreter. */
function encodedJson(value: unknown, maximum: number): string {
  const seen = new Set<object>(); let nodes = 0, bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > JAVASCRIPT_LIMITS.jsonNodes || depth > JAVASCRIPT_LIMITS.jsonDepth) throw Error("JSON structure exceeds limit");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw Error("Invalid JSON number"); return; }
    if (typeof item === "string") { bytes += Buffer.byteLength(item); if (bytes > maximum) throw Error("JSON text exceeds limit"); return; }
    if (typeof item !== "object" || seen.has(item)) throw Error("Invalid JSON value");
    if (Array.isArray(item) && item.length > JAVASCRIPT_LIMITS.jsonNodes) throw Error("JSON array exceeds limit");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw Error("Invalid JSON object");
    seen.add(item);
    const entries = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(entries);
    if (keys.length > JAVASCRIPT_LIMITS.jsonNodes) throw Error("JSON fields exceed limit");
    for (const key of keys) {
      if (typeof key !== "string") throw Error("Invalid JSON key");
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = entries[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw Error("Invalid JSON field");
      bytes += Buffer.byteLength(key); if (bytes > maximum) throw Error("JSON text exceeds limit");
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > maximum) throw Error("JSON encoding exceeds limit");
  return encoded;
}

/** One fresh WebAssembly instance and QuickJS heap per call. No host functions,
 * module loader, IO, timers, credentials or contact objects enter this runtime. */
export async function runJavascriptInInterpreter(code: string, input: unknown, signal: AbortSignal): Promise<JavascriptResult> {
  signal.throwIfAborted();
  let inputJson: string;
  try {
    if (typeof code !== "string" || !code.trim() || code.includes("\0") || Buffer.byteLength(code) > JAVASCRIPT_LIMITS.codeBytes) return { ok: false, error: "invalid-input" };
    inputJson = encodedJson(input, JAVASCRIPT_LIMITS.inputBytes);
  } catch { return { ok: false, error: "invalid-input" }; }
  const quickjs = await newQuickJSWASMModuleFromVariant(variant); signal.throwIfAborted();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(JAVASCRIPT_LIMITS.memoryBytes); runtime.setMaxStackSize(JAVASCRIPT_LIMITS.stackBytes);
  const deadline = performance.now() + JAVASCRIPT_LIMITS.cpuMs;
  let checks = 0, interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted ||= signal.aborted || performance.now() >= deadline || ++checks > JAVASCRIPT_LIMITS.interruptChecks;
    return interrupted;
  });
  try {
    const context = runtime.newContext();
    try {
      const inputHandle = context.newString(inputJson);
      try { context.setProp(context.global, "__inputJSON", inputHandle); } finally { inputHandle.dispose(); }
      const guest = JSON.stringify(code);
      const result = context.evalCode(`(() => {
        const encode = JSON.stringify;
        const input = JSON.parse(globalThis.__inputJSON);
        delete globalThis.__inputJSON;
        globalThis.Date = undefined;
        Math.random = undefined;
        const execute = Function("input", "\\\"use strict\\\"; return (() => {\\n" + ${guest} + "\\n})();");
        let value;
        try { value = execute(input); } catch (error) { throw error; }
        if (value && typeof value.then === "function") throw Error("Asynchronous output is unavailable");
        const encoded = encode(value);
        if (typeof encoded !== "string" || encoded.length > ${JAVASCRIPT_LIMITS.outputBytes}) throw Error("Output exceeds limit");
        return encoded;
      })()`, "contact-calculation.js", { type: "global" });
      if (result.error) {
        result.error.dispose(); signal.throwIfAborted();
        return { ok: false, error: interrupted ? "resource-limit" : "execution-failed" };
      }
      try {
        signal.throwIfAborted();
        if (runtime.hasPendingJob() || context.typeof(result.value) !== "string") return { ok: false, error: "invalid-output" };
        const encoded = context.getString(result.value);
        if (Buffer.byteLength(encoded) > JAVASCRIPT_LIMITS.outputBytes) return { ok: false, error: "invalid-output" };
        try {
          const value: unknown = JSON.parse(encoded);
          encodedJson(value, JAVASCRIPT_LIMITS.outputBytes);
          return { ok: true, value: value as JsonValue };
        } catch { return { ok: false, error: "invalid-output" }; }
      } finally { result.value.dispose(); }
    } finally { context.dispose(); }
  } finally { runtime.dispose(); }
}

/** A thread watchdog requests termination even for native operations that do
 * not poll QuickJS interrupts. Host admission remains closed until worker exit;
 * the bounded resource-limit result can return sooner. */
export async function runJavascriptTool(code: string, input: unknown, signal: AbortSignal): Promise<JavascriptResult> {
  signal.throwIfAborted();
  let inputJson: string;
  try {
    if (typeof code !== "string" || !code.trim() || code.includes("\0") || Buffer.byteLength(code) > JAVASCRIPT_LIMITS.codeBytes) return { ok: false, error: "invalid-input" };
    inputJson = encodedJson(input, JAVASCRIPT_LIMITS.inputBytes);
  } catch { return { ok: false, error: "invalid-input" }; }
  const admitted = await acquireWorker(signal);
  if (!admitted) { signal.throwIfAborted(); return { ok: false, error: "resource-limit" }; }
  try { signal.throwIfAborted(); } catch (error) { releaseWorkerSlot(); throw error; }
  const embeddedWorker = typeof __TEXTBUTLER_JAVASCRIPT_WORKER_SOURCE === "string" ? __TEXTBUTLER_JAVASCRIPT_WORKER_SOURCE : undefined;
  const workerBlobUrl = embeddedWorker === undefined ? undefined : URL.createObjectURL(new Blob([embeddedWorker], { type: "text/javascript" }));
  const workerUrl = workerBlobUrl ?? new URL("./javascript-worker-entry.ts", import.meta.url);
  let worker: Worker;
  try { worker = new Worker(workerUrl, { env: {}, argv: [], execArgv: [] }); }
  catch { if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl); releaseWorkerSlot(); return { ok: false, error: "execution-failed" }; }
  worker.unref(); activeWorker = worker;
  return new Promise<JavascriptResult>((resolve, reject) => {
    let finished = false, started = false;
    let timer = setTimeout(() => finish({ ok: false, error: "resource-limit" }), JAVASCRIPT_LIMITS.startupMs);
    const abort = () => finish(undefined, signal.reason);
    function finish(result?: JavascriptResult, failure?: unknown, returnBeforeStop = false) {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort); worker.removeAllListeners();
      const stopping = worker.terminate().then(() => {
        if (activeWorker === worker) activeWorker = undefined;
        releaseWorkerSlot();
        if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
      });
      if (returnBeforeStop) { void stopping.catch(() => {}); resolve(result ?? { ok: false, error: "resource-limit" }); return; }
      void stopping.then(() => { if (failure !== undefined) reject(failure); else resolve(result ?? { ok: false, error: "execution-failed" }); }, reject);
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: JavascriptResult | { ready: true }) => {
      if ("ready" in message) {
        if (started) { finish({ ok: false, error: "execution-failed" }); return; }
        started = true; clearTimeout(timer); timer = setTimeout(() => finish({ ok: false, error: "resource-limit" }, undefined, true), JAVASCRIPT_LIMITS.workerMs);
        return;
      }
      finish(message);
    });
    worker.on("error", () => finish({ ok: false, error: "execution-failed" }));
    worker.on("exit", () => finish({ ok: false, error: "execution-failed" }));
    worker.postMessage({ code, inputJson });
    if (signal.aborted) abort();
  });
}

declare const __TEXTBUTLER_JAVASCRIPT_WORKER_SOURCE: string | undefined;
