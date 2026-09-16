import type { AccountLease, AccountLeaseStore } from "./accounts.ts";
import type { ToolBroker } from "./broker.ts";
import type { CapabilityBroker } from "./capabilities.ts";
import { runAgentTask, type AgentTaskAdapter, type AgentTaskRequest, type AgentTaskResult } from "./task-runtime.ts";
import { boundedText, identifier, provider, safeInteger, type AgentProvider } from "./validation.ts";

export const CONTACT_TOOL_PROFILE = "agentrouter.scoped-tools.v1" as const;
export type RuntimeQualification =
  | Readonly<{ status: "unqualified"; reason: string }>
  | Readonly<{
      status: "qualified";
      profile: typeof CONTACT_TOOL_PROFILE;
      runtimeVersion: string;
      runtimeDigest: string;
      evidenceDigest: string;
      expiresAt: number;
      controls: Readonly<{
        noCommandTools: true;
        exactToolInventory: true;
        contactReadIsolation: true;
        contactWriteIsolation: true;
        isolatedConfiguration: true;
        authOutsideWorkspace: true;
        hostBrokerOnly: true;
      }>;
    }>;

export type AgentRunRequest = Readonly<{
  runId: string;
  provider: AgentProvider;
  accountId: string;
  workspaceId: string;
  prompt: string;
  model: string;
  purpose: "classify" | "respond";
  signal: AbortSignal;
}>;
export type AgentRunResult = Readonly<{
  output: unknown;
  /** Must prove provider process exit or fenced controller release, even after errors. */
  processStopped: true;
}>;
/** An adapter may use this only after independently joining every process it started. */
export class AgentStoppedError extends Error {
  readonly processStopped = true;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly qualification: RuntimeQualification;
  run(request: AgentRunRequest, broker: ToolBroker): Promise<AgentRunResult>;
}

export const UNQUALIFIED_PROVIDER_REASONS = Object.freeze({
  codex: "Codex 0.153.4 has a restricted experimental driver; native confinement, adversarial custody and account transport qualification remain incomplete.",
  claude: "Claude tool selection is documented; isolated configuration and contact-only read confinement require exact-runtime adversarial qualification.",
});

/** Installed adapters explicitly advertise blocked status until their host evidence exists. */
export function unqualifiedAdapter(selected: AgentProvider): AgentAdapter {
  const p = provider(selected);
  return Object.freeze({ provider: p,
    qualification: Object.freeze({ status: "unqualified", reason: UNQUALIFIED_PROVIDER_REASONS[p] }),
    async run(): Promise<AgentRunResult> { throw new Error("PROVIDER_UNQUALIFIED"); },
  });
}

export type AccountBinding = Readonly<{ provider: AgentProvider; accountId: string; authBindingId: string }>;
/** The trusted adapter resolves this opaque handle; the broker/model never receives credentials. */
export interface AccountResolver { resolve(provider: AgentProvider, accountId: string): Promise<AccountBinding> }

export class AgentRouter {
  private readonly taskAdapters: readonly AgentTaskAdapter[];
  constructor(private readonly options: {
    adapters: readonly AgentAdapter[];
    taskAdapters?: readonly AgentTaskAdapter[];
    leases: AccountLeaseStore;
    now: () => number;
  }) {
    if (new Set(options.adapters.map((adapter) => adapter.provider)).size !== options.adapters.length) throw new Error("DUPLICATE_PROVIDER");
    this.taskAdapters = Object.freeze([...(options.taskAdapters ?? [])]);
  }

  /** Additive execution path for an application's exact capability profile. */
  async runTask(request: AgentTaskRequest, broker: CapabilityBroker): Promise<AgentTaskResult> {
    return await runAgentTask({ adapters: this.taskAdapters, leases: this.options.leases, now: this.options.now }, request, broker);
  }

  async run(request: AgentRunRequest, broker: ToolBroker): Promise<AgentRunResult> {
    try {
      return await this.runAdmitted(request, broker);
    } finally {
      broker.revoke();
    }
  }

