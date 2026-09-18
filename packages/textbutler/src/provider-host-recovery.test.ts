import { expect, test } from "bun:test";
import { createManagedCodexAccountController, type CodexAccountCloseReceipt, type CodexAccountRequest } from "@hraness/agentmixer";
import { createProviderHost } from "./provider-host.ts";
import { RunJournal } from "./journal.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const journal = RunJournal.memory(), leases = journal.accountLeases();
  const stopping = deferred<void>(), stopped = deferred<boolean>();
  let generation = 0, closes = 0;
  const reply = (request: CodexAccountRequest, value: unknown) => ({ binding: request.binding, accountGeneration: request.accountGeneration, value });
  const host = createProviderHost({ dataDir: "/synthetic-unused", config: { schemaVersion: 1 }, leases,
    managedCodex: ({ accountId, leases }) => {
      const processGeneration = ++generation;
      return createManagedCodexAccountController({ accountId, leases, processGeneration, owner: `synthetic-${generation}`,
        transportFactory: () => ({
          async accountRead(request) { return reply(request, { requiresOpenaiAuth: true, account: null }); },
          async startLogin(request) {
            if (processGeneration === 1) throw Error("synthetic interrupted dispatch");
            return reply(request, { type: "chatgptDeviceCode", loginId: `synthetic-${processGeneration}`, verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" });
          },
          async cancelLogin(request) { return reply(request, { status: "canceled" }); },
          async logout(request) { return reply(request, {}); },
          async listModels(request) { return reply(request, { data: [], nextCursor: null }); },
          async close({ binding }): Promise<CodexAccountCloseReceipt> {
            const attempt = ++closes; stopping.resolve();
            const joined = attempt === 1 ? await stopped.promise : true;
            return { binding, processExited: joined, processGroupStopped: joined, stdoutEnded: joined, stderrEnded: joined,
              writesSettled: joined, requestsSettled: joined, notificationsSettled: joined };
          },
        }),
      });
    },
  });
  const signal = new AbortController().signal;
  return { host, journal, leases, stopping, stopped, signal, generation: () => generation, closes: () => closes };
}

test("failed dispatched login joins its old helper before a fresh owner attempt", async () => {
  const f = fixture();
  try {
    const failed = f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal);
    const failure = failed.then(() => null, error => error);
    await f.stopping.promise;
    expect(f.leases.inspect("codex", "native-codex")?.owner).toBe("synthetic-1");
    await expect(f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal)).rejects.toThrow();
    expect(f.generation()).toBe(1);
    f.stopped.resolve(true); expect((await failure)?.message).toBe("CODEX_ACCOUNT_OPERATION_FAILED");
    expect(f.leases.inspect("codex", "native-codex")).toBeNull();
    expect(f.host.accounts()[0]?.managedAccount?.state).toBe("unchecked");
    expect(await f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal)).toMatchObject({ loginId: "synthetic-2" });
    expect(f.generation()).toBe(2);
    expect(f.host.accounts()[0]?.status).toBe("unavailable");
  } finally { f.stopped.resolve(true); await f.host.close(); f.journal.close(); }
});

test("an incomplete cleanup retains the original account until a later joined close", async () => {
  const f = fixture();
  try {
    const failure = f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal).then(() => null, error => error);
    await f.stopping.promise; f.stopped.resolve(false); expect((await failure)?.message).toBe("CODEX_ACCOUNT_OPERATION_FAILED");
    expect(f.host.accounts()[0]?.managedAccount?.state).toBe("recovery-required");
    expect(f.leases.inspect("codex", "native-codex")?.owner).toBe("synthetic-1");
    // An explicit check can finish recovery, but cannot replay the failed login.
    await expect(f.host.check("native-codex", f.signal)).rejects.toThrow();
    expect(f.closes()).toBe(2); expect(f.generation()).toBe(1);
    expect(f.leases.inspect("codex", "native-codex")).toBeNull();
    await f.host.check("native-codex", f.signal);
    expect(f.generation()).toBe(2);
  } finally { f.stopped.resolve(true); await f.host.close(); f.journal.close(); }
});

test("host shutdown waits for failed-login cleanup and forbids a replacement", async () => {
  const f = fixture();
  try {
    const failure = f.host.startLogin("native-codex", "chatgptDeviceCode", f.signal).then(() => null, error => error);
    await f.stopping.promise;
    const closing = f.host.close();
    await expect(f.host.check("native-codex", f.signal)).rejects.toThrow();
    expect(f.generation()).toBe(1);
    f.stopped.resolve(true); const [error] = await Promise.all([failure, closing]);
    expect(error).toBeInstanceOf(Error);
    expect(f.leases.inspect("codex", "native-codex")).toBeNull();
    expect(f.host.accounts()[0]?.managedAccount?.state).toBe("closed");
  } finally { f.stopped.resolve(true); await f.host.close(); f.journal.close(); }
});
