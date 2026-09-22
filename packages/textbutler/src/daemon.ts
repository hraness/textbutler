import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { attachControlSocket, requestControlSocket } from "@hraness/local-custody/control-socket";
import { assertOwnedPath, ensurePrivateDirectory, readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { TextbutlerControlService, TEXTBUTLER_CONTROL_PROTOCOL, parseControlRequest } from "./control-service.ts";
import { parseControlResponse, type ControlResponse } from "../../control/src/index.ts";
import type { Settings } from "./config.ts";
import { loadOwnerExtensions, type LoadedExtensions } from "./plugins.ts";
import { loadHostConfig } from "./host-config.ts";
import { createGhostgetOwnerReadPort } from "./ghostget-owner-read.ts";
import type { OwnerConversationReadPort } from "./enrollment.ts";
import { DaemonCustody } from "./daemon-custody.ts";
import { createProviderHost, type ManagedCodexAccountFactory } from "./provider-host.ts";
import type { NativeSubscriptionHost } from "./native-subscription.ts";
import { createXcbSubscriptionHost } from "./xcb-host.ts";
import type { ClaudeApiAdapterOptions } from "@hraness/agentmixer";
import { createGhostgetAutomationProcess } from "./ghostget-automation-process.ts";
import { createAutomationOwnerPort } from "./automation-owner.ts";
import { createDaemonReplyLoop } from "./reply-loop.ts";
import { createFastDriver } from "./fast-driver.ts";
import { bundledXcbIntegrationAdmission, validXcbIntegrationAdmission } from "./xcb-integration.ts";

export const MAX_CONTROL_FRAME_BYTES = 1_048_576;
const MAX_CONNECTIONS = 16;
const MAX_REQUESTS_PER_CONNECTION = 4;
const SOCKET_TIMEOUT_MS = 5_000;
export function defaultDataDirectory(): string { return join(homedir(), "Library", "Application Support", "Textbutler"); }
export function daemonSocketPath(dataDir = defaultDataDirectory()): string {
  const path = join(resolve(dataDir), "daemon.sock");
  if (Buffer.byteLength(path) > 100) throw new Error("Textbutler Unix socket path exceeds its platform limit");
  return path;
}
function unavailable(message: string): ControlResponse { return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: false, code: "unavailable", message }; }
export interface RunningDaemon { readonly socketPath: string; readonly service: TextbutlerControlService; readonly extensions: LoadedExtensions; close(): Promise<void> }

/** Foreground owner daemon. Explicit configured messaging accounts may start a
 * Ghostget control process; only enabled contacts with grants can run replies. */
