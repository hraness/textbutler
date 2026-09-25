import { createHash } from "node:crypto";
import type { AccountLease, AgentTaskAdapter, AgentTaskExecutionRequest, TaskRuntimeQualification } from "@hraness/agentmixer";
import type { ProviderAccountDiagnostic } from "../../control/src/index.ts";
import { contactCapabilityIdentity, type ButlerPurpose } from "./contact-capabilities.ts";
import type { XcbHostConfig, XcbProvider } from "./host-config.ts";
import { createNativeSubscriptionHost, nativeSubscriptionAccount, nativeSubscriptionRoute, type NativeSubscriptionAccount, type NativeSubscriptionHost } from "./native-subscription.ts";
import { createNativeTaskAdapter, type NativeTaskController } from "./native-task.ts";
import { bundledXcbIntegrationAdmission, validXcbIntegrationAdmission, type XcbIntegrationAdmission } from "./xcb-integration.ts";
import { createXcbClient, parseXcbJson, XcbCapabilitiesError, XcbNotStarted, type XcbAccount, type XcbCapabilities, type XcbCapabilityFailure, type XcbClient, type XcbResult } from "./xcb-client.ts";

const sha = (input: unknown): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const localId = (provider: XcbProvider): NativeSubscriptionAccount => nativeSubscriptionAccount(provider);
const LABELS: Readonly<Record<XcbProvider, string>> = Object.freeze({ claude: "Claude Code via XCB", codex: "Codex via XCB", devin: "Devin via XCB" });
const controls = Object.freeze({ noCommandTools: true, exactToolInventory: true, workspaceReadIsolation: true,
  workspaceWriteIsolation: true, isolatedConfiguration: true, authOutsideWorkspace: true, hostBrokerOnly: true } as const);
const CAPABILITY_FAILURE_DETAILS: Readonly<Record<XcbCapabilityFailure, string>> = Object.freeze({
  "executable-changed": "XCB's executable no longer matches its pinned file. Review the configured installation before checking again.",
  "executable-unsafe": "XCB's executable has unsupported ownership, permissions or file properties. Review the configured installation.",
  "executable-unavailable": "XCB's configured executable could not be read and verified. Check that the installation is accessible to TextButler.",
  "not-started": "XCB's capability process could not start. Check that the configured executable can run from TextButler.",
  "timeout": "XCB's capability check exceeded its 90-second deadline. Check XCB's application API before trying again.",
  "io": "XCB's capability process had an input or output error. Check XCB's application API before trying again.",
  "exit": "XCB's capability process exited unsuccessfully. Check XCB's application API before trying again.",
  "output-limit": "XCB's capability output exceeded TextButler's limits. Check that the installed application API is compatible.",
  "invalid-json": "XCB's capability response was not valid bounded UTF-8 JSON. Check that the installed application API is compatible.",
  "invalid-schema": "XCB's capability response did not match the required application API schema. Check that the installed versions are compatible.",
});
const UNKNOWN_CAPABILITY_FAILURE = "XCB could not be verified. Check its pinned executable and application API, then check this account again.";

/** Each XCB invocation owns its provider descendants. A signal or wrapper exit
 * never becomes stop evidence: every started invocation must return XCB's
 * explicit settled envelope. Uncertainty leaves Textbutler's lease held. */
