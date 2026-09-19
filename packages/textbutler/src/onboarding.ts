import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createPrivateFileOnce, publishPrivateFile } from "@hraness/local-custody/atomic-publish";
import { assertOwnedPath } from "@hraness/local-custody/private-paths";
import { CONTROL_PROTOCOL, type DesktopSnapshot } from "../../control/src/index.ts";
import { acquireOwnerDatabase } from "./daemon-custody.ts";
import { OwnerCliError } from "./owner-cli.ts";
import { initializeOwnerState } from "./control-service.ts";
import { requestDaemon } from "./daemon.ts";
import { loadHostConfig, parseHostConfig, type HostConfig } from "./host-config.ts";

export interface SetupStep { id: string; title: string; status: "done" | "action-needed" | "blocked"; detail: string; command?: string }
export interface Readiness {
  ok: boolean; platform: string; dataDir: string; initialized: boolean; daemonConnected: boolean;
  automaticReplies: "running" | "paused" | "unavailable";
  canReviewInbox: boolean; canGenerateReplies: boolean; steps: readonly SetupStep[];
  snapshot: DesktopSnapshot | null;
}
export const SETUP_USAGE = "textbutler setup [--ghostget /absolute/executable [--runtime /absolute/bun] [--state-home /absolute/state] --account imessage:ACCOUNT --account whatsapp:ACCOUNT --account beeper:ACCOUNT]";

/** Inspect local configuration and daemon metadata only. Never opens a provider,
 * imports history, spends model credits, or changes pause/contact settings. */
export async function readReadiness(dataDir: string): Promise<Readiness> {
  const steps: SetupStep[] = [];
  let initialized = false, config: HostConfig | null = null;
  try {
    await assertOwnedPath(join(dataDir, "state", "settings.json"), { kind: "file", exactMode: 0o600, links: 1 });
    initialized = true;
    config = await loadHostConfig(dataDir);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    steps.push({ id: "configuration", title: "Private settings", status: missing ? "action-needed" : "blocked",
      detail: missing ? "Create your private settings. Automatic replies start paused." : "Private settings need attention. Preserve existing files; check their ownership, permissions and configuration.",
      ...(missing ? { command: "textbutler setup" } : {}) });
  }
  if (config) steps.push({ id: "configuration", title: "Private settings", status: "done", detail: "Private settings are present. Existing contacts and pause settings are preserved." });
  const response = await requestDaemon({ dataDir, request: { protocol: CONTROL_PROTOCOL, command: "snapshot" } }).catch(() => null);
  const snapshot = response?.ok && response.kind === "snapshot" ? response.snapshot : null;
  steps.push({ id: "daemon", title: "Background service", status: snapshot ? "done" : "action-needed",
    detail: snapshot ? "The owner control service is connected." : "Start the background service. It continues after you close the terminal or menu.",
    ...(!snapshot ? { command: "textbutler daemon install" } : {}) });
  const configured = config?.ghostget?.automationAccounts ?? [];
  const connected = snapshot?.messagingProviders ?? [];
  steps.push({ id: "messaging", title: "Messaging apps", status: connected.length > 0 ? "done" : "action-needed",
    detail: connected.length > 0 ? `Configured connections: ${connected.join(", ")}. Connect each app, then choose an exact conversation.`
      : configured.length > 0 ? "Messaging accounts are configured. Restart the daemon to load them; inspect connection status if it remains unavailable."
      : "Choose native iMessage, native WhatsApp, or Beeper for linked messaging apps. Account sign-in and permissions belong to Ghostget.",
    command: connected.length > 0 ? "textbutler messaging list" : "textbutler setup" });
  const contacts = snapshot?.contacts ?? [];
  steps.push({ id: "contacts", title: "Choose conversations", status: contacts.length > 0 ? "done" : "action-needed",
    detail: contacts.length > 0 ? `${contacts.length} selected conversation${contacts.length === 1 ? "" : "s"}. You can review your inbox with automatic replies off.`
      : "Add one conversation first. New contacts stay disabled; importing history is optional and never sends a reply.",
    command: "textbutler tui" });
  const accounts = snapshot?.providerAccounts ?? [];
  const ready = accounts.filter(account => account.status === "ready");
  const selected = contacts.some(contact => ready.some(account => account.id === contact.settings.accountId && account.provider === contact.settings.provider));
  steps.push({ id: "agent", title: "Reply suggestions", status: selected ? "done" : ready.length ? "action-needed" : "blocked",
    detail: selected ? "A ready agent account is selected for at least one contact. Suggestions still require an explicit send."
      : ready.length ? "Choose a ready agent account for the contact you want help with."
      : "No qualified reply engine is ready. The source CLI cannot activate Codex, Claude Code, or Claude API. Inbox review and explicit typed replies do not need an AI account.",
    command: "textbutler providers list" });
  const automaticReplies = snapshot?.automation?.state ?? "unavailable";
  steps.push({ id: "automation", title: "Automatic replies", status: automaticReplies === "running" ? "done" : "action-needed",
    detail: automaticReplies === "running" ? "Automatic replies are running for enabled contacts. Pause remains available."
      : snapshot?.settings.paused ? "Paused. Keep this off while you try inbox review; enabling automation is a separate choice."
      : "Automatic replies need an enabled contact, a current messaging grant and a qualified agent.", command: "textbutler pause" });
  return { ok: config !== null && snapshot !== null && process.platform === "darwin", platform: process.platform, dataDir, initialized,
    daemonConnected: snapshot !== null, automaticReplies, canReviewInbox: snapshot?.replies !== undefined && contacts.length > 0,
    canGenerateReplies: selected, steps, snapshot };
}