export async function startDaemon(options: { dataDir?: string; initialSettings?: Settings; enrollment?: OwnerConversationReadPort;
  providerArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"]; managedCodex?: ManagedCodexAccountFactory;
  nativeSubscriptions?: NativeSubscriptionHost } = {}): Promise<RunningDaemon> {
  const dataDir = await ensurePrivateDirectory(options.dataDir ?? defaultDataDirectory());
  const path = daemonSocketPath(dataDir);
  // SQLite retains an OS lock for this lifetime, with committed socket custody.
  // Only exact recorded sockets from a proved-dead owner can be recovered.
  const custody = await DaemonCustody.acquire(dataDir, path);
  let service: TextbutlerControlService | undefined;
  let extensions: LoadedExtensions | undefined;
  let messaging: Awaited<ReturnType<typeof createGhostgetAutomationProcess>> | undefined;
  let replyLoop: Awaited<ReturnType<typeof createDaemonReplyLoop>> | undefined;
  let nativeSubscriptions: NativeSubscriptionHost | undefined;
  const server = createServer();
  const transport = attachControlSocket(server, {
    maximumFrameBytes: MAX_CONTROL_FRAME_BYTES,
    maximumConnections: MAX_CONNECTIONS,
    maximumRequestsPerConnection: MAX_REQUESTS_PER_CONNECTION,
    headerTimeoutMs: SOCKET_TIMEOUT_MS,
    idleTimeoutMs: SOCKET_TIMEOUT_MS,
    onRequest: (value) => service === undefined
      ? unavailable("The control daemon is not ready or is at capacity.")
      : service.request(value),
    failureResponse: (reason) => reason === "invalid-request"
      ? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: false, code: "invalid-request", message: "A bounded UTF-8 JSON control request is required." }
      : unavailable(reason === "limit"
          ? "The control frame or request queue exceeds its limit."
          : reason === "response-limit"
            ? "The control response exceeds its byte limit."
            : "The control daemon is not ready or is at capacity."),
  });
  try {
    await custody.publish(server);
    await assertOwnedPath(path, { kind: "socket", exactMode: 0o600 });
    const host = await loadHostConfig(dataDir);
    // Explicit trusted injection wins. Configured XCB never discovers another
    // account or falls back to a provider API.
    nativeSubscriptions = options.nativeSubscriptions ?? (host.xcb === undefined ? undefined : await createXcbSubscriptionHost(host.xcb));
    let messagingUnavailable = false;
    if (host.ghostget?.automationAccounts) {
      try { messaging = await createGhostgetAutomationProcess({ executable: host.ghostget.executable, providers: host.ghostget.automationAccounts, custodyDirectory: join(dataDir, "state"),
        ...(host.ghostget.runtimeExecutable === undefined ? {} : { runtimeExecutable: host.ghostget.runtimeExecutable }), ...(host.ghostget.stateHome === undefined ? {} : { stateHome: host.ghostget.stateHome }) }); }
      catch { messagingUnavailable = true; }
    }
    const automation = messaging && host.ghostget?.automationAccounts ? createAutomationOwnerPort({ client: messaging.client, providers: host.ghostget.automationAccounts.map(account => account.provider) }) : undefined;
    const enrollment = options.enrollment ?? (host.ghostget === undefined || host.ghostget.automationAccounts ? undefined : createGhostgetOwnerReadPort({ ...host.ghostget, custodyDirectory: join(dataDir, "state") }));
    extensions = await loadOwnerExtensions(dataDir);
    service = await TextbutlerControlService.open({ dataDir, ...(options.initialSettings === undefined ? {} : { initialSettings: options.initialSettings }), ...(enrollment === undefined ? {} : { enrollment }), ...(automation === undefined ? {} : { automation }), recoverRuns: true,
      ...(messaging === undefined ? {} : { client: messaging.client }), hooks: extensions.hooks,
      providers: leases => createProviderHost({ dataDir, config: host, leases, ...(options.providerArtifact === undefined ? {} : { runtimeArtifact: options.providerArtifact }),
        ...(options.managedCodex === undefined ? {} : { managedCodex: options.managedCodex }),
        ...(nativeSubscriptions === undefined ? {} : { nativeSubscriptions }) }) });
    await service.recoverInactiveGrants();
    let habitat: Parameters<typeof createDaemonReplyLoop>[0]["habitat"];
    if (host.habitat?.enabled) {
      if (!validXcbIntegrationAdmission(bundledXcbIntegrationAdmission())) throw Error("Habitat execution requires a reviewed, admitted Textbutler bundle");
      const config = host.habitat;
      const driver = createFastDriver(config.driver, { journal: service.runJournal(), ...(config.driver.kind === "gateway" ? { credential: async () => {
        const directory = join(dataDir, "state", "provider-credentials");
        await assertOwnedPath(directory, { kind: "directory", canonical: true, ownerOnly: true });
        return new TextDecoder("utf-8", { fatal: true }).decode(await readOwnedFileStable(join(directory, (config.driver as Extract<typeof config.driver, { kind: "gateway" }>).credentialFile), 8192)).trim();
      } } : {}) });
      habitat = { config, driver };
      service.setHabitatConfig(config);
    }
    if (messaging) replyLoop = await createDaemonReplyLoop({ service, client: messaging.client, hooks: extensions.hooks,
      ...(habitat === undefined ? {} : { habitat }), onStatus: value => service!.setRuntimeStatus(value) });
    else if (messagingUnavailable) service.setRuntimeStatus({ state: "unavailable", detail: "Ghostget automation setup or previous process custody needs owner attention. No automatic replies are running." });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const cleanup of [
      async () => { await transport.close(); },
      async () => replyLoop?.close(), async () => messaging?.close(), async () => service?.close(),
      async () => { if (service === undefined) await nativeSubscriptions?.close(); }, async () => custody.close(),
    ]) { try { await cleanup(); } catch (failure) { failures.push(failure); } }
    if (failures.length > 1) throw new AggregateError(failures, "Daemon startup and cleanup require attention");
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return { socketPath: path, service, extensions: extensions!, close() {
    closePromise ??= (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => { await transport.close(); },
        async () => replyLoop?.close(), async () => messaging?.close(), async () => service!.close(), async () => custody.close(),
      ]) { try { await cleanup(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, "Daemon cleanup requires attention");
    })();
    return closePromise;
  } };
}

/** Owner CLI control client; the native Rust host independently checks getpeereid. */
export async function requestDaemon(options: { dataDir?: string; request: unknown; timeoutMs?: number }): Promise<ControlResponse> {
  const request = parseControlRequest(options.request);
  const dataDir = resolve(options.dataDir ?? defaultDataDirectory());
  const timeoutMs = options.timeoutMs ?? 4_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5_000) throw new Error("Invalid control timeout");
  return requestControlSocket({
    socketPath: daemonSocketPath(dataDir), request,
    maximumRequestBytes: MAX_CONTROL_FRAME_BYTES, maximumResponseBytes: MAX_CONTROL_FRAME_BYTES,
    timeoutMs, parseResponse: parseControlResponse,
  });
}
