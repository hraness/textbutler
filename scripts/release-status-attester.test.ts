import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  parseReleaseAuthorityCombinedStatusResponse,
  parseReleaseAuthorityStatusResponse,
  RELEASE_AUTHORITY_STATUS_CONTEXT,
  releaseAuthorityStatusRequest,
  withReleaseAuthorityAttestation,
  withReleaseAuthorityAttestationFromEnvironment,
  withReleaseAuthorityTerminalStatus,
  withReleaseAuthorityTerminalStatusFromEnvironment,
} from "./release-status-attester.mjs";

const helperUrl = new URL("./release-status-attester.mjs", import.meta.url);
const targetSha = "1234567890abcdef1234567890abcdef12345678";
const app = Object.freeze({
  appId: 4_830_612,
  appSlug: "mlm-prod-ref-writer-1342143606",
  clientId: "Iv1.messageLikeMeRelease",
  expiresAt: "2026-09-05T02:00:00Z",
  installationId: 159_058_102,
  repositoryId: 1_342_143_606,
});
const descriptions = Object.freeze({
  error: "Release authority consumed after the production-ref attempt",
  success: "Exact release authority admitted for one production-ref attempt",
});

function statusResponse(
  state: "error" | "success",
  id: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const timestamp = state === "success" ? "2026-09-05T01:00:00Z" : "2026-09-05T01:00:01Z";
  return {
    context: RELEASE_AUTHORITY_STATUS_CONTEXT,
    created_at: timestamp,
    creator: {
      id: 100_000_001,
      login: "mlm-prod-ref-writer-1342143606[bot]",
      node_id: "MDM6Qm90MTAwMDAwMDAx",
      site_admin: false,
      type: "Bot",
    },
    description: descriptions[state],
    id,
    node_id: `SC_kwDOstatus${String(id)}`,
    state,
    target_url: null,
    updated_at: timestamp,
    url: `https://api.github.com/repos/hraness/textbutler/statuses/${targetSha}`,
    ...overrides,
  };
}

function repository() {
  return {
    full_name: "hraness/textbutler",
    id: 1_342_143_606,
    name: "textbutler",
    owner: { login: "hraness", type: "Organization" },
  };
}

function combinedResponse(
  status: Readonly<Record<string, unknown>> = combinedStatusResponse("error", 102),
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    commit_url: `https://api.github.com/repos/hraness/textbutler/commits/${targetSha}`,
    repository: repository(),
    sha: targetSha,
    state: "failure",
    statuses: [status],
    total_count: 1,
    url: `https://api.github.com/repos/hraness/textbutler/commits/${targetSha}/status`,
    ...overrides,
  };
}

function combinedStatusResponse(
  state: "error" | "success",
  id: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const { creator: _creator, ...status } = statusResponse(state, id, overrides);
  return status;
}

function statusReceipt<State extends "error" | "success">(state: State, id: number) {
  return parseReleaseAuthorityStatusResponse(
    statusResponse(state, id),
    state === "success"
      ? "Sat, 05 Sep 2026 01:00:10 GMT"
      : "Sat, 05 Sep 2026 01:00:11 GMT",
    { app, state, targetSha },
  );
}

function lifecycleOptions(overrides: Readonly<{
  combined?: Readonly<Record<string, unknown>>;
  combinedDate?: unknown;
  error?: Readonly<Record<string, unknown>>;
  errorDate?: unknown;
  success?: Readonly<Record<string, unknown>>;
  successDate?: unknown;
}> = {}) {
  const events: string[] = [];
  return Object.freeze({
    events,
    options: Object.freeze({
      app,
      async postStatus(request: ReturnType<typeof releaseAuthorityStatusRequest>) {
        events.push(`post:${request.body.state}`);
        return request.body.state === "success"
          ? {
            body: overrides.success ?? statusResponse("success", 101),
            serverDate: overrides.successDate ?? "Sat, 05 Sep 2026 01:00:10 GMT",
          }
          : {
            body: overrides.error ?? statusResponse("error", 102),
            serverDate: overrides.errorDate ?? "Sat, 05 Sep 2026 01:00:11 GMT",
          };
      },
      async readCombinedStatus(received: string) {
        events.push(`read:${received}`);
        return {
          body: overrides.combined ?? combinedResponse(),
          serverDate: overrides.combinedDate ?? "Sat, 05 Sep 2026 01:00:12 GMT",
        };
      },
      targetSha,
    }),
  });
}

