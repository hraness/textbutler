import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { XcbHostConfig } from "./host-config.ts";

export const XCB_LIMITS = Object.freeze({ request: 1_048_576, response: 2_097_152, output: 262_144, cleanupMs: 15_000 });
export interface XcbModel { key: string; label: string; observedAtMs: number }
export interface XcbQualification { runtimeVersion: string; runtimeDigest: string; evidenceDigest: string; expiresAt: number }
export interface XcbAccount {
  id: string; label: string; provider: string; enabled: boolean; busy: boolean;
  connected: boolean; runtimeAdmitted: boolean; available: boolean; reason: string | null;
  models: readonly XcbModel[]; qualification?: XcbQualification;
}
export interface XcbCapabilities {
  version: 1; supported: boolean; zeroTools: true; zeroHooks: true; ephemeral: true;
  accounts: readonly XcbAccount[];
}
export interface XcbGenerateRequest { version: 1; account: string; model: string; prompt: string; timeoutMs: number; maxOutputBytes: number }
export type XcbResult = Readonly<{ version: 1; status: "completed"; requestId: string; account: string; model: string; text: string;
  outcome: { terminal: "completed"; joined: true; effects: "none" } }>
  | Readonly<{ version: 1; status: "failed"; requestId?: string; code: string; joined?: boolean; effects?: string }>;
export interface XcbClient {
  capabilities(signal: AbortSignal): Promise<XcbCapabilities>;
  generate(request: XcbGenerateRequest, signal: AbortSignal): Promise<XcbResult>;
}
function invalid(): never { throw Error("XCB_APPLICATION_RESPONSE_INVALID"); }
function row(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return object;
}
function text(value: unknown, max = 160): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") return invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(); return value as number; }
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return invalid(); return value; }
/** Reject ambiguous keys before JSON.parse can discard them. Both the native
 * envelope and the model's proposed operation are untrusted protocol data. */
export function parseXcbJson(source: string): unknown {
  if (Buffer.byteLength(source) > XCB_LIMITS.response) return invalid();
  const stack: Array<Set<string> | null> = []; let tokens = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index++;
      for (; index < source.length && source[index] !== '"'; index++) if (source[index] === "\\") index++;
      if (index >= source.length) return invalid();
      let end = index + 1; while (end < source.length && /\s/u.test(source[end]!)) end++;
      if (source[end] === ":") {
        const key: unknown = JSON.parse(source.slice(start, index + 1)), object = stack.at(-1);
        if (!object || typeof key !== "string" || object.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) return invalid();
        object.add(key);
      }
      tokens++;
    } else if (character === "{" || character === "[") { stack.push(character === "{" ? new Set() : null); tokens++; }
    else if (character === "}" || character === "]") stack.pop();
    else if (character === "," || character === ":") tokens++;
    if (stack.length > 24 || tokens > 131_072) return invalid();
  }
  return JSON.parse(source) as unknown;
}
export function parseXcbCapabilities(value: unknown): XcbCapabilities {
  const v = row(value, ["version", "supported", "zeroTools", "zeroHooks", "ephemeral", "limits", "accounts"]);
  const limits = row(v.limits, ["maxInputBytes", "maxOutputBytes", "minTimeoutMs", "maxTimeoutMs"]);
  if (v.version !== 1 || v.zeroTools !== true || v.zeroHooks !== true || v.ephemeral !== true
    || limits.maxInputBytes !== XCB_LIMITS.request || limits.maxOutputBytes !== XCB_LIMITS.output
    || limits.minTimeoutMs !== 1000 || limits.maxTimeoutMs !== 120_000 || !Array.isArray(v.accounts) || v.accounts.length > 128) return invalid();
  const accounts = v.accounts.map(raw => {
    const a = row(raw, ["id", "label", "provider", "enabled", "busy", "connected", "runtimeAdmitted", "available", "reason", "models"], ["qualification"]);
    if (!Array.isArray(a.models) || a.models.length > 1024) return invalid();
    const models = a.models.map(rawModel => {
      const m = row(rawModel, ["key", "label", "observedAtMs"]);
      return { key: text(m.key, 484), label: text(m.label, 256), observedAtMs: integer(m.observedAtMs) };
    });
    if (new Set(models.map(model => model.key)).size !== models.length) return invalid();
    let qualification: XcbQualification | undefined;
    if (a.qualification !== undefined && a.qualification !== null) {
      const q = row(a.qualification, ["runtimeVersion", "runtimeDigest", "evidenceDigest", "expiresAt"]);
      qualification = { runtimeVersion: text(q.runtimeVersion), runtimeDigest: digest(q.runtimeDigest), evidenceDigest: digest(q.evidenceDigest), expiresAt: integer(q.expiresAt) };
    }
    return { id: text(a.id), label: text(a.label, 256), provider: text(a.provider), enabled: bool(a.enabled), busy: bool(a.busy),
      connected: bool(a.connected), runtimeAdmitted: bool(a.runtimeAdmitted), available: bool(a.available), reason: a.reason === null ? null : text(a.reason), models,
      ...(qualification === undefined ? {} : { qualification }) };
  });
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) return invalid();
  return { version: 1, supported: bool(v.supported), zeroTools: true, zeroHooks: true, ephemeral: true, accounts };
}
export function parseXcbResult(value: unknown, request: XcbGenerateRequest, exitCode: number | null): XcbResult {
  const v = value as Record<string, unknown> | null;
  if (v?.status === "completed") {
    row(v, ["version", "status", "requestId", "account", "model", "text", "outcome"]);
    const outcome = row(v.outcome, ["terminal", "joined", "effects"]);
    if (exitCode !== 0 || v.version !== 1 || v.account !== request.account || v.model !== request.model
      || typeof v.text !== "string" || !v.text || Buffer.byteLength(v.text) > request.maxOutputBytes
      || outcome.terminal !== "completed" || outcome.joined !== true || outcome.effects !== "none") return invalid();
    text(v.requestId);
    return v as unknown as XcbResult;
  }
  const failure = row(v, ["version", "status", "code"], ["requestId", "joined", "effects"]);
  if (exitCode === null || exitCode === 0 || failure.version !== 1 || failure.status !== "failed"
    || !["invalid_request", "unavailable", "busy", "deadline", "cancelled", "provider_error", "output_limit", "custody_unproven"].includes(text(failure.code))) return invalid();
  if (failure.requestId !== undefined) text(failure.requestId);
  if (failure.joined !== undefined) bool(failure.joined);
  if (failure.effects !== undefined && !["none", "settled", "uncertain"].includes(text(failure.effects))) return invalid();
  if (failure.code === "custody_unproven" && (failure.joined === true || failure.effects === "none")) return invalid();
  return failure as unknown as XcbResult;
}

