import { fileURLToPath } from "node:url";
import { createLaunchAgentLifecycle, defaultLaunchAgentHost } from "./launch-agent.ts";
import { runMenuBarCommand } from "./menubar.ts";
import { createInterface } from "node:readline/promises";
import { CONTROL_PROTOCOL, type ControlRequest, type ControlResponse, type DesktopSnapshot, type ReplyDraftDetail } from "../../control/src/index.ts";
import { requestDaemon } from "./daemon.ts";
import { loadHostConfig } from "./host-config.ts";
import { disclose } from "./config.ts";
import { runSetup } from "./onboarding.ts";
import { CliUsageError } from "./cli-style.ts";
import { awaitOwnerJob, handleOwnerCommand, OwnerCliError, type OwnerControlClient } from "./owner-cli.ts";

export interface TerminalSession {
  write(text: string): unknown;
  ask(prompt: string): Promise<string | null>;
}
/** Terminal content is data. Escape C0/C1 and bidi controls, retaining line
 * breaks for complete message review; never print provider escape sequences. */
export function terminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function terminalLabel(text: string): string { return terminalText(text).replace(/[\r\n\t]/gu, " ").slice(0, 300); }
export function terminalDashboard(snapshot: DesktopSnapshot | null): string {
  const active = snapshot?.contacts.filter(contact => contact.settings.enabled).length ?? 0;
  const state = !snapshot ? "Service not connected" : snapshot.settings.paused ? "Automatic replies paused" : snapshot.automation?.state === "running" ? "Automatic replies running" : "Automatic replies need setup";
  return ["", "TEXTBUTLER", "Your conversations, with you in control.", "", state,
    snapshot ? `${snapshot.contacts.length} conversations · ${active} with automatic replies on` : "Start with Setup & readiness.",
    "", "  1  Setup & readiness", "  2  Connect messaging apps", "  3  Add a conversation", "  4  Inbox & replies", "  5  Manage a contact", "  6  Pause automatic replies", "  7  Resume automatic replies", "  8  Menu bar companion", "  q  Quit terminal", "", "Quitting leaves the background service running.", ""].join("\n");
}
export function terminalDraft(draft: ReplyDraftDetail): string {
  const field = (value: string): string => terminalText(JSON.stringify(value));
  const lines = [`To: ${terminalLabel(draft.name)} · ${draft.provider}`, `Contact: ${field(draft.contactId)}`, `Conversation: ${field(draft.conversationId)}`, ""];
  draft.actions.forEach((action, index) => {
    lines.push(`${index + 1}. ${action.kind === "text" ? "Message" : action.kind}`);
    switch (action.kind) {
      case "text": lines.push(terminalText(action.text)); break;
      case "attachment": lines.push(`File: ${field(action.name)} (${field(action.mimeType)})`, `Path: ${field(action.file)}`); break;
      case "sticker": lines.push(`File: ${field(action.file)}`, `On message: ${action.messageId === null ? "new message" : field(action.messageId)}`); break;
      case "reaction": lines.push(`${action.action} ${field(action.emoji)} on message ${field(action.messageId)}`); break;
      case "link": case "app-clip": lines.push(terminalText(action.url)); break;
      case "poll": lines.push(terminalText(action.question), ...action.options.map(option => `  - ${terminalText(option)}`), `Maximum selections: ${action.maximumSelections ?? "any"}`); break;
      case "experience": lines.push(field(action.experienceId), terminalText(JSON.stringify(action.parameters, null, 2))); break;
    }
    lines.push("");
  });
  for (const asset of draft.assets) lines.push(`File verification: ${field(asset.path)} · ${asset.bytes} bytes · SHA-256 ${asset.sha256}`);
  lines.push(`Expires: ${draft.expiresAt}`, "Sending includes every action above, in that order.", "");
  return lines.join("\n");
}

