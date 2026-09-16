import { createHash } from "node:crypto";

import type { CapabilityBroker } from "./capabilities.ts";
import type { BoundedProviderProcessFactory } from "./provider-process.ts";
import { DevinAcpClient } from "./devin-client.ts";
import { startDevinToolRelay, type DevinToolRelay } from "./devin-mcp.ts";
import type { DevinPermissionOutcome, DevinPermissionRequest } from "./devin-acp.ts";
import type {
  AgentTaskAdapter, AgentTaskBinding, AgentTaskCompletion, AgentTaskExecutionRequest, AgentTaskRoute,
  AgentTaskStopEvidence, AgentTaskStopReason, AgentTaskUsage, TaskRuntimeQualification,
} from "./task-runtime.ts";
import { assertAgentTaskAccountLease } from "./task-runtime.ts";
import { boundedText } from "./validation.ts";

/**
 * Devin task adapter over ACP v1 (`devin acp`). One bounded child per run:
 * initialize -> session/new (host cwd, stdio MCP bridge when the profile has
 * tools) -> optional mode/model selection -> session/prompt -> join. The
 * profile's tools are exposed only through the host-owned loopback relay; fs
 * and terminal client capabilities stay unimplemented. This adapter is
 * admission-only: the supplied qualification decides whether tasks may run.
 */
export type DevinAcpAdapterOptions = Readonly<{
  route: AgentTaskRoute;
  runtime: Readonly<{ version: string; digest: string }>;
  qualification: TaskRuntimeQualification;
  /** Host-admitted Devin CLI executable; an absolute pinned artifact path. */
  executable: string;
  /** Exact child environment; the host owns credential and HOME isolation. */
  env: Readonly<Record<string, string>>;
  factory: BoundedProviderProcessFactory;
  /** Runtime executable that runs the stdio MCP bridge (`-e` source), e.g. a
   * pinned bun/node path. Required when a task profile declares tools. */
  bridgeExecutable?: string;
  /** Canonical absolute cwd for the Devin session's workspace. */
  workspaceCwd: (workspaceId: string) => string;
  /** Session mode pinned for every task, e.g. "plan" or "ask". */
  mode?: string;
  /** Host permission policy for provider tool gates; default denies all. */
  permission?: (request: DevinPermissionRequest) => DevinPermissionOutcome | Promise<DevinPermissionOutcome>;
  now(): number;
}>;

type Active = {
  binding: AgentTaskBinding;
  requestDigest: string;
  cleanupDeadlineUnixMs: number;
  controller: AbortController;
  promise: Promise<AgentTaskCompletion>;
  processLaunched: boolean;
  processStopped: boolean;
  stopping?: Promise<AgentTaskStopEvidence>;
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (request: AgentTaskExecutionRequest): AgentTaskBinding => Object.freeze({
  route: Object.freeze({ ...request.route }), accountId: request.accountId, workspaceId: request.workspaceId,
  runId: request.runId, profile: Object.freeze({ ...request.profile }), model: Object.freeze({ ...request.model }),
  runtime: Object.freeze({ ...request.runtime }), accountLease: request.accountLease,
  ...(request.authority === undefined ? {} : { authority: Object.freeze({ ...request.authority }) }),
});
const requestDigest = (request: AgentTaskExecutionRequest) => digest({ ...binding(request),
  purpose: request.purpose, prompt: request.prompt, limits: request.limits,
  admittedAtUnixMs: request.admittedAtUnixMs, executionDeadlineUnixMs: request.executionDeadlineUnixMs });
const failedUsage: AgentTaskUsage = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });

