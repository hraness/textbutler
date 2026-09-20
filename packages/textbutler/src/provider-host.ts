import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { AgentMixer, AgentStoppedError, unqualifiedAdapter, type AgentAdapter, type RuntimeQualification } from "@hraness/agentmixer";
import { createClaudeApiAdapter, type ClaudeApiAdapterOptions } from "@hraness/agentmixer";
import { canonicalJson } from "@hraness/agentmixer";
import { createFileClaudeApiKeyResolver } from "@hraness/agentmixer";
import { discoverClaudeModels, type ClaudeModelDiscoveryOptions } from "@hraness/agentmixer";
import { selectClassifierModel, type ModelCatalog } from "@hraness/agentmixer";
import type { AccountLease, AccountLeaseStore } from "@hraness/agentmixer";
import type { CapabilityBroker } from "@hraness/agentmixer";
import type { AgentTaskAdapter, AgentTaskRequest, AgentTaskResult } from "@hraness/agentmixer";
import type { AgentTaskAuthority } from "@hraness/agentmixer";
import type { ManagedCodexAccountController } from "@hraness/agentmixer";
import type { ProviderAccountConfig, HostConfig } from "./host-config.ts";
import type { ContactSettings } from "./config.ts";
import type { ProviderSelection } from "./routed-agent.ts";
import { parseProviderLoginChallenge, type ProviderLoginChallenge, type ProviderAccountDiagnostic } from "../../control/src/index.ts";
import { assertNativeSubscriptionHost, nativeSubscriptionProvider, type NativeSubscriptionAccount, type NativeSubscriptionHost } from "./native-subscription.ts";

export type { ProviderAccountDiagnostic } from "../../control/src/index.ts";
export interface ProviderHost {
  readonly router: AgentMixer;
  accounts(): readonly ProviderAccountDiagnostic[];
  check(accountId: string, signal: AbortSignal): Promise<void>;
  startLogin(accountId: string, method: "chatgpt" | "chatgptDeviceCode", signal: AbortSignal): Promise<ProviderLoginChallenge>;
  cancelLogin(accountId: string, loginId: string, signal: AbortSignal): Promise<void>;
  logout(accountId: string, signal: AbortSignal): Promise<void>;
  /** Trusted managed execution only; the runtime owns its sole account lease. */
  runManagedTask(request: AgentTaskRequest, broker: CapabilityBroker): Promise<AgentTaskResult>;
  selection(contact: ContactSettings, purpose?: "classify" | "respond"): Promise<ProviderSelection>;
  validateAccountChange(previous: ContactSettings, next: { provider: "claude" | "codex"; accountId?: string }): void;
  close(): Promise<void>;
}
type Dependencies = {
  createAdapter: (options: ClaudeApiAdapterOptions) => Promise<AgentAdapter>;
  discover: (options: ClaudeModelDiscoveryOptions) => Promise<ModelCatalog>;
};
/** Trusted host port. Owner JSON and model-writable files cannot install a transport. */
export type ManagedCodexAccountFactory = (input: { accountId: string; dataDir: string; leases: AccountLeaseStore }) => ManagedCodexAccountController;

function managedCatalogDigest(models: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(models)).digest("hex");
}