async function pick<T>(io: TerminalSession, title: string, values: readonly T[], label: (value: T) => string): Promise<T | undefined> {
  let filtered = values;
  while (true) {
    io.write(`\n${title}\n`);
    if (values.length === 0) { io.write("Nothing available yet. Check Setup & readiness.\n"); return undefined; }
    filtered.slice(0, 20).forEach((value, index) => io.write(`  ${index + 1}  ${terminalLabel(label(value))}\n`));
    if (!filtered.length) io.write("No matches. Try another name, or Enter to go back.\n");
    if (filtered.length > 20) io.write(`Showing 20 of ${filtered.length}. Type a name to narrow the list.\n`);
    const value = await io.ask("Number or name to filter (Enter to go back): ");
    if (value === null || !value.trim()) return undefined;
    if (/^[1-9][0-9]?$/u.test(value.trim())) {
      const index = Number(value.trim()) - 1;
      if (index < 20 && filtered[index] !== undefined) return filtered[index];
      io.write("Choose one of the displayed numbers.\n");
    } else filtered = values.filter(item => label(item).toLowerCase().includes(value.trim().toLowerCase()));
  }
}
function printResponse(io: TerminalSession, response: ControlResponse): void {
  if (!response.ok) { io.write(`${terminalText(response.message)}\n`); return; }
  if (response.kind === "job") { io.write(`Still pending: ${response.jobId}. Use textbutler jobs show ${response.jobId}. Do not repeat this operation.\n`); return; }
  if (response.kind === "snapshot") { io.write("Settings updated.\n"); return; }
  io.write(`${terminalText(JSON.stringify(response, null, 2))}\n`);
}

/** A thin owner client, following XCB's separation between interaction and
 * runtime authority. Selection never becomes a shell command or recipient guess. */
