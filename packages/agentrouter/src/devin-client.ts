import type { Readable, Transform, Writable } from "node:stream";

import type { BoundedProviderProcess } from "./provider-process.ts";
import {
  boundedDevinPrompt, boundedDevinSessionId, denyPermissionOutcome, devinAcpFraming,
  devinModeId, DEVIN_ACP_MAX_FRAME_BYTES, DEVIN_ACP_PROTOCOL_VERSION,
  parseAcpInbound, parseInitializeResult, parseNewSessionResult, parsePermissionRequest,
  parsePromptResult, parseSessionUpdate, validatePermissionOutcome,
  type DevinAcpInbound, type DevinFact, type DevinNewSession, type DevinPermissionOutcome,
  type DevinPermissionRequest, type DevinPromptResult,
} from "./devin-acp.ts";
import { safeInteger } from "./validation.ts";

/** One owned `devin acp` child behind the bounded-process custody contract. The
 * client serializes writes, correlates requests, routes inbound fs/permission
 * requests to host handlers and refuses concurrent prompts. */
export type DevinAcpClientOptions = Readonly<{
  process: BoundedProviderProcess;
  onFact?: (fact: DevinFact) => void;
  onPermission?: (request: DevinPermissionRequest) => DevinPermissionOutcome | Promise<DevinPermissionOutcome>;
  maximumPendingRequests?: number;
  shutdownGraceMs?: number;
  shutdownForceJoinMs?: number;
}>;

type PendingRequest = Readonly<{
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}>;

type PendingInbound = Readonly<{
  wireId: string | number;
  sessionId: string;
  options: readonly import("./devin-acp.ts").DevinPermissionOption[];
}>;

const acpError = (code: string): Error => new Error(`DEVIN_ACP_${code}`);
const requestKey = (id: string | number): string => typeof id === "number" ? `n:${id}` : `s:${id}`;

export class DevinAcpClient {
  readonly #process: BoundedProviderProcess;
  readonly #onFact: (fact: DevinFact) => void;
  readonly #onPermission: DevinAcpClientOptions["onPermission"];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #inbound = new Map<string, PendingInbound>();
  readonly #sessions = new Set<string>();
  readonly #maximumPendingRequests: number;
  readonly #shutdownGraceMs: number;
  readonly #shutdownForceJoinMs: number;
  #activePrompt = false;
  #nextRequestId = 1;
  #initialized = false;
  #state: "open" | "closing" | "closed" = "open";
  #failure: Error | null = null;
  #readerDone: Promise<void>;
  #framed: Transform;
  #exited: Promise<unknown>;
  #exitedSeen = false;
  #writeTail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: Error) => void;
  #closeTask: Promise<void> | null = null;

