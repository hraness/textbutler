import { createServer, connect, type Socket } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { TextbutlerControlService, TEXTBUTLER_CONTROL_PROTOCOL, ensurePrivateDirectory, parseControlRequest } from "./control-service.ts";
import { parseControlResponse, type ControlResponse } from "../../control/src/index.ts";
import type { Settings } from "./config.ts";
import { loadOwnerExtensions, type LoadedExtensions } from "./plugins.ts";
import { loadHostConfig } from "./host-config.ts";
import { createGhostgetOwnerReadPort } from "./ghostget-owner-read.ts";
import type { OwnerConversationReadPort } from "./enrollment.ts";
import { DaemonCustody } from "./daemon-custody.ts";
import { createProviderHost, type ManagedCodexAccountFactory } from "./provider-host.ts";
import type { ClaudeApiAdapterOptions } from "@hraness/agentmixer";
import { createGhostgetAutomationProcess } from "./ghostget-automation-process.ts";
import { createAutomationOwnerPort } from "./automation-owner.ts";
import { createDaemonReplyLoop } from "./reply-loop.ts";

export const MAX_CONTROL_FRAME_BYTES = 1_048_576;
const MAX_CONNECTIONS = 16;
const MAX_PENDING_REQUESTS = 16;
const SOCKET_TIMEOUT_MS = 5_000;
export function defaultDataDirectory(): string { return join(homedir(), "Library", "Application Support", "Textbutler"); }
export function daemonSocketPath(dataDir = defaultDataDirectory()): string {
  const path = join(resolve(dataDir), "daemon.sock");
  if (Buffer.byteLength(path) > 100) throw new Error("Textbutler Unix socket path exceeds its platform limit");
  return path;
}
function unavailable(message: string): ControlResponse { return { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: false, code: "unavailable", message }; }
function encode(response: ControlResponse): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
  if (bytes.length <= MAX_CONTROL_FRAME_BYTES) return bytes;
  return Buffer.from(`${JSON.stringify(unavailable("The control response exceeds its byte limit."))}\n`);
}
async function socketIdentity(path: string): Promise<{ dev: number; ino: number }> {
  const info = await lstat(path);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error("Control socket must be owned and private");
  return { dev: info.dev, ino: info.ino };
}
async function inspectDataDirectory(dataDir: string): Promise<void> {
  const info = await lstat(dataDir);
  if (await realpath(dataDir) !== dataDir || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Control directory is not physical, private, and owned");
}
export interface RunningDaemon { readonly socketPath: string; readonly service: TextbutlerControlService; readonly extensions: LoadedExtensions; close(): Promise<void> }

/** Foreground owner daemon. Explicit configured messaging accounts may start a
 * Ghostget control process; only enabled contacts with grants can run replies. */
export async function startDaemon(options: { dataDir?: string; initialSettings?: Settings; enrollment?: OwnerConversationReadPort;
  providerArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"]; managedCodex?: ManagedCodexAccountFactory } = {}): Promise<RunningDaemon> {
  const dataDir = await ensurePrivateDirectory(options.dataDir ?? defaultDataDirectory());
  const path = daemonSocketPath(dataDir);
  // SQLite retains an OS lock for this lifetime, with committed socket custody.
  // Only exact recorded sockets from a proved-dead owner can be recovered.
  const custody = await DaemonCustody.acquire(dataDir, path);
  let service: TextbutlerControlService | undefined;
  let extensions: LoadedExtensions | undefined;
  let messaging: Awaited<ReturnType<typeof createGhostgetAutomationProcess>> | undefined;
  let replyLoop: Awaited<ReturnType<typeof createDaemonReplyLoop>> | undefined;
  let closing = false, pending = 0;
  const clients = new Set<Socket>(), work = new Set<Promise<unknown>>();
  const server = createServer(socket => {
    if (closing || service === undefined || clients.size >= MAX_CONNECTIONS) { socket.end(encode(unavailable("The control daemon is not ready or is at capacity."))); return; }
    clients.add(socket); socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    let buffer = Buffer.alloc(0), queued = 0, chain: Promise<unknown> = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      if (closing) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(10);
        if (newline < 0) { if (buffer.length >= MAX_CONTROL_FRAME_BYTES) socket.destroy(); return; }
        if (newline + 1 > MAX_CONTROL_FRAME_BYTES || newline === 0 || pending >= MAX_PENDING_REQUESTS || queued >= 4) { socket.end(encode(unavailable("The control frame or request queue exceeds its limit."))); socket.pause(); return; }
        const frame = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        pending++; queued++;
        const task = chain.catch(() => {}).then(async () => {
          if (closing || socket.destroyed) return;
          let response: ControlResponse;
          try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); response = await service!.request(value); }
          catch { response = { protocol: TEXTBUTLER_CONTROL_PROTOCOL, ok: false, code: "invalid-request", message: "A bounded UTF-8 JSON control request is required." }; }
          if (!socket.destroyed && !socket.writableEnded) {
            const bytes = encode(response);
            if (socket.writableLength + bytes.length > MAX_CONTROL_FRAME_BYTES) socket.destroy();
            else socket.write(bytes);
          }
        }).finally(() => { pending--; queued--; work.delete(task); });
        work.add(task); chain = task;
      }
    });
    socket.on("end", () => { if (buffer.length !== 0) socket.destroy(); });
  });
  try {
    await custody.publish(server);
    await socketIdentity(path);
    const host = await loadHostConfig(dataDir);
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
      providers: leases => createProviderHost({ dataDir, config: host, leases, ...(options.providerArtifact === undefined ? {} : { runtimeArtifact: options.providerArtifact }),
        ...(options.managedCodex === undefined ? {} : { managedCodex: options.managedCodex }) }) });
    await service.recoverInactiveGrants();
    if (messaging) replyLoop = await createDaemonReplyLoop({ service, client: messaging.client, hooks: extensions.hooks, onStatus: value => service!.setRuntimeStatus(value) });
    else if (messagingUnavailable) service.setRuntimeStatus({ state: "unavailable", detail: "Ghostget automation setup or previous process custody needs owner attention. No automatic replies are running." });
  } catch (error) {
    for (const client of clients) client.destroy();
    const failures: unknown[] = [error];
    for (const cleanup of [
      async () => { if (server.listening) await new Promise<void>(resolve_ => server.close(() => resolve_())); },
      async () => replyLoop?.close(), async () => messaging?.close(), async () => service?.close(), async () => custody.close(),
    ]) { try { await cleanup(); } catch (failure) { failures.push(failure); } }
    if (failures.length > 1) throw new AggregateError(failures, "Daemon startup and cleanup require attention");
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return { socketPath: path, service, extensions: extensions!, close() {
    closePromise ??= (async () => {
      closing = true;
      for (const client of clients) client.destroy();
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => new Promise<void>((resolve_, reject) => server.close(error => error ? reject(error) : resolve_())),
        async () => { await Promise.allSettled([...work]); },
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
  const path = daemonSocketPath(dataDir);
  const timeoutMs = options.timeoutMs ?? 4_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5_000) throw new Error("Invalid control timeout");
  await inspectDataDirectory(dataDir);
  const before = await socketIdentity(path);
  const frame = Buffer.from(`${JSON.stringify(request)}\n`);
  if (frame.length > MAX_CONTROL_FRAME_BYTES) throw new Error("Control request exceeds frame limit");
  return new Promise((resolve_, reject) => {
    const socket = connect(path); let buffer = Buffer.alloc(0), settled = false;
    const settle = (error: Error | null, value?: ControlResponse): void => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve_(value!); };
    const timer = setTimeout(() => settle(new Error("Textbutler control request timed out")), timeoutMs);
    socket.once("connect", () => {
      void socketIdentity(path).then(after => { if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Control socket identity changed"); if (!settled) socket.write(frame); }).catch(error => settle(error instanceof Error ? error : new Error("Control socket changed")));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_CONTROL_FRAME_BYTES) { settle(new Error("Control response exceeds frame limit")); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) { settle(new Error("Unexpected additional control output")); return; }
      try { settle(null, parseControlResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))))); }
      catch { settle(new Error("Invalid control response")); }
    });
    socket.once("error", () => settle(new Error("The Textbutler control daemon is unavailable")));
    socket.once("close", () => { if (!settled) settle(new Error("The control daemon closed without a response")); });
  });
}