export async function runTerminalSession(dataDir: string, io: TerminalSession, client: OwnerControlClient = request => requestDaemon({ dataDir, request }), options: { entrypoint?: string } = {}): Promise<number> {
  const entrypoint = options.entrypoint ?? fileURLToPath(new URL("cli.ts", import.meta.url));
  const lifecycle = () => createLaunchAgentLifecycle(defaultLaunchAgentHost(entrypoint));
  const job = (request: ControlRequest) => awaitOwnerJob(request, client);
  const current = async (): Promise<DesktopSnapshot | null> => {
    const response = await client({ protocol: CONTROL_PROTOCOL, command: "snapshot" }).catch(() => null);
    return response?.ok && response.kind === "snapshot" ? response.snapshot : null;
  };
  const owner = async (args: readonly string[]): Promise<void> => {
    await handleOwnerCommand(args, { request: client, print: value => io.write(`${terminalText(JSON.stringify(value, null, 2))}\n`) });
  };
  while (true) {
    const snapshot = await current();
    io.write(terminalDashboard(snapshot));
    const choice = await io.ask("Choose an action: ");
    if (choice === null || ["q", "quit", "exit"].includes(choice.trim().toLowerCase())) return 0;
    try {
      if (choice.trim() === "1") {
        await runSetup([], dataDir, io, { next: false });
        const configured = await loadHostConfig(dataDir);
        const hasMessaging = Boolean(configured.ghostget?.authId || configured.ghostget?.automationAccounts?.length);
        if (!snapshot && !hasMessaging) {
          io.write("Next choose Connect messaging apps (2). After saving your connections, return here to start the background service.\n");
        } else if (!snapshot && (await io.ask("Start the background service at login? [y/N]: "))?.trim().toLowerCase() === "y") {
          const result = await lifecycle().install(dataDir);
          io.write(`${terminalText(JSON.stringify(result, null, 2))}\n`);
        }
        continue;
      }
      if (!snapshot && !["2", "8"].includes(choice.trim())) { io.write("Choose Setup & readiness (1) to start the background service, then return here. For a foreground session use textbutler daemon run in another terminal.\n"); continue; }
      if (choice.trim() === "2") {
        const providers = snapshot?.messagingProviders ?? [];
        const provider = providers.length ? await pick(io, "Choose a connection", [...providers, "configure" as const], value =>
          value === "configure" ? "Add another messaging app" : value === "beeper" ? "Beeper — linked messaging apps" : value === "imessage" ? "iMessage — native Messages" : "WhatsApp — native linked device") : "configure";
        if (provider === "configure") {
          io.write("Sign in to each app with Ghostget first. iMessage also needs macOS access for Textbutler (textbutler help permissions). Beeper must be open with its linked apps. Adding connections requires the Textbutler service to be stopped.\n");
          const config = await loadHostConfig(dataDir).catch(() => null);
          const executable = config?.ghostget?.executable ?? await io.ask("Physical path to Ghostget executable (Enter to cancel): ");
          if (!executable?.trim()) continue;
          const runtime = config?.ghostget ? config.ghostget.runtimeExecutable ?? "" : await io.ask("Physical path to Bun if Ghostget is a .ts file (otherwise Enter): ");
          if (runtime === null) continue;
          const accounts = await io.ask("Accounts, separated by commas (for example imessage:messages,beeper:beeper-main): ");
          if (!accounts?.trim()) continue;
          const args = ["--ghostget", executable.trim(), ...(runtime.trim() ? ["--runtime", runtime.trim()] : []),
            ...(config?.ghostget?.stateHome ? ["--state-home", config.ghostget.stateHome] : [])];
          for (const account of accounts.split(",")) args.push("--account", account.trim());
          await runSetup(args, dataDir, io, { next: false });
          io.write("Connections saved. Choose Setup & readiness (1) to start the background service.\n");
          continue;
        }
        if (provider) printResponse(io, await job({ protocol: CONTROL_PROTOCOL, command: "messaging.start", provider }));
      } else if (choice.trim() === "3") {
        const response = await job({ protocol: CONTROL_PROTOCOL, command: "conversations.list" });
        if (!response.ok || response.kind !== "conversations") { printResponse(io, response); continue; }
        io.write(`${terminalText(response.detail)}\n`);
        const candidate = await pick(io, "Select the exact conversation", response.candidates, value => `${value.name} · ${value.subtitle}${value.eligible ? "" : ` (unavailable: ${value.reason})`}`);
        if (!candidate) continue;
        if (!candidate.eligible) { io.write(`${terminalText(candidate.reason)}\n`); continue; }
        const history = await io.ask("Import up to 200 recent messages as context? [y/N]: ");
        if (history === null) continue;
        const confirmed = await io.ask(`Add ${terminalLabel(candidate.name)} with automatic replies OFF? [y/N]: `);
        if (confirmed?.trim().toLowerCase() !== "y") continue;
        await owner(["contacts", "add", candidate.id, ...(history.trim().toLowerCase() === "y" ? ["--history"] : [])]);
      } else if (choice.trim() === "4") {
        const response = await job({ protocol: CONTROL_PROTOCOL, command: "replies.scan" });
        if (!response.ok || response.kind !== "replies") { printResponse(io, response); continue; }
        io.write(`Checked ${response.checked} conversations; ${response.unreadable} unavailable.\n`);
        const item = await pick(io, "Waiting for your reply", response.pending, value => `${value.name} · ${value.pendingCount} messages\n     ${value.preview ?? ""}${value.reason ? `\n     ${value.reason}` : ""}`);
        if (!item) continue;
        const action = await io.ask("[t] Type a reply  [s] Suggest a reply  [Enter] Back: ");
        if (action?.trim() === "s") {
          const suggested = await job({ protocol: CONTROL_PROTOCOL, command: "replies.suggest", contactId: item.contactId });
          if (!suggested.ok || suggested.kind !== "reply-suggestion" || !suggested.draft) { printResponse(io, suggested); continue; }
          const review = await client({ protocol: CONTROL_PROTOCOL, command: "replies.draft.read", draftId: suggested.draft.id });
          if (!review.ok || review.kind !== "reply-draft") { printResponse(io, review); continue; }
          io.write(`\nReview every outgoing action for ${terminalLabel(review.draft.name)} (${review.draft.provider}).\n`);
          io.write(terminalDraft(review.draft));
          if ((await io.ask("Type send to send these exact actions, or Enter to cancel: ")) === "send") {
            printResponse(io, await job({ protocol: CONTROL_PROTOCOL, command: "replies.send", draftId: review.draft.id, expectedDigest: review.draft.digest }));
          }
        } else if (action?.trim() === "t") {
          const text = await io.ask("Your reply (Enter to cancel): ");
          if (!text?.trim()) continue;
          if (Buffer.byteLength(text) > 16_384) { io.write("Keep this reply within 16 KB.\n"); continue; }
          const contact = snapshot!.contacts.find(contact => contact.id === item.contactId);
          if (!contact) continue;
          const disclosed = disclose(text, contact.settings.disclosure);
          io.write(`\nTo: ${terminalLabel(item.name)}\n${terminalText(disclosed)}\n\n`);
          if ((await io.ask("Type send to send this reply, or Enter to cancel: ")) === "send") {
            printResponse(io, await job({ protocol: CONTROL_PROTOCOL, command: "replies.send", contactId: item.contactId, text, expectedRevision: snapshot!.revision }));
          }
        }
      } else if (choice.trim() === "5") {
        const contact = await pick(io, "Choose a contact", snapshot!.contacts, value => `${value.name} · automatic replies ${value.settings.enabled ? "on" : "off"} · ${value.messaging?.provider ?? "read only"}`);
        if (!contact) continue;
        const action = await io.ask("[a] Choose agent  [e] Enable automatic replies  [d] Disable  [k] Keyword mode  [Enter] Back: ");
        if (action?.trim() === "a") {
          const account = await pick(io, "Choose an agent account", snapshot!.providerAccounts ?? [], value => `${value.label} · ${value.status}\n     ${value.detail}`);
          if (account) await owner(["contacts", "account", contact.id, account.id]);
        } else if (action?.trim() === "d") await owner(["contacts", "disable", contact.id]);
        else if (action?.trim() === "e") {
          if ((await io.ask(`Allow automatic replies to ${terminalLabel(contact.name)} when unpaused? [y/N]: `))?.trim().toLowerCase() === "y") await owner(["contacts", "enable", contact.id]);
        } else if (action?.trim() === "k") {
          const keyword = await io.ask("Keyword (Enter keeps butler): ");
          if (keyword !== null) await owner(["contacts", "mode", contact.id, "keyword", "--keyword", keyword.trim() || "butler"]);
        }
      } else if (choice.trim() === "6") await owner(["pause"]);
      else if (choice.trim() === "7") {
        if ((await io.ask("Resume automatic replies for enabled contacts? [y/N]: "))?.trim().toLowerCase() === "y") await owner(["resume"]);
      } else if (choice.trim() === "8") {
        const action = await io.ask("[s] Start menu  [l] Start menu at login  [x] Stop menu  [Enter] Back: ");
        const command = action === "s" ? "start" : action === "l" ? "install" : action === "x" ? "stop" : null;
        if (command) await runMenuBarCommand([command], dataDir, entrypoint,
          result => io.write(`${terminalText(JSON.stringify(result, null, 2))}\n`));
      } else io.write("Choose a number from 1 to 8, or q to quit.\n");
    } catch (error) {
      if (error instanceof OwnerCliError) { io.write(`${terminalText(error.message)}\n`); continue; }
      // Input mistakes are not uncertain operations: show the one-line fix.
      if (error instanceof CliUsageError) { io.write(`${terminalText(error.message)} See: ${terminalText(error.next)}\n`); continue; }
      io.write("This action could not be confirmed. Check Setup & readiness and Recent activity. Do not repeat a send with an uncertain result.\n");
    }
  }
}

export async function runTextbutlerTui(dataDir: string, output: { write(text: string): unknown } = process.stdout, options: { entrypoint?: string } = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { output.write("The interactive terminal needs a TTY. Use textbutler setup, doctor, or --help for scriptable commands.\n"); return 1; }
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
  let closed = false;
  terminal.on("close", () => { closed = true; });
  terminal.on("SIGINT", () => terminal.close());
  try {
    return await runTerminalSession(dataDir, { write: text => output.write(terminalText(text)),
      ask: async prompt => {
        if (closed) return null;
        return await new Promise<string | null>(resolve => {
          const cancel = (): void => resolve(null);
          terminal.once("close", cancel);
          void terminal.question(terminalText(prompt)).then(answer => resolve(answer.length <= 16_384 ? answer : ""), () => resolve(null))
            .finally(() => terminal.removeListener("close", cancel));
        });
      } }, undefined, options);
  } finally { terminal.close(); }
}