export function createXcbTaskController(request: AgentTaskExecutionRequest, config: XcbHostConfig,
  account: XcbHostConfig["accounts"][number], client: XcbClient, now: () => number = Date.now): NativeTaskController {
  const cancellation = new AbortController(), receipts: XcbResult[] = [], seen = new Set<string>();
  let pending: Promise<unknown> | undefined, stopped = false, uncertain = false;
  return {
    next(input) {
      if (stopped || pending || uncertain) return Promise.reject(Error("XCB_INVOCATION_UNAVAILABLE"));
      const signal = AbortSignal.any([input.signal, cancellation.signal]);
      const work = async () => {
        signal.throwIfAborted();
        const remaining = request.executionDeadlineUnixMs - now();
        if (remaining < 1000) throw Error("XCB_DEADLINE");
        let result: XcbResult;
        try {
          result = await client.generate({ version: 1, account: account.accountId, model: account.model,
            prompt: input.prompt, timeoutMs: Math.min(120_000, remaining), maxOutputBytes: 262_144 }, signal);
        } catch (error) { if (!(error instanceof XcbNotStarted)) uncertain = true; throw error; }
        const joined = result.status === "completed" ? result.outcome.joined && result.outcome.effects === "none"
          : result.code !== "custody_unproven" && result.joined === true && result.effects === "none";
        if (!joined || result.requestId !== undefined && seen.has(result.requestId)) { uncertain = true; throw Error("XCB_CUSTODY_UNPROVEN"); }
        if (result.requestId !== undefined) seen.add(result.requestId);
        receipts.push(result);
        signal.throwIfAborted();
        if (result.status !== "completed") throw Error(`XCB_${result.code.toUpperCase()}`);
        // The native task adapter validates this data against the exact contact
        // operation inventory before any host operation can execute.
        try { return parseXcbJson(result.text); } catch { throw Error("XCB_REPLY_JSON_INVALID"); }
      };
      pending = Promise.resolve().then(work).finally(() => { pending = undefined; });
      return pending;
    },
    async stopAndJoin(stopRequest) {
      stopped = true; cancellation.abort(); await pending?.catch(() => {});
      if (uncertain) throw Error("XCB_CUSTODY_UNPROVEN");
      const binding = { route: stopRequest.route, accountId: stopRequest.accountId, workspaceId: stopRequest.workspaceId,
        runId: stopRequest.runId, profile: stopRequest.profile, model: stopRequest.model, runtime: stopRequest.runtime,
        accountLease: stopRequest.accountLease, ...(stopRequest.authority === undefined ? {} : { authority: stopRequest.authority }) };
      return { ...binding, processStopped: true, controllersStopped: true, joined: true, stoppedAtUnixMs: now(),
        proofDigest: sha({ binding, xcb: config.sha256, receipts, noInvocation: receipts.length === 0 }) };
    },
  };
}

/** The only production launcher is XCB's versioned application API. Configuration
 * binds an existing account, model and executable; it supplies no credentials,
 * qualification flags, native tools, hooks, or contact filesystem roots. */
