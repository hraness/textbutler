import { maybeShowSupportInvitation, runSupportCommand } from "./support-runtime.js";
import type { SupportCommandOptions } from "@hraness/support-foundation/node";

export const supportProfile = {
  "id": "message-like-me",
  "name": "Textbutler",
  "valueProposition": "Support ongoing development of local tools for your messaging workflows.",
  "updates": false
} as const;

type Output = Readonly<{ stdout: (text: string) => unknown; stderr: (text: string) => unknown }>;

/** Only the real standalone entrypoint calls this; children inherit quiet support. */
export function standaloneSupportEnvironment(): Readonly<Record<string, string | undefined>> {
  const env = { ...process.env };
  process.env.HRANESS_SUPPORT_AUDIENCE = "off";
  return env;
}

export async function runProductSupportCommand(args: readonly string[], output: Output, options: SupportCommandOptions = {}): Promise<number> {
  const result = await runSupportCommand(supportProfile, args, { command: ["messagelikeme"], gitEmail: false, ...options });
  if (result.stdout !== "") output.stdout(result.stdout);
  if (result.stderr !== "") output.stderr(result.stderr);
  return result.exitCode;
}

export async function showProductSupportInvitation(options: SupportCommandOptions = {}): Promise<void> {
  try {
    await maybeShowSupportInvitation(supportProfile, { usefulResult: true, command: ["messagelikeme"], gitEmail: false, ...options });
  } catch {
    // Optional support must never change the completed task's outcome.
  }
}
