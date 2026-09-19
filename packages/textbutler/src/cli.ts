import { runProductSupportCommand } from "../../../src/support.ts";
import { fileURLToPath } from "node:url";

import { initializeOwnerState, TEXTBUTLER_CONTROL_PROTOCOL } from "./control-service.ts";
import { defaultDataDirectory, requestDaemon, startDaemon } from "./daemon.ts";
import { createLaunchAgentLifecycle, defaultLaunchAgentHost, type LaunchAgentLifecycle } from "./launch-agent.ts";
import { runMenuBarCommand } from "./menubar.ts";
import type { ClaudeApiAdapterOptions } from "@hraness/agentmixer";
import type { ControlRequest, ControlResponse } from "../../control/src/index.ts";
import { awaitOwnerJob, handleOwnerCommand, OWNER_COMMAND_HELP, OwnerCliError, pendingJobOutput, resolveOwnerContact } from "./owner-cli.ts";
import { runDoctor, runSetup } from "./onboarding.ts";
import { runTextbutlerTui } from "./tui.ts";

export const CLI_USAGE = `Textbutler — your local messaging assistant

Start here:
  textbutler setup                    Initialize private settings and next steps
  textbutler tui                      Open the guided terminal interface
  textbutler doctor                   Check readiness and see what to do next
  textbutler --help                   Show this guide

Setup options:
  setup [--ghostget ABS] [--runtime ABS] [--state-home ABS]
        [--account PROVIDER:AUTHID ...]
  init                               Initialize private settings, paused

${OWNER_COMMAND_HELP}

Agents:
  providers list                     Show configured agent accounts
  providers check ACCOUNT            Verify one explicitly selected account

Review and reply:
  inbox                              Find enrolled conversations to answer
  replies suggest CONTACT            Create a suggestion without sending it
  replies show DRAFT                  Review every action and its digest
  replies send DRAFT DIGEST           Send the exact reviewed suggestion
  replies send CONTACT TEXT...       Send your literal reply
  replies discard DRAFT              Discard a suggestion

Background service:
  daemon run                         Run in this terminal
  daemon install|uninstall|status     Manage login startup and service status
  menubar [start|stop|status|doctor|install|uninstall]

Optional support:
  support [protocol --json|offer --json|shown ID|release ID|dismiss|snooze|enable|status --json]

Append --data-dir /absolute/private/path to use another data directory.
Commands return JSON; help and the guided interface are for people.
Start paused, add one contact, review a reply, then enable automation when ready.`;
export async function runTextbutlerCli(argv: readonly string[], output: { write(text: string): unknown } = process.stdout, options: { launchAgent?: LaunchAgentLifecycle; entrypoint?: string;
  providerArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"]; supportEnv?: Readonly<Record<string, string | undefined>> } = {}): Promise<number> {
  if (argv[0] === "support") return await runProductSupportCommand(argv.slice(1), { stdout: text => output.write(text), stderr: text => process.stderr.write(text) }, { command: ["textbutler"], ...(options.supportEnv === undefined ? {} : { env: options.supportEnv }) });
  const args = [...argv]; let dataDir = defaultDataDirectory();
  const option = args.indexOf("--data-dir");
  if (option !== -1) {
    if (option !== args.length - 2 || args[option + 1] === undefined || !args[option + 1]!.startsWith("/")) throw new Error(CLI_USAGE);
    dataDir = args[option + 1]!; args.splice(option, 2);
  }
  if (args.length === 0) {
    if (process.stdin.isTTY && output === process.stdout) return await runTextbutlerTui(dataDir, output, { ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}) });
    output.write(`${CLI_USAGE}\n`); return 0;
  }
  if (args.length === 1 && ["--help", "help", "-h"].includes(args[0]!)) { output.write(`${CLI_USAGE}\n`); return 0; }
  const command = args.join(" ");
  const print = (value: unknown): void => { output.write(`${JSON.stringify(value)}\n`); };
  const request = (request: ControlRequest): Promise<ControlResponse> => requestDaemon({ dataDir, request });
  if (args[0] === "setup") return await runSetup(args.slice(1), dataDir, output);
  if (command === "tui") return await runTextbutlerTui(dataDir, output, { ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}) });
  if (command === "doctor") return await runDoctor(dataDir, output);
  try {
    const handled = await handleOwnerCommand(args, { request, print });
    if (handled !== undefined) return handled;
  } catch (error) {
    if (error instanceof OwnerCliError) throw error;
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
  const replies = inbox || repliesSuggest !== undefined || repliesShow !== undefined || repliesSendDraft !== undefined || repliesSendText !== undefined || repliesDiscard !== undefined;
  if (args[0] === "replies" && !replies) throw new Error(CLI_USAGE);
  if (!["init", "doctor", "providers list", "daemon run", "daemon install", "daemon uninstall", "daemon status"].includes(command) && !menuBar && !checkAccount && !replies) throw new Error(CLI_USAGE);
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
      if (error instanceof OwnerCliError || (error instanceof Error && error.message === CLI_USAGE)) throw error;
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
if (import.meta.main) {
  const supportEnv = { ...process.env };
  try { process.exitCode = await runTextbutlerCli(process.argv.slice(2), process.stdout, { supportEnv }); }
  catch (error) { process.stderr.write(`${error instanceof OwnerCliError ? error.message : error instanceof Error && error.message === CLI_USAGE ? CLI_USAGE : "Textbutler could not complete this command. Run textbutler doctor for setup and readiness guidance. Check that the private data directory and installed runtime are available."}\n`); process.exitCode = 1; }
}
