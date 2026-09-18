/** Synthetic public-CLI fixture. Never reads Messages, Contacts, credentials, or model accounts. */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2), operation = args[2], authId = args[args.indexOf("--auth") + 1];
const input = JSON.parse(await Bun.stdin.text());
const directory = process.env.GHOSTGET_STATE_HOME!;
appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ args, input, runtimeArgs: process.execArgv, supportAudience: process.env.HRANESS_SUPPORT_AUDIENCE, supportEmail: process.env.HRANESS_SUPPORT_EMAIL }) + "\n", { mode: 0o600 });
if (authId === "slow") {
  // Acknowledge the completed call record before a test interrupts this process.
  writeFileSync(join(directory, "slow-ready"), "ready\n", { mode: 0o600 });
  await Bun.sleep(10_000);
}
if (authId === "graceful" && !args.includes("--projection-identity-only")) {
  const child = spawn(process.execPath, ["--no-env-file", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  await Bun.sleep(100);
  writeFileSync(join(directory, "descendant.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  await new Promise<void>(resolve => process.once("SIGTERM", () => {
    process.kill(-child.pid!, "SIGTERM");
    setTimeout(() => { process.kill(-child.pid!, "SIGKILL"); }, 700);
    child.once("exit", () => resolve());
  }));
}
if (args[0] !== "invoke" || args[1] !== "imessage-direct" || !["messaging.list", "conversations.read", "messaging.read"].includes(operation!)) process.exit(9);
const chat = { guid: "synthetic-chat", id: 42, service: "iMessage", kind: "single", title: "Synthetic Robin", participants: ["synthetic@example.invalid"], observedAccountId: "synthetic-account", observedAccountLogin: null, observedLastAddressedHandle: null };
if (args.includes("--projection-identity-only")) {
  console.log(JSON.stringify({ ok: true, source: "projection-identity", status: "ready", authIdentity: (authId === "drift" && operation !== "messaging.list" ? "c" : "a").repeat(64), authHash: "b".repeat(64), inputHash: "d".repeat(64), projection: { key: "synthetic-projection" } }));
} else {
  if (operation !== "messaging.list" && (input.chat_guid !== chat.guid || input.observed_chat_row_id !== chat.id || input.service !== "iMessage")) process.exit(8);
  console.log(JSON.stringify({ ok: true, status: "succeeded", runId: "synthetic-run", receipt: { schemaVersion: 7, runId: "synthetic-run", transport: "local-cli", risk: "R1", status: "succeeded", operation, adapter: { id: "imessage-direct" }, auth: { id: authId, hash: (authId === "receipt-drift" ? "c" : "b").repeat(64) } }, source: authId === "cache" ? "cache" : "live", output: { provider: "imessage", operation, accountSubject: "synthetic-device", accountSelection: "device-default", service: "iMessage", transport: "applescript", smsFallback: false, ...(operation === "messaging.list" ? { conversations: [chat] } : { conversation: chat }), ...(operation === "messaging.read" ? { messages: [
    { chatGuid: chat.guid, chatId: chat.id, guid: "synthetic-text", createdAt: "2026-09-11T12:00:00.000Z", isFromMe: false, text: "Synthetic hello" },
    { chatGuid: chat.guid, chatId: chat.id, guid: "synthetic-empty", createdAt: "2026-09-11T12:00:01.000Z", isFromMe: false, text: "" },
    { chatGuid: chat.guid, chatId: chat.id, guid: "synthetic-butler", createdAt: "2026-09-11T12:00:02.000Z", isFromMe: true, text: "🤖{ A synthetic reply }" },
  ] } : {}) } }));
}

if ((authId === "overflow" || authId === "stderr-overflow") && !args.includes("--projection-identity-only")) {
  process.once("SIGTERM", () => process.exit(0));
  // A successful-looking terminal prefix must not excuse later output overflow.
  (authId === "overflow" ? process.stdout : process.stderr).write(" ".repeat(9 * 1024 * 1024));
  await Bun.sleep(5000);
}