export function createDevinAcpAdapter(options: DevinAcpAdapterOptions): AgentTaskAdapter {
  if (options.route.provider !== "devin") throw new Error("DEVIN_ROUTE_PROVIDER");
  const executable = boundedText(options.executable, 1024);
  if (!executable.startsWith("/") || executable.includes("\0") || executable.includes(".."))
    throw new Error("DEVIN_EXECUTABLE_INVALID");
  const env = Object.freeze({ ...options.env });
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || boundedText(value, 8192, true).includes("\0"))
      throw new Error("DEVIN_ENV_INVALID");
  }
  let active: Active | null = null;
  const slots = new WeakMap<AbortSignal, Active>();
  const adapter = {
    route: Object.freeze({ ...options.route }),
    runtime: Object.freeze({ ...options.runtime }),
    qualification: options.qualification,
    async run(request: AgentTaskExecutionRequest, broker: CapabilityBroker): Promise<AgentTaskCompletion> {
      if (slots.has(request.signal)) throw Error("DEVIN_TASK_REQUEST_ALREADY_ADMITTED");
      const busy = active !== null;
      const controller = new AbortController();
      const outputLimit = request.limits.maxOutputBytes;
      const slot: Active = { binding: binding(request), requestDigest: requestDigest(request),
        cleanupDeadlineUnixMs: request.cleanupDeadlineUnixMs, controller,
        promise: Promise.resolve().then(execute), processLaunched: false, processStopped: false };
      slots.set(request.signal, slot);
      if (!busy) active = slot;
      let outputText = "", outputBytes = 0, outputTruncated = false;
      const encoder = new TextEncoder();
      function appendDelta(text: string): void {
        if (outputTruncated) return;
        const bytes = encoder.encode(text);
        if (outputBytes + bytes.byteLength <= outputLimit) { outputText += text; outputBytes += bytes.byteLength; return; }
        outputTruncated = true;
      }
      async function execute(): Promise<AgentTaskCompletion> {
        let usage = failedUsage;
        try {
          if (busy) throw Error("DEVIN_TASK_ALREADY_RUNNING");
          assertAgentTaskAccountLease(request);
          const signal = AbortSignal.any([request.signal, controller.signal]);
          signal.throwIfAborted();
          const cwd = options.workspaceCwd(request.workspaceId);
          if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\0") || cwd.includes("..")
            || new TextEncoder().encode(cwd).byteLength > 4096) throw new Error("DEVIN_WORKSPACE_CWD_INVALID");
          let relay: DevinToolRelay | null = null;
          const mcpServers: Record<string, unknown>[] = [];
          if (broker.profile.tools.length > 0) {
            if (options.bridgeExecutable === undefined) throw new Error("DEVIN_BRIDGE_REQUIRED");
            relay = await startDevinToolRelay({ broker, bridgeExecutable: options.bridgeExecutable, signal });
            mcpServers.push(relay.mcpServerEntry());
          }
          try {
            const handle = options.factory({
              executable, args: ["acp"], cwd, env, onViolation: () => controller.abort(),
              binding: { runId: request.runId, accountId: request.accountId, workspaceId: request.workspaceId },
            });
            slot.processLaunched = true;
            const client = new DevinAcpClient({
              process: handle,
              ...(options.permission === undefined ? {} : { onPermission: options.permission }),
              onFact: fact => {
                if (fact.type === "assistantDelta") appendDelta(fact.text);
                if (fact.type === "usageUpdated") usage = Object.freeze({ inputTokens: fact.inputTokens,
                  outputTokens: fact.outputTokens, totalTokens: null, costUsd: null });
              },
            });
            try {
              const init = await client.initialize(signal);
              if (init.protocolVersion !== 1) throw new Error("DEVIN_PROTOCOL_MISMATCH");
              const session = await client.newSession({ cwd, mcpServers, signal });
              if (options.mode !== undefined && options.mode !== session.currentMode)
                await client.setMode(session.sessionId, options.mode, signal);
              await client.setConfigOption(session.sessionId, "model", request.model.id, signal);
              const result = await client.prompt(session.sessionId, request.prompt, signal);
              if (result.stopReason !== "end_turn" && result.stopReason !== "max_tokens")
                throw new Error(`DEVIN_TURN_${result.stopReason.toUpperCase()}`);
              if (result.usage !== null) usage = Object.freeze({ inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens, costUsd: null });
            } finally {
              await client.close();
              slot.processStopped = true;
            }
            signal.throwIfAborted();
            return Object.freeze({ ...slot.binding, output: outputText.length === 0 ? null : outputText,
              usage, outcome: Object.freeze({ status: "completed" as const, code: null }) });
          } finally { await relay?.stop(); }
        } catch (error) {
          return Object.freeze({ ...slot.binding, output: null, usage,
            outcome: Object.freeze({ status: "failed" as const,
              code: busy ? "DEVIN_TASK_ALREADY_RUNNING"
                : error instanceof Error && /^DEVIN_[A-Z_]+$/u.test(error.message) ? error.message : "DEVIN_ADAPTER_FAILED" }) });
        }
      }
      return slot.promise;
    },
    async stop(request: AgentTaskExecutionRequest, _reason: AgentTaskStopReason): Promise<AgentTaskStopEvidence> {
      const slot = slots.get(request.signal);
      if (!slot) throw Error("DEVIN_TASK_NOT_RUNNING");
      if (requestDigest(request) !== slot.requestDigest || !Number.isSafeInteger(request.cleanupDeadlineUnixMs)
        || request.cleanupDeadlineUnixMs < request.admittedAtUnixMs
        || request.cleanupDeadlineUnixMs > slot.cleanupDeadlineUnixMs) throw Error("DEVIN_TASK_STOP_BINDING_MISMATCH");
      return slot.stopping ??= Promise.resolve().then(async () => {
        slot.controller.abort();
        await slot.promise;
        if (slot.processLaunched && !slot.processStopped) throw Error("DEVIN_TASK_PROCESS_STOP_UNPROVEN");
        if (active === slot) active = null;
        return Object.freeze({ ...slot.binding, processStopped: true, controllersStopped: true, joined: true,
          stoppedAtUnixMs: options.now(), proofDigest: digest({ requestDigest: slot.requestDigest,
            processLaunched: slot.processLaunched, processStopped: slot.processStopped }) });
      });
    },
  } satisfies AgentTaskAdapter;
  return Object.freeze(adapter);
}

