import { spawn } from "node:child_process";
import { basename } from "node:path";
import { AUTOMATION_PROTOCOL, automationBindingDigest } from "../../transport/src/automation-contract.ts";

// Every successful synthetic handshake proves the real delegated child is quiet.
if (process.env.HRANESS_SUPPORT_AUDIENCE !== "off" || process.env.HRANESS_SUPPORT_EMAIL !== "off") process.exit(4);
if (process.argv.slice(2).join(" ") !== "messaging automation serve --stdio") process.exit(2);
const mode = basename(process.env.GHOSTGET_STATE_HOME ?? "normal");
let buffer = "", sending: Record<string, unknown> | undefined;
const heldPolls: Record<string, unknown>[] = [];
let maxHeld = 0, totalPolls = 0;
const pollSetResult = (request: Record<string, unknown>) => {
  const ids = Array.isArray(request.params?.enrollmentIds) ? request.params.enrollmentIds : [];
  return { results: ids.map((id: unknown) => ({ enrollmentId: String(id), enrollment: fixtureEnrollment(String(id)), error: null })) };
};
const fixtureEnrollment = (id: string) => {
  const identity = { provider: "imessage", authId: "fixture", accountIdentity: "1".repeat(64), accountSubject: "imessage:fixture", implementationIdentity: "2".repeat(64), sourceGeneration: "fixture:1" };
  const coordinate = { provider: "imessage", chatGuid: "iMessage;-;fixture@example.test", service: "iMessage", observedChatRowId: 1 };
  const conversation = { coordinate, title: "Fixture", kind: "single", participants: ["fixture@example.test"] };
  return { id, identity, conversation, bindingDigest: automationBindingDigest(identity, conversation), revision: 0, ready: true, reason: null };
};
function reply(row: Record<string, unknown>, result: unknown) { process.stdout.write(JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id: mode === "wrong-id" ? "unexpected" : row.id, ok: true, result }) + "\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let at: number;
  while ((at = buffer.indexOf("\n")) !== -1) {
    const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (request.method === "initialize" && mode === "slow-initialize") {
      // A same-group helper burns CPU while initialize answers late, mirroring
      // a loaded host whose startup progress must extend the request watchdog.
      spawn(process.execPath, ["-e", "const s=Date.now();while(Date.now()-s<600);"], { detached: false, stdio: "ignore" }).unref();
      setTimeout(() => reply(request, { initialized: true }), 700);
    }
    else if (request.method === "initialize" && mode === "deaf-initialize") { /* A frozen child never answers. */ }
    else if (request.method === "initialize") reply(request, { initialized: true });
    else if (request.method === "conversations" && mode.startsWith("remote-")) {
      process.stdout.write(JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id: request.id, ok: false,
        error: { code: mode.slice("remote-".length), message: "private fixture body, handle and /synthetic/private/path" } }) + "\n");
    }
    else if (request.method === "conversations" && mode === "native-diagnostic") {
      process.stdout.write(JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id: request.id, ok: false,
        error: { code: "unavailable", message: "ghostget.discovery.v1:native-chats:response-invalid" } }) + "\n");
    }
    else if (request.method === "conversations" && mode === "non-string-error") {
      process.stdout.write(JSON.stringify({ protocol: AUTOMATION_PROTOCOL, id: request.id, ok: false,
        error: { code: ["unavailable"], message: "ghostget.discovery.v1:native-chats:failed" } }) + "\n");
    }
    else if (request.method === "conversations") reply(request, { privateBody: "Must never be published" });
    else if ((request.method === "poll" || request.method === "pollSet") && mode === "poll-lane") {
      // Held polls prove wire overlap: a serialized client could never reach
      // more than one held frame, and the lane cap bounds the burst.
      heldPolls.push(request); totalPolls++; maxHeld = Math.max(maxHeld, heldPolls.length);
    }
    else if (request.method === "poll") reply(request, fixtureEnrollment(String(request.params?.enrollmentId ?? "enrollment:fixture")))
    else if (request.method === "pollSet") reply(request, pollSetResult(request));
    else if (request.method === "lane-stats") reply(request, { held: heldPolls.length, maxHeld, totalPolls });
    else if (request.method === "release-polls") {
      for (const held of heldPolls.splice(0)) {
        if (held.method === "pollSet") reply(held, pollSetResult(held));
        else reply(held, fixtureEnrollment(String(held.params?.enrollmentId ?? "enrollment:fixture")));
      }
      reply(request, { released: true });
    }
    else if (request.method === "submit") sending = request;
    else if (request.method === "cancel") {
      reply(request, { cancelled: true });
      if (sending) { const params = sending.params as Record<string, string>; reply(sending, { id: "run:fixture", planId: params.planId, intentId: "intent:fixture", enrollmentId: "enrollment:fixture", state: "partial", accepted: [{ messageId: "sent:fixture", providerReceiptId: null }], totalActions: 2, reason: "Synthetic cancellation", retryable: false }); sending = undefined; }
    } else if (request.method === "close") {
      reply(request, { closed: true });
      // A same-group sibling that ignores SIGTERM must still meet the SIGKILL
      // escalation after this child exits; it must never be left orphaned.
      if (mode === "leave-sibling") spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: false, stdio: "ignore" }).unref();
      process.stdin.pause(); setTimeout(() => process.exit(0), 5);
    }
    else process.exit(3);
  }
});
