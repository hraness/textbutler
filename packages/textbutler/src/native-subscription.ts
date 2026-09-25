import { AgentMixer, type AccountLeaseStore, type AgentTaskAdapter, type AgentTaskRequest, type AgentTaskResult, type CapabilityBroker } from "@hraness/agentmixer";
import type { ProviderAccountDiagnostic } from "../../control/src/index.ts";
import { contactCapabilityIdentity, type ButlerPurpose } from "./contact-capabilities.ts";
import { selectButlerModel, type ProviderSelection } from "./routed-agent.ts";

export type NativeSubscriptionAccount = "native-codex" | "native-claude-code" | "native-devin";
export type NativeSubscriptionSelection = Extract<ProviderSelection, { kind: "managed" }>;
export type NativeSubscriptionChoice = Pick<NativeSubscriptionSelection, "route" | "modelCatalog" | "defaultReplyModel">;
export type NativeSubscriptionAdmission = Readonly<{ leases: AccountLeaseStore; now(): number }>;

/** Trusted compiled-host capability, never owner JSON, credentials, or a plugin.
 * Qualification is independent evidence for the exact installed adapter, not
 * authority created by account sign-in, configuration, or this factory. */
export interface NativeSubscriptionHost {
  accounts(): readonly ProviderAccountDiagnostic[];
  check(accountId: NativeSubscriptionAccount, signal: AbortSignal): Promise<void>;
  selection(accountId: NativeSubscriptionAccount, purpose: ButlerPurpose): Promise<NativeSubscriptionSelection>;
  runTask(request: AgentTaskRequest, broker: CapabilityBroker, admission: NativeSubscriptionAdmission): Promise<AgentTaskResult>;
  close(): Promise<void>;
}
const hosts = new WeakSet<object>();
export function assertNativeSubscriptionHost(value: NativeSubscriptionHost): void {
  if (!hosts.has(value)) throw Error("NATIVE_SUBSCRIPTION_HOST_REQUIRED");
}
export const NATIVE_SUBSCRIPTION_PROVIDERS = ["claude", "codex", "devin"] as const;
export type NativeSubscriptionProvider = (typeof NATIVE_SUBSCRIPTION_PROVIDERS)[number];
export function nativeSubscriptionProvider(accountId: string): NativeSubscriptionProvider | null {
  return accountId === "native-codex" ? "codex" : accountId === "native-claude-code" ? "claude" : accountId === "native-devin" ? "devin" : null;
}
export function nativeSubscriptionAccount(provider: NativeSubscriptionProvider): NativeSubscriptionAccount {
  return provider === "claude" ? "native-claude-code" : provider === "codex" ? "native-codex" : "native-devin";
}
/** The owner-visible route name for each subscription provider's coding agent. */
export function nativeSubscriptionRoute(provider: NativeSubscriptionProvider): "claude-code" | "codex" | "devin" {
  return provider === "claude" ? "claude-code" : provider;
}
function account(value: string): NativeSubscriptionAccount {
  if (nativeSubscriptionProvider(value) === null) throw Error("NATIVE_SUBSCRIPTION_ACCOUNT_INVALID");
  return value as NativeSubscriptionAccount;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const field of Object.values(value)) freeze(field); Object.freeze(value); }
  return value;
}

/** The integration supplies native adapters and account observations. Execution
 * always passes through AgentMixer with the daemon's actual shared lease store.
 * No default process, inherited configuration, API fallback, or credential
 * discovery is installed. A matching receipt is not live qualification. */