/** Owner account wiring. Configuration contains references; it never grants tool authority. */
export function createProviderHost(options: {
  dataDir: string;
  config: HostConfig;
  leases: AccountLeaseStore;
  runtimeArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"];
  managedCodex?: ManagedCodexAccountFactory;
  /** Explicit qualified host adapters, never owner settings or default activation. */
  taskAdapters?: readonly AgentTaskAdapter[];
  nativeSubscriptions?: NativeSubscriptionHost;
  now?: () => number;
}, dependencies: Dependencies = { createAdapter: createClaudeApiAdapter, discover: discoverClaudeModels }): ProviderHost {
  const native = options.nativeSubscriptions;
  if (native !== undefined) assertNativeSubscriptionHost(native);
  /** One owner per account: a supplied managed Codex factory keeps its own
   * account, so accounts, checks, selection and tasks cannot disagree. */
  const nativeAccount = (accountId: string): boolean => native !== undefined
    && nativeSubscriptionProvider(accountId) !== null
    && (accountId !== "native-codex" || options.managedCodex === undefined);
  const accounts: readonly ProviderAccountConfig[] = [
    { id: "native-codex", label: "Codex", route: "codex" },
    { id: "native-claude-code", label: "Claude Code", route: "claude-code" },
    ...(options.config.providerAccounts ?? []),
  ], now = options.now ?? Date.now;
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>();
  const managed = new Map<string, ManagedCodexAccountController>();
  const managedFailures = new Set<string>();
  const managedSlots = new Map<string, object>(), taskLeases = new Map<string, AccountLease>();
  let closing: Promise<void> | undefined;
  // Observe the real runtime acquisition/release, without acquiring another
  // lease or inferring stopped custody from an exception or expired TTL.
  const taskLeaseStore: AccountLeaseStore = {
    acquire(input) { const lease = options.leases.acquire(input); taskLeases.set(input.accountId, lease); return lease; },
    renew: (lease, at, ttl) => options.leases.renew(lease, at, ttl),
    release(lease) {
      const released = options.leases.release(lease), owned = taskLeases.get(lease.accountId);
      if (released && owned?.provider === lease.provider && owned.owner === lease.owner && owned.generation === lease.generation
        && owned.expiresAt === lease.expiresAt) taskLeases.delete(lease.accountId);
      return released;
    },
  };
  const taskRouter = new AgentMixer({ adapters: [], taskAdapters: options.taskAdapters ?? [], now, leases: taskLeaseStore });
  function managedExclusive<T>(id: string, external: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([external, shutdown.signal]); signal.throwIfAborted();
    if (managedSlots.has(id)) throw new Error("Managed Codex account is busy.");
    const slot = Object.freeze({}); managedSlots.set(id, slot);
    // Publish exclusion before any controller, abort listener or task can reenter.
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); });
    pending.add(task);
    return task.finally(() => { pending.delete(task); if (managedSlots.get(id) === slot) managedSlots.delete(id); });
  }
  const managedAccount = (id: string): ManagedCodexAccountController => {
    if (shutdown.signal.aborted || !options.managedCodex || managedFailures.has(id)
      || !accounts.some(account => account.id === id && account.route === "codex")) throw new Error("Managed Codex account controls are unavailable.");
    const existing = managed.get(id); if (existing) return existing;
    try {
      const controller = options.managedCodex({ accountId: id, dataDir: options.dataDir, leases: options.leases });
      // Retain custody even if a buggy trusted factory returns the wrong binding.
      managed.set(id, controller);
      if (controller.snapshot().accountId !== id) throw new Error("Managed Codex account binding mismatch.");
      return controller;
    } catch { managedFailures.add(id); throw new Error("Managed Codex account setup needs recovery."); }
  };
  async function managedOperation<T>(id: string, external: AbortSignal, work: (controller: ManagedCodexAccountController, signal: AbortSignal) => Promise<T>): Promise<T> {
    return managedExclusive(id, external, async signal => {
      const controller = managedAccount(id);
      try { const result = await work(controller, signal); signal.throwIfAborted(); return result; }
      catch (error) {
      // An interrupted login may still be polling natively. Retire this exact
      // controller only after joined cleanup; never retry the owner's operation.
      if (controller.snapshot().state === "recovery-required") {
        try {
          const receipt = await controller.close();
          if (receipt.released && receipt.state === "closed" && controller.snapshot().state === "closed"
            && managed.get(id) === controller) managed.delete(id);
        } catch { /* Keep custody and its visible recovery state for host close. */ }
      }
        throw error;
      }
    });
  }
  const credentials = createFileClaudeApiKeyResolver({ directory: join(options.dataDir, "state", "provider-credentials"),
    bindings: Object.fromEntries(accounts.filter((account): account is ProviderAccountConfig & { route: "claude-api" } => account.route === "claude-api").map(account => [account.id, account.credentialFile])) });
  const adapters = new Map<string, AgentAdapter>(), catalogs = new Map<string, ModelCatalog>();
  const generations = new Map<string, AbortController>(), credentialPins = new Map<string, string>();
  const checking = new Map<string, Promise<void>>(), fingerprintKey = randomBytes(32);
  const fingerprint = (key: string) => createHmac("sha256", fingerprintKey).update(key).digest("hex");
  const retire = (id: string) => { generations.get(id)?.abort(); generations.delete(id); adapters.delete(id); catalogs.delete(id); };
  const failures = new Set<string>();
  const currentModels = (account: ProviderAccountConfig, value: ModelCatalog | undefined): boolean => account.route === "claude-api"
    && account.prices.observedAt <= now() && account.prices.observedAt >= now() - 30 * 86_400_000
    && value !== undefined && value.observedAt <= now() && value.observedAt >= now() - 86_400_000;
  const qualified = (): RuntimeQualification => [...adapters.values()].find(adapter => adapter.qualification.status === "qualified" && adapter.qualification.expiresAt > now())?.qualification
    ?? { status: "unqualified", reason: "No explicitly configured Claude API account is ready." };
  const route: AgentAdapter = { provider: "claude", get qualification() { return qualified(); },
    async run(request, broker) {
      if (shutdown.signal.aborted || accounts.find(account => account.id === request.accountId)?.route !== "claude-api") throw new AgentStoppedError("PROVIDER_ROUTE_UNAVAILABLE");
      const adapter = adapters.get(request.accountId), generation = generations.get(request.accountId);
      if (!adapter || !generation) throw new AgentStoppedError("PROVIDER_ACCOUNT_UNAVAILABLE");
      const task = adapter.run({ ...request, signal: AbortSignal.any([request.signal, shutdown.signal, generation.signal]) }, broker);
      pending.add(task); try { return await task; } finally { pending.delete(task); }
    } };
  async function refresh(account: ProviderAccountConfig, externalSignal: AbortSignal, allowCredentialChange: boolean): Promise<void> {
    if (account.route !== "claude-api" || !options.runtimeArtifact) throw new Error("Provider route is not admitted");
    const generation = new AbortController(), signal = AbortSignal.any([externalSignal, shutdown.signal, generation.signal]); signal.throwIfAborted();
    retire(account.id);
    let pinned: string | undefined, admitting = true;
    const pinnedCredentials: ClaudeApiAdapterOptions["credentials"] = { async withApiKey(id, external, run) {
      if (id !== account.id || !pinned || !admitting && generations.get(id) !== generation) throw new Error("Provider credential generation is unavailable");
      const scopedSignal = AbortSignal.any([external, shutdown.signal, generation.signal]); scopedSignal.throwIfAborted();
      try {
        return await credentials.withApiKey(id, scopedSignal, async key => {
          if (fingerprint(key) !== pinned) throw new Error("Provider credential changed");
          scopedSignal.throwIfAborted(); return run(key);
        });
      } catch (error) {
        generation.abort();
        if (generations.get(id) === generation) { retire(id); failures.add(id); }
        throw error;
      }
    } };
    try {
      // Verify the reviewed compiled artifact before opening a credential or network.
      const adapter = await dependencies.createAdapter({ runtimeArtifact: options.runtimeArtifact, credentials: pinnedCredentials,
        modelCatalog: async accountId => {
          if (accountId !== account.id || shutdown.signal.aborted || generations.get(accountId) !== generation) throw new Error("Provider account revoked");
          const value = catalogs.get(accountId); if (!value) throw new Error("Provider models unavailable"); return value;
        }, maxBudgetUsd: account.maxBudgetUsd, now });
      await credentials.withApiKey(account.id, signal, async key => {
        pinned = fingerprint(key);
        if (!allowCredentialChange && credentialPins.has(account.id) && credentialPins.get(account.id) !== pinned) throw new Error("Check the replacement credential explicitly");
      });
      const modelCatalog = await dependencies.discover({ credentials: pinnedCredentials, accountId: account.id, priceCatalog: account.prices, signal, now });
      if (!currentModels(account, modelCatalog) || !modelCatalog.models.some(model => model.id === account.replyModel && model.available && model.supportsStructuredOutput)) throw new Error("Reply model is unavailable");
      selectClassifierModel(modelCatalog, now());
      await pinnedCredentials.withApiKey(account.id, signal, async () => {}); signal.throwIfAborted();
      generations.set(account.id, generation); credentialPins.set(account.id, pinned!); admitting = false;
      catalogs.set(account.id, modelCatalog); adapters.set(account.id, adapter); failures.delete(account.id);
    } finally { if (admitting) generation.abort(); }
  }
  const check = async (accountId: string, signal: AbortSignal, allowCredentialChange = true) => {
    signal.throwIfAborted();
    if (nativeAccount(accountId)) {
      if (managedFailures.has(accountId)) throw Error("Native subscription account needs recovery.");
      await managedExclusive(accountId, signal, scoped => native!.check(accountId as NativeSubscriptionAccount, scoped)); return;
    }
    if (accounts.some(account => account.id === accountId && account.route === "codex")) {
      await managedOperation(accountId, signal, async (controller, scoped) => { await controller.check(scoped); }); return;
    }
    const existing = checking.get(accountId); if (existing) { await existing; signal.throwIfAborted(); return; }
    const account = accounts.find(account => account.id === accountId);
    if (!account) throw new Error("Unknown provider account");
    const task = refresh(account, signal, allowCredentialChange).catch(() => { failures.add(accountId); retire(accountId); throw new Error("Provider setup could not be verified. Check the selected credential, models, prices and compiled runtime."); });
    pending.add(task); checking.set(accountId, task);
    try { await task; }
    finally { pending.delete(task); checking.delete(accountId); }
  };
  return {
    router: new AgentMixer({ adapters: [route, unqualifiedAdapter("codex")], leases: options.leases, now }),
    accounts() { return accounts.map(account => {
      const provider = account.route === "codex" ? "codex" as const : "claude" as const;
      if (nativeAccount(account.id)) {
        const diagnostic = native!.accounts().find(row => row.id === account.id);
        if (diagnostic) return shutdown.signal.aborted || managedFailures.has(account.id) ? { ...diagnostic, status: "unavailable" as const,
          detail: shutdown.signal.aborted ? "The native subscription host is closed." : "The native subscription process needs recovery.",
          defaultReplyModel: null, classifierModel: null } : diagnostic;
      }
      if (account.route === "codex" && options.managedCodex) {
        const snapshot = managed.get(account.id)?.snapshot();
        const state = managedFailures.has(account.id) ? "recovery-required" as const : shutdown.signal.aborted ? "closed" as const : snapshot?.state ?? "unchecked" as const;
        const details = {
          unchecked: "Check or sign in to this Codex subscription account. Automatic replies still require an admitted response engine.",
          "signed-out": "Sign in with ChatGPT to connect your Codex subscription.",
          "signing-in": "Complete sign-in in your browser, then check the account. Automatic replies remain unavailable.",
          "signed-in": "Codex subscription signed in. The response engine still needs isolation qualification before this account can reply.",
          unavailable: "The Codex account could not be verified. Check the account again after resolving its setup.",
          "recovery-required": "The previous Codex account operation needs process recovery. New operations remain blocked.",
          closed: "The Codex account controller is closed.",
        };
        return { id: account.id, label: account.label, provider, route: account.route, status: "unavailable" as const,
          detail: details[state], defaultReplyModel: null, classifierModel: null,
          managedAccount: { state, generation: snapshot?.accountGeneration ?? 0, modelCount: state === "signed-in" ? snapshot?.models.length ?? 0 : 0,
            pendingLoginId: state === "closed" || state === "recovery-required" ? null : snapshot?.pendingLoginId ?? null } };
      }
      const modelCatalog = catalogs.get(account.id), adapter = adapters.get(account.id);
      const ready = !shutdown.signal.aborted && currentModels(account, modelCatalog)
        && adapter?.qualification.status === "qualified" && adapter.qualification.expiresAt > now();
      return { id: account.id, label: account.label, provider, route: account.route,
        status: ready ? "ready" as const : account.route !== "claude-api" ? "unavailable" as const : "setup-required" as const,
        detail: account.route !== "claude-api" ? "This coding-agent route is not qualified for contact-scoped execution. No API fallback is used."
          : !options.runtimeArtifact ? "Claude API requires a reviewed compiled runtime. Source-mode execution is unavailable."
          : failures.has(account.id) ? "Check the selected credential file, model access and current price catalog."
          : ready ? "Claude API account and models are available. This does not enable message delivery."
          : "Check this explicit Claude API account to verify model access. API usage is billed separately from coding-agent subscriptions.",
        defaultReplyModel: account.route === "claude-api" ? account.replyModel : null,
        classifierModel: ready ? selectClassifierModel(modelCatalog!, now()).id : null };
    }); },
    check,
    startLogin: (id, method, signal) => managedOperation(id, signal, async (controller, scoped) => parseProviderLoginChallenge(await controller.startLogin(method, scoped))),
    cancelLogin: (id, loginId, signal) => managedOperation(id, signal, async (controller, scoped) => { await controller.cancelLogin(loginId, scoped); }),
    logout: (id, signal) => managedOperation(id, signal, async (controller, scoped) => { await controller.logout(scoped); }),
    async runManagedTask(input, broker) {
      let delegated = false;
      try {
        const request = snapshotTaskRequest(input), id = request.accountId;
        const nativeTask = nativeAccount(id) && nativeSubscriptionProvider(id) === request.route.provider && request.route.authentication === "subscription";
        if (managedFailures.has(id) || !nativeTask && (request.route.provider !== "codex" || request.route.authentication !== "subscription"
          || !options.managedCodex || managedFailures.has(id) || !accounts.some(account => account.id === id && account.route === "codex"))
        ) throw new Error("Managed subscription task route is unavailable.");
        return await managedExclusive(id, request.signal, async signal => {
          delegated = true;
          try {
            const controller = managed.get(id);
            let accountSnapshot = controller?.snapshot();
            if (accountSnapshot?.pendingLoginId != null || accountSnapshot?.state === "signing-in") throw new Error("Managed Codex sign-in is pending.");
            if (controller && accountSnapshot && accountSnapshot.state !== "signed-in") accountSnapshot = await controller.check(signal);
            if (accountSnapshot && accountSnapshot.state !== "signed-in") throw new Error("Managed Codex account is not ready.");
            if (accountSnapshot && !accountSnapshot.models.some(model => model.id === request.model.id)) throw new Error("Managed Codex model is unavailable.");
            const authority: AgentTaskAuthority | undefined = accountSnapshot === undefined ? undefined : Object.freeze({ kind: "codex-managed",
              accountGeneration: accountSnapshot.accountGeneration, modelCatalogDigest: managedCatalogDigest(accountSnapshot.models) });
            const handedOff = Object.freeze({ ...request, ...(authority === undefined ? {} : { authority }) });
            if (controller) {
              const snapshot = controller.snapshot();
              if (snapshot.pendingLoginId !== null || snapshot.state === "signing-in") throw new Error("Managed Codex sign-in is pending.");
              if (snapshot.state === "recovery-required") throw new Error("Managed Codex account needs recovery.");
              try {
                const receipt = await controller.close();
                if (receipt.released !== true || receipt.state !== "closed" || controller.snapshot().state !== "closed" || managed.get(id) !== controller)
                  throw new Error("Managed Codex account handoff needs recovery.");
              } catch {
                managedFailures.add(id);
                throw new Error("Managed Codex account handoff needs recovery.");
              }
              managed.delete(id);
            }
            signal.throwIfAborted();
            const task = Object.freeze({ ...handedOff, signal });
            return nativeTask ? await native!.runTask(task, broker, { leases: taskLeaseStore, now }) : await taskRouter.runTask(task, broker);
          } finally {
            if (taskLeases.has(id)) managedFailures.add(id);
            await broker.close();
          }
        });
      } finally { if (!delegated) await broker.close(); }
    },
    async selection(contact, purpose = "respond") {
      if (nativeAccount(contact.accountId) && nativeSubscriptionProvider(contact.accountId) === contact.provider) {
        if (shutdown.signal.aborted || managedFailures.has(contact.accountId)) throw Error("Native subscription account is unavailable.");
        return native!.selection(contact.accountId as NativeSubscriptionAccount, purpose);
      }
      const account = accounts.find(account => account.id === contact.accountId);
      if (!account || account.route !== "claude-api" || contact.provider !== "claude" || shutdown.signal.aborted) throw new Error("The selected coding-agent account is unavailable; no API substitution is permitted.");
      const modelCatalog = catalogs.get(account.id), adapter = adapters.get(account.id);
      if (!currentModels(account, modelCatalog) || adapter?.qualification.status !== "qualified" || adapter.qualification.expiresAt <= now()) {
        await check(account.id, shutdown.signal, false);
      }
      return { qualification: adapters.get(account.id)!.qualification, modelCatalog: catalogs.get(account.id)!, defaultReplyModel: account.replyModel };
    },
    validateAccountChange(previous, next) {
      const id = next.accountId ?? previous.accountId, account = accounts.find(value => value.id === id);
      if (next.accountId !== undefined && ((!account && id !== previous.accountId) || account && (account.route === "codex" ? "codex" : "claude") !== next.provider)) throw new Error("Choose a configured account for this provider.");
      if (account?.route === "claude-api" && next.accountId === undefined && previous.provider !== next.provider) throw new Error("Choose the Claude API account explicitly; changing provider alone does not authorize API billing.");
    },
    close() {
      if (closing) return closing;
      const task = Promise.resolve().then(async () => {
        await Promise.allSettled([...pending]);
        const controllers = [...managed.values()];
        const receipts = await Promise.allSettled(controllers.map(async controller => {
          const receipt = await controller.close();
          return receipt.released === true && receipt.state === "closed" && controller.snapshot().state === "closed";
        }));
        const nativeClosed = await Promise.allSettled(native ? [native.close()] : []);
        if (taskLeases.size || nativeClosed.some(result => result.status === "rejected") || receipts.some(result => result.status === "rejected" || result.value !== true))
          throw new Error("Managed Codex account process recovery is required.");
      });
      closing = task;
      void task.catch(() => { if (closing === task) closing = undefined; });
      // Publish before synchronous cancellation callbacks can call close again.
      shutdown.abort(); return closing;
    },
  };
}

/** Keep queued handoff identity fixed while the old controller joins. Runtime
 * still performs complete task validation before its single lease acquisition. */
function snapshotTaskRequest(input: AgentTaskRequest): AgentTaskRequest {
  function copy<T extends object>(value: T, keys: readonly string[]): T {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error("MANAGED_TASK_REQUEST_INVALID");
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw Error("MANAGED_TASK_REQUEST_INVALID");
    const result: Record<string, unknown> = {};
    for (const key of keys) { const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !("value" in field)) throw Error("MANAGED_TASK_REQUEST_INVALID"); result[key] = field.value;
    }
    return Object.freeze(result) as T;
  }
  const value = copy(input, ["route", "accountId", "workspaceId", "runId", "profile", "model", "purpose", "prompt", "limits", "signal"]);
  if (!(value.signal instanceof AbortSignal)) throw Error("MANAGED_TASK_SIGNAL_INVALID");
  return Object.freeze({ ...value, route: copy(value.route, ["id", "provider", "authentication"]), profile: copy(value.profile, ["id", "version", "digest"]),
    model: copy(value.model, ["id", "reasoningEffort", "serviceTier"]), limits: copy(value.limits, ["maxRunMs", "maxCleanupMs", "maxOutputBytes"]) });
}
