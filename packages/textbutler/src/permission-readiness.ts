/** The doctor's "macOS access for iMessage" step. It reads only Textbutler's
 * own private records: the installed app receipt and the last app-setup
 * result. It never opens Messages, probes chat.db, or causes a macOS prompt.
 * A file probe from this process would test the terminal's access, not the
 * Textbutler app's, so it would be misleading here. */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MESSAGES_AUTOMATION, recoverySentence, settingsPath, settingsUrl } from "./permission-copy.ts";

export interface PermissionStep { id: "macos-access"; title: string; status: "done" | "action-needed" | "blocked"; detail: string; command?: string; settingsUrl?: string }

const TITLE = "macOS access for iMessage";
const FDA = settingsPath("full-disk-access");

type Presence = "present" | "absent" | "unreadable";
async function privateJson(path: string): Promise<{ presence: Presence; value?: Record<string, unknown> }> {
  let info;
  try { info = await lstat(path); }
  catch (error) { return { presence: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 65536) return { presence: "unreadable" };
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? { presence: "present", value: value as Record<string, unknown> } : { presence: "unreadable" };
  } catch { return { presence: "unreadable" }; }
}

/** Returns undefined when iMessage isn't set up or this isn't a Mac. */
export async function macosAccessStep(input: { dataDir: string; imessageConfigured: boolean; platform?: string }): Promise<PermissionStep | undefined> {
  if (!input.imessageConfigured || (input.platform ?? process.platform) !== "darwin") return undefined;
  const state = join(input.dataDir, "state");
  const step = (status: PermissionStep["status"], detail: string, extra: Partial<Pick<PermissionStep, "command" | "settingsUrl">> = {}): PermissionStep =>
    ({ id: "macos-access", title: TITLE, status, detail, ...extra });
  const setup = `bun run textbutler:app imessage-setup --data-dir ${input.dataDir}`;
  const app = await privateJson(join(state, "macos-app.json"));
  if (app.presence === "absent") return step("action-needed",
    `iMessage works through the Textbutler app on this Mac. Install it, then turn on Textbutler in ${FDA}.`,
    { command: "textbutler help permissions", settingsUrl: settingsUrl("full-disk-access") });
  if (app.presence === "unreadable") return step("blocked",
    "Textbutler can't read its app record. Keep the file, and check that you own it and only you can read it.");
  const result = await privateJson(join(state, "imessage-setup-result.json"));
  if (result.presence === "absent") return step("action-needed",
    `Turn on Textbutler in ${FDA}, then run app setup. macOS will ask to let Textbutler control Messages.`,
    { command: setup, settingsUrl: settingsUrl("full-disk-access") });
  const permission = result.value?.automationPermission;
  if (permission === "denied") return step("blocked",
    `${recoverySentence(MESSAGES_AUTOMATION, "denied")} macOS won't ask again, so run app setup again after you turn it on.`,
    { command: setup, settingsUrl: settingsUrl("automation") });
  if (permission !== "allowed") return step("blocked",
    `${recoverySentence(MESSAGES_AUTOMATION, "unknown")} Then run app setup again.`,
    { command: setup, settingsUrl: settingsUrl("automation") });
  if (result.value?.status !== "completed") return step("action-needed", "App setup stopped before it finished. Run it again.", { command: setup });
  return step("done", `Textbutler can control Messages. If iMessage chats stop loading, turn on Textbutler in ${FDA}.`);
}
