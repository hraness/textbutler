#!/usr/bin/env bun
import { parseArguments } from "./args.ts";
import { runProductSupportCommand, showProductSupportInvitation, standaloneSupportEnvironment } from "./support.ts";
import { runCommand } from "./commands.ts";
import { HELP } from "./command-input.ts";
import { terminalIntro } from "./cli-intro.ts";
import { errorMessage, exitCodeFor } from "./errors.ts";
import { processIo, type CommandIo } from "./io.ts";

export function isUsefulSupportResult(argv: readonly string[]): boolean {
  try {
    const parsed = parseArguments(argv);
    if (parsed.flags.has("help") || parsed.flags.has("version")) return false;
    const [command, action] = parsed.positionals;
    return command === "context" || ["sources list", "sources show", "contacts list", "contacts show", "contacts resolve", "inspect tempo", "inspect sessions", "study prepare", "ensoul prepare", "evaluate prepare", "profile apply", "profile show", "profile export", "routes list", "handoff prepare"].includes(`${command} ${action}`);
  } catch { return false; }
}

export async function main(argv: readonly string[], io: CommandIo = processIo, supportEnv?: Readonly<Record<string, string | undefined>>): Promise<number> {
  try {
    if (argv[0] === "support") return await runProductSupportCommand(argv.slice(1), io, supportEnv === undefined ? {} : { env: supportEnv });
    const rootHelp = argv.length === 0 || (argv.length === 1 && argv[0] === "--help");
    const output = rootHelp && io === processIo ? {
      ...io,
      stdout: (text: string) => io.stdout((text === HELP ? terminalIntro({ isTTY: process.stdout.isTTY, columns: process.stdout.columns, term: process.env.TERM }) : "") + text),
    } : io;
    await runCommand(argv, output);
    return 0;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return exitCodeFor(error);
  }
}

if (import.meta.main) {
  const supportEnv = standaloneSupportEnvironment();
  const args = process.argv.slice(2);
  const exitCode = await main(args, processIo, supportEnv);
  process.exitCode = exitCode;
  if (exitCode === 0 && isUsefulSupportResult(args)) await showProductSupportInvitation({ env: supportEnv });
}