describe("release authority commit-status lifecycle", () => {
  test("builds only exact success and terminal-error requests for the pinned target", () => {
    expect(releaseAuthorityStatusRequest(targetSha, "success")).toEqual({
      body: {
        context: "message-like-me/website-production-authority",
        description: descriptions.success,
        state: "success",
        target_url: null,
      },
      endpoint: `/repos/hraness/textbutler/statuses/${targetSha}`,
      repository: "hraness/textbutler",
      repositoryId: 1_342_143_606,
      targetSha,
    });
    expect(releaseAuthorityStatusRequest(targetSha, "error").body).toEqual({
      context: "message-like-me/website-production-authority",
      description: descriptions.error,
      state: "error",
      target_url: null,
    });
    for (const invalid of [
      "",
      "1234567890ABCDEF1234567890ABCDEF12345678",
      `${targetSha}0`,
      targetSha.slice(1),
      "g".repeat(40),
      null,
    ]) {
      expect(() => releaseAuthorityStatusRequest(invalid, "success")).toThrow(
        "TARGET is not one exact lowercase 40-hex",
      );
    }
    for (const unsupported of ["pending", "failure", "queued", "", undefined]) {
      expect(() => releaseAuthorityStatusRequest(targetSha, unsupported)).toThrow(
        "exact success or terminal error",
      );
    }
  });

  test("parses one exact App-authored status with an authenticated bounded Date", () => {
    expect(statusReceipt("success", 101)).toEqual({
      appId: 4_830_612,
      appSlug: "mlm-prod-ref-writer-1342143606",
      context: RELEASE_AUTHORITY_STATUS_CONTEXT,
      createdAt: "2026-09-05T01:00:00Z",
      creator: {
        id: 100_000_001,
        login: "mlm-prod-ref-writer-1342143606[bot]",
        nodeId: "MDM6Qm90MTAwMDAwMDAx",
      },
      description: descriptions.success,
      installationId: 159_058_102,
      repository: "hraness/textbutler",
      repositoryId: 1_342_143_606,
      serverDate: "2026-09-05T01:00:10.000Z",
      state: "success",
      statusId: 101,
      statusNodeId: "SC_kwDOstatus101",
      statusUrl: `https://api.github.com/repos/hraness/textbutler/statuses/${targetSha}`,
      targetSha,
    });
  });

  test("keeps admission and terminalization as separate exact phases", async () => {
    const fixture = lifecycleOptions();
    const attestation = await withReleaseAuthorityAttestation(fixture.options);
    const terminal = await withReleaseAuthorityTerminalStatus(fixture.options);
    expect(fixture.events).toEqual([
      "post:success",
      "post:error",
      `read:${targetSha}`,
    ]);
    expect(attestation.state).toBe("success");
    expect(terminal.consumption.state).toBe("error");
    expect(terminal.readback).toEqual({
      context: RELEASE_AUTHORITY_STATUS_CONTEXT,
      serverDate: "2026-09-05T01:00:12.000Z",
      state: "failure",
      statusCount: 1,
      targetSha,
      terminalStatusId: 102,
      terminalStatusNodeId: "SC_kwDOstatus102",
    });
  });

  test("rejects malformed admission and terminal phases independently", async () => {
    const fixture = lifecycleOptions({ success: statusResponse("success", 101, { state: "pending" }) });
    await expect(withReleaseAuthorityAttestation(fixture.options)).rejects.toThrow("exact request");
    expect(fixture.events).toEqual(["post:success"]);
    const malformedConsumption = lifecycleOptions({
      error: statusResponse("error", 102, { context: "other/check" }),
    });
    await expect(withReleaseAuthorityTerminalStatus(malformedConsumption.options))
      .rejects.toThrow("exact request");
    expect(malformedConsumption.events).toEqual(["post:error"]);

    const missingReadback = lifecycleOptions({ combined: combinedResponse(undefined, { statuses: [] }) });
    await expect(withReleaseAuthorityTerminalStatus(missingReadback.options))
      .rejects.toThrow("complete bounded status set");
  });

  test("rejects status response, creator, token, and authority-time drift", () => {
    const invalidResponses: readonly [Readonly<Record<string, unknown>>, unknown, string][] = [
      [{ state: "pending" }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact request"],
      [{ context: "other/check" }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact request"],
      [{ description: "other" }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact request"],
      [{ target_url: "https://example.test" }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact request"],
      [{ url: "https://api.github.com/repos/hraness/other/statuses/101" }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact request"],
      [{ id: 0 }, "Sat, 05 Sep 2026 01:00:10 GMT", "positive integer"],
      [{ node_id: "contains space" }, "Sat, 05 Sep 2026 01:00:10 GMT", "node_id is malformed"],
      [{ updated_at: "2026-09-05T01:00:01Z" }, "Sat, 05 Sep 2026 01:00:10 GMT", "updated after creation"],
      [{ created_at: "2026-09-05T01:00:11Z", updated_at: "2026-09-05T01:00:11Z" }, "Sat, 05 Sep 2026 01:00:10 GMT", "response-time bound"],
      [{ created_at: "2026-09-05T00:59:54Z", updated_at: "2026-09-05T00:59:54Z" }, "Sat, 05 Sep 2026 01:00:10 GMT", "response-time bound"],
      [{ creator: { ...statusResponse("success", 101).creator as object, login: "other[bot]" } }, "Sat, 05 Sep 2026 01:00:10 GMT", "exact release App bot"],
    ];
    for (const [overrides, date, message] of invalidResponses) {
      expect(() => parseReleaseAuthorityStatusResponse(
        statusResponse("success", 101, overrides),
        date,
        { app, state: "success", targetSha },
      )).toThrow(message);
    }
    for (const date of [null, "", "2026-09-05T01:00:10Z", "Sat, 32 Sep 2026 01:00:10 GMT"]) {
      expect(() => parseReleaseAuthorityStatusResponse(
        statusResponse("success", 101),
        date,
        { app, state: "success", targetSha },
      )).toThrow();
    }
    expect(() => parseReleaseAuthorityStatusResponse(
      statusResponse("success", 101),
      "Sat, 05 Sep 2026 01:00:10 GMT",
      { app: { ...app, repositoryId: 1 }, state: "success", targetSha },
    )).toThrow("exact Message Like Me repository");
    expect(() => parseReleaseAuthorityStatusResponse(
      statusResponse("success", 101),
      "Sat, 05 Sep 2026 02:00:00 GMT",
      { app, state: "success", targetSha },
    )).toThrow("before the exact App token expiry");
  });

  test("requires a complete exact combined-status readback", () => {
    const consumption = statusReceipt("error", 102);
    expect(parseReleaseAuthorityCombinedStatusResponse(
      combinedResponse(),
      "Sat, 05 Sep 2026 01:00:12 GMT",
      { app, consumption, targetSha },
    ).terminalStatusId).toBe(102);
    const unrelatedStatus = {
      ...combinedStatusResponse("success", 501),
      context: "ci/example",
      description: "Unrelated status",
    };
    expect(parseReleaseAuthorityCombinedStatusResponse(
      combinedResponse(undefined, {
        statuses: [unrelatedStatus, combinedStatusResponse("error", 102)],
        total_count: 2,
      }),
      "Sat, 05 Sep 2026 01:00:12 GMT",
      { app, consumption, targetSha },
    ).statusCount).toBe(2);

    const cases: readonly [Readonly<Record<string, unknown>>, unknown, string][] = [
      [{ sha: "0".repeat(40) }, "Sat, 05 Sep 2026 01:00:12 GMT", "exact failed target"],
      [{ state: "success" }, "Sat, 05 Sep 2026 01:00:12 GMT", "exact failed target"],
      [{ repository: { ...repository(), id: 1 } }, "Sat, 05 Sep 2026 01:00:12 GMT", "not exact Message Like Me"],
      [{ total_count: 2 }, "Sat, 05 Sep 2026 01:00:12 GMT", "complete bounded status set"],
      [{ total_count: 101 }, "Sat, 05 Sep 2026 01:00:12 GMT", "complete bounded status set"],
      [{ statuses: [] , total_count: 0 }, "Sat, 05 Sep 2026 01:00:12 GMT", "complete bounded status set"],
      [{ statuses: [combinedStatusResponse("error", 102), combinedStatusResponse("error", 102)], total_count: 2 }, "Sat, 05 Sep 2026 01:00:12 GMT", "duplicate identity"],
      [{ statuses: [combinedStatusResponse("error", 102), combinedStatusResponse("error", 103)], total_count: 2 }, "Sat, 05 Sep 2026 01:00:12 GMT", "no unique newest authority context"],
      [{ statuses: [combinedStatusResponse("error", 103)] }, "Sat, 05 Sep 2026 01:00:12 GMT", "exact terminal consumption"],
    ];
    for (const [overrides, date, message] of cases) {
      expect(() => parseReleaseAuthorityCombinedStatusResponse(
        combinedResponse(undefined, overrides),
        date,
        { app, consumption, targetSha },
      )).toThrow(message);
    }
    for (const [date, message] of [
      ["Sat, 05 Sep 2026 01:00:10 GMT", "closely follow consumption"],
      ["Sat, 05 Sep 2026 01:00:27 GMT", "closely follow consumption"],
    ] as const) {
      expect(() => parseReleaseAuthorityCombinedStatusResponse(
        combinedResponse(),
        date,
        { app, consumption, targetSha },
      )).toThrow(message);
    }
  });

  test("exports only phase-specific environment wrappers and no arbitrary-operation status lifecycle", async () => {
    const source = await readFile(helperUrl, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(withReleaseAuthorityAttestationFromEnvironment.length).toBe(2);
    expect(withReleaseAuthorityTerminalStatusFromEnvironment.length).toBe(2);
    expect(source).not.toContain("contents:");
    expect(source).not.toContain("workflows:");
    expect(source).not.toContain("release-ref-writer");
    expect(source).not.toContain("export function withReleaseAuthorityStatus(");
    expect(source).not.toContain("export function withReleaseAuthorityStatusFromEnvironment(");
    expect(source).toContain("withReleaseAppTokenFromEnvironment");
  });

  test("accepts GitHub's 201 creation Location and completes the status-only revocation transaction", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const installationToken = "exact-status-only-installation-token";
    const environment = Object.freeze({
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "hraness/textbutler",
      GITHUB_REPOSITORY_ID: "1342143606",
      GITHUB_REPOSITORY_OWNER: "hraness",
      MLM_RELEASE_APP_CLIENT_ID: app.clientId,
      MLM_RELEASE_APP_ID: String(app.appId),
      MLM_RELEASE_APP_INSTALLATION_ID: String(app.installationId),
      MLM_RELEASE_APP_PRIVATE_KEY: privateKeyPem,
      MLM_RELEASE_APP_SLUG: app.appSlug,
      TARGET: targetSha,
    });
    const exactPermissions = { metadata: "read", statuses: "write" };
    const events: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalStdoutWrite = process.stdout.write;
    let deniedReads = 0;
    try {
      Date.now = () => Date.parse("2026-09-05T01:00:00Z");
      process.stdout.write = ((chunk: string | Uint8Array) => {
        expect(String(chunk)).toBe(`::add-mask::${installationToken}\n`);
        events.push("mask");
        return true;
      }) as typeof process.stdout.write;
      globalThis.fetch = (async (request: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(request));
        const method = init?.method ?? "GET";
        const headers = init?.headers as Readonly<Record<string, string>>;
        events.push(`${method} ${url.pathname}${url.search}`);
        expect(url.origin).toBe("https://api.github.com");
        expect(init?.redirect).toBe("error");
        if (url.pathname === "/app") {
          return new Response(JSON.stringify({
            client_id: app.clientId,
            id: app.appId,
            owner: { login: "hraness", type: "Organization" },
            permissions: exactPermissions,
            slug: app.appSlug,
          }), { status: 200 });
        }
        if (url.pathname === `/app/installations/${String(app.installationId)}`) {
          return new Response(JSON.stringify({
            account: { login: "hraness", type: "Organization" },
            app_id: app.appId,
            app_slug: app.appSlug,
            id: app.installationId,
            permissions: exactPermissions,
            repository_selection: "selected",
            target_type: "Organization",
          }), { status: 200 });
        }
        if (url.pathname === `/app/installations/${String(app.installationId)}/access_tokens`) {
          expect(JSON.parse(String(init?.body))).toEqual({
            permissions: exactPermissions,
            repository_ids: [1_342_143_606],
          });
          return new Response(JSON.stringify({
            expires_at: "2026-09-05T02:00:00Z",
            permissions: exactPermissions,
            repositories: [{
              full_name: "hraness/textbutler",
              id: 1_342_143_606,
              name: "textbutler",
              owner: { login: "hraness" },
            }],
            repository_selection: "selected",
            token: installationToken,
          }), {
            headers: { Date: "Sat, 05 Sep 2026 01:00:00 GMT" },
            status: 201,
          });
        }
        if (url.pathname === `/repos/hraness/textbutler/statuses/${targetSha}`) {
          expect(method).toBe("POST");
          expect(headers).toEqual({
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${installationToken}`,
            "Content-Type": "application/json",
            "User-Agent": "message-like-me-release-attester",
            "X-GitHub-Api-Version": "2022-11-28",
          });
          const body = JSON.parse(String(init?.body)) as { state: "error" | "success" };
          const id = body.state === "success" ? 101 : 102;
          return new Response(JSON.stringify(statusResponse(body.state, id)), {
            headers: {
              Date: body.state === "success"
                ? "Sat, 05 Sep 2026 01:00:10 GMT"
                : "Sat, 05 Sep 2026 01:00:11 GMT",
              Location: `https://api.github.com/repos/hraness/textbutler/statuses/${targetSha}`,
            },
            status: 201,
          });
        }
        if (url.pathname === `/repos/hraness/textbutler/commits/${targetSha}/status`) {
          expect(method).toBe("GET");
          expect(url.search).toBe("?per_page=100");
          expect(headers).toEqual({
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${installationToken}`,
            "Cache-Control": "no-cache",
            "User-Agent": "message-like-me-release-attester",
            "X-GitHub-Api-Version": "2022-11-28",
          });
          return new Response(JSON.stringify(combinedResponse()), {
            headers: { Date: "Sat, 05 Sep 2026 01:00:12 GMT" },
            status: 200,
          });
        }
        if (url.pathname === "/installation/token") {
          expect(method).toBe("DELETE");
          return new Response(null, {
            headers: {
              "Content-Length": "0",
              Date: "Sat, 05 Sep 2026 01:00:13 GMT",
            },
            status: 204,
          });
        }
        expect(url.pathname).toBe("/installation/repositories");
        expect(method).toBe("GET");
        deniedReads += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          headers: { Date: "Sat, 05 Sep 2026 01:00:13 GMT" },
          status: 401,
        });
      }) as typeof fetch;

      const attestation = await withReleaseAuthorityAttestationFromEnvironment(
        environment,
        async (receipt) => {
          expect(receipt.converged).toBe(true);
          events.push("attestation-revoked");
        },
      );
      expect(attestation.state).toBe("success");
      const terminal = await withReleaseAuthorityTerminalStatusFromEnvironment(
        environment,
        async (receipt) => {
          expect(receipt.converged).toBe(true);
          events.push("terminal-revoked");
        },
      );
      expect(terminal.readback.terminalStatusId).toBe(102);
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalDateNow;
      process.stdout.write = originalStdoutWrite;
    }
    expect(deniedReads).toBe(4);
    expect(events).toEqual([
      "GET /app",
      `GET /app/installations/${String(app.installationId)}`,
      `POST /app/installations/${String(app.installationId)}/access_tokens`,
      "mask",
      `POST /repos/hraness/textbutler/statuses/${targetSha}`,
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
      "attestation-revoked",
      "GET /app",
      `GET /app/installations/${String(app.installationId)}`,
      `POST /app/installations/${String(app.installationId)}/access_tokens`,
      "mask",
      `POST /repos/hraness/textbutler/statuses/${targetSha}`,
      `GET /repos/hraness/textbutler/commits/${targetSha}/status?per_page=100`,
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
      "terminal-revoked",
    ]);
  });
});
