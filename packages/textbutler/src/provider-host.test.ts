import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentStoppedError, createClaudeApiAdapter, createToolBroker, type ClaudeApiAdapterOptions, type ModelCatalog } from "@hraness/agentmixer";
import { createProviderHost, type ProviderHost } from "./provider-host.ts";
import { parseHostConfig } from "./host-config.ts";
import { RunJournal } from "./journal.ts";
import { newContact } from "./config.ts";

const roots: string[] = [], hosts: ProviderHost[] = [], journals: RunJournal[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const journal of journals.splice(0)) journal.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const at = 1_000_000_000;
function account(id: string) { return { id, label: `Synthetic ${id}`, route: "claude-api", credentialFile: `${id}-key`, replyModel: "synthetic-reply",
  prices: { observedAt: at, models: [
    { id: "synthetic-reply", inputUsdPerMillion: 2, outputUsdPerMillion: 8, classifierEligible: true },
    { id: "synthetic-cheap", inputUsdPerMillion: 1, outputUsdPerMillion: 3, classifierEligible: true },
  ] } }; }
const contact = (id = "account-a") => ({ ...newContact("person", "Synthetic person", "route"), provider: "claude" as const, accountId: id });
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "textbutler-providers-")); roots.push(root);
  await mkdir(join(root, "state"), { mode: 0o700 }); await mkdir(join(root, "state", "provider-credentials"), { mode: 0o700 });
  const keys = new Map(["account-a", "account-b"].map(id => [id, ["sk", "ant", "api03", "synthetic", id, "credential"].join("-")]));
  for (const [id, key] of keys) await writeFile(join(root, "state", "provider-credentials", `${id}-key`), key, { mode: 0o600 });
  const entrypoint = join(root, "synthetic-compiled-entry.js"), bytes = "Synthetic compiled host artifact; never production evidence";
  await writeFile(entrypoint, bytes, { mode: 0o600 });
  const runtimeArtifact = { entrypoint, sha256: createHash("sha256").update(bytes).digest("hex") };
  const journal = RunJournal.memory(); journals.push(journal);
  const config = parseHostConfig({ schemaVersion: 1, providerAccounts: [account("account-a"), account("account-b")] });
  return { root, keys, config, runtimeArtifact, journal };
}
function broker(runId: string) {
  const no = async (): Promise<never> => { throw new Error("Fixture has no tools"); };
  return createToolBroker({ workspaceId: "person", runId, allowedTools: [], signal: new AbortController().signal, isActive: () => true,
    files: { read: no, write: no }, web: { fetchPublic: no }, messaging: { stage: no } });
}

test("source mode and coding-agent selections never discover or substitute an API account", async () => {
  const f = await fixture(); let calls = 0;
  const host = createProviderHost({ dataDir: f.root, config: f.config, leases: f.journal.accountLeases(), now: () => at }, {
    createAdapter: async () => { calls++; throw new Error("unexpected"); }, discover: async () => { calls++; throw new Error("unexpected"); },
  }); hosts.push(host);
  expect(host.accounts().map(value => value.route)).toEqual(["codex", "claude-code", "claude-api", "claude-api"]);
  expect(host.accounts().every(value => value.status !== "ready")).toBe(true);
  await expect(host.check("account-a", new AbortController().signal)).rejects.toThrow("setup");
  await expect(host.selection(contact("native-claude-code"))).rejects.toThrow("no API substitution");
  await expect(host.selection(newContact("person", "Synthetic", "route"))).rejects.toThrow();
  expect(calls).toBe(0);
  expect(JSON.stringify(host.accounts())).not.toContain("credentialFile");
  expect(JSON.stringify(host.accounts())).not.toContain("account-a-key");
});

