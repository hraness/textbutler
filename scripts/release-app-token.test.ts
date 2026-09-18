import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createReleaseAppJwt,
  MESSAGE_LIKE_ME_REPOSITORY_ID,
  parseReleaseAppIdentity,
  parseReleaseAppInstallation,
  parseReleaseAppConfiguration,
  parseReleaseAppTokenResponse,
  RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS,
  releaseAppTokenRequestBody,
  revokeReleaseAppTokenWithConvergence,
  withReleaseAppToken,
  withReleaseAppTokenFromEnvironment,
} from "./release-app-token.mjs";

const releaseAppTokenHelperUrl = new URL("./release-app-token.mjs", import.meta.url);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const token = "installation-token-for-exact-repository";
const serverDate = "Sat, 29 Aug 2026 18:00:00 GMT";
const expiresAt = "2026-08-29T19:00:00Z";
const exactPermissions = Object.freeze({
  metadata: "read" as const,
  statuses: "write" as const,
});
const revocationReceipt = Object.freeze({
  converged: true as const,
  deletionServerDate: "2026-08-29T18:00:01.000Z",
  lastObservationServerDate: "2026-08-29T18:00:01.000Z",
  observationCount: 2,
  propagationObserved: false,
  stableDenials: 2 as const,
});
const environment = Object.freeze({
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: "hraness/textbutler",
  GITHUB_REPOSITORY_ID: String(MESSAGE_LIKE_ME_REPOSITORY_ID),
  GITHUB_REPOSITORY_OWNER: "hraness",
  MLM_RELEASE_APP_CLIENT_ID: "Iv1.messageLikeMeRelease",
  MLM_RELEASE_APP_ID: "24680",
  MLM_RELEASE_APP_INSTALLATION_ID: "13579",
  MLM_RELEASE_APP_PRIVATE_KEY: privateKeyPem,
  MLM_RELEASE_APP_SLUG: "message-like-me-release-writer",
});

function tokenResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    expires_at: expiresAt,
    permissions: { ...exactPermissions },
    repositories: [{
      full_name: "hraness/textbutler",
      id: MESSAGE_LIKE_ME_REPOSITORY_ID,
      name: "textbutler",
      owner: { login: "hraness" },
    }],
    repository_selection: "selected",
    token,
    ...overrides,
  };
}

function appIdentity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    client_id: "Iv1.messageLikeMeRelease",
    id: 24680,
    owner: { login: "hraness", type: "Organization" },
    permissions: { ...exactPermissions },
    slug: "message-like-me-release-writer",
    ...overrides,
  };
}

function installationIdentity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    account: { login: "hraness", type: "Organization" },
    app_id: 24680,
    app_slug: "message-like-me-release-writer",
    id: 13579,
    permissions: { ...exactPermissions },
    repository_selection: "selected",
    target_type: "Organization",
    ...overrides,
  };
}

const repositoryBody = Object.freeze({
  repositories: [{
    full_name: "hraness/textbutler",
    id: MESSAGE_LIKE_ME_REPOSITORY_ID,
    name: "textbutler",
    owner: { login: "hraness" },
  }],
  repository_selection: "selected",
  total_count: 1,
});

type RevocationObservation = Readonly<{
  body?: "binary" | "empty" | "invalid-json" | "json" | "overflow" | "pending" | "text" | "wrong-repo";
  bodyLatencyMilliseconds?: number;
  bodyText?: string;
  contentLength?: string;
  date?: string;
  fetchLatencyMilliseconds?: number;
  location?: string;
  networkFailure?: "abort" | "pending" | true;
  omitDate?: boolean;
  redirected?: boolean;
  status: number;
}>;

const observation = (
  status: number,
  overrides: Omit<RevocationObservation, "status"> = {},
): RevocationObservation => Object.freeze({ status, ...overrides });

const stableDenials = Object.freeze([
  observation(401, { body: "empty" }),
  observation(401, { body: "json" }),
]);

