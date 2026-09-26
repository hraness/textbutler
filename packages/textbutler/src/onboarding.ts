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
import { nativeSubscriptionAccount } from "./native-subscription.ts";
import { CliUsageError, symbolsFor, type Symbols } from "./cli-style.ts";
import { macosAccessStep } from "./permission-readiness.ts";

/** "skipped" marks a step that doesn't apply or that the owner left off on purpose. */
export interface SetupStep { id: string; title: string; status: "done" | "action-needed" | "blocked" | "skipped"; detail: string; command?: string; settingsUrl?: string }
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
      detail: missing ? "Create your private settings. Automatic replies start paused." : "Your private settings can't be read. Keep the files, and check that you own them and only you can read them.",
      ...(missing ? { command: "textbutler setup" } : {}) });
  }
  if (config) steps.push({ id: "configuration", title: "Private settings", status: "done", detail: "Private settings are present. Existing contacts and pause settings are preserved." });
  const response = await requestDaemon({ dataDir, request: { protocol: CONTROL_PROTOCOL, command: "snapshot" } }).catch(() => null);
  const snapshot = response?.ok && response.kind === "snapshot" ? response.snapshot : null;
  const configured = config?.ghostget?.automationAccounts ?? [];
  const connected = snapshot?.messagingProviders ?? [];
  const appName = (provider: string): string => provider === "imessage" ? "iMessage" : provider === "whatsapp" ? "WhatsApp" : provider === "beeper" ? "Beeper" : provider;
  steps.push({ id: "messaging", title: "Messaging apps", status: connected.length > 0 || configured.length > 0 && !snapshot ? "done" : "action-needed",
    detail: connected.length > 0 ? `Connected: ${connected.map(appName).join(", ")}. Next, choose the chats Textbutler may answer.`
      : configured.length > 0 && !snapshot ? `Set up: ${configured.map(account => appName(account.provider)).join(", ")}. The background service connects them when it starts.`
      : configured.length > 0 ? "Your messaging apps are set up but not loaded. Restart the background service to load them."
      : "Connect iMessage, WhatsApp, or Beeper (for Signal, Telegram and more). Sign in to each app with Ghostget. iMessage also needs macOS access for Textbutler.",
    command: connected.length > 0 ? "textbutler messaging list" : configured.length > 0 ? "textbutler daemon install" : "textbutler tui" });
  const access = await macosAccessStep({ dataDir, imessageConfigured: configured.some(account => account.provider === "imessage") || connected.includes("imessage") });
  if (access) steps.push(access);
  steps.push({ id: "daemon", title: "Background service", status: snapshot ? "done" : "action-needed",
    detail: snapshot ? "Running." : "Start the background service. It keeps running after you close the terminal or menu.",
    ...(!snapshot ? { command: "textbutler daemon install" } : {}) });
  const contacts = snapshot?.contacts ?? [];
  steps.push({ id: "contacts", title: "Choose conversations", status: contacts.length > 0 ? "done" : "action-needed",
    detail: contacts.length > 0 ? `${contacts.length} chat${contacts.length === 1 ? "" : "s"} added. You can review your inbox with automatic replies off.`
      : "Add one chat first. It starts with automatic replies off. Importing history is optional and never sends a reply.",
    command: "textbutler tui" });
  const accounts = snapshot?.providerAccounts ?? [];
  const ready = accounts.filter(account => account.status === "ready");
  const selected = contacts.some(contact => ready.some(account => account.id === contact.settings.accountId && account.provider === contact.settings.provider));
  const xcbAccounts = config?.xcb?.accounts ?? [];
  const nextAccount = ready[0]?.id ?? (xcbAccounts[0] ? nativeSubscriptionAccount(xcbAccounts[0].provider) : "native-codex");
  steps.push({ id: "agent", title: "Reply suggestions", status: selected ? "done" : ready.length ? "action-needed" : "blocked",
    detail: selected ? "A ready AI account is chosen for at least one chat. Nothing is sent until you send it or turn on automatic replies."
      : ready.length ? "Choose a ready AI account for the chat you want help with."
      : xcbAccounts.length ? "Your xcb accounts are set up. Start the background service, then check an account. It must be signed in with model access before Textbutler can suggest replies."
      : "Connect your Claude, Codex, or Devin subscription through xcb. Sign in with xcb first; Textbutler keeps only references. You can review your inbox and send your own replies without one.",
    command: ready.length ? `textbutler contacts account <contact> ${nextAccount}`
      : xcbAccounts.length ? `textbutler providers check ${nextAccount}`
      : "textbutler help setup" });
  const automaticReplies = snapshot?.automation?.state ?? "unavailable";
  const paused = automaticReplies !== "running" && snapshot?.settings.paused === true;
  steps.push({ id: "automation", title: "Automatic replies", status: automaticReplies === "running" ? "done" : paused ? "skipped" : "action-needed",
    detail: automaticReplies === "running" ? "Running for the chats you turned on. You can pause them any time."
      : paused ? "Paused. Leave them off while you try the inbox; turning them on is a separate choice."
      : "Automatic replies need a chat that's turned on, access to send in it, and a ready AI account.",
    command: automaticReplies === "running" ? "textbutler pause" : paused ? "textbutler resume" : "textbutler help contacts" });
  return { ok: config !== null && snapshot !== null && process.platform === "darwin", platform: process.platform, dataDir, initialized,
    daemonConnected: snapshot !== null, automaticReplies, canReviewInbox: snapshot?.replies !== undefined && contacts.length > 0,
    canGenerateReplies: selected, steps, snapshot };
}

