import { CLI_USAGE, runTextbutlerCli } from "./cli.ts";
import { OwnerCliError } from "./owner-cli.ts";

/** The verified launcher supplies its own physical entrypoint for restarts.
 * Local bundle integrity is not provider qualification: no runtimeArtifact is
 * created here, and account/contact activation remains an owner operation. */
export async function runInstalledCli(args: readonly string[], entrypoint: string): Promise<number> {
  try { return await runTextbutlerCli(args, process.stdout, { entrypoint }); }
  catch (error) {
    process.stderr.write(`${error instanceof OwnerCliError ? error.message : error instanceof Error && error.message === CLI_USAGE ? CLI_USAGE
      : "Textbutler could not complete this command. Run textbutler doctor for setup and readiness guidance."}\n`);
    return 1;
  }
}
