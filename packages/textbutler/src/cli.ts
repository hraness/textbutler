import { runProductSupportCommand } from "../../../src/support.ts";
import { fileURLToPath } from "node:url";

import { initializeOwnerState, TEXTBUTLER_CONTROL_PROTOCOL } from "./control-service.ts";
import { defaultDataDirectory, requestDaemon, startDaemon } from "./daemon.ts";
import { createLaunchAgentLifecycle, defaultLaunchAgentHost, type LaunchAgentLifecycle } from "./launch-agent.ts";
import { runMenuBarCommand } from "./menubar.ts";
import type { ClaudeApiAdapterOptions } from "@hraness/agentmixer";
import type { ControlRequest, ControlResponse } from "../../control/src/index.ts";
import { awaitOwnerJob, handleOwnerCommand, OwnerCliError, pendingJobOutput, resolveOwnerContact } from "./owner-cli.ts";
import { runDoctor, runSetup } from "./onboarding.ts";
import { runTextbutlerTui } from "./tui.ts";
import { runIMessageSetup } from "./imessage-setup.ts";
import { handleMessagesCommand } from "./messages-cli.ts";
import { BARE_INTRO, COMMANDS, HELP_TOPICS, ROOT_HELP, topicHelp } from "./cli-help.ts";
import { CliUsageError, closest, detectAudience, jsonError, quoteInput, renderError, symbolsFor, type Audience } from "./cli-style.ts";
import { TEXTBUTLER_VERSION } from "./version.ts";

type CliOptions = { launchAgent?: LaunchAgentLifecycle; entrypoint?: string; providerArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"];
  supportEnv?: Readonly<Record<string, string | undefined>>; audience?: Audience; env?: Readonly<Record<string, string | undefined>> };

/** A malformed form of a known command points at that command's help. */
function usage(args: readonly string[]): CliUsageError {
  const family = args[0] ?? "";
  const shown = args.slice(0, family === "replies" || family === "daemon" || family === "providers" || family === "menubar" ? 2 : 1).filter(word => /^[a-z-]{1,24}$/u.test(word)).join(" ");
  return new CliUsageError(`Missing or invalid arguments for "${shown || family}".`, `textbutler help ${topicHelp(family) ? family : ""}`.trim());
}