test("explicit API accounts bind their own credential, catalog and lease while choosing a cheap classifier", async () => {
  const f = await fixture(), calls: string[] = []; const configured = new Map<string, ClaudeApiAdapterOptions>();
  const host = createProviderHost({ dataDir: f.root, config: f.config, runtimeArtifact: f.runtimeArtifact, leases: f.journal.accountLeases(), now: () => at }, {
    createAdapter: async options => {
      const adapter = await createClaudeApiAdapter(options);
      return { ...adapter, async run(request) {
        configured.set(request.accountId, options);
        const selected = await options.modelCatalog(request.accountId);
        await options.credentials.withApiKey(request.accountId, request.signal, async key => { expect(key).toBe(f.keys.get(request.accountId)!); });
        expect(selected.provider).toBe("claude"); calls.push(request.accountId);
        return { output: { respond: false, confidence: 1, reason: "not_needed" }, processStopped: true };
      } };
    },
    discover: async options => {
      await options.credentials.withApiKey(options.accountId, options.signal, async key => { expect(key).toBe(f.keys.get(options.accountId)!); });
      return { provider: "claude", observedAt: at, models: options.priceCatalog.models.map(row => ({ ...row, available: true, supportsStructuredOutput: true })) };
    },
  }); hosts.push(host);
  for (const accountId of ["account-a", "account-b"]) {
    await host.check(accountId, new AbortController().signal);
    expect(host.accounts().find(value => value.id === accountId)).toMatchObject({ status: "ready", classifierModel: "synthetic-cheap", defaultReplyModel: "synthetic-reply" });
    expect((await host.selection(contact(accountId))).defaultReplyModel).toBe("synthetic-reply");
    const runId = `run-${accountId}`;
    await host.router.run({ accountId, provider: "claude", workspaceId: "person", runId, prompt: "Synthetic classification", purpose: "classify", model: "synthetic-cheap", signal: new AbortController().signal }, broker(runId));
    expect(f.journal.accountLeases().inspect("claude", accountId)).toBeNull();
  }
  expect(calls).toEqual(["account-a", "account-b"]);
  await expect(configured.get("account-a")!.modelCatalog("account-b")).rejects.toThrow("revoked");
  const runId = "native-attempt";
  await expect(host.router.run({ accountId: "native-claude-code", provider: "claude", workspaceId: "person", runId, prompt: "Synthetic", purpose: "classify", model: "synthetic-cheap", signal: new AbortController().signal }, broker(runId))).rejects.toThrow("ROUTE_UNAVAILABLE");
  expect(calls).toHaveLength(2);
  expect(f.journal.accountLeases().inspect("claude", "native-claude-code")).toBeNull();
  await host.close();
  expect(host.accounts().every(value => value.status !== "ready")).toBe(true);
  await expect(host.selection(contact())).rejects.toThrow();
});

test("changed compiled bytes stop setup before credentials or network and native account changes require explicit selection", async () => {
  const f = await fixture(); let discoveries = 0;
  await writeFile(f.runtimeArtifact.entrypoint, "changed synthetic bytes");
  const host = createProviderHost({ dataDir: f.root, config: f.config, runtimeArtifact: f.runtimeArtifact, leases: f.journal.accountLeases(), now: () => at }, {
    createAdapter: createClaudeApiAdapter, discover: async () => { discoveries++; throw new Error("unexpected"); },
  }); hosts.push(host);
  await expect(host.check("account-a", new AbortController().signal)).rejects.toThrow("setup"); expect(discoveries).toBe(0);
  expect(() => host.validateAccountChange(newContact("person", "Synthetic", "route"), { provider: "claude" })).not.toThrow();
  expect(() => host.validateAccountChange(contact(), { provider: "claude" })).not.toThrow();
  expect(() => host.validateAccountChange({ ...contact(), provider: "codex" }, { provider: "claude" })).toThrow("explicitly");
  expect(() => host.validateAccountChange(contact(), { provider: "codex", accountId: "account-a" })).toThrow();
  expect(() => host.validateAccountChange(contact(), { provider: "claude", accountId: "missing" })).toThrow();
  expect(() => host.validateAccountChange(contact(), { provider: "codex", accountId: "native-codex" })).not.toThrow();
});

