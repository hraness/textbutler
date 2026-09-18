import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { OwnerReadRecoveryError, assertSameConversation, parseConversationBinding, type HistoryMessage, type ObservedConversation, type OwnerConversationReadPort } from "./enrollment.ts";

export interface GhostgetOwnerReadOptions {
  /** Trusted, owner-installed public Ghostget CLI; never supplied through the UI or by an agent. */
  executable: string;
  /** Exact Bun executable when `executable` is the Ghostget source entry point. */
  runtimeExecutable?: string;
  authId: string;
  stateHome?: string;
  /** Private Textbutler owner state, outside Ghostget state and agent folders. */
  custodyDirectory: string;
}
type ReadOperation = "messaging.list" | "conversations.read" | "messaging.read";
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Ghostget read response"); return value as Record<string, unknown>; }
// Ghostget's public process boundary reserves 30 s for cleanup joins and 5 s
// for persistence. It may own detached imsg groups, so do not kill its controller
// after a short generic subprocess grace period.
export const GHOSTGET_OWNER_CLEANUP_GRACE_MS = 36_000;
export const GHOSTGET_OWNER_CUSTODY_FILE = "ghostget-read-custody.json";
async function claimCustody(options: GhostgetOwnerReadOptions, operation: ReadOperation, identityOnly: boolean) {
  const directory = options.custodyDirectory;
  const info = await lstat(directory);
  if (await realpath(directory) !== directory || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Ghostget read custody requires private physical owner state");
  const path = join(directory, GHOSTGET_OWNER_CUSTODY_FILE);
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch { throw new OwnerReadRecoveryError(); }
  const identity = await handle.stat();
  const configurationSha256 = createHash("sha256").update(JSON.stringify({ executable: options.executable, runtimeExecutable: options.runtimeExecutable ?? null, authId: options.authId, stateHome: options.stateHome ?? null })).digest("hex");
  const record = { schemaVersion: 1, configurationSha256, operationId: randomUUID(), operation, identityOnly, hostPid: process.pid, startedAt: new Date().toISOString(), status: "in-flight-or-unreconciled" };
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(directory, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  return async () => {
    const current = await lstat(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid?.() || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new OwnerReadRecoveryError();
    await unlink(path);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  };
}
async function run(options: GhostgetOwnerReadOptions, operation: ReadOperation, input: unknown, identityOnly: boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const release = await claimCustody(options, operation, identityOnly);
  const args = ["invoke", "imessage-direct", operation, "--input", "-", "--auth", options.authId, "--json", ...(identityOnly ? ["--projection-identity-only"] : [])];
  const environment: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HRANESS_SUPPORT_AUDIENCE: "off", HRANESS_SUPPORT_EMAIL: "off" };
  for (const name of ["HOME", "USER", "LOGNAME", "TMPDIR"]) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  if (options.stateHome !== undefined) environment.GHOSTGET_STATE_HOME = options.stateHome;
  // Only a validated normal successful public result releases custody. A failed,
  // forced or signal exit may have left a separately grouped upstream child;
  // retain the durable marker even after this immediate child has closed.
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(options.runtimeExecutable ?? options.executable, options.runtimeExecutable === undefined ? args : ["--no-env-file", options.executable, ...args], { env: environment, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true });
    const chunks: Buffer[] = []; let outputBytes = 0, errorBytes = 0, stopped = false, forced = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => { try { if (child.pid !== undefined) process.kill(-child.pid, name); } catch { /* close owns immediate-child settlement */ } };
    const groupExists = () => { if (child.pid === undefined) return false; try { process.kill(-child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
    const stop = () => { if (stopped) return; stopped = true; kill("SIGTERM"); killTimer = setTimeout(() => { forced = true; kill("SIGKILL"); }, GHOSTGET_OWNER_CLEANUP_GRACE_MS); };
    const timer = setTimeout(stop, 35_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 8_388_608) stop(); else chunks.push(bytes); });
    child.stderr.on("data", (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes > 65_536) stop(); });
    child.stdin.on("error", stop);
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer); if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      if (outputBytes > 8_388_608 || errorBytes > 65_536 || forced || spawnFailed || code !== 0 || exitSignal !== null || groupExists()) { reject(new OwnerReadRecoveryError()); return; }
      try {
        const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
        if (identityOnly) identity(value);
        else {
          const output = object(value.output), receipt = object(value.receipt);
          if (value.ok !== true || value.status !== "succeeded" || value.source !== "live" || output.operation !== operation || output.provider !== "imessage"
            || receipt.schemaVersion !== 7 || receipt.transport !== "local-cli" || receipt.risk !== "R1" || receipt.status !== "succeeded" || receipt.operation !== operation
            || object(receipt.adapter).id !== "imessage-direct" || object(receipt.auth).id !== options.authId || typeof receipt.runId !== "string" || receipt.runId !== value.runId
            || output.accountSelection !== "device-default" || output.service !== "iMessage" || output.transport !== "applescript" || output.smsFallback !== false) throw new Error("Unsettled Ghostget output");
        }
        resolve(value);
      } catch { reject(new OwnerReadRecoveryError()); }
    });
    child.stdin.end(JSON.stringify(input));
  });
  await release();
  signal.throwIfAborted();
  return result;
}
function identity(value: Record<string, unknown>): { authIdentity: string; authHash: string } {
  if (value.ok !== true || value.source !== "projection-identity" || value.status !== "ready" || typeof value.authIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(value.authIdentity) || typeof value.authHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.authHash)) throw new Error("Ghostget account identity is unavailable");
  return { authIdentity: value.authIdentity, authHash: value.authHash };
}
function observed(raw: unknown, account: { authIdentity: string; authHash: string; accountSubject: string }, authId: string): ObservedConversation {
  const chat = object(raw);
  if (chat.kind !== "single" && chat.kind !== "group" || chat.title !== null && typeof chat.title !== "string") throw new Error("Invalid conversation projection");
  const binding = parseConversationBinding({ version: 1, authId, ...account, chatGuid: chat.guid, observedChatRowId: chat.id, service: chat.service, participants: chat.participants, observedAccountId: chat.observedAccountId, observedAccountLogin: chat.observedAccountLogin, observedLastAddressedHandle: chat.observedLastAddressedHandle });
  return { binding, kind: chat.kind, title: (chat.title?.trim() || binding.participants.join(", ") || "Messages conversation").slice(0, 200) };
}
/** Factory does no provider reads. Only explicit owner list/enrollment calls launch public R1 commands. */
export function createGhostgetOwnerReadPort(options: GhostgetOwnerReadOptions): OwnerConversationReadPort {
  if (!isAbsolute(options.custodyDirectory) || !isAbsolute(options.executable) || options.runtimeExecutable !== undefined && !isAbsolute(options.runtimeExecutable) || options.stateHome !== undefined && !isAbsolute(options.stateHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(options.authId)) throw new Error("Ghostget owner read requires absolute trusted paths and an explicit auth ID");
  const config = Object.freeze({ ...options });
  async function read(operation: ReadOperation, input: unknown, signal: AbortSignal) {
    const before = identity(await run(config, operation, input, true, signal));
    const live = await run(config, operation, input, false, signal);
    const after = identity(await run(config, operation, input, true, signal));
    signal.throwIfAborted();
    if (before.authIdentity !== after.authIdentity || before.authHash !== after.authHash || object(object(live.receipt).auth).hash !== before.authHash || live.ok !== true || live.status !== "succeeded" || live.source !== "live") throw new Error("Ghostget account changed or its live read was not verified");
    const output = object(live.output);
    if (output.provider !== "imessage" || output.operation !== operation || output.accountSelection !== "device-default" || output.service !== "iMessage" || output.transport !== "applescript" || output.smsFallback !== false || typeof output.accountSubject !== "string") throw new Error("Ghostget read contract changed");
    return { output, account: { ...before, accountSubject: output.accountSubject } };
  }
  return {
    async list(signal) {
      const { output, account } = await read("messaging.list", { limit: 200 }, signal);
      if (!Array.isArray(output.conversations) || output.conversations.length > 200) throw new Error("Conversation list exceeds its bound");
      const conversations = output.conversations.map(value => observed(value, account, config.authId));
      if (new Set(conversations.map(value => value.binding.chatGuid)).size !== conversations.length) throw new Error("Repeated conversation identity");
      return conversations;
    },
    async read(binding, initializeHistory, signal) {
      if (binding.authId !== config.authId) throw new Error("Configured Ghostget account changed");
      const input = { chat_guid: binding.chatGuid, service: binding.service, observed_chat_row_id: binding.observedChatRowId };
      const result = await read("conversations.read", input, signal);
      const conversation = observed(result.output.conversation, result.account, config.authId);
      assertSameConversation(binding, conversation);
      if (!initializeHistory) return { conversation, messages: [] };
      const history = await read("messaging.read", { ...input, limit: 200 }, signal);
      assertSameConversation(binding, observed(history.output.conversation, history.account, config.authId));
      if (!Array.isArray(history.output.messages) || history.output.messages.length > 200) throw new Error("History exceeds its bound");
      const messages: HistoryMessage[] = history.output.messages.map(value => {
        const message = object(value);
        const at = typeof message.createdAt === "string" ? Date.parse(message.createdAt) : NaN;
        if (message.chatGuid !== binding.chatGuid || message.chatId !== binding.observedChatRowId || typeof message.isFromMe !== "boolean" || typeof message.guid !== "string" || typeof message.text !== "string" || !Number.isSafeInteger(at) || at < 0) throw new Error("History conversation binding changed");
        // Visible butler messages are never owner style evidence. Unknown/custom historical
        // automation remains untrusted context; this bootstrap does not infer style rules.
        return { id: message.guid, at, text: message.text, author: message.isFromMe ? /^🤖\{/u.test(message.text) ? "butler" : "owner" : "contact" };
      });
      return { conversation, messages };
    },
  };
}