function createRevocationHarness(
  observations: readonly RevocationObservation[],
  overrides: Readonly<{
    deleteObservation?: RevocationObservation;
    initialClock?: number;
    nowSamples?: readonly number[];
    sleepMode?: "frozen" | "overflow" | "partial" | "regress" | "reject";
  }> = {},
) {
  let clock = overrides.initialClock ?? 0;
  let nowSampleIndex = 0;
  let deleted = false;
  let observationIndex = 0;
  const calls: string[] = [];
  const callTimes: number[] = [];
  const sleepCalls: number[] = [];
  const timeouts: number[] = [];
  const sourceChunks: Uint8Array[] = [];
  let cancelledBodies = 0;
  const encoder = new TextEncoder();
  const defaultDate = "Sat, 29 Aug 2026 18:00:01 GMT";

  const responseFor = async (
    item: RevocationObservation,
    signal?: AbortSignal | null,
  ): Promise<Response> => {
    if (item.networkFailure === "abort") {
      throw new DOMException(`aborted ${token}`, "AbortError");
    }
    if (item.networkFailure === "pending") {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException(`aborted ${token}`, "AbortError"));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (item.networkFailure === true) throw new Error(`network leaked ${token}`);
    clock += item.fetchLatencyMilliseconds ?? 1;
    let bytes: Uint8Array;
    switch (item.body) {
      case "empty":
      case "pending":
        bytes = new Uint8Array();
        break;
      case "text":
        bytes = encoder.encode(item.bodyText ?? "denied");
        break;
      case "binary":
        bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
        break;
      case "invalid-json":
        bytes = encoder.encode("{");
        break;
      case "overflow":
        bytes = encoder.encode("bounded");
        break;
      case "json":
        bytes = encoder.encode(JSON.stringify({ message: "Bad credentials" }));
        break;
      case "wrong-repo":
        bytes = encoder.encode(JSON.stringify({
          ...repositoryBody,
          repositories: [{
            ...repositoryBody.repositories[0],
            full_name: "hraness/other",
            id: 1,
            name: "other",
          }],
        }));
        break;
      default:
        bytes = item.status === 200
          ? encoder.encode(JSON.stringify(repositoryBody))
          : encoder.encode(JSON.stringify({ message: "Bad credentials" }));
        break;
    }
    const headers: Record<string, string> = {};
    if (item.omitDate !== true) headers.Date = item.date ?? defaultDate;
    if (item.contentLength !== undefined) headers["Content-Length"] = item.contentLength;
    else if (item.body === "overflow") headers["Content-Length"] = String(1024 * 1024 + 1);
    if (item.location !== undefined) headers.Location = item.location;
    const forbidden204Body = item.status === 204 && item.body !== undefined && item.body !== "empty";
    const body = item.status === 204 && !forbidden204Body ? null : new ReadableStream<Uint8Array>({
      cancel() { cancelledBodies += 1; },
      start(controller) {
        clock += item.bodyLatencyMilliseconds ?? 0;
        if (item.body === "pending") {
          const abort = () => controller.error(new DOMException(`aborted ${token}`, "AbortError"));
          if (signal?.aborted === true) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          return;
        }
        if (bytes.byteLength > 0) {
          sourceChunks.push(bytes);
          controller.enqueue(bytes);
        }
        controller.close();
      },
    });
    const response = new Response(body, {
      headers,
      status: forbidden204Body ? 200 : item.status,
    });
    if (forbidden204Body) Object.defineProperty(response, "status", { value: 204 });
    if (item.redirected === true) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };

  const fetchImplementation = async (request: URL | RequestInfo, init?: RequestInit) => {
    expect(request).toBeInstanceOf(URL);
    const url = new URL(String(request));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Readonly<Record<string, string>> | undefined;
    expect(url.href).toBe(`https://api.github.com${url.pathname}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    expect(headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache",
      "User-Agent": "message-like-me-release-writer",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    calls.push(`${method} ${url.pathname}`);
    callTimes.push(clock);
    if (url.pathname === "/installation/token") {
      expect(method).toBe("DELETE");
      expect(deleted).toBe(false);
      deleted = true;
      return responseFor(
        overrides.deleteObservation ?? observation(204, { body: "empty" }),
        init?.signal,
      );
    }
    expect(url.pathname).toBe("/installation/repositories");
    expect(method).toBe("GET");
    expect(deleted).toBe(true);
    const item = observations[observationIndex];
    observationIndex += 1;
    if (item === undefined) throw new Error("revocation fixture exhausted");
    return responseFor(item, init?.signal);
  };

  return Object.freeze({
    advanceClock(milliseconds: number) { clock += milliseconds; },
    calls,
    callTimes,
    cancelledBodies() { return cancelledBodies; },
    createTimeoutSignal(milliseconds: number) {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    },
    currentClock() { return clock; },
    fetchImplementation,
    now() {
      const sample = overrides.nowSamples?.[nowSampleIndex];
      nowSampleIndex += 1;
      if (sample !== undefined) clock = sample;
      return clock;
    },
    observationCount() { return observationIndex; },
    async sleep(milliseconds: number) {
      sleepCalls.push(milliseconds);
      if (overrides.sleepMode === "reject") throw new Error(`sleep leaked ${token}`);
      if (overrides.sleepMode === "frozen") return;
      if (overrides.sleepMode === "regress") {
        clock -= 1;
        return;
      }
      if (overrides.sleepMode === "overflow") {
        clock = Number.MAX_SAFE_INTEGER + 1;
        return;
      }
      clock += overrides.sleepMode === "partial"
        ? Math.max(1, Math.floor(milliseconds / 2))
        : milliseconds;
    },
    sleepCalls,
    sourceChunks,
    timeouts,
  });
}

async function runRevocationCase(
  observations: readonly RevocationObservation[],
  overrides: Parameters<typeof createRevocationHarness>[1] = {},
) {
  const harness = createRevocationHarness(observations, overrides);
  const receipt = await revokeReleaseAppTokenWithConvergence({
    apiUrl: new URL("https://api.github.com/"),
    createTimeoutSignal: harness.createTimeoutSignal,
    expiresAt,
    fetchImplementation: harness.fetchImplementation,
    now: harness.now,
    sleep: harness.sleep,
    token,
  });
  return Object.freeze({ harness, receipt });
}

describe("release App token transaction", () => {
  test("signs a bounded RS256 App JWT with the checked client identity", () => {
    const nowMilliseconds = Date.parse("2026-08-29T18:00:00Z");
    const jwt = createReleaseAppJwt({
      clientId: environment.MLM_RELEASE_APP_CLIENT_ID,
      nowMilliseconds,
      privateKey: privateKeyPem,
    });
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("JWT does not have three segments");
    const [header, payload, signature] = parts as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      exp: Math.floor(nowMilliseconds / 1000) - 60 + 9 * 60,
      iat: Math.floor(nowMilliseconds / 1000) - 60,
      iss: environment.MLM_RELEASE_APP_CLIENT_ID,
    });
    expect(verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`, "ascii"),
      publicKey,
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  test("requests and accepts only the numeric Message Like Me repository closure", () => {
    expect(releaseAppTokenRequestBody()).toEqual({
      permissions: exactPermissions,
      repository_ids: [1_342_143_606],
    });
    expect(parseReleaseAppTokenResponse(tokenResponse(), serverDate)).toEqual({
      expiresAt,
      permissions: exactPermissions,
      repositoryId: 1_342_143_606,
      token,
    });
    expect(() => parseReleaseAppIdentity(
      appIdentity(),
      parseReleaseAppConfiguration(environment),
    )).not.toThrow();
    expect(() => parseReleaseAppInstallation(
      installationIdentity(),
      parseReleaseAppConfiguration(environment),
    )).not.toThrow();
  });

  test("rejects missing, downgraded, or extra authority at every App permission boundary", () => {
    const configuration = parseReleaseAppConfiguration(environment);
    const invalidPermissions = [
      { metadata: "read" },
      { metadata: "read", statuses: "read" },
      { metadata: "read", statuses: "write", workflows: "write" },
      { actions: "read", metadata: "read", statuses: "write" },
      { contents: "write", metadata: "read", statuses: "write" },
    ] as const;

    for (const permissions of invalidPermissions) {
      expect(() => parseReleaseAppIdentity(
        appIdentity({ permissions }),
        configuration,
      )).toThrow();
      expect(() => parseReleaseAppInstallation(
        installationIdentity({ permissions }),
        configuration,
      )).toThrow();
      expect(() => parseReleaseAppTokenResponse(
        tokenResponse({ permissions }),
        serverDate,
      )).toThrow();
    }
  });

  test("requires the canonical repository name and unchanged numeric identity after rename", () => {
    expect(() => parseReleaseAppConfiguration({
      ...environment,
      GITHUB_REPOSITORY: "hraness/message-like-me",
    })).toThrow("exact repository hraness/textbutler");
    expect(() => parseReleaseAppConfiguration({
      ...environment,
      GITHUB_REPOSITORY_ID: "1342143607",
    })).toThrow("exact repository hraness/textbutler");
    for (const repository of [
      { full_name: "hraness/message-like-me", id: MESSAGE_LIKE_ME_REPOSITORY_ID, name: "message-like-me" },
      { full_name: "hraness/textbutler", id: MESSAGE_LIKE_ME_REPOSITORY_ID + 1, name: "textbutler" },
    ]) {
      expect(() => parseReleaseAppTokenResponse(tokenResponse({
        repositories: [{ ...repository, owner: { login: "hraness" } }],
      }), serverDate)).toThrow("exact hraness/textbutler");
    }
  });

  test("masks, uses, and revokes the exact token around one operation", async () => {
    const calls: string[] = [];
    const result = await withReleaseAppToken({
      environment,
      async inspect(input) {
        expect(input.apiUrl.href).toBe("https://api.github.com/");
        expect(input.jwt.split(".")).toHaveLength(3);
        calls.push("inspect");
        return appIdentity();
      },
      async inspectInstallation(input) {
        expect(input.apiUrl.href).toBe("https://api.github.com/");
        expect(input.installationId).toBe(13579);
        expect(input.jwt.split(".")).toHaveLength(3);
        calls.push("inspect-installation");
        return installationIdentity();
      },
      mask(value) {
        expect(value).toBe(token);
        calls.push("mask");
      },
      async mint(input) {
        expect(input.apiUrl.href).toBe("https://api.github.com/");
        expect(input.body).toEqual(releaseAppTokenRequestBody());
        expect(input.installationId).toBe(13579);
        expect(input.jwt.split(".")).toHaveLength(3);
        calls.push("mint");
        return { body: tokenResponse(), serverDate };
      },
      nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
      async revoke(input) {
        expect(input).toEqual({
          apiUrl: new URL("https://api.github.com/"),
          expiresAt,
          token,
        });
        calls.push("revoke");
        return revocationReceipt;
      },
    }, async (value, receipt) => {
      expect(value).toBe(token);
      expect(receipt).toEqual({
        appId: 24680,
        appSlug: "message-like-me-release-writer",
        clientId: "Iv1.messageLikeMeRelease",
        expiresAt,
        installationId: 13579,
        repositoryId: 1_342_143_606,
      });
      calls.push("operation");
      return "complete";
    });
    expect(result).toBe("complete");
    expect(calls).toEqual([
      "inspect",
      "inspect-installation",
      "mint",
      "mask",
      "operation",
      "revoke",
    ]);
  });

  test("rejects a mismatched selected installation before token mint", async () => {
    for (const installation of [
      installationIdentity({ id: 1 }),
      installationIdentity({ app_id: 1 }),
      installationIdentity({ app_slug: "other-app" }),
      installationIdentity({ account: { login: "other", type: "Organization" } }),
      installationIdentity({ repository_selection: "all" }),
      installationIdentity({ permissions: { metadata: "read", statuses: "read" } }),
    ] as const) {
      const calls: string[] = [];
      await expect(withReleaseAppToken({
        environment,
        async inspect() { calls.push("inspect"); return appIdentity(); },
        async inspectInstallation() {
          calls.push("inspect-installation");
          return installation;
        },
        mask() { calls.push("mask"); },
        async mint() { calls.push("mint"); return { body: tokenResponse(), serverDate }; },
        nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
        async revoke() { calls.push("revoke"); return revocationReceipt; },
      }, async () => {
        calls.push("operation");
      })).rejects.toThrow("installation identity or permission closure");
      expect(calls).toEqual(["inspect", "inspect-installation"]);
    }
  });

  test("revokes a minted token when response validation or the operation fails", async () => {
    for (const body of [
      tokenResponse({ expires_at: "2026-08-29T18:01:00Z" }),
      tokenResponse({ permissions: { metadata: "read", statuses: "read" } }),
      tokenResponse({ repositories: [] }),
      tokenResponse({ repository_selection: "all" }),
    ] as const) {
      const calls: string[] = [];
      await expect(withReleaseAppToken({
        environment,
        async inspect() { calls.push("inspect"); return appIdentity(); },
        async inspectInstallation() {
          calls.push("inspect-installation");
          return installationIdentity();
        },
        mask() { calls.push("mask"); },
        async mint() { calls.push("mint"); return { body, serverDate }; },
        nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
        async revoke() { calls.push("revoke"); return revocationReceipt; },
      }, async () => {
        calls.push("operation");
      })).rejects.toThrow();
      expect(calls).toEqual(["inspect", "inspect-installation", "mint", "mask", "revoke"]);
    }

    const missingDateCalls: string[] = [];
    await expect(withReleaseAppToken({
      environment,
      async inspect() { missingDateCalls.push("inspect"); return appIdentity(); },
      async inspectInstallation() {
        missingDateCalls.push("inspect-installation");
        return installationIdentity();
      },
      mask() { missingDateCalls.push("mask"); },
      async mint() {
        missingDateCalls.push("mint");
        return { body: tokenResponse(), serverDate: null };
      },
      nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
      async revoke() { missingDateCalls.push("revoke"); return revocationReceipt; },
    }, async () => {
      missingDateCalls.push("operation");
    })).rejects.toThrow("response Date is not a string");
    expect(missingDateCalls).toEqual([
      "inspect",
      "inspect-installation",
      "mint",
      "mask",
      "revoke",
    ]);

    const calls: string[] = [];
    await expect(withReleaseAppToken({
      environment,
      async inspect() { calls.push("inspect"); return appIdentity(); },
      async inspectInstallation() {
        calls.push("inspect-installation");
        return installationIdentity();
      },
      mask() { calls.push("mask"); },
      async mint() { calls.push("mint"); return { body: tokenResponse(), serverDate }; },
      nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
      async revoke() { calls.push("revoke"); return revocationReceipt; },
    }, async () => {
      calls.push("operation");
      throw new Error("leased push failed");
    })).rejects.toThrow("leased push failed");
    expect(calls).toEqual([
      "inspect",
      "inspect-installation",
      "mint",
      "mask",
      "operation",
      "revoke",
    ]);
  });

  test("reports both an operation failure and a revocation failure", async () => {
    const failure = withReleaseAppToken({
      environment,
      async inspect() { return appIdentity(); },
      async inspectInstallation() { return installationIdentity(); },
      mask() {},
      async mint() { return { body: tokenResponse(), serverDate }; },
      nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
      async revoke() { throw new Error("revoke failed"); },
    }, async () => {
      throw new Error("operation failed");
    });
    await expect(failure).rejects.toThrow("operation and token revocation both failed");
    try {
      await failure;
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
        "Error: operation failed",
        "Error: revoke failed",
      ]);
    }
  });

  test("binds the complete helper and exercises the real three-argument environment wrapper", async () => {
    const source = await readFile(releaseAppTokenHelperUrl, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "2694b0fcd4238da26cfb64eff15436e55fc16a7f04dd3f29083cc2bd5a024c4e",
    );
    const implementationStart = source.indexOf("function revocationIndeterminate");
    const implementationEnd = source.indexOf("\nasync function revokeWithFetch", implementationStart);
    expect(implementationStart).toBeGreaterThan(0);
    expect(implementationEnd).toBeGreaterThan(implementationStart);
    expect(createHash("sha256").update(
      source.slice(implementationStart, implementationEnd),
    ).digest("hex")).toBe("e3cdfb5de5dd6165784af10b1d8624d9dd20094329c17035adf2ae26b84aab0c");
    expect(withReleaseAppTokenFromEnvironment.length).toBe(3);
    expect(source.slice(source.indexOf("export function withReleaseAppTokenFromEnvironment")).trimEnd())
      .toBe(`export function withReleaseAppTokenFromEnvironment(environment, operation, onRevoked) {
  return withReleaseAppToken({
    environment,
    inspect: inspectWithFetch,
    inspectInstallation: inspectInstallationWithFetch,
    mask(token) {
      process.stdout.write(\`::add-mask::\${token}\\n\`);
    },
    mint: mintWithFetch,
    nowMilliseconds: Date.now,
    onRevoked,
    revoke: revokeWithFetch,
  }, operation);
}`);

    const events: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalStdoutWrite = process.stdout.write;
    let deniedReads = 0;
    try {
      Date.now = () => Date.parse("2026-08-29T18:00:00Z");
      process.stdout.write = ((chunk: string | Uint8Array) => {
        expect(String(chunk)).toBe(`::add-mask::${token}\n`);
        events.push("mask");
        return true;
      }) as typeof process.stdout.write;
      globalThis.fetch = (async (request: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(request));
        const method = init?.method ?? "GET";
        events.push(`${method} ${url.pathname}`);
        expect(url.origin).toBe("https://api.github.com");
        expect(init?.redirect).toBe("error");
        if (url.pathname === "/app") {
          return new Response(JSON.stringify(appIdentity()), { status: 200 });
        }
        if (url.pathname === "/app/installations/13579") {
          return new Response(JSON.stringify(installationIdentity()), { status: 200 });
        }
        if (url.pathname === "/app/installations/13579/access_tokens") {
          expect(init?.body).toBe(JSON.stringify(releaseAppTokenRequestBody()));
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { Date: serverDate },
            status: 201,
          });
        }
        if (url.pathname === "/installation/token") {
          expect(method).toBe("DELETE");
          return new Response(null, {
            headers: { "Content-Length": "0", Date: "Sat, 29 Aug 2026 18:00:01 GMT" },
            status: 204,
          });
        }
        expect(url.pathname).toBe("/installation/repositories");
        expect(method).toBe("GET");
        deniedReads += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          headers: { Date: "Sat, 29 Aug 2026 18:00:01 GMT" },
          status: 401,
        });
      }) as typeof fetch;
      const value = await withReleaseAppTokenFromEnvironment(
        environment,
        async (leasedToken, receipt) => {
          expect(leasedToken).toBe(token);
          expect(receipt.expiresAt).toBe(expiresAt);
          events.push("operation");
          return "advanced";
        },
        async (receipt) => {
          expect(receipt).toEqual(revocationReceipt);
          events.push("revoked");
        },
      );
      expect(value).toBe("advanced");
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalDateNow;
      process.stdout.write = originalStdoutWrite;
    }
    expect(events).toEqual([
      "GET /app",
      "GET /app/installations/13579",
      "POST /app/installations/13579/access_tokens",
      "mask",
      "operation",
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
      "revoked",
    ]);
    expect(deniedReads).toBe(2);
  });

  test("requires exact repository authority and two stable post-delete denials", async () => {
    const direct = await runRevocationCase(stableDenials);
    expect(direct.receipt).toEqual(revocationReceipt);
    expect(direct.harness.calls).toEqual([
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
    ]);
    expect(direct.harness.sourceChunks.every((chunk) =>
      chunk.every((value) => value === 0))).toBe(true);

    const propagated = await runRevocationCase([
      observation(200),
      observation(401, { body: "text" }),
      observation(401, { body: "empty" }),
    ], { sleepMode: "partial" });
    expect(propagated.receipt).toEqual({
      converged: true,
      deletionServerDate: "2026-08-29T18:00:01.000Z",
      lastObservationServerDate: "2026-08-29T18:00:01.000Z",
      observationCount: 3,
      propagationObserved: true,
      stableDenials: 2,
    });

    const wrongRepository = createRevocationHarness([
      observation(200, { body: "wrong-repo" }),
    ]);
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: wrongRepository.createTimeoutSignal,
      expiresAt,
      fetchImplementation: wrongRepository.fetchImplementation,
      now: wrongRepository.now,
      sleep: wrongRepository.sleep,
      token,
    })).rejects.toThrow("authorized revocation observation is malformed");
    expect(wrongRepository.calls).toEqual([
      "DELETE /installation/token",
      "GET /installation/repositories",
    ]);

    const authorizationReturned = createRevocationHarness([
      observation(401, { body: "empty" }),
      observation(200),
    ]);
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: authorizationReturned.createTimeoutSignal,
      expiresAt,
      fetchImplementation: authorizationReturned.fetchImplementation,
      now: authorizationReturned.now,
      sleep: authorizationReturned.sleep,
      token,
    })).rejects.toThrow("authorization returned after a denial observation");
    expect(authorizationReturned.calls.filter((value) =>
      value === "DELETE /installation/token")).toHaveLength(1);

    const oneDenial = createRevocationHarness([
      ...Array.from({ length: 9 }, () => observation(200)),
      observation(401, { body: "empty" }),
    ]);
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: oneDenial.createTimeoutSignal,
      expiresAt,
      fetchImplementation: oneDenial.fetchImplementation,
      now: oneDenial.now,
      sleep: oneDenial.sleep,
      token,
    })).rejects.toThrow("only one denial was observed before the operational deadline");

    for (const status of [302, 403, 404, 429, 500, 503] as const) {
      const unexpected = createRevocationHarness([observation(status, { body: "text" })]);
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: unexpected.createTimeoutSignal,
        expiresAt,
        fetchImplementation: unexpected.fetchImplementation,
        now: unexpected.now,
        sleep: unexpected.sleep,
        token,
      })).rejects.toThrow("observation returned an unexpected authorization state");
    }

    const redirected = createRevocationHarness([
      observation(302, {
        body: "text",
        location: "https://example.test/untrusted",
        redirected: true,
      }),
    ]);
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: redirected.createTimeoutSignal,
      expiresAt,
      fetchImplementation: redirected.fetchImplementation,
      now: redirected.now,
      sleep: redirected.sleep,
      token,
    })).rejects.toThrow("release App token revocation observation redirected");
  });

  test("uses absolute monotonic slots and enforces the exact 30-second edges", async () => {
    expect(RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS).toEqual([
      0,
      250,
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      24_000,
      29_000,
    ]);

    const persistent = createRevocationHarness(
      Array.from({ length: 10 }, () => observation(200)),
    );
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: persistent.createTimeoutSignal,
      expiresAt,
      fetchImplementation: persistent.fetchImplementation,
      now: persistent.now,
      sleep: persistent.sleep,
      token,
    })).rejects.toThrow("did not converge within the bounded operational window");
    expect(persistent.calls).toEqual([
      "DELETE /installation/token",
      ...Array.from({ length: 10 }, () => "GET /installation/repositories"),
    ]);
    expect(persistent.timeouts.slice(1)).toEqual([
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      6_000,
      1_000,
    ]);

    for (const authoritativeBegin of [250, 251] as const) {
      const edge = createRevocationHarness(stableDenials, {
        nowSamples: [0, 1, 2, authoritativeBegin, 30_002],
      });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: edge.createTimeoutSignal,
        expiresAt,
        fetchImplementation: edge.fetchImplementation,
        now: edge.now,
        sleep: edge.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(edge.calls).toEqual(["DELETE /installation/token"]);
    }

    for (const authoritativeBegin of [30_000, 30_001] as const) {
      const finalSlot = createRevocationHarness(stableDenials, {
        nowSamples: [
          0,
          250,
          500,
          1_000,
          2_000,
          4_000,
          8_000,
          16_000,
          24_000,
          29_000,
          29_000,
          29_000,
          authoritativeBegin,
        ],
      });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: finalSlot.createTimeoutSignal,
        expiresAt,
        fetchImplementation: finalSlot.fetchImplementation,
        now: finalSlot.now,
        sleep: finalSlot.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(finalSlot.calls).toEqual(["DELETE /installation/token"]);
    }

    for (const authoritativeBegin of [30_000, 30_001] as const) {
      const nineObserved = createRevocationHarness(
        Array.from({ length: 9 }, () => observation(200)),
        { deleteObservation: observation(204, { body: "empty", fetchLatencyMilliseconds: 0 }) },
      );
      let finalSlotReads = 0;
      const finalSlotNow = () => {
        if (nineObserved.observationCount() === 9 && nineObserved.currentClock() === 29_000) {
          finalSlotReads += 1;
          if (finalSlotReads === 2) nineObserved.advanceClock(authoritativeBegin - 29_000);
        }
        return nineObserved.currentClock();
      };
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: nineObserved.createTimeoutSignal,
        expiresAt,
        fetchImplementation: nineObserved.fetchImplementation,
        now: finalSlotNow,
        sleep: nineObserved.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(nineObserved.observationCount()).toBe(9);
      expect(nineObserved.calls.filter((value) =>
        value === "DELETE /installation/token")).toHaveLength(1);
    }

    const acceptedBoundary = await runRevocationCase([
      ...Array.from({ length: 8 }, () => observation(200)),
      observation(401, { body: "text" }),
      observation(401, { body: "empty", bodyLatencyMilliseconds: 1_000, fetchLatencyMilliseconds: 0 }),
    ]);
    expect(acceptedBoundary.receipt.observationCount).toBe(10);
    await expect(runRevocationCase([
      ...Array.from({ length: 8 }, () => observation(200)),
      observation(401),
      observation(401, { bodyLatencyMilliseconds: 1_001, fetchLatencyMilliseconds: 0 }),
    ])).rejects.toThrow("completed outside its deadline");

    const missedSlots = await runRevocationCase([
      observation(200, { fetchLatencyMilliseconds: 9_000 }),
      observation(401, { body: "empty" }),
      observation(401, { body: "text" }),
    ]);
    expect(missedSlots.harness.callTimes.slice(1)).toEqual([1, 16_001, 24_001]);

    for (const invalidClock of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ] as const) {
      const invalid = createRevocationHarness(stableDenials, { nowSamples: [invalidClock] });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: invalid.createTimeoutSignal,
        expiresAt,
        fetchImplementation: invalid.fetchImplementation,
        now: invalid.now,
        sleep: invalid.sleep,
        token,
      })).rejects.toThrow("clock is invalid");
      expect(invalid.calls).toEqual(["DELETE /installation/token"]);
    }
    for (const sleepMode of ["frozen", "overflow", "regress", "reject"] as const) {
      const invalidSleep = createRevocationHarness([
        observation(200),
        ...stableDenials,
      ], { sleepMode });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: invalidSleep.createTimeoutSignal,
        expiresAt,
        fetchImplementation: invalidSleep.fetchImplementation,
        now: invalidSleep.now,
        sleep: invalidSleep.sleep,
        token,
      })).rejects.toThrow("indeterminate");
      expect(invalidSleep.calls.filter((value) =>
        value === "DELETE /installation/token")).toHaveLength(1);
    }

    const impreciseDeadline = createRevocationHarness(stableDenials, {
      initialClock: Number.MAX_SAFE_INTEGER - 30_000,
    });
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: impreciseDeadline.createTimeoutSignal,
      expiresAt,
      fetchImplementation: impreciseDeadline.fetchImplementation,
      now: impreciseDeadline.now,
      sleep: impreciseDeadline.sleep,
      token,
    })).rejects.toThrow("outside the precise clock range");
    expect(impreciseDeadline.calls).toEqual(["DELETE /installation/token"]);
  });

  test("streams bounded bodies and requires canonical authenticated time before expiry", async () => {
    const oneSecondBeforeExpiry = "Sat, 29 Aug 2026 18:59:59 GMT";
    const accepted = await runRevocationCase([
      observation(200, { date: oneSecondBeforeExpiry }),
      observation(401, { body: "empty", date: oneSecondBeforeExpiry }),
      observation(401, { body: "text", date: oneSecondBeforeExpiry }),
    ], {
      deleteObservation: observation(204, { body: "empty", date: oneSecondBeforeExpiry }),
    });
    expect(accepted.receipt.propagationObserved).toBe(true);

    await expect(runRevocationCase([
      observation(401, { body: "empty", date: "Sat, 29 Aug 2026 18:00:01 GMT" }),
    ], {
      deleteObservation: observation(204, {
        body: "empty",
        date: "Sat, 29 Aug 2026 18:00:02 GMT",
      }),
    })).rejects.toThrow("denied revocation observation is malformed");

    await expect(runRevocationCase([
      observation(401, { body: "empty", date: "Sat, 29 Aug 2026 18:00:02 GMT" }),
      observation(401, { body: "empty", date: "Sat, 29 Aug 2026 18:00:01 GMT" }),
    ], {
      deleteObservation: observation(204, {
        body: "empty",
        date: "Sat, 29 Aug 2026 18:00:01 GMT",
      }),
    })).rejects.toThrow("denied revocation observation is malformed");

    for (const failureCase of [
      {
        expected: "revocation authority time proof is malformed",
        observations: stableDenials,
        overrides: {
          deleteObservation: observation(204, {
            body: "empty",
            date: "Sat, 29 Aug 2026 19:00:00 GMT",
          }),
        },
      },
      {
        expected: "authorized revocation observation is malformed",
        observations: [observation(200, { date: "Sat, 29 Aug 2026 19:00:00 GMT" })],
      },
      {
        expected: "denied revocation observation is malformed",
        observations: [observation(401, {
          body: "empty",
          date: "Sat, 29 Aug 2026 19:00:00 GMT",
        })],
      },
      {
        expected: "authorized revocation observation is malformed",
        observations: [observation(200, { body: "overflow" })],
      },
      {
        expected: "denied revocation observation is malformed",
        observations: [observation(401, { body: "overflow" })],
      },
      {
        expected: "observation returned an unexpected authorization state",
        observations: [observation(403, {
          body: "empty",
          date: "Sat, 29 Aug 2026 19:00:00 GMT",
        })],
      },
      {
        expected: "unexpected revocation observation response is malformed",
        observations: [observation(403, { body: "overflow" })],
      },
    ] as const) {
      const harness = createRevocationHarness(failureCase.observations, failureCase.overrides);
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: harness.createTimeoutSignal,
          expiresAt,
          fetchImplementation: harness.fetchImplementation,
          now: harness.now,
          sleep: harness.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain(failureCase.expected);
      expect(String(caught)).not.toContain(token);
      expect(harness.calls.filter((value) =>
        value === "DELETE /installation/token")).toHaveLength(1);
      if (failureCase.observations.some((item) => item.body === "overflow")) {
        expect(harness.cancelledBodies()).toBe(1);
      }
    }

    for (const deleteObservation of [
      observation(403, { body: "text", bodyText: "secret revocation response" }),
      observation(500, { body: "text", bodyText: "secret revocation response" }),
      observation(204, { body: "text", bodyText: "secret revocation response" }),
      observation(204, { body: "empty", contentLength: "1" }),
    ] as const) {
      const badDelete = createRevocationHarness(stableDenials, { deleteObservation });
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: badDelete.createTimeoutSignal,
          expiresAt,
          fetchImplementation: badDelete.fetchImplementation,
          now: badDelete.now,
          sleep: badDelete.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("indeterminate");
      expect(String(caught)).not.toContain("secret revocation response");
      expect(badDelete.calls).toEqual(["DELETE /installation/token"]);
    }

    for (const pending of [
      createRevocationHarness(stableDenials, {
        deleteObservation: observation(204, { body: "empty", networkFailure: "pending" }),
      }),
      createRevocationHarness([
        observation(401, { body: "pending" }),
      ]),
    ]) {
      let pendingError: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: () => AbortSignal.timeout(1),
          expiresAt,
          fetchImplementation: pending.fetchImplementation,
          now: pending.now,
          sleep: pending.sleep,
          token,
        });
      } catch (error) {
        pendingError = error;
      }
      expect(String(pendingError)).toContain("indeterminate");
      expect(String(pendingError)).not.toContain(token);
      expect(pending.calls.filter((value) =>
        value === "DELETE /installation/token")).toHaveLength(1);
    }
  });

  test("never retries revocation and retains operation plus convergence failures", async () => {
    const harness = createRevocationHarness(
      Array.from({ length: 10 }, () => observation(200)),
    );
    let operationCount = 0;
    try {
      await withReleaseAppToken({
        environment,
        async inspect() { return appIdentity(); },
        async inspectInstallation() { return installationIdentity(); },
        mask() {},
        async mint() { return { body: tokenResponse(), serverDate }; },
        nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
        async revoke(input) {
          return revokeReleaseAppTokenWithConvergence({
            ...input,
            createTimeoutSignal: harness.createTimeoutSignal,
            fetchImplementation: harness.fetchImplementation,
            now: harness.now,
            sleep: harness.sleep,
          });
        },
      }, async () => {
        operationCount += 1;
        throw new Error("leased write failed");
      });
      throw new Error("combined failure unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
        "Error: leased write failed",
        "Error: release App token revocation did not converge within the bounded operational window",
      ]);
    }
    expect(operationCount).toBe(1);
    expect(harness.calls.filter((value) =>
      value === "DELETE /installation/token")).toHaveLength(1);
    expect(3 + harness.calls.length).toBe(14);

    for (const invalidReceipt of [
      undefined,
      { ...revocationReceipt, observationCount: 3 },
      { ...revocationReceipt, observationCount: 2, propagationObserved: true },
      { ...revocationReceipt, stableDenials: 1 },
      { ...revocationReceipt, extra: true },
    ] as const) {
      let observerCalls = 0;
      await expect(withReleaseAppToken({
        environment,
        async inspect() { return appIdentity(); },
        async inspectInstallation() { return installationIdentity(); },
        mask() {},
        async mint() { return { body: tokenResponse(), serverDate }; },
        nowMilliseconds: () => Date.parse("2026-08-29T18:00:00Z"),
        async onRevoked() { observerCalls += 1; },
        async revoke() { return invalidReceipt; },
      }, async () => "advanced")).rejects.toThrow("revocation receipt");
      expect(observerCalls).toBe(0);
    }
  });

  test("rejects copied repository and App coordinates before minting", () => {
    expect(parseReleaseAppConfiguration(environment).repositoryId).toBe(1_342_143_606);
    for (const overrides of [
      { GITHUB_API_URL: "https://github.example.test" },
      { GITHUB_REPOSITORY: "hraness/other" },
      { GITHUB_REPOSITORY_ID: "1" },
      { GITHUB_REPOSITORY_OWNER: "other" },
      { MLM_RELEASE_APP_CLIENT_ID: "bad client" },
      { MLM_RELEASE_APP_ID: "0" },
      { MLM_RELEASE_APP_INSTALLATION_ID: "1.5" },
      { MLM_RELEASE_APP_PRIVATE_KEY: "" },
      { MLM_RELEASE_APP_SLUG: "Bad_Slug" },
    ] as const) {
      expect(() => parseReleaseAppConfiguration({ ...environment, ...overrides })).toThrow();
    }
  });
});