/** Human readiness report (SPEC § D7): one symbol per step, detail only where
 * something is left to do, a one-line count and at most one next command. */
export function readinessText(value: Readiness, options: { symbols?: Symbols; next?: boolean } = {}): string {
  const symbols = options.symbols ?? symbolsFor();
  const mark = (status: SetupStep["status"]): string => status === "done" ? symbols.ok : status === "blocked" ? symbols.fail : status === "skipped" ? symbols.skip : symbols.warn;
  const lines = ["Textbutler readiness", ""];
  for (const step of value.steps) {
    lines.push(`${mark(step.status)} ${step.title}`);
    if (step.status !== "done") lines.push(`  ${step.detail}`);
  }
  const open = value.steps.filter(step => step.status === "action-needed" || step.status === "blocked");
  const next = open.find(step => step.command !== undefined)?.command;
  lines.push("", "Replies need your Mac awake and signed in. Quitting the menu doesn't stop them.", "",
    open.length === 0 ? "Everything is ready." : `${open.length} step${open.length === 1 ? "" : "s"} left.`);
  if (next !== undefined && options.next !== false) lines.push(`${symbols.next} ${next}`);
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(dataDir: string, output: { write(text: string): unknown }, options: { json?: boolean; symbols?: Symbols } = {}): Promise<number> {
  const value = await readReadiness(dataDir);
  output.write(options.json ? `${JSON.stringify(value)}\n` : readinessText(value, options.symbols === undefined ? {} : { symbols: options.symbols }));
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
  } catch { throw new OwnerCliError("Use an owned physical xcb executable, without links or group/public write access. Its exact SHA-256 is pinned during setup; no account credentials are copied."); }
  finally { await handle?.close(); }
}

/** Setup is additive under the daemon owner lock. It cannot replace an account,
 * executable, model, or agent settings, nor can it start synchronization. */
export async function runSetup(args: readonly string[], dataDir: string, output: { write(text: string): unknown }, options: { next?: boolean; symbols?: Symbols } = {}): Promise<number> {
  let config: HostConfig | undefined;
  if (args.length > 0) {
    const values = new Map<string, string>(); const accounts: { provider: string; authId: string }[] = [];
    const xcbAccounts: { provider: string; accountId: string }[] = [], xcbModels = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!value || !["--ghostget", "--runtime", "--state-home", "--account", "--xcb", "--xcb-state", "--xcb-account", "--xcb-model"].includes(key)) throw new CliUsageError("Setup needs different options.", "textbutler help setup");
      if (key === "--account" || key === "--xcb-account") {
        const parts = value.split(":");
        if (parts.length !== 2) throw new CliUsageError("Setup needs different options.", "textbutler help setup");
        if (key === "--account") accounts.push({ provider: parts[0]!, authId: parts[1]! });
        else xcbAccounts.push({ provider: parts[0]!, accountId: parts[1]! });
      } else if (key === "--xcb-model") {
        const provider = value.split("/")[0]!;
        if (xcbModels.has(provider)) throw new CliUsageError("Setup needs different options.", "textbutler help setup");
        xcbModels.set(provider, value);
      } else { if (values.has(key)) throw new CliUsageError("Setup needs different options.", "textbutler help setup"); values.set(key, value); }
    }
    const ghostgetRequested = ["--ghostget", "--runtime", "--state-home"].some(key => values.has(key)) || accounts.length > 0;
    const xcbRequested = values.has("--xcb") || values.has("--xcb-state") || xcbAccounts.length > 0 || xcbModels.size > 0;
    if (ghostgetRequested && (!values.has("--ghostget") || accounts.length === 0)
      || xcbRequested && (!values.has("--xcb") || !values.has("--xcb-state") || xcbAccounts.length === 0
        || xcbModels.size !== xcbAccounts.length || xcbAccounts.some(account => !xcbModels.has(account.provider)))) throw new CliUsageError("Setup needs different options.", "textbutler help setup");
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
      catch { throw new OwnerCliError("Use xcb's existing owned, private, physical state directory. Connect your subscription using xcb first; Textbutler does not create or copy credentials."); }
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
            throw new OwnerCliError("Existing xcb executable, digest and state directory were preserved. Reuse the same installation when adding an account; an xcb upgrade requires explicit owner configuration review.");
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
    output.write(`${(options.symbols ?? symbolsFor()).ok} Connection saved. Existing accounts and settings were kept. No credentials were copied and no messages were read or sent.\n\n`);
  }
  output.write(readinessText(await readReadiness(dataDir), { ...(options.symbols === undefined ? {} : { symbols: options.symbols }), ...(options.next === undefined ? {} : { next: options.next }) }));
  return 0;
}