export function createNativeSubscriptionHost(options: Readonly<{
  adapters: readonly AgentTaskAdapter[];
  accounts(): readonly ProviderAccountDiagnostic[];
  check(accountId: NativeSubscriptionAccount, signal: AbortSignal): Promise<void>;
  /** Optional metadata refresh; it grants no qualification or task authority. */
  beforeSelection?(accountId: NativeSubscriptionAccount, purpose: ButlerPurpose, signal: AbortSignal): Promise<void>;
  selection(accountId: NativeSubscriptionAccount, purpose: ButlerPurpose): Promise<NativeSubscriptionChoice>;
  close(): Promise<void>;
  now?: () => number;
}>): NativeSubscriptionHost {
  const adapters = Object.freeze([...options.adapters]), now = options.now ?? Date.now;
  if (adapters.length > NATIVE_SUBSCRIPTION_PROVIDERS.length * 2 || new Set(adapters.map(adapter => adapter.route.id)).size !== adapters.length
    || adapters.some(adapter => adapter.route.authentication !== "subscription" || !(NATIVE_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(adapter.route.provider)))
    throw Error("NATIVE_SUBSCRIPTION_ADAPTER_INVALID");
  const observe = options.accounts.bind(options), check = options.check.bind(options), choose = options.selection.bind(options), close = options.close.bind(options);
  const ready = new Map<string, NativeSubscriptionSelection>(), pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController(); let closing: Promise<void> | undefined;
  const active = () => { shutdown.signal.throwIfAborted(); };
  async function select(id: NativeSubscriptionAccount, purpose: ButlerPurpose): Promise<NativeSubscriptionSelection> {
    account(id); active();
    if (purpose !== "classify" && purpose !== "respond") throw Error("NATIVE_SUBSCRIPTION_PURPOSE_INVALID");
    await options.beforeSelection?.(id, purpose, shutdown.signal); active();
    const observed = observe().find(row => row.id === id);
    if (!observed || observed.provider !== nativeSubscriptionProvider(id) || observed.route !== nativeSubscriptionRoute(nativeSubscriptionProvider(id)!)
      || observed.status !== "ready") throw Error("NATIVE_SUBSCRIPTION_ACCOUNT_UNAVAILABLE");
    const choice = await choose(id, purpose); active();
    const adapter = adapters.find(candidate => candidate.route.id === choice.route.id);
    if (!adapter || choice.route.provider !== nativeSubscriptionProvider(id) || !same(adapter.route, choice.route)
      || choice.modelCatalog.models.length > 256) throw Error("NATIVE_SUBSCRIPTION_ROUTE_UNAVAILABLE");
    const selection = freeze(structuredClone({ ...choice, kind: "managed" as const, qualification: adapter.qualification }));
    const model = selectButlerModel(selection, { provider: nativeSubscriptionProvider(id)!, classifierModel: null, replyModel: null }, purpose, now(), true);
    if (selection.qualification.status !== "qualified" || selection.qualification.runtimeVersion !== adapter.runtime.version
      || selection.qualification.runtimeDigest !== adapter.runtime.digest || !model) throw Error("NATIVE_SUBSCRIPTION_RUNTIME_MISMATCH");
    ready.set(`${id}:${purpose}`, selection); return selection;
  }
  function track<T>(work: () => Promise<T>): Promise<T> {
    active(); const task = Promise.resolve().then(work); pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  const host: NativeSubscriptionHost = Object.freeze<NativeSubscriptionHost>({
    accounts() {
      const rows = observe();
      if (rows.length > NATIVE_SUBSCRIPTION_PROVIDERS.length || new Set(rows.map(row => row.id)).size !== rows.length) throw Error("NATIVE_SUBSCRIPTION_ACCOUNTS_INVALID");
      return Object.freeze(rows.map(row => {
        const id = account(row.id), provider = nativeSubscriptionProvider(id)!;
        if (row.provider !== provider || row.route !== nativeSubscriptionRoute(provider)) throw Error("NATIVE_SUBSCRIPTION_ACCOUNT_BINDING_INVALID");
        let qualified = !shutdown.signal.aborted;
        for (const purpose of ["classify", "respond"] as const) {
          const selection = ready.get(`${id}:${purpose}`), adapter = adapters.find(candidate => candidate.route.id === selection?.route.id);
          try {
            if (!selection || !adapter || !same(adapter.qualification, selection.qualification)) throw Error("NATIVE_SUBSCRIPTION_UNCHECKED");
            selectButlerModel(selection, { provider, classifierModel: null, replyModel: null }, purpose, now(), true);
          } catch { qualified = false; }
        }
        return freeze(structuredClone(row.status === "ready" && !qualified ? { ...row, status: "unavailable" as const,
          detail: "The subscription account needs current classification and reply qualification before it can reply.", defaultReplyModel: null, classifierModel: null } : row));
      }));
    },
    check(id, signal) {
      account(id); return track(async () => {
        const scoped = AbortSignal.any([signal, shutdown.signal]); scoped.throwIfAborted();
        ready.delete(`${id}:classify`); ready.delete(`${id}:respond`);
        await check(id, scoped); scoped.throwIfAborted();
        // Account authentication may succeed while execution remains unavailable.
        for (const purpose of ["classify", "respond"] as const) { try { await select(id, purpose); } catch {} }
        scoped.throwIfAborted();
      });
    },
    selection: (id, purpose) => track(() => select(id, purpose)),
    async runTask(input, broker, admission) {
      try { return await track(async () => {
        try {
          const id = account(input.accountId), purpose = input.purpose;
          if (purpose !== "classify" && purpose !== "respond" || input.route.provider !== nativeSubscriptionProvider(id)
            || input.route.authentication !== "subscription" || !same(input.profile, contactCapabilityIdentity(purpose)))
            throw Error("NATIVE_SUBSCRIPTION_TASK_BINDING_INVALID");
          const selection = await select(id, purpose); active(); input.signal.throwIfAborted();
          if (!same(input.route, selection.route)) throw Error("NATIVE_SUBSCRIPTION_TASK_ROUTE_CHANGED");
          selectButlerModel(selection, { provider: input.route.provider, classifierModel: purpose === "classify" ? input.model.id : null,
            replyModel: purpose === "respond" ? input.model.id : null }, purpose, admission.now(), true);
          const router = new AgentMixer({ adapters: [], taskAdapters: adapters, leases: admission.leases, now: admission.now });
          return await router.runTask({ ...input, signal: AbortSignal.any([input.signal, shutdown.signal]) }, broker);
        } finally { await broker.close(); }
      }); } finally { await broker.close(); }
    },
    close() {
      if (closing) return closing;
      const task = Promise.resolve().then(async () => { await Promise.allSettled([...pending]); await close(); });
      closing = task; shutdown.abort(); ready.clear();
      void task.catch(() => { if (closing === task) closing = undefined; }); return task;
    },
  });
  hosts.add(host); return host;
}
