import { runProductSupportCommand } from "../../../src/support.ts";
import { fileURLToPath } from "node:url";

import { initializeOwnerState, TEXTBUTLER_CONTROL_PROTOCOL } from "./control-service.ts";
import { defaultDataDirectory, requestDaemon, startDaemon } from "./daemon.ts";
import { createLaunchAgentLifecycle, type LaunchAgentLifecycle } from "./launch-agent.ts";
import { runMenuBarCommand } from "./menubar.ts";
import type { ClaudeApiAdapterOptions } from "@hraness/agentmixer";

export const CLI_USAGE = "textbutler support [protocol --json|offer --json|shown ID|release ID|dismiss|snooze|enable|status --json] | init|doctor|providers list|providers check ACCOUNT|inbox|replies suggest CONTACT|replies send DRAFT|replies send CONTACT TEXT...|replies discard DRAFT|daemon run|daemon install|daemon uninstall|daemon status|menubar [start|stop|status|doctor|install|uninstall] [--data-dir /physical/private/path]";
export async function runTextbutlerCli(argv: readonly string[], output: { write(text: string): unknown } = process.stdout, options: { launchAgent?: LaunchAgentLifecycle;
  providerArtifact?: ClaudeApiAdapterOptions["runtimeArtifact"]; supportEnv?: Readonly<Record<string, string | undefined>> } = {}): Promise<number> {
  if (argv[0] === "support") return await runProductSupportCommand(argv.slice(1), { stdout: text => output.write(text), stderr: text => process.stderr.write(text) }, { command: ["textbutler"], ...(options.supportEnv === undefined ? {} : { env: options.supportEnv }) });
  if (argv.length === 0 || argv.length === 1 && ["--help", "help", "-h"].includes(argv[0]!)) { output.write(`${CLI_USAGE}\n`); return 0; }
  const args = [...argv]; let dataDir = defaultDataDirectory();
  const option = args.indexOf("--data-dir");
  if (option !== -1) {
    if (option !== args.length - 2 || args[option + 1] === undefined || !args[option + 1]!.startsWith("/")) throw new Error(CLI_USAGE);
    dataDir = args[option + 1]!; args.splice(option, 2);
  }
  const command = args.join(" ");
  const checkAccount = args.length === 3 && args[0] === "providers" && args[1] === "check" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(args[2]!) ? args[2] : undefined;
  const menuBar = args[0] === "menubar" && (args.length === 1 || args.length === 2 && ["start", "stop", "status", "doctor", "install", "uninstall", "--foreground"].includes(args[1]!));
  const inbox = command === "inbox";
  const repliesSuggest = args[0] === "replies" && args[1] === "suggest" && args.length === 3 ? args[2]! : undefined;
  const repliesSendDraft = args[0] === "replies" && args[1] === "send" && args.length === 3 && args[2]!.startsWith("draft:") ? args[2]! : undefined;
  const repliesSendText = args[0] === "replies" && args[1] === "send" && args.length >= 4 && !args[2]!.startsWith("draft:") ? { contact: args[2]!, text: args.slice(3).join(" ") } : undefined;
  const repliesDiscard = args[0] === "replies" && args[1] === "discard" && args.length === 3 ? args[2]! : undefined;
  const replies = inbox || repliesSuggest !== undefined || repliesSendDraft !== undefined || repliesSendText !== undefined || repliesDiscard !== undefined;
  if (args[0] === "replies" && !replies) throw new Error(CLI_USAGE);
  if (!["init", "doctor", "providers list", "daemon run", "daemon install", "daemon uninstall", "daemon status"].includes(command) && !menuBar && !checkAccount && !replies) throw new Error(CLI_USAGE);
  const print = (value: unknown): void => { output.write(`${JSON.stringify(value)}\n`); };
  /** Job-backed control call: poll until the stored result arrives. */
  const job = async (request: Record<string, unknown>): Promise<import("../../control/src/index.ts").ControlResponse> => {
    let response = await requestDaemon({ dataDir, request });
    const deadline = Date.now() + 120_000;
    while (response.ok && response.kind === "job" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "owner.job.read", jobId: response.jobId } });
    }
    return response;
  };
  /** CONTACT resolves by exact id, then by case-insensitive label substring. */
  class ContactResolutionError extends Error {}
  const resolveContact = async (name: string): Promise<string> => {
    const response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } });
    if (!response.ok || response.kind !== "snapshot") throw new Error("The Textbutler daemon is unavailable.");
    const contacts = response.snapshot.contacts;
    const exact = contacts.find(contact => contact.id === name);
    if (exact) return exact.id;
    const lowered = name.toLowerCase();
    const matches = contacts.filter(contact => contact.name.toLowerCase().includes(lowered));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length === 0) throw new ContactResolutionError(`No configured contact matches "${name}".`);
    throw new ContactResolutionError(`"${name}" matches ${matches.map(contact => contact.name).join(", ")}. Use the exact contact id.`);
  };
  if (replies) {
    try { return await repliesCommand(); }
    catch (error) {
      if (error instanceof ContactResolutionError || (error instanceof Error && error.message === CLI_USAGE)) throw error;
      print({ ok: false, status: "disconnected", detail: "No qualified owner-only Textbutler control daemon is reachable. Start it with textbutler daemon run." }); return 1;
    }
  }
  async function repliesCommand(): Promise<number> {
    if (inbox) {
      const response = await job({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.scan" });
      if (response.ok && response.kind === "replies") { print({ ok: true, scannedAt: response.scannedAt, checked: response.checked, unreadable: response.unreadable, pending: response.pending, drafts: response.drafts }); return 0; }
      print(response.ok ? { ok: false, detail: "The inbox scan is still pending; inspect daemon status before retrying." } : response); return 1;
    }
    if (repliesDiscard !== undefined) {
      const response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.discard", draftId: repliesDiscard } });
      print(response.ok && response.kind === "reply-discarded" ? { ok: true, discarded: response.discarded } : response);
      return response.ok ? 0 : 1;
    }
    if (repliesSuggest !== undefined) {
      const response = await job({ protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.suggest", contactId: await resolveContact(repliesSuggest) });
      if (response.ok && response.kind === "reply-suggestion") { print({ ok: true, draft: response.draft, pending: response.pending }); return 0; }
      print(response.ok ? { ok: false, detail: "The suggestion is still pending; inspect daemon status before retrying." } : response); return 1;
    }
    const send = repliesSendDraft !== undefined
      ? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.send" as const, draftId: repliesSendDraft }
      : { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "replies.send" as const, contactId: await resolveContact(repliesSendText!.contact), text: repliesSendText!.text };
    const response = await job(send);
    if (response.ok && response.kind === "reply-sent") { print({ ok: response.state === "submitted", state: response.state, contactId: response.contactId, runId: response.runId, detail: response.detail }); return response.state === "submitted" ? 0 : 1; }
    print(response.ok ? { ok: false, detail: "The send is still pending; inspect daemon status before retrying." } : response); return 1;
  }
  if (command === "providers list" || checkAccount) {
    let response = await requestDaemon({ dataDir, request: checkAccount
      ? { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "provider.accounts.check", accountId: checkAccount }
      : { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } });
    const deadline = Date.now() + 120_000;
    while (response.ok && response.kind === "job" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "owner.job.read", jobId: response.jobId } });
    }
    if (response.ok && response.kind === "snapshot") { print({ ok: true, accounts: response.snapshot.providerAccounts ?? [] }); return 0; }
    print(response.ok ? { ok: false, detail: "Provider check is still pending; inspect daemon status before retrying." } : response); return 1;
  }
  if (command === "init") {
    const state = await initializeOwnerState(dataDir);
    print({ ok: true, status: "initialized", dataDir: state.dataDir, automation: "unavailable", detail: "Owner settings are private and paused. No contacts, providers, agents, or launch agents were installed." });
    return 0;
  }
  if (command === "daemon install" || command === "daemon uninstall") {
    const lifecycle = options.launchAgent ?? createLaunchAgentLifecycle();
    const launchAgent = command === "daemon install" ? await lifecycle.install(dataDir) : await lifecycle.uninstall(dataDir);
    const ok = launchAgent.installation === (command === "daemon install" ? "installed" : "absent");
    print({ ok, launchAgent, automaticReplies: "unavailable" }); return ok ? 0 : 1;
  }
  if (command === "daemon status") {
    const lifecycle = options.launchAgent ?? createLaunchAgentLifecycle();
    const [launchAgent, daemon] = await Promise.all([
      lifecycle.status(dataDir),
      requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } }).catch(() => null),
    ]);
    print({ ok: daemon?.ok ?? false, daemon: daemon ?? { ok: false, status: "disconnected" }, launchAgent, automaticReplies: "unavailable" });
    return daemon?.ok ? 0 : 1;
  }
  if (menuBar) {
    // The shared desktop-foundation lifecycle owns start/stop/status/doctor,
    // login startup and the private --foreground owner branch. The daemon
    // remains the authority for state and mutations.
    return await runMenuBarCommand(args.slice(1), dataDir, fileURLToPath(new URL("cli.ts", import.meta.url)), print);
  }
  if (command === "doctor") {
    try {
      const response = await requestDaemon({ dataDir, request: { protocol: TEXTBUTLER_CONTROL_PROTOCOL, command: "snapshot" } });
      print({ ok: response.ok, platform: process.platform, supportedPlatform: process.platform === "darwin", daemon: response, automaticReplies: "unavailable" });
      return response.ok ? 0 : 1;
    } catch {
      print({ ok: false, status: "disconnected", platform: process.platform, automaticReplies: "unavailable", detail: "No qualified owner-only Textbutler control daemon is reachable. Start it with textbutler daemon run." });
      return 1;
    }
  }
  if (process.platform !== "darwin") throw new Error("The Textbutler foreground daemon is supported on macOS only.");
  const daemon = await startDaemon({ dataDir, ...(options.providerArtifact === undefined ? {} : { providerArtifact: options.providerArtifact }) });
  print({ ok: true, status: "running", socketPath: daemon.socketPath, automation: "unavailable", detail: "Foreground owner control service; settings and contact memory are available. Automatic replies are not active." });
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
  catch (error) { process.stderr.write(`${error instanceof Error && error.message === CLI_USAGE ? CLI_USAGE : "Textbutler could not start. Check the physical private data directory, existing socket ownership, and current runtime."}\n`); process.exitCode = 1; }
}
