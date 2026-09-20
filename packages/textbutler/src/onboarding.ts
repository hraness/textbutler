import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
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
export const SETUP_USAGE = "textbutler setup [--ghostget /absolute/executable [--runtime /absolute/bun] [--state-home /absolute/state] --account PROVIDER:ACCOUNT ...] [--xcb /absolute/executable --xcb-state /absolute/state --xcb-account PROVIDER:ACCOUNT --xcb-model PROVIDER/MODEL[/EFFORT] ...]";

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
  const xcbAccounts = config?.xcb?.accounts ?? [];
  const nextAccount = ready[0]?.id ?? (xcbAccounts[0]?.provider === "claude" ? "native-claude-code" : "native-codex");
  steps.push({ id: "agent", title: "Reply suggestions", status: selected ? "done" : ready.length ? "action-needed" : "blocked",
    detail: selected ? "A ready agent account is selected for at least one contact. Suggestions still require an explicit send."
      : ready.length ? "Choose a ready agent account for the contact you want help with."
      : xcbAccounts.length ? "XCB subscription accounts are configured. Start or restart the daemon, then check the selected account. Sign-in, model access and contact-scoped qualification must all pass before suggestions are available."
      : "Connect your Claude or Codex subscription through XCB using an explicit account and full model key. Sign in using XCB first; Textbutler keeps only references. Inbox review and explicit typed replies do not need an AI account.",
    command: ready.length ? `textbutler contacts account CONTACT ${nextAccount}`
      : xcbAccounts.length ? `textbutler providers check ${nextAccount}`
      : "textbutler setup --xcb /absolute/xcb --xcb-state /absolute/xcb-state --xcb-account codex:ACCOUNT --xcb-model codex/MODEL" });
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

/** Hash only an explicit, physical executable. Never execute it during setup. */
async function xcbExecutableDigest(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 256 * 1024 * 1024
      || await realpath(path) !== path || (before.mode & 0o022) !== 0
      || before.uid !== process.getuid?.() && before.uid !== 0) throw Error("unsafe executable");
    await access(path, constants.X_OK);
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - total + 1), total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > before.size) throw Error("changed executable");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await lstat(path);
    if (total !== before.size || !after.isFile() || await realpath(path) !== path
      || ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeMs", "ctimeMs"].some(key => after[key as keyof typeof after] !== before[key as keyof typeof before])) throw Error("changed executable");
    return hash.digest("hex");
  } catch { throw new OwnerCliError("Use an owned physical XCB executable, without links or group/public write access. Its exact SHA-256 is pinned during setup; no account credentials are copied."); }
  finally { await handle?.close(); }
}

/** Setup is additive under the daemon owner lock. It cannot replace an account,
 * executable, model, or agent settings, nor can it start synchronization. */