test("price expiry and interrupted model checks cannot leave a ready account", async () => {
  const f = await fixture(); let now = at, suspend = false, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const host = createProviderHost({ dataDir: f.root, config: f.config, runtimeArtifact: f.runtimeArtifact, leases: f.journal.accountLeases(), now: () => now }, {
    createAdapter: createClaudeApiAdapter,
    discover: async options => {
      if (suspend) { began(); await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Synthetic key diagnostic must not escape")), { once: true })); }
      return { provider: "claude", observedAt: now, models: options.priceCatalog.models.map(row => ({ ...row, available: true, supportsStructuredOutput: true })) } satisfies ModelCatalog;
    },
  }); hosts.push(host);
  await host.check("account-a", new AbortController().signal);
  now += 30 * 86_400_000 + 1;
  expect(host.accounts().find(value => value.id === "account-a")?.status).toBe("setup-required");
  await expect(host.selection(contact())).rejects.toThrow("setup");
  now = at; suspend = true;
  const checking = host.check("account-a", new AbortController().signal).then(() => null, error => error as Error);
  await started; await host.close();
  expect((await checking)?.message).toContain("Provider setup could not be verified");
  expect(host.accounts().every(value => value.status !== "ready")).toBe(true);
});

test("credential replacement between classifier and response cannot reuse availability or silently switch billing", async () => {
  const f = await fixture(), used: string[] = []; let discoveries = 0;
  const host = createProviderHost({ dataDir: f.root, config: f.config, runtimeArtifact: f.runtimeArtifact, leases: f.journal.accountLeases(), now: () => at }, {
    createAdapter: async options => ({ ...await createClaudeApiAdapter(options), async run(request) {
      try {
        await options.modelCatalog(request.accountId);
        return await options.credentials.withApiKey(request.accountId, request.signal, async key => { used.push(key); return { output: {}, processStopped: true }; });
      } catch { throw new AgentStoppedError("SYNTHETIC_STOPPED"); }
    } }),
    discover: async options => { discoveries++; await options.credentials.withApiKey(options.accountId, options.signal, async () => {});
      return { provider: "claude", observedAt: at, models: options.priceCatalog.models.map(row => ({ ...row, available: true, supportsStructuredOutput: true })) }; },
  }); hosts.push(host);
  const run = (runId: string) => host.router.run({ provider: "claude", accountId: "account-a", workspaceId: "person", runId, prompt: "Synthetic", purpose: "classify", model: "synthetic-cheap", signal: new AbortController().signal }, broker(runId));
  await host.check("account-a", new AbortController().signal); await run("classification");
  const replacement = ["sk", "ant", "api03", "synthetic", "replacement", "credential"].join("-");
  await writeFile(join(f.root, "state", "provider-credentials", "account-a-key"), replacement);
  await expect(run("response")).rejects.toThrow("SYNTHETIC_STOPPED");
  expect(used).toEqual([f.keys.get("account-a")!]); expect(f.journal.accountLeases().inspect("claude", "account-a")).toBeNull();
  expect(host.accounts().find(value => value.id === "account-a")?.status).toBe("setup-required");
  await expect(host.selection(contact())).rejects.toThrow("setup"); expect(discoveries).toBe(1);
  await host.check("account-a", new AbortController().signal); await run("explicit-replacement");
  expect(discoveries).toBe(2); expect(used).toEqual([f.keys.get("account-a")!, replacement]);
  expect(JSON.stringify(host.accounts())).not.toContain(replacement);
});

test("credential drift during discovery fails admission and a new checked generation aborts the old run", async () => {
  const f = await fixture(); let swap = true, started!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  const replacement = ["sk", "ant", "api03", "synthetic", "new", "credential"].join("-");
  const host = createProviderHost({ dataDir: f.root, config: f.config, runtimeArtifact: f.runtimeArtifact, leases: f.journal.accountLeases(), now: () => at }, {
    createAdapter: async options => ({ ...await createClaudeApiAdapter(options), async run(request) {
      try { return await options.credentials.withApiKey(request.accountId, request.signal, async () => {
        started(); await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
        return { output: {}, processStopped: true };
      }); } catch { throw new AgentStoppedError("SYNTHETIC_STOPPED"); }
    } }),
    discover: async options => {
      await options.credentials.withApiKey(options.accountId, options.signal, async () => { if (swap) { swap = false; await writeFile(join(f.root, "state", "provider-credentials", "account-a-key"), replacement); } });
      return { provider: "claude", observedAt: at, models: options.priceCatalog.models.map(row => ({ ...row, available: true, supportsStructuredOutput: true })) };
    },
  }); hosts.push(host);
  await expect(host.check("account-a", new AbortController().signal)).rejects.toThrow("setup");
  expect(host.accounts().find(value => value.id === "account-a")?.status).toBe("setup-required");
  await host.check("account-a", new AbortController().signal);
  const runId = "old-generation";
  const run = host.router.run({ provider: "claude", accountId: "account-a", workspaceId: "person", runId, prompt: "Synthetic", purpose: "classify", model: "synthetic-cheap", signal: new AbortController().signal }, broker(runId)).then(() => null, error => error as Error);
  await runStarted; await host.check("account-a", new AbortController().signal);
  expect((await run)?.message).toBe("SYNTHETIC_STOPPED");
  expect(f.journal.accountLeases().inspect("claude", "account-a")).toBeNull();
  expect(host.accounts().find(value => value.id === "account-a")?.status).toBe("ready");
});