export function readinessText(value: Readiness): string {
  return ["Textbutler — setup and readiness", "", ...value.steps.map(step => `${step.status === "done" ? "✓" : step.status === "blocked" ? "!" : "○"} ${step.title}\n  ${step.detail}${step.command && step.status !== "done" ? `\n  Next: ${step.command}` : ""}`),
    "", "Your Mac must be awake and signed in. Quitting the menu does not stop the daemon.",
    "Pause stops automatic replies; owner-confirmed replies are a separate action.", ""].join("\n");
}

export async function runDoctor(dataDir: string, output: { write(text: string): unknown }): Promise<number> {
  const value = await readReadiness(dataDir);
  output.write(`${JSON.stringify(value)}\n`);
  return value.ok ? 0 : 1;
}

/** Setup is additive under the daemon owner lock. It cannot replace an account,
 * executable, or agent settings, nor can it start synchronization. */
export async function runSetup(args: readonly string[], dataDir: string, output: { write(text: string): unknown }): Promise<number> {
  let config: HostConfig | undefined;
  if (args.length > 0) {
    const values = new Map<string, string>(); const accounts: { provider: string; authId: string }[] = [];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!value || !["--ghostget", "--runtime", "--state-home", "--account"].includes(key)) throw new OwnerCliError(SETUP_USAGE);
      if (key === "--account") {
        const parts = value.split(":");
        if (parts.length !== 2) throw new OwnerCliError(SETUP_USAGE);
        accounts.push({ provider: parts[0]!, authId: parts[1]! });
      } else { if (values.has(key)) throw new OwnerCliError(SETUP_USAGE); values.set(key, value); }
    }
    if (!values.has("--ghostget") || accounts.length === 0) throw new OwnerCliError(SETUP_USAGE);
    config = parseHostConfig({ schemaVersion: 1, ghostget: { executable: values.get("--ghostget"), authId: accounts[0]!.authId,
      automationAccounts: accounts, ...(values.has("--runtime") ? { runtimeExecutable: values.get("--runtime") } : {}),
      ...(values.has("--state-home") ? { stateHome: values.get("--state-home") } : {}) } });
    for (const path of [config.ghostget!.executable, config.ghostget!.runtimeExecutable].filter((path): path is string => path !== undefined)) {
      const metadata = await stat(path);
      if (!metadata.isFile() || await realpath(path) !== path || (metadata.mode & 0o022) !== 0 || metadata.uid !== process.getuid?.() && metadata.uid !== 0) {
        throw new OwnerCliError("Use an owned physical Ghostget executable and runtime, without group or public write access.");
      }
    }
    try { await access(config.ghostget!.runtimeExecutable ?? config.ghostget!.executable, constants.X_OK); }
    catch { throw new OwnerCliError("The selected command cannot execute. For a Ghostget TypeScript entrypoint, also supply --runtime with the physical Bun executable."); }
  }
  await initializeOwnerState(dataDir);
  if (config) {
    const merge = (existing: HostConfig): HostConfig => {
      const previous = existing.ghostget, incoming = config!.ghostget!;
      if (!previous) return parseHostConfig({ ...existing, ghostget: incoming });
      if (previous.executable !== incoming.executable || previous.runtimeExecutable !== incoming.runtimeExecutable || previous.stateHome !== incoming.stateHome) {
        throw new OwnerCliError("Existing connector paths were preserved. Reuse the same Ghostget/runtime/state paths when adding an account; changing the connector requires explicit owner configuration review.");
      }
      const accounts = [...previous.automationAccounts ?? []];
      for (const account of incoming.automationAccounts ?? []) {
        const found = accounts.find(value => value.provider === account.provider);
        if (found && found.authId !== account.authId) throw new OwnerCliError("This app already has a different account. Setup preserves that binding; it cannot silently switch recipients or account identity.");
        if (!found) accounts.push(account);
      }
      return parseHostConfig({ ...existing, ghostget: { ...previous, automationAccounts: accounts } });
    };
    const before = await loadHostConfig(dataDir), desired = merge(before);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      let lock;
      try { lock = await acquireOwnerDatabase(dataDir, "daemon-custody"); }
      catch { throw new OwnerCliError("Stop the Textbutler service before adding a connection: use daemon uninstall for a login service, or Ctrl-C in its foreground terminal. Settings and contact memory are retained. Then repeat setup and start the service again."); }
      try {
        const current = await loadHostConfig(dataDir), merged = merge(current);
        const contents = `${JSON.stringify(merged, null, 2)}\n`;
        const outcome = await createPrivateFileOnce(join(dataDir, "state"), "host.json", contents);
        if (outcome === "existing" && JSON.stringify(current) !== JSON.stringify(merged)) {
          await publishPrivateFile(join(dataDir, "state"), "host.json", contents, { beforeCommit: async () => {
            if (JSON.stringify(await loadHostConfig(dataDir)) !== JSON.stringify(current)) throw new OwnerCliError("Configuration changed during setup. No new connection was applied; inspect current settings before continuing.");
          } });
        }
      } finally { lock.close(); }
    }
    output.write("Messaging configuration saved. Existing accounts and agent settings are preserved. No messages were read or sent. Start the daemon to load new connections.\n\n");
  }
  output.write(readinessText(await readReadiness(dataDir)));
  if (!config) output.write("For guided connection and contact selection, run: textbutler tui\n");
  return 0;
}