  private async runAdmitted(request: AgentRunRequest, broker: ToolBroker): Promise<AgentRunResult> {
    const p = provider(request.provider);
    identifier(request.runId); identifier(request.accountId); identifier(request.workspaceId);
    boundedText(request.prompt, 512 * 1024); boundedText(request.model, 160);
    if (request.purpose !== "classify" && request.purpose !== "respond") throw new Error("INVALID_RUN_PURPOSE");
    if (request.workspaceId !== broker.workspaceId || request.runId !== broker.runId) throw new Error("BROKER_BINDING_MISMATCH");
    request.signal.throwIfAborted();
    const adapter = this.options.adapters.find((candidate) => candidate.provider === p);
    if (adapter === undefined) throw new Error("UNSUPPORTED_PROVIDER");
    assertQualified(adapter.qualification, this.options.now());
    if (request.purpose === "classify" && broker.tools.length !== 0) throw new Error("CLASSIFIER_MUST_HAVE_NO_TOOLS");
    const lease: AccountLease = this.options.leases.acquire({ provider: p, accountId: request.accountId,
      owner: request.runId, now: this.options.now(), ttlMs: 300_000 });
    // Rejections retain custody: arbitrary errors do not prove the provider stopped.
    let result: AgentRunResult;
    try {
      result = await adapter.run(Object.freeze({ ...request }), broker);
    } catch (error) {
      if (error instanceof AgentStoppedError && !this.options.leases.release(lease)) throw new Error("STALE_ACCOUNT_LEASE");
      throw error;
    }
    if (result.processStopped !== true) throw new Error("PROVIDER_PROCESS_STOP_UNPROVEN");
    if (!this.options.leases.release(lease)) throw new Error("STALE_ACCOUNT_LEASE");
    return result;
  }
}

export function assertQualified(value: RuntimeQualification, now: number): void {
  safeInteger(now, 0, Number.MAX_SAFE_INTEGER);
  if (value.status !== "qualified") throw new Error("PROVIDER_UNQUALIFIED");
  if (value.profile !== CONTACT_TOOL_PROFILE || value.expiresAt <= now || !Number.isSafeInteger(value.expiresAt)
    || !/^[a-f0-9]{64}$/u.test(value.runtimeDigest) || !/^[a-f0-9]{64}$/u.test(value.evidenceDigest)
    || !value.runtimeVersion) throw new Error("PROVIDER_QUALIFICATION_INVALID");
  for (const control of ["noCommandTools", "exactToolInventory", "contactReadIsolation", "contactWriteIsolation", "isolatedConfiguration", "authOutsideWorkspace", "hostBrokerOnly"] as const) {
    if (value.controls?.[control] !== true) throw new Error("PROVIDER_QUALIFICATION_INCOMPLETE");
  }
}

export type ProviderLaunchPlan = Readonly<{
  provider: AgentProvider;
  status: "unqualified";
  authBindingId: string;
  workspaceId: string;
  /** Configuration intent, not an executable security claim. Host adapter must qualify it. */
  configuration: Readonly<Record<string, unknown>>;
}>;

export function createProviderLaunchPlan(binding: AccountBinding, workspaceId: string): ProviderLaunchPlan {
  const p = provider(binding.provider);
  identifier(binding.accountId); identifier(binding.authBindingId); identifier(workspaceId);
  return Object.freeze({ provider: p, status: "unqualified", authBindingId: binding.authBindingId, workspaceId,
    configuration: Object.freeze(p === "codex" ? {
      transport: "app-server", commandTools: false, inheritedConfig: false, dynamicTools: "broker-only",
      readPolicy: "contact-only", writePolicy: "contact-only", approvalPolicy: "never",
      observedRuntime: "0.153.4",
      unresolvedControls: Object.freeze(["native adversarial qualification", "direct filesystem and process confinement",
        "inherited descriptor isolation", "failure custody", "account transport and model admission"]),
    } : {
      transport: "agent-sdk", tools: Object.freeze([]), settingSources: Object.freeze([]),
      permissionMode: "dontAsk", mcpServers: "broker-only", allowedTools: "exact-broker-manifest",
      readPolicy: "contact-only", writePolicy: "contact-only",
    }),
  });
}