export async function runTextbutlerCli(argv: readonly string[], output: { write(text: string): unknown } = process.stdout, options: CliOptions = {}): Promise<number> {
  if (argv[0] === "support" && argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) { output.write(`${topicHelp("support")}\n`); return 0; }
  if (argv[0] === "support") return await runProductSupportCommand(argv.slice(1), { stdout: text => output.write(text), stderr: text => process.stderr.write(text) }, { command: ["textbutler"], ...(options.supportEnv === undefined ? {} : { env: options.supportEnv }) });
  const env = options.env ?? process.env, audience = options.audience ?? detectAudience({ env }), symbols = symbolsFor(env);
  const args = [...argv]; let dataDir = defaultDataDirectory(), json = false;
  // A trailing --json selects machine output. It is never taken from the text
  // of a literal reply, so "replies send CONTACT ... --json" stays unchanged.
  const takeJson = (): void => { if (args.at(-1) === "--json" && !(args[0] === "replies" && args[1] === "send")) { args.pop(); json = true; } };
  takeJson();
  const option = args.indexOf("--data-dir");
  if (option !== -1) {
    if (option !== args.length - 2 || args[option + 1] === undefined || !args[option + 1]!.startsWith("/")) throw new CliUsageError("--data-dir needs an absolute folder path and must come last.", "textbutler --help");
    dataDir = args[option + 1]!; args.splice(option, 2);
  }
  takeJson();
  const machine = json || audience === "agent";
  if (args.length === 0) {
    if (process.stdin.isTTY && output === process.stdout) return await runTextbutlerTui(dataDir, output, { ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}) });
    output.write(`${BARE_INTRO}\n`); return 0;
  }
  if (args.length === 1 && ["--version", "-V", "version"].includes(args[0]!)) {
    output.write(machine ? `${JSON.stringify({ name: "textbutler", version: TEXTBUTLER_VERSION })}\n` : `textbutler ${TEXTBUTLER_VERSION}\n`); return 0;
  }
  const helpFlag = args.length > 1 && ["--help", "-h"].includes(args.at(-1)!);
  if (["--help", "-h", "help"].includes(args[0]!) || helpFlag) {
    if (args.length === 1) { output.write(`${ROOT_HELP}\n`); return 0; }
    // The agent messaging family keeps its JSON help for agents.
    if (helpFlag && args[0] === "messages" && args.length === 2 && machine) return (await handleMessagesCommand(args, { request: () => Promise.reject(new Error("unused")), print: value => output.write(`${JSON.stringify(value)}\n`), dataDir }))!;
    const topic = helpFlag ? args[0]! : args[1]!, text = topicHelp(topic);
    if (text === undefined || args[0] === "help" && args.length !== 2) {
      const guess = closest(topic, HELP_TOPICS);
      throw new CliUsageError(`No help topic ${quoteInput(topic)}.${guess ? ` Did you mean "${guess}"?` : ""}`, "textbutler --help", "unknown-topic");
    }
    output.write(`${text}\n`); return 0;
  }
  if (!COMMANDS.includes(args[0]!) && args[0] !== "app") {
    const guess = closest(args[0]!, COMMANDS);
    throw new CliUsageError(`Unknown command ${quoteInput(args[0]!)}.${guess ? ` Did you mean "${guess}"?` : ""}`, "textbutler --help", "unknown-command");
  }
  const command = args.join(" ");
  const print = (value: unknown): void => { output.write(`${JSON.stringify(value)}\n`); };
  const request = (request: ControlRequest): Promise<ControlResponse> => requestDaemon({ dataDir, request });
  if (args[0] === "setup") return await runSetup(args.slice(1), dataDir, output, { symbols });
  // Hidden: TextButler.app runs this role itself (see the setup guide).
  if (command === "app imessage-setup") {
    if (option === -1) throw new CliUsageError("App setup runs inside TextButler.app, not from this command.", "bun run textbutler:app imessage-setup --data-dir <path>");
    const result = await runIMessageSetup(dataDir); print(result); return result.ok ? 0 : 1;
  }
  if (args[0] === "app") throw new CliUsageError(`Unknown command ${quoteInput(args.join(" "))}.`, "textbutler --help", "unknown-command");
  if (command === "tui") return await runTextbutlerTui(dataDir, output, { ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}) });
  if (command === "doctor") return await runDoctor(dataDir, output, { json: machine, symbols });
  if (args[0] === "messages") {
    try { return (await handleMessagesCommand(args, { request, print, dataDir }))!; }
    catch (error) {
      if (error instanceof OwnerCliError) { print({ ok: false, code: "invalid-request", message: error.message }); return 1; }
      print({ ok: false, code: "unconfirmed", message: "The messaging operation could not be confirmed. Check its job or current state before repeating a send." }); return 1;
    }
  }
  try {
    const handled = await handleOwnerCommand(args, { request, print });
    if (handled !== undefined) return handled;
  } catch (error) {
    if (error instanceof OwnerCliError || error instanceof CliUsageError) throw error;
    print({ ok: false, status: "disconnected", detail: "The control request could not be confirmed. Run textbutler doctor. Check status before repeating a change; it may already have taken effect." }); return 1;
  }
  const checkAccount = args.length === 3 && args[0] === "providers" && args[1] === "check" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(args[2]!) ? args[2] : undefined;
  const menuBar = args[0] === "menubar" && (args.length === 1 || args.length === 2 && ["start", "stop", "status", "doctor", "install", "uninstall", "--foreground"].includes(args[1]!));
  const inbox = command === "inbox";
  const repliesSuggest = args[0] === "replies" && args[1] === "suggest" && args.length === 3 ? args[2]! : undefined;
  const repliesShow = args[0] === "replies" && args[1] === "show" && args.length === 3 && args[2]!.startsWith("draft:") ? args[2]! : undefined;
  const repliesSendDraft = args[0] === "replies" && args[1] === "send" && args.length === 4 && args[2]!.startsWith("draft:") && /^[a-f0-9]{64}$/u.test(args[3]!)
    ? { id: args[2]!, digest: args[3]! } : undefined;
  const repliesSendText = args[0] === "replies" && args[1] === "send" && args.length >= 4 && !args[2]!.startsWith("draft:") ? { contact: args[2]!, text: args.slice(3).join(" ") } : undefined;
  const repliesDiscard = args[0] === "replies" && args[1] === "discard" && args.length === 3 ? args[2]! : undefined;
  const repliesReconcile = args[0] === "replies" && args[1] === "reconcile" && (args.length === 3 || args.length === 4 && ["--sent", "--failed"].includes(args[3]!))
    ? { contact: args[2]!, resolution: args[3] === "--sent" ? "sent" as const : args[3] === "--failed" ? "failed" as const : undefined } : undefined;
  const replies = inbox || repliesSuggest !== undefined || repliesShow !== undefined || repliesSendDraft !== undefined || repliesSendText !== undefined || repliesDiscard !== undefined || repliesReconcile !== undefined;
  if (args[0] === "replies" && !replies) throw usage(args);
  if (!["init", "doctor", "providers list", "daemon run", "daemon install", "daemon uninstall", "daemon status"].includes(command) && !menuBar && !checkAccount && !replies) throw usage(args);
  /** Job-backed control call: poll until the stored result arrives. */
  const job = (input: ControlRequest): Promise<ControlResponse> => awaitOwnerJob(input, request);
  const unresolved = (response: ControlResponse): void => { print(response.ok && response.kind === "job" ? pendingJobOutput(response) : response); };
  /** CONTACT resolves by exact id, then by case-insensitive label substring. */
  const resolveContact = async (name: string): Promise<string> => {
    const response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } });
    if (!response.ok || response.kind !== "snapshot") throw new Error("The Textbutler daemon is unavailable.");
    return resolveOwnerContact(response.snapshot, name).id;
  };
  if (replies) {
    try { return await repliesCommand(); }
    catch (error) {
      if (error instanceof OwnerCliError || error instanceof CliUsageError) throw error;
      print({ ok: false, status: "disconnected", detail: "The reply operation could not be confirmed. Run textbutler doctor and inspect status before repeating a send; it may already have been submitted." }); return 1;
    }
  }
  async function repliesCommand(): Promise<number> {
    if (inbox) {
      const response = await job({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.scan" });
      if (response.ok && response.kind === "replies") { print({ ok: true, scannedAt: response.scannedAt, checked: response.checked, unreadable: response.unreadable, pending: response.pending, drafts: response.drafts }); return 0; }
      unresolved(response); return 1;
    }
    if (repliesShow !== undefined) {
      const response = await request({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.draft.read", draftId: repliesShow });
      print(response); return response.ok && response.kind === "reply-draft" ? 0 : 1;
    }
    if (repliesDiscard !== undefined) {
      const response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.discard", draftId: repliesDiscard } });
      print(response.ok && response.kind === "reply-discarded" ? { ok: true, discarded: response.discarded } : response);
      return response.ok ? 0 : 1;
    }
    if (repliesReconcile !== undefined) {
      const response = await job({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.reconcile", contactId: await resolveContact(repliesReconcile.contact),
        ...(repliesReconcile.resolution === undefined ? {} : { resolution: repliesReconcile.resolution }) });
      if (response.ok && response.kind === "reply-reconciled") { print({ ok: response.resolved, contactId: response.contactId, runId: response.runId ?? null, resolved: response.resolved, state: response.state ?? null, detail: response.detail }); return response.resolved ? 0 : 1; }
      unresolved(response); return 1;
    }
    if (repliesSuggest !== undefined) {
      const response = await job({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.suggest", contactId: await resolveContact(repliesSuggest) });
      if (response.ok && response.kind === "reply-suggestion") { print({ ok: true, draft: response.draft, pending: response.pending }); return 0; }
      unresolved(response); return 1;
    }
    const send = repliesSendDraft !== undefined
      ? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.send" as const, draftId: repliesSendDraft.id, expectedDigest: repliesSendDraft.digest }
      : { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.send" as const, contactId: await resolveContact(repliesSendText!.contact), text: repliesSendText!.text };
    const response = await job(send);
    if (response.ok && response.kind === "reply-sent") { print({ ok: response.state === "submitted", state: response.state, contactId: response.contactId, runId: response.runId, detail: response.detail }); return response.state === "submitted" ? 0 : 1; }
    unresolved(response); return 1;
  }
  if (command === "providers list" || checkAccount) {
    const response = await job(checkAccount
      ? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "provider.accounts.check", accountId: checkAccount }
      : { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" });
    if (response.ok && response.kind === "snapshot") { print({ ok: true, accounts: response.snapshot.providerAccounts ?? [] }); return 0; }
    unresolved(response); return 1;
  }
  if (command === "init") {
    const state = await initializeOwnerState(dataDir);
    print({ ok: true, status: "initialized", dataDir: state.dataDir, automation: "unchanged", detail: "New settings start private and paused; existing settings and activation are preserved. This command does not connect accounts or install login startup. Run textbutler doctor for next steps." });
    return 0;
  }
  if (command === "daemon install" || command === "daemon uninstall") {
    const lifecycle = options.launchAgent ?? createLaunchAgentLifecycle(defaultLaunchAgentHost(options.entrypoint));
    const launchAgent = command === "daemon install" ? await lifecycle.install(dataDir) : await lifecycle.uninstall(dataDir);
    const ok = launchAgent.installation === (command === "daemon install" ? "installed" : "absent");
    const daemon = await request({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" }).catch(() => null);
    print({ ok, launchAgent, automaticReplies: daemon?.ok && daemon.kind === "snapshot" ? daemon.snapshot.automation?.state ?? "unavailable" : "unavailable" }); return ok ? 0 : 1;
  }
  if (command === "daemon status") {
    const lifecycle = options.launchAgent ?? createLaunchAgentLifecycle(defaultLaunchAgentHost(options.entrypoint));
    const [launchAgent, daemon] = await Promise.all([
      lifecycle.status(dataDir),
      requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } }).catch(() => null),
    ]);
    print({ ok: daemon?.ok ?? false, daemon: daemon ?? { ok: false, status: "disconnected" }, launchAgent,
      automaticReplies: daemon?.ok && daemon.kind === "snapshot" ? daemon.snapshot.automation?.state ?? "unavailable" : "unavailable" });
    return daemon?.ok ? 0 : 1;
  }
  if (menuBar) {
    // The shared desktop-foundation lifecycle owns start/stop/status/doctor,
    // login startup and the private --foreground owner branch. The daemon
    // remains the authority for state and mutations.
    return await runMenuBarCommand(args.slice(1), dataDir, options.entrypoint ?? fileURLToPath(new URL("cli.ts", import.meta.url)), print);
  }
  if (process.platform !== "darwin") throw new Error("The Textbutler foreground daemon is supported on macOS only.");
  const daemon = await startDaemon({ dataDir, ...(options.providerArtifact === undefined ? {} : { providerArtifact: options.providerArtifact }) });
  const state = await daemon.service.snapshot();
  print({ ok: true, status: "running", socketPath: daemon.socketPath, automation: state.automation?.state ?? "unavailable", detail: state.automation?.detail ?? state.detail });
  await new Promise<void>(resolve_ => {
    const stopped = (): void => { process.off("SIGINT", stopped); process.off("SIGTERM", stopped); resolve_(); };
    process.once("SIGINT", stopped); process.once("SIGTERM", stopped);
  });
  await daemon.close();
  return 0;
}
/** Render a thrown error per SPEC § D5: one sentence and one next command on
 * stderr, or the JSON error object on stdout for --json and agents. */
export function describeCliError(error: unknown, argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env, audience: Audience = detectAudience({ env })): { stdout: string; stderr: string; exitCode: number } {
  const usage = error instanceof CliUsageError;
  const message = usage || error instanceof OwnerCliError ? error.message : "Textbutler couldn't finish this command.";
  const next = usage ? error.next : error instanceof OwnerCliError ? undefined : "textbutler doctor";
  const code = usage ? error.code : error instanceof OwnerCliError ? "invalid-request" : "failed";
  const exitCode = usage ? 2 : 1;
  const literalReply = argv[0] === "replies" && argv[1] === "send";
  const json = !literalReply && (argv.at(-1) === "--json" || argv.at(-3) === "--json" && argv.at(-2) === "--data-dir");
  if (json || audience === "agent") return { stdout: jsonError(code, message, next), stderr: "", exitCode };
  return { stdout: "", stderr: renderError(message, next, symbolsFor(env)), exitCode };
}
/** `textbutler --help | head -1` exits quietly instead of printing a trace. */
export function quietOnClosedPipe(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "EPIPE") process.exit(0); throw error; });
}
if (import.meta.main) {
  quietOnClosedPipe();
  const supportEnv = { ...process.env }, argv = process.argv.slice(2);
  try { process.exitCode = await runTextbutlerCli(argv, process.stdout, { supportEnv }); }
  catch (error) { const shown = describeCliError(error, argv); process.stdout.write(shown.stdout); process.stderr.write(shown.stderr); process.exitCode = shown.exitCode; }
}
