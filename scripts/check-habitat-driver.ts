import { isAbsolute } from "node:path";
import { readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { RunJournal } from "../packages/textbutler/src/journal.ts";
import { createFastDriver, parseFastDriverConfig } from "../packages/textbutler/src/fast-driver.ts";
import { executeHabitatProgram } from "../packages/textbutler/src/habitat-program.ts";
import { DEFAULT_HABITAT_PLAN } from "../packages/textbutler/src/contact-habitat.ts";

async function main() {
  const [keyFlag, keyPath, modelFlag, model, extra] = process.argv.slice(2);
  if (keyFlag !== "--credential-file" || !keyPath || !isAbsolute(keyPath) || modelFlag !== "--model" || !model || extra !== undefined && extra !== "--search" || process.argv.length > 7) throw Error("Use --credential-file ABS_PATH --model MODEL [--search]");
  const config = parseFastDriverConfig({ kind: "gateway", model, credentialFile: "explicit-synthetic-check", dailyBudgetUsd: 1 });
  const journal = RunJournal.memory(), signal = AbortSignal.timeout(30_000);
  try {
    const driver = createFastDriver(config, { journal, credential: async () => new TextDecoder("utf-8", { fatal: true }).decode(await readOwnedFileStable(keyPath, 8192)).trim() });
    const start = performance.now();
    if (extra === "--search") {
      const result = await driver.search(`synthetic-search-${crypto.randomUUID()}`, "Vercel AI Gateway Exa search documentation", signal);
      console.log(JSON.stringify({ ok: true, synthetic: true, operation: "exa-search", model, elapsedMs: Math.round(performance.now() - start), result }));
    } else {
      const run = await executeHabitatProgram({ phase: "respond", plan: DEFAULT_HABITAT_PLAN, signal, executor: driver.executor(`synthetic-driver-${crypto.randomUUID()}`),
        context: { message: "Butler, explain why the sky is blue in one short sentence.", output: 'Return {"respond":true,"confidence":0.99,"reason":"requested","summary":"Explain clearly","actions":[{"kind":"text","text":"your answer"}],"tool":null}. No real conversation is involved; do not send anything.' } });
      console.log(JSON.stringify({ ok: true, synthetic: true, operation: "reply-proposal-only", model, elapsedMs: Math.round(performance.now() - start), receiptDigest: run.receipt.digest, output: run.output }));
    }
  } finally { journal.close(); }
}
if (import.meta.main) main().catch(() => { console.error("Synthetic Gateway qualification failed; provider output and credentials withheld. No message was sent."); process.exitCode = 1; });
