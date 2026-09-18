import { basename } from "node:path";
import { AUTOMATION_PROTOCOL } from "../../transport/src/automation-contract.ts";

// Every successful synthetic handshake proves the real delegated child is quiet.
if (process.env.HRANESS_SUPPORT_AUDIENCE !== "off" || process.env.HRANESS_SUPPORT_EMAIL !== "off") process.exit(4);
if (process.argv.slice(2).join(" ") !== "messaging automation serve --stdio") process.exit(2);
const mode = basename(process.env.GHOSTGET_STATE_HOME ?? "normal");
let buffer = "", sending: Record<string, unknown> | undefined;
function reply(row: Record<string, unknown>, result: unknown) { process.stdout.write(JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id: mode === "wrong-id" ? "unexpected" : row.id, ok: true, result }) + "\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) !== -1) {
    const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (request.method === "initialize") reply(request, { initialized: true });
    else if (request.method === "submit") sending = request;
    else if (request.method === "cancel") {
      reply(request, { cancelled: true });
      if (sending) { const params = sending.params as Record<string, string>; reply(sending, { id: "run:fixture", planId: params.planId, intentId: "intent:fixture", enrollmentId: "enrollment:fixture", state: "partial", accepted: [{ messageId: "sent:fixture", providerReceiptId: null }], totalActions: 2, reason: "Synthetic cancellation", retryable: false }); sending = undefined; }
    } else if (request.method === "close") { reply(request, { closed: true }); process.stdin.pause(); setTimeout(() => process.exit(0), 5); }
    else process.exit(3);
  }
});
