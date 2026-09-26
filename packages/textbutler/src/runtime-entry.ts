import { describeCliError, quietOnClosedPipe, runTextbutlerCli } from "./cli.ts";

/** The verified launcher supplies its own physical entrypoint for restarts.
 * Local bundle integrity is not provider qualification: no runtimeArtifact is
 * created here, and account/contact activation remains an owner operation. */
export async function runInstalledCli(args: readonly string[], entrypoint: string): Promise<number> {
  quietOnClosedPipe();
  try { return await runTextbutlerCli(args, process.stdout, { entrypoint }); }
  catch (error) {
    const shown = describeCliError(error, args);
    process.stdout.write(shown.stdout); process.stderr.write(shown.stderr);
    return shown.exitCode;
  }
}