/** A pre-spawn failure proves no XCB child exists. Once spawned, only XCB's
 * validated settlement envelope can establish provider-process custody. */
export class XcbNotStarted extends Error {}
export async function verifyXcbExecutable(config: XcbHostConfig): Promise<void> {
  if (await realpath(config.executable) !== config.executable) throw Error("XCB_EXECUTABLE_CHANGED");
  const file = await open(config.executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || ![process.getuid?.(), 0].includes(before.uid) || (before.mode & 0o022) !== 0
      || (before.mode & 0o111) === 0 || before.size < 1 || before.size > 256 * 1024 * 1024) throw Error("XCB_EXECUTABLE_UNSAFE");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let position = 0;
    while (position < before.size) { const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!read.bytesRead) throw Error("XCB_EXECUTABLE_CHANGED"); hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead; }
    const after = await file.stat(), path = await lstat(config.executable);
    if (hash.digest("hex") !== config.sha256 || before.ino !== path.ino || before.dev !== path.dev || path.isSymbolicLink()
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error("XCB_EXECUTABLE_CHANGED");
  } finally { await file.close(); }
}

export function createXcbClient(config: XcbHostConfig): XcbClient {
  async function invoke(capabilities: boolean, request: XcbGenerateRequest | undefined, signal: AbortSignal): Promise<{ value: unknown; code: number | null }> {
    let input: string;
    try {
      signal.throwIfAborted(); input = request === undefined ? "" : JSON.stringify(request);
      if (Buffer.byteLength(input) > XCB_LIMITS.request) throw Error("XCB_REQUEST_LIMIT");
      await verifyXcbExecutable(config); signal.throwIfAborted();
    } catch (cause) { throw new XcbNotStarted("XCB_NOT_STARTED", { cause }); }
    return await new Promise((resolve, reject) => {
      const child = spawn(config.executable, ["--state", config.stateHome, "--json", "generate", ...(capabilities ? ["--capabilities"] : [])], {
        cwd: "/", env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = []; let stdout = 0, stderr = 0, overflow = false, started = false, terminated = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (terminated) return; terminated = true; child.kill("SIGINT"); killTimer = setTimeout(() => child.kill("SIGKILL"), XCB_LIMITS.cleanupMs); };
      const timer = setTimeout(stop, capabilities ? 10_000 : request!.timeoutMs + 1000);
      signal.addEventListener("abort", stop, { once: true });
      child.on("spawn", () => { started = true; if (signal.aborted) stop(); });
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.length; if (stdout > XCB_LIMITS.response) { overflow = true; stop(); } else chunks.push(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65_536) { overflow = true; stop(); } });
      // Never echo provider stderr or request bodies into diagnostics.
      child.stdin.on("error", () => { stop(); });
      child.on("error", cause => { if (!started) reject(new XcbNotStarted("XCB_NOT_STARTED", { cause })); else reject(Error("XCB_PROCESS_UNCERTAIN")); });
      child.on("close", code => {
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener("abort", stop);
        if (overflow) { reject(Error("XCB_OUTPUT_LIMIT")); return; }
        try { resolve({ value: parseXcbJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), code }); }
        catch { reject(Error("XCB_APPLICATION_RESPONSE_INVALID")); }
      });
      child.stdin.end(input);
      if (signal.aborted) stop();
    });
  }
  return {
    async capabilities(signal) { const result = await invoke(true, undefined, signal); signal.throwIfAborted(); if (result.code !== 0) throw Error("XCB_APPLICATION_UNAVAILABLE"); return parseXcbCapabilities(result.value); },
    async generate(request, signal) { const result = await invoke(false, request, signal); return parseXcbResult(result.value, request, result.code); },
  };
}
