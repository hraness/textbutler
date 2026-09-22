import { join, isAbsolute, resolve } from "node:path";
import { createPrivateFileOnce } from "@hraness/local-custody/atomic-publish";
import { assertOwnedPath, ensurePrivateDirectory } from "@hraness/local-custody/private-paths";

async function bounded(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const reader = stream.getReader(), parts: Uint8Array[] = []; let count = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.length; if (count > maximum) throw Error("CLI output limit"); parts.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}
async function main() {
  const [teamFlag, team, dataFlag, dataDir, ...extra] = process.argv.slice(2);
  if (teamFlag !== "--team" || !team || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(team) || dataFlag !== "--data-dir" || !dataDir || !isAbsolute(dataDir) || resolve(dataDir) !== dataDir || extra.length) throw Error("Use --team TEAM --data-dir ABSOLUTE_PRIVATE_DIRECTORY");
  await assertOwnedPath(dataDir, { kind: "directory", canonical: true, ownerOnly: true });
  const state = join(dataDir, "state"); await assertOwnedPath(state, { kind: "directory", canonical: true, ownerOnly: true });
  const credentials = await ensurePrivateDirectory(join(state, "provider-credentials")), name = "habitat-gateway";
  try { await assertOwnedPath(join(credentials, name), { kind: "file", ownerOnly: true, links: 1 }); console.log(JSON.stringify({ ok: true, existing: true, credentialFile: name, activated: false })); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const intent = { version: 1, team, name: "textbutler-habitats", dailyBudgetUsd: 1, includeByok: true, credentialFile: name };
  if (await createPrivateFileOnce(credentials, "habitat-gateway-intent.json", JSON.stringify(intent)) !== "created") throw Error("A prior key creation needs reconciliation; no duplicate key was created");
  const cli = Bun.which("vercel"); if (!cli) throw Error("Vercel CLI is required");
  const child = Bun.spawn([cli, "api", "/v1/api-keys", "--method", "POST", "--input", "-", "--raw", "--scope", team, "--non-interactive"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => { child.kill("SIGTERM"); killer = setTimeout(() => child.kill("SIGKILL"), 5000); }, 60_000);
  try {
    child.stdin.write(JSON.stringify({ purpose: "ai-gateway", name: intent.name, aiGatewayQuota: { limitAmount: 1, refreshPeriod: "daily", includeByokInQuota: true } })); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([bounded(child.stdout, 65_536), bounded(child.stderr, 65_536), child.exited]);
    if (code !== 0) throw Error(/log ?in|authenticat/iu.test(stderr) ? "Vercel authentication needs owner attention; raw diagnostics withheld" : "Vercel key creation did not settle; raw diagnostics withheld; inspect the exact team before any retry");
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || !("apiKeyString" in result) || typeof result.apiKeyString !== "string" || !/^vck_[A-Za-z0-9_-]{16,4096}$/u.test(result.apiKeyString)
      || !("apiKey" in result) || !result.apiKey || typeof result.apiKey !== "object" || !("id" in result.apiKey) || typeof result.apiKey.id !== "string") throw Error("Vercel returned an unexpected key response; reconcile the recorded attempt before retrying");
    if (await createPrivateFileOnce(credentials, name, result.apiKeyString) !== "created") throw Error("Credential publication conflicted; reconcile before activation");
    const metadata = result.apiKey as Record<string, unknown>, rawQuota = metadata.quota ?? metadata.aiGatewayQuota;
    const quota = rawQuota && typeof rawQuota === "object" ? { limitAmount: (rawQuota as Record<string, unknown>).limitAmount === 1 ? 1 : null,
      refreshPeriod: (rawQuota as Record<string, unknown>).refreshPeriod === "daily" ? "daily" : null,
      includeByokInQuota: (rawQuota as Record<string, unknown>).includeByokInQuota === true } : null;
    await createPrivateFileOnce(credentials, "habitat-gateway-receipt.json", JSON.stringify({ ...intent, id: result.apiKey.id, quota }));
    console.log(JSON.stringify({ ok: true, credentialFile: name, activated: false }));
  } finally { clearTimeout(timer); if (killer) clearTimeout(killer); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error && !error.message.includes("vck_") ? error.message : "Gateway key setup failed; secret diagnostics withheld"); process.exitCode = 1; });
