/** Shows a permission notice before macOS asks, and recovery after a denial.
 * Mirrors prePrompt() and the audience table from the desktop-foundation
 * permissions kit (docs/permissions.md).
 * TODO(df-0.8): use prePrompt from @hraness/desktop-foundation.
 * TODO(wave-b): switch to the kit once Textbutler depends on 0.8.0. */
import { detectAudience, symbolsFor } from "./cli-style.ts";
import { formatNotice, formatRecovery, renderPrePrompt, settingsUrl, SETTINGS_URLS, type PermissionNeed } from "./permission-copy.ts";

type Env = Readonly<Record<string, string | undefined>>;
export type Key = "enter" | "s" | "o" | "timeout";

export interface PromptIO {
  env: Env;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  /** Writes to stderr. */
  write(text: string): void;
  /** One line from the terminal: Enter, s, o, or a timeout. */
  readKey(timeoutSeconds: number): Promise<Key>;
  /** Runs /usr/bin/open with an allowlisted System Settings URL. */
  openUrl(url: string): Promise<boolean>;
}

export type PrePromptOutcome = "continue" | "skip" | "unattended-proceed" | "unattended-stop";

/** Never triggers the macOS prompt itself. Settings opens only on Enter for a
 * settings-only notice, which is an explicit owner action. */
export async function prePrompt(need: PermissionNeed & { whenUnattended?: "proceed" | "stop" }, io: PromptIO, timeoutSeconds = 120): Promise<PrePromptOutcome> {
  const audience = detectAudience({ env: io.env, stderrIsTTY: io.stderrIsTTY });
  const interactive = audience === "human" && io.stdinIsTTY && io.stderrIsTTY;
  const unattended = (need.whenUnattended ?? "stop") === "proceed" ? "unattended-proceed" : "unattended-stop";
  if (audience === "agent") {
    io.write(`${JSON.stringify({ type: "permission-notice", product: need.product, kind: need.kind, message: renderPrePrompt(need, false).lines.join(" ") })}\n`);
    return unattended;
  }
  if (audience === "quiet") return unattended;
  io.write(formatNotice(renderPrePrompt(need, interactive), symbolsFor(io.env)));
  if (!interactive) return unattended;
  if (await io.readKey(timeoutSeconds) !== "enter") return "skip";
  // Full Disk Access has no macOS dialog; Enter opens its pane instead.
  if (need.kind === "full-disk-access") await openSettings(need, io);
  return "continue";
}

/** Prints the recovery for a denial or an unconfirmed result to a person at a
 * terminal. After a denial, "o" opens the pane. */
export async function recover(need: PermissionNeed, state: "denied" | "unknown", io: PromptIO, timeoutSeconds = 60): Promise<void> {
  if (detectAudience({ env: io.env, stderrIsTTY: io.stderrIsTTY }) !== "human") return;
  const interactive = io.stdinIsTTY && io.stderrIsTTY && state === "denied";
  io.write(formatRecovery(need, state, interactive, symbolsFor(io.env)));
  if (interactive && await io.readKey(timeoutSeconds) === "o") await openSettings(need, io);
}

async function openSettings(need: PermissionNeed, io: PromptIO): Promise<boolean> {
  const url = settingsUrl(need.kind);
  return SETTINGS_URLS.includes(url) ? io.openUrl(url) : false;
}

/** Real terminal IO for scripts. Tests inject their own PromptIO instead. */
export function terminalPromptIO(): PromptIO {
  return {
    env: process.env, stdinIsTTY: process.stdin.isTTY === true, stderrIsTTY: process.stderr.isTTY === true,
    write: text => { process.stderr.write(text); },
    readKey: timeoutSeconds => new Promise(resolve => {
      const stdin = process.stdin;
      const done = (value: Key): void => { clearTimeout(timer); stdin.off("data", onData); stdin.pause(); resolve(value); };
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8").trim().toLowerCase();
        done(text === "" ? "enter" : text === "o" ? "o" : "s");
      };
      const timer = setTimeout(() => done("timeout"), timeoutSeconds * 1000);
      stdin.resume(); stdin.on("data", onData);
    }),
    openUrl: async url => {
      if (!SETTINGS_URLS.includes(url)) return false;
      const child = Bun.spawn(["/usr/bin/open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return await child.exited === 0;
    },
  };
}
