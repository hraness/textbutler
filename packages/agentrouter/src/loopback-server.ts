// Loopback HTTP server port shared by Bun and Node runtimes. Implemented on node:http so the
// host relay keeps identical semantics (ephemeral port, transport body bound, idle timeout,
// in-flight accounting, immediate join) under either runtime; callers keep fetch-style
// Request/Response handling.

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface LoopbackServer {
  readonly port: number;
  readonly pendingRequests: number;
  stop(immediate?: boolean): Promise<void>;
}

export type LoopbackServerOptions = Readonly<{
  hostname: string;
  idleTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  fetch(request: Request): Response | Promise<Response>;
  error(error: unknown): Response;
}>;

function requestFromIncoming(request: IncomingMessage, port: number, maxRequestBodyBytes: number | undefined): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = request.method ?? "GET";
  const host = headers.get("host") ?? `127.0.0.1:${port}`;
  const url = `http://${host}${request.url ?? "/"}`;
  const iterator = request[Symbol.asyncIterator]();
  let received = 0;
  const body = method === "GET" || method === "HEAD" ? undefined : new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) { controller.close(); return; }
        received += item.value.byteLength;
        // Match the Bun.serve maxRequestBodySize transport rejection: an over-bound body
        // errors the stream and tears the connection down instead of draining unboundedly.
        if (maxRequestBodyBytes !== undefined && received > maxRequestBodyBytes) {
          controller.error(new Error("LOOPBACK_REQUEST_BODY_BOUND"));
          request.destroy();
          return;
        }
        controller.enqueue(item.value);
      } catch (error) { controller.error(error); }
    },
    cancel() { request.destroy(); },
  });
  return new Request(url, { method, headers, body, ...(body ? { duplex: "half" } : {}) } as RequestInit);
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (result.body === null) { response.end(); return; }
  const reader = result.body.getReader();
  const closed = once(response, "close");
  void closed.catch(() => {});
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (response.destroyed || response.writableEnded) return;
      if (!response.write(value)) await Promise.race([once(response, "drain"), closed]);
    }
    response.end();
  } finally { reader.releaseLock(); }
}

export function createLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const sockets = new Set<Socket>();
  let pendingRequests = 0;
  let port = 0;
  let stopped: Promise<void> | undefined;
  const server: Server = createServer((incoming, response) => {
    pendingRequests++;
    let accounted = false;
    const complete = () => { if (!accounted) { accounted = true; pendingRequests--; } };
    response.once("finish", complete);
    response.once("close", complete);
    // A socket teardown racing queued or unflushed bytes must not escape as an
    // unhandled 'error'; custody joins are the accounting surface, not this event.
    response.on("error", () => {});
    const run = async (): Promise<Response> => {
      try { return await options.fetch(requestFromIncoming(incoming, port, options.maxRequestBodyBytes)); }
      catch (error) { return options.error(error); }
    };
    void run()
      .then(result => writeResponse(response, result))
      .catch(() => { response.destroy(); })
      .finally(complete);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => socket.destroy());
  if (options.idleTimeoutMs) server.setTimeout(options.idleTimeoutMs, socket => socket.destroy());
  return new Promise((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, options.hostname, () => {
      server.removeListener("error", onListenError);
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        get port() { return port; },
        get pendingRequests() { return pendingRequests; },
        stop(immediate = false) {
          stopped ??= new Promise<void>((settle, rejectClose) => {
            // Stop accepting first so the connection set is frozen before teardown.
            server.close(error => error ? rejectClose(error) : settle());
            if (immediate) for (const socket of sockets) socket.destroy();
          }).then(() => { for (const socket of sockets) socket.destroy(); });
          return stopped;
        },
      });
    });
  });
}