export async function runSetup(args: readonly string[], dataDir: string, output: { write(text: string): unknown }): Promise<number> {
  let config: HostConfig | undefined;
  if (args.length > 0) {
    const values = new Map<string, string>(); const accounts: { provider: string; authId: string }[] = [];
    const xcbAccounts: { provider: string; accountId: string }[] = [], xcbModels = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!value || !["--ghostget", "--runtime", "--state-home", "--account", "--xcb", "--xcb-state", "--xcb-account", "--xcb-model"].includes(key)) throw new OwnerCliError(SETUP_USAGE);
      if (key === "--account" || key === "--xcb-account") {
        const parts = value.split(":");
        if (parts.length !== 2) throw new OwnerCliError(SETUP_USAGE);
        if (key === "--account") accounts.push({ provider: parts[0]!, authId: parts[1]! });
        else xcbAccounts.push({ provider: parts[0]!, accountId: parts[1]! });
      } else if (key === "--xcb-model") {
        const provider = value.split("/")[0]!;
        if (xcbModels.has(provider)) throw new OwnerCliError(SETUP_USAGE);
        xcbModels.set(provider, value);
      } else { if (values.has(key)) throw new OwnerCliError(SETUP_USAGE); values.set(key, value); }
    }
    const ghostgetRequested = ["--ghostget", "--runtime", "--state-home"].some(key => values.has(key)) || accounts.length > 0;
    const xcbRequested = values.has("--xcb") || values.has("--xcb-state") || xcbAccounts.length > 0 || xcbModels.size > 0;
    if (ghostgetRequested && (!values.has("--ghostget") || accounts.length === 0)
      || xcbRequested && (!values.has("--xcb") || !values.has("--xcb-state") || xcbAccounts.length === 0
        || xcbModels.size !== xcbAccounts.length || xcbAccounts.some(account => !xcbModels.has(account.provider)))) throw new OwnerCliError(SETUP_USAGE);
    config = parseHostConfig({ schemaVersion: 1, ...(ghostgetRequested ? { ghostget: { executable: values.get("--ghostget"), authId: accounts[0]!.authId,
      automationAccounts: accounts, ...(values.has("--runtime") ? { runtimeExecutable: values.get("--runtime") } : {}),
      ...(values.has("--state-home") ? { stateHome: values.get("--state-home") } : {}) } } : {}),
      ...(xcbRequested ? { xcb: { executable: values.get("--xcb"), stateHome: values.get("--xcb-state"), sha256: "0".repeat(64),
        accounts: xcbAccounts.map(account => ({ ...account, model: xcbModels.get(account.provider) })) } } : {}) });
    for (const path of [config.ghostget?.executable, config.ghostget?.runtimeExecutable].filter((path): path is string => path !== undefined)) {
      const metadata = await stat(path);
      if (!metadata.isFile() || await realpath(path) !== path || (metadata.mode & 0o022) !== 0 || metadata.uid !== process.getuid?.() && metadata.uid !== 0) {
        throw new OwnerCliError("Use an owned physical Ghostget executable and runtime, without group or public write access.");
      }
    }
    if (config.ghostget) {
      try { await access(config.ghostget.runtimeExecutable ?? config.ghostget.executable, constants.X_OK); }
      catch { throw new OwnerCliError("The selected command cannot execute. For a Ghostget TypeScript entrypoint, also supply --runtime with the physical Bun executable."); }
    }
    if (config.xcb) {
      const sha256 = await xcbExecutableDigest(config.xcb.executable);
      try { await assertOwnedPath(config.xcb.stateHome, { kind: "directory", canonical: true, ownerOnly: true }); }
      catch { throw new OwnerCliError("Use XCB's existing owned, private, physical state directory. Connect your subscription using XCB first; Textbutler does not create or copy credentials."); }
      config = parseHostConfig({ ...config, xcb: { ...config.xcb, sha256 } });
    }
  }
  await initializeOwnerState(dataDir);
  if (config) {
    const merge = (existing: HostConfig): HostConfig => {
      let merged = existing;
      if (config!.xcb) {
        const incoming = config!.xcb, previous = existing.xcb;
        if (!previous) merged = parseHostConfig({ ...merged, xcb: incoming });
        else {
          if (previous.executable !== incoming.executable || previous.stateHome !== incoming.stateHome || previous.sha256 !== incoming.sha256)
            throw new OwnerCliError("Existing XCB executable, digest and state directory were preserved. Reuse the same installation when adding an account; an XCB upgrade requires explicit owner configuration review.");
          const accounts = [...previous.accounts];
          for (const account of incoming.accounts) {
            const found = accounts.find(value => value.provider === account.provider);
            if (found && (found.accountId !== account.accountId || found.model !== account.model)) throw new OwnerCliError("This subscription already has a different account or model. Setup preserves that binding; it cannot silently switch account identity or model.");
            if (!found) accounts.push(account);
          }
          merged = parseHostConfig({ ...merged, xcb: { ...previous, accounts } });
        }
      }
      const previous = existing.ghostget, incoming = config!.ghostget;
      if (!incoming) return merged;
      if (!previous) return parseHostConfig({ ...merged, ghostget: incoming });
      if (previous.executable !== incoming.executable || previous.runtimeExecutable !== incoming.runtimeExecutable || previous.stateHome !== incoming.stateHome) {
        throw new OwnerCliError("Existing connector paths were preserved. Reuse the same Ghostget/runtime/state paths when adding an account; changing the connector requires explicit owner configuration review.");
      }
      const accounts = [...previous.automationAccounts ?? []];
      for (const account of incoming.automationAccounts ?? []) {
        const found = accounts.find(value => value.provider === account.provider);
        if (found && found.authId !== account.authId) throw new OwnerCliError("This app already has a different account. Setup preserves that binding; it cannot silently switch recipients or account identity.");
        if (!found) accounts.push(account);
      }
      return parseHostConfig({ ...merged, ghostget: { ...previous, automationAccounts: accounts } });
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
    output.write("Connection configuration saved. Existing accounts and agent settings are preserved. No credentials were copied and no messages were read or sent. Start the daemon to load new connections, then run providers check for your chosen AI account.\n\n");
  }
  output.write(readinessText(await readReadiness(dataDir)));
  if (!config) output.write("For guided connection and contact selection, run: textbutler tui\n");
  return 0;
}