export async function createXcbSubscriptionHost(config: XcbHostConfig,
  dependencies: { client?: XcbClient; now?: () => number; integration?: XcbIntegrationAdmission } = {}): Promise<NativeSubscriptionHost> {
  const client = dependencies.client ?? createXcbClient(config), now = dependencies.now ?? Date.now;
  const integration = dependencies.integration ?? bundledXcbIntegrationAdmission();
  let capabilities: XcbCapabilities | undefined, failure: string | undefined;
  let refreshedAt = -Infinity, refreshing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const observed = (account: XcbHostConfig["accounts"][number]): XcbAccount | undefined =>
    capabilities?.accounts.find(a => a.id === account.accountId && a.provider === account.provider);
  function admitted(account: XcbHostConfig["accounts"][number]): boolean {
    const a = observed(account), q = a?.qualification, model = a?.models.find(m => m.key === account.model);
    return validXcbIntegrationAdmission(integration) && !failure && capabilities?.supported === true && a?.available === true && a.enabled && !a.busy && a.connected && a.runtimeAdmitted
      && q !== undefined && q.runtimeDigest === config.sha256 && q.expiresAt >= now() + 135_000
      && model !== undefined && model.observedAtMs <= now() && model.observedAtMs >= now() - 86_400_000;
  }
  async function refresh(signal: AbortSignal): Promise<void> {
    const task = refreshing ??= (async () => {
      try { capabilities = await client.capabilities(AbortSignal.any([signal, shutdown.signal])); failure = undefined; }
      catch (error) { capabilities = undefined; failure = error instanceof XcbCapabilitiesError && Object.hasOwn(CAPABILITY_FAILURE_DETAILS, error.code)
        ? CAPABILITY_FAILURE_DETAILS[error.code] : UNKNOWN_CAPABILITY_FAILURE; }
      finally { refreshedAt = now(); }
    })();
    try { await task; } finally { if (refreshing === task) refreshing = undefined; }
    signal.throwIfAborted(); shutdown.signal.throwIfAborted();
  }
  await refresh(shutdown.signal);
  const adapters: AgentTaskAdapter[] = config.accounts.flatMap(account => (["classify", "respond"] as const).map(purpose => {
    const route = Object.freeze({ id: `xcb-${account.provider}-${purpose}`, provider: account.provider, authentication: "subscription" as const });
    const running = new WeakMap<AccountLease, AgentTaskAdapter>();
    const qualification = (): TaskRuntimeQualification => {
      const q = observed(account)?.qualification;
      return admitted(account) && q ? { status: "qualified", route, profile: contactCapabilityIdentity(purpose),
        runtimeVersion: q.runtimeVersion, runtimeDigest: q.runtimeDigest,
        evidenceDigest: sha({ xcbEvidence: q.evidenceDigest, composition: integration!.evidenceDigest, sources: integration!.sourceDigest,
          profile: integration!.profiles[purpose] }), expiresAt: q.expiresAt, controls }
        : { status: "unqualified", reason: "XCB needs current application qualification for this exact executable, provider, and account." };
    };
    const adapter: AgentTaskAdapter = {
      route,
      get runtime() { return { version: observed(account)?.qualification?.runtimeVersion ?? "xcb-application-v1", digest: config.sha256 }; },
      get qualification() { return qualification(); },
      async run(request, broker) {
        if (request.model.id !== account.model || request.model.reasoningEffort !== null || request.model.serviceTier !== null) throw Error("XCB_MODEL_BINDING_CHANGED");
        const delegate = createNativeTaskAdapter({ route, runtime: adapter.runtime, qualification: qualification(), now,
          createController: request => createXcbTaskController(request, config, account, client, now) });
        running.set(request.accountLease, delegate);
        return await delegate.run(request, broker);
      },
      async stop(request, reason) {
        const delegate = running.get(request.accountLease);
        if (!delegate) throw Error("XCB_CUSTODY_UNPROVEN");
        const receipt = await delegate.stop(request, reason); running.delete(request.accountLease); return receipt;
      },
    };
    return adapter;
  }));
  const accounts = (): readonly ProviderAccountDiagnostic[] => config.accounts.map(account => {
    const a = observed(account), ready = admitted(account);
    return { id: localId(account.provider), provider: account.provider, route: nativeSubscriptionRoute(account.provider),
      label: LABELS[account.provider],
      status: ready ? "ready" : a && !a.connected ? "setup-required" : "unavailable",
      detail: ready ? "XCB subscription connection is ready. Textbutler controls contact access and reply approval."
        : !validXcbIntegrationAdmission(integration) ? "Install a Textbutler bundle with reviewed XCB contact-profile evidence. Source integrity alone does not admit AI replies."
          : failure ? failure
          : !a ? "The configured XCB account was not found. Check the account binding in setup."
            : a.busy ? "This XCB account is busy or needs custody recovery."
              : !a.connected ? "Sign in to this account in XCB, then check it here again."
                : "XCB's application route, model, or exact runtime qualification is unavailable. Check XCB before enabling replies.",
      defaultReplyModel: ready ? account.model : null, classifierModel: ready ? account.model : null };
  });
  const host = createNativeSubscriptionHost({ adapters, accounts, now,
    async beforeSelection(_id, _purpose, signal) { if (now() - refreshedAt >= 30_000) await refresh(signal); },
    async check(id, signal) { if (!config.accounts.some(account => localId(account.provider) === id)) throw Error("XCB_ACCOUNT_UNBOUND"); await refresh(signal); },
    async selection(id, purpose: ButlerPurpose) {
      const account = config.accounts.find(account => localId(account.provider) === id);
      if (!account || !admitted(account)) throw Error("XCB_APPLICATION_UNAVAILABLE");
      const model = observed(account)!.models.find(model => model.key === account.model)!;
      return { route: adapters.find(adapter => adapter.route.id === `xcb-${account.provider}-${purpose}`)!.route,
        defaultReplyModel: account.model, modelCatalog: { provider: account.provider, observedAt: model.observedAtMs,
          models: [{ id: account.model, available: true, supportsStructuredOutput: true, classifierEligible: true,
            inputUsdPerMillion: 0, outputUsdPerMillion: 0 }] } };
    },
    async close() { shutdown.abort(); },
  });
  // Readiness survives daemon restart and always-reply mode without requiring
  // a manual check. This validates cached evidence only; it runs no model.
  for (const account of config.accounts) for (const purpose of ["classify", "respond"] as const) {
    try { await host.selection(localId(account.provider), purpose); } catch { /* Keep the specific unavailable diagnostic. */ }
  }
  return host;
}