  constructor(options: DevinAcpClientOptions) {
    this.#process = options.process;
    this.#onFact = options.onFact ?? (() => {});
    this.#onPermission = options.onPermission;
    this.#maximumPendingRequests = safeInteger(options.maximumPendingRequests ?? 128, 1, 4096);
    this.#shutdownGraceMs = safeInteger(options.shutdownGraceMs ?? 500, 1, 10_000);
    this.#shutdownForceJoinMs = safeInteger(options.shutdownForceJoinMs ?? 1_000, 1, 10_000);
    this.#closed = new Promise((resolve, reject) => { this.#resolveClosed = resolve; this.#rejectClosed = reject; });
    void this.#closed.catch(() => undefined);
    const inner = options.process.process;
    const stdout: Readable = inner.stdout;
    const framed = stdout.pipe(devinAcpFraming(DEVIN_ACP_MAX_FRAME_BYTES));
    this.#framed = framed;
    this.#readerDone = this.#readLoop(framed);
    void this.#readerDone.catch(() => undefined);
    this.#exited = new Promise(resolve => inner.once("exit", resolve));
    void this.#exited.then(() => {
      this.#exitedSeen = true;
      if (this.#state === "open") this.#fail(acpError("PROCESS_EXITED"));
    });
  }

  get closed(): Promise<void> { return this.#closed; }

  async initialize(signal?: AbortSignal): Promise<Readonly<{ protocolVersion: number; loadSession: boolean }>> {
    this.#assertOpen();
    if (this.#initialized) throw acpError("ALREADY_INITIALIZED");
    const result = await this.#request("initialize", {
      protocolVersion: DEVIN_ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agentrouter", version: "0.1.0" },
    }, signal);
    const parsed = parseInitializeResult(result);
    this.#initialized = true;
    return parsed;
  }

  /** mcpServers entries are stdio transports only — Devin advertises no
   * http/sse MCP capability; the caller must not pass other transports. */
  async newSession(input: { cwd: string; mcpServers?: readonly Record<string, unknown>[]; signal?: AbortSignal }): Promise<DevinNewSession> {
    this.#assertInitialized();
    const servers = input.mcpServers ?? [];
    if (servers.length > 8) throw acpError("MCP_SERVERS_BOUND");
    const params: Record<string, unknown> = { cwd: boundedDevinCwd(input.cwd), mcpServers: [...servers] };
    const result = await this.#request("session/new", params, input.signal);
    const session = parseNewSessionResult(result);
    if (this.#sessions.has(session.sessionId)) throw this.#terminal(acpError("SESSION_ID_DUPLICATE"));
    this.#sessions.add(session.sessionId);
    return session;
  }

  async setMode(sessionIdInput: string, mode: string, signal?: AbortSignal): Promise<void> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(sessionIdInput);
    await this.#request("session/set_mode", { sessionId, modeId: devinModeId(mode) }, signal);
  }

  async setConfigOption(sessionIdInput: string, configId: string, value: string, signal?: AbortSignal): Promise<void> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(sessionIdInput);
    await this.#request("session/set_config_option", {
      sessionId, configId: devinModeId(configId), value: devinModeId(value) }, signal);
  }

  async prompt(sessionIdInput: string, text: string, signal?: AbortSignal): Promise<DevinPromptResult> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(sessionIdInput);
    if (this.#activePrompt) throw acpError("PROMPT_ACTIVE");
    const params = { sessionId, prompt: [{ type: "text", text: boundedDevinPrompt(text) }] };
    this.#activePrompt = true;
    try {
      return parsePromptResult(await this.#request("session/prompt", params, signal));
    } finally { this.#activePrompt = false; }
  }

  async cancel(sessionIdInput: string): Promise<void> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(sessionIdInput);
    for (const [key, inbound] of this.#inbound)
      if (inbound.sessionId === sessionId) await this.#resolveInbound(key, { outcome: "cancelled" });
    this.#writeNow({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  resolvePermission(requestId: string, outcome: DevinPermissionOutcome): void {
    this.#assertOpen();
    void this.#resolveInbound(requestId, outcome);
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    const task = this.#close();
    this.#closeTask = task;
    task.then(this.#resolveClosed, this.#rejectClosed);
    return task;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    const failure = acpError("CLIENT_CLOSED");
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
    // Courtesy cancels are best-effort writes; process custody starts first and
    // never waits on a provider that has stopped reading stdin.
    const cleanup = (async () => {
      if (this.#activePrompt) for (const sessionId of this.#sessions)
        this.#writeNow({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      for (const key of [...this.#inbound.keys()])
        await this.#resolveInbound(key, { outcome: "cancelled" }).catch(() => undefined);
      try { this.#process.process.stdin.end(); } catch { /* custody join below is authoritative. */ }
    })();
    void cleanup.catch(() => undefined);
    let processJoined = false;
    try {
      processJoined = await this.#stopAndJoinProcess();
      // Joined custody frees the reader: a destroyed provider source may never
      // deliver 'end' to the piped transform, so finish it explicitly.
      this.#framed.destroy();
      await Promise.race([
        Promise.allSettled([this.#readerDone]),
        new Promise(resolve => setTimeout(resolve, this.#shutdownForceJoinMs)),
      ]);
      if (!processJoined) throw acpError("PROCESS_JOIN_UNPROVEN");
    } finally {
      this.#inbound.clear();
      this.#sessions.clear();
      this.#state = "closed";
    }
    await cleanup;
  }

  async #stopAndJoinProcess(): Promise<boolean> {
    const handle = this.#process;
    if (!this.#exitedSeen && !handle.isStopped()) {
      try { handle.process.kill("SIGTERM"); } catch { /* forced below */ }
      await Promise.race([this.#exited.catch(() => -1), new Promise(resolve => setTimeout(resolve, this.#shutdownGraceMs))]);
    }
    try { await handle.stopAndJoin(); } catch { return false; }
    return true;
  }

  async #readLoop(framed: Readable): Promise<void> {
    try {
      for await (const chunk of framed) {
        const text = (chunk as Buffer).toString("utf8");
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw acpError("FRAME_JSON"); }
        const inbound = parseAcpInbound(value);
        await this.#dispatch(inbound);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : acpError("READ_FAILED"));
      return;
    }
    if (this.#state === "open") this.#fail(acpError("PROCESS_EXITED"));
  }

  async #dispatch(message: DevinAcpInbound): Promise<void> {
    switch (message.kind) {
      case "response": {
        const pending = this.#pending.get(requestKey(message.id));
        if (pending) { this.#pending.delete(requestKey(message.id)); pending.resolve(message.result); }
        return;
      }
      case "errorResponse": {
        const pending = this.#pending.get(requestKey(message.id));
        if (pending) {
          this.#pending.delete(requestKey(message.id));
          pending.reject(Object.assign(acpError("PROVIDER_ERROR"),
            { providerCode: message.error.code }));
        }
        return;
      }
      case "notification": {
        if (message.method === "session/update") {
          for (const fact of parseSessionUpdate(message.params)) this.#onFact(fact);
        } else {
          this.#onFact(Object.freeze({ type: "protocolNotice", sessionId: null, method: message.method }));
        }
        return;
      }
      case "request": {
        if (message.method === "session/request_permission") {
          const request = parsePermissionRequest(message.id, message.params);
          if (this.#inbound.size >= 64) throw acpError("PERMISSION_BOUND");
          this.#inbound.set(request.requestId, { wireId: message.id, sessionId: request.sessionId, options: request.options });
          void this.#answerPermission(request).catch(() => this.#fail(acpError("PERMISSION_FAILED")));
          return;
        }
        // Unimplemented inbound requests get a closed method error; never hang.
        this.#writeNow({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "method not supported by this client" } });
        return;
      }
    }
  }

  async #answerPermission(request: DevinPermissionRequest): Promise<void> {
    let outcome: DevinPermissionOutcome;
    try {
      outcome = this.#onPermission === undefined
        ? denyPermissionOutcome(request.options)
        : validatePermissionOutcome(await this.#onPermission(request), request.options);
    } catch { outcome = denyPermissionOutcome(request.options); }
    await this.#resolveInbound(request.requestId, outcome);
  }

  async #resolveInbound(requestId: string, outcome: DevinPermissionOutcome): Promise<void> {
    const inbound = this.#inbound.get(requestId);
    if (!inbound) return;
    this.#inbound.delete(requestId);
    const validated = validatePermissionOutcome(outcome, inbound.options);
    this.#writeNow({ jsonrpc: "2.0", id: inbound.wireId,
      result: { outcome: validated.outcome === "cancelled" ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: validated.optionId } } });
  }

  #assertOpen(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#state !== "open") throw acpError("CLIENT_CLOSED");
  }
  #assertInitialized(): void {
    this.#assertOpen();
    if (!this.#initialized) throw acpError("NOT_INITIALIZED");
  }
  #knownSession(input: string): string {
    const sessionId = boundedDevinSessionId(input);
    if (!this.#sessions.has(sessionId)) throw acpError("SESSION_UNKNOWN");
    return sessionId;
  }
  #fail(error: Error): void {
    if (this.#failure === null) this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }
  #terminal(error: Error): Error { this.#fail(error); return error; }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#assertOpen();
    if (signal?.aborted) throw acpError("REQUEST_ABORTED");
    if (this.#pending.size >= this.#maximumPendingRequests) throw acpError("REQUEST_BOUND");
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };
      this.#pending.set(requestKey(id), pending);
      const onAbort = () => {
        if (this.#pending.delete(requestKey(id))) reject(acpError("REQUEST_ABORTED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.#enqueueWrite(body).catch(error => {
        this.#pending.delete(requestKey(id));
        reject(error instanceof Error ? error : acpError("WRITE_FAILED"));
      });
      const removeAbort = () => signal?.removeEventListener("abort", onAbort);
      void this.#closed.then(removeAbort, removeAbort);
    });
  }

  /** Serialized stdin with a total queued-byte bound; writes never reorder. */
  #enqueueWrite(body: string): Promise<void> {
    const bytes = Buffer.byteLength(body) + 1;
    if (bytes > DEVIN_ACP_MAX_FRAME_BYTES || this.#queuedBytes + bytes > 2 * DEVIN_ACP_MAX_FRAME_BYTES)
      return Promise.reject(acpError("WRITE_BOUND"));
    this.#queuedBytes += bytes;
    const write = this.#writeTail.then(() => new Promise<void>((resolve, reject) => {
      this.#queuedBytes -= bytes;
      const stdin: Writable = this.#process.process.stdin;
      if (stdin.destroyed || stdin.closed) { reject(acpError("STDIN_CLOSED")); return; }
      stdin.write(`${body}\n`, error => error ? reject(error) : resolve());
    }));
    this.#writeTail = write.then(() => undefined, () => undefined);
    return write;
  }

  /** Best-effort unserialized write for notifications, cancels and inbound
   * answers; custody is proven by close(), not by these frames landing. */
  #writeNow(message: Record<string, unknown>): void {
    try {
      const stdin: Writable = this.#process.process.stdin;
      if (!stdin.destroyed && !stdin.closed) stdin.write(`${JSON.stringify(message)}\n`);
    } catch { /* courtesy write; never custody evidence */ }
  }
}

function boundedDevinCwd(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.includes("..")
    || new TextEncoder().encode(value).byteLength > 4096) throw acpError("CWD_INVALID");
  return value;
}

export type { DevinFact, DevinPermissionRequest, DevinPermissionOutcome, DevinPromptResult, DevinNewSession };
