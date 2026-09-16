import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createManagedCodexAccountController, type CodexAccountBinding, type CodexAccountEvent, type CodexAccountRequest } from "@hraness/agentmixer";
import { CONTROL_PROTOCOL as protocol, parseControlResponse, type ControlResponse } from "../../control/src/index.ts";
import { createProviderHost } from "./provider-host.ts";
import { TextbutlerControlService, parseControlRequest } from "./control-service.ts";
import { newContact } from "./config.ts";

const roots: string[] = [], services: TextbutlerControlService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "textbutler-managed-account-")); roots.push(root);
  let created = 0, signedIn = false, closed = 0;
  let binding: CodexAccountBinding | undefined, onEvent: ((event: CodexAccountEvent) => void) | undefined;
  const calls: string[] = [];
  const reply = (request: CodexAccountRequest, value: unknown) => ({ binding: request.binding, accountGeneration: request.accountGeneration, value });
  const service = await TextbutlerControlService.open({ dataDir: root, providers: leases => createProviderHost({ dataDir: root, config: { schemaVersion: 1 }, leases,
    managedCodex: ({ accountId, leases }) => {
      created++;
      return createManagedCodexAccountController({ accountId, owner: "synthetic-owner", processGeneration: 1, leases,
        transportFactory: (owned, notify) => {
          binding = owned; onEvent = notify;
          return {
            async accountRead(request) { calls.push("read"); return reply(request, { requiresOpenaiAuth: true, account: signedIn ? { type: "chatgpt", email: "synthetic@example.invalid", planType: "plus" } : null }); },
            async startLogin(request) { calls.push("login"); return reply(request, { type: "chatgptDeviceCode", loginId: "synthetic-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" }); },
            async cancelLogin(request) { calls.push("cancel"); return reply(request, { status: "canceled" }); },
            async logout(request) { calls.push("logout"); signedIn = false; return reply(request, {}); },
            async listModels(request) { calls.push("models"); return reply(request, { data: [{ id: "synthetic-model", model: "synthetic-model", displayName: "Synthetic model", description: "Fixture only", hidden: false, isDefault: true, defaultReasoningEffort: "ultra", supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "Fixture" }] }], nextCursor: null }); },
            async close({ binding }) { closed++; return { binding, processExited: true, processGroupStopped: true, stdoutEnded: true, stderrEnded: true, writesSettled: true, requestsSettled: true, notificationsSettled: true }; },
          };
        },
      });
    },
  }) }); services.push(service);
  return { root, service, calls, created: () => created, closed: () => closed,
    signIn() { signedIn = true; onEvent?.({ binding: binding!, type: "login-completed", loginId: "synthetic-login", success: true }); },
  };
}
async function finish(service: TextbutlerControlService, value: unknown): Promise<ControlResponse> {
  let response = await service.request(value);
  for (let count = 0; response.ok && response.kind === "job" && count < 100; count++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    response = await service.request({ protocol, command: "owner.job.read", jobId: response.jobId });
  }
  return parseControlResponse(response);
}

test("owner managed login stays lazy, private, cancelable and separate from reply readiness", async () => {
  const f = await fixture(), accountId = "native-codex";
  expect(f.created()).toBe(0);
  expect((await f.service.snapshot()).providerAccounts?.find(account => account.id === accountId)).toMatchObject({ status: "unavailable", managedAccount: { state: "unchecked" } });
  const login = await finish(f.service, { protocol, command: "provider.accounts.login.start", accountId, method: "chatgptDeviceCode" });
  expect(login).toMatchObject({ ok: true, kind: "provider-login", accountId, challenge: { userCode: "TEST-ONLY" } });
  expect(f.created()).toBe(1);
  const pending = await finish(f.service, { protocol, command: "provider.accounts.check", accountId });
  expect(pending).toMatchObject({ ok: true, kind: "snapshot", snapshot: { providerAccounts: [{ managedAccount: { state: "signing-in" } }, {}] } });
  const privateSettings = await readFile(join(f.root, "state", "settings.json"), "utf8");
  expect(privateSettings).not.toContain("TEST-ONLY");
  expect(JSON.stringify(await f.service.snapshot())).not.toMatch(/TEST-ONLY|authUrl|verificationUrl|synthetic@example/);
  expect(f.calls).not.toContain("models");
  expect(await finish(f.service, { protocol, command: "provider.accounts.login.cancel", accountId, loginId: "wrong-login" })).toMatchObject({ ok: false });
  expect(f.calls).not.toContain("cancel");
  expect(await finish(f.service, { protocol, command: "provider.accounts.login.cancel", accountId, loginId: "synthetic-login" })).toMatchObject({ ok: true, kind: "snapshot" });
  expect(f.calls.filter(call => call === "cancel")).toHaveLength(1);
});

test("managed subscription discovery never authorizes execution or an API fallback", async () => {
  const f = await fixture(), accountId = "native-codex";
  await finish(f.service, { protocol, command: "provider.accounts.login.start", accountId, method: "chatgptDeviceCode" }); f.signIn();
  expect(await finish(f.service, { protocol, command: "provider.accounts.check", accountId })).toMatchObject({ ok: true, kind: "snapshot" });
  const account = (await f.service.snapshot()).providerAccounts?.find(account => account.id === accountId);
  expect(account).toMatchObject({ status: "unavailable", defaultReplyModel: null, classifierModel: null, managedAccount: { state: "signed-in", modelCount: 1 } });
  const contact = { ...newContact("synthetic-contact", "Synthetic", "synthetic-route"), accountId };
  await expect(f.service.providers!.selection(contact)).rejects.toThrow("no API substitution");
  expect(await finish(f.service, { protocol, command: "provider.accounts.logout", accountId })).toMatchObject({ ok: true });
  expect((await f.service.snapshot()).providerAccounts?.find(account => account.id === accountId)?.managedAccount?.state).toBe("signed-out");
  await f.service.close(); services.splice(services.indexOf(f.service), 1); expect(f.closed()).toBe(1);
});

test("owner login commands reject credential input, arbitrary methods and foreign account routes", async () => {
  const f = await fixture();
  for (const value of [
    { command: "provider.accounts.login.start", accountId: "native-codex", method: "apiKey" },
    { command: "provider.accounts.login.start", accountId: "native-codex", method: "chatgptAuthTokens" },
    { command: "provider.accounts.login.start", accountId: "native-codex", method: "chatgpt", accessToken: "synthetic-secret" },
    { command: "provider.accounts.logout", accountId: "../other" },
    { command: "provider.accounts.login.cancel", accountId: "native-codex", loginId: "\n" },
  ]) expect(() => parseControlRequest({ protocol, ...value })).toThrow();
  expect(await finish(f.service, { protocol, command: "provider.accounts.login.start", accountId: "native-claude-code", method: "chatgpt" })).toMatchObject({ ok: false });
  expect(f.created()).toBe(0);
});
