import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTextbutler } from "./build-textbutler.ts";
import { installTextbutler } from "./install-textbutler.ts";

test("the real bundle runs from an isolated installation without node_modules or source paths", async () => {
  const root = await mkdtemp(join(await realpath("/tmp"), "textbutler-build-"));
  async function writable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(directory, entry.name));
  }
  try {
    const result = await buildTextbutler({ outdir: join(root, "artifacts") });
    const installed = await installTextbutler({ from: result.directory, prefix: join(root, "isolated") });
    const unrelated = join(root, "unrelated"), home = join(root, "home");
    await mkdir(unrelated, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
    await writeFile(join(unrelated, "bunfig.toml"), 'preload = ["./injected.js"]\n');
    await writeFile(join(unrelated, "injected.js"), 'process.stdout.write("UNSAFE-PRELOAD");\n');
    await writeFile(join(home, ".bunfig.toml"), `preload = [${JSON.stringify(join(unrelated, "injected.js"))}]\n`);
    const run = async (args: string[]) => {
      const child = Bun.spawn([installed.command, ...args], { cwd: unrelated, env: { PATH: "/usr/bin:/bin", HOME: home, NODE_OPTIONS: `--require=${join(unrelated, "injected.js")}`, BUN_OPTIONS: `--preload=${join(unrelated, "injected.js")}` }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const help = await run(["--help"]);
    expect(help).toMatchObject({ code: 0, stderr: "" }); expect(help.stdout).toContain("Start here");
    expect(help.stdout).toContain("replies <command>");
    const replies = await run(["replies", "--help"]);
    expect(replies).toMatchObject({ code: 0, stderr: "" }); expect(replies.stdout).toContain("replies send <draft> <check>");
    const version = await run(["--version"]);
    expect(version).toMatchObject({ code: 0, stderr: "" }); expect(version.stdout).toMatch(/^textbutler \S+\n$/u);
    const invalid = await run(["contacts", "bogus"]);
    expect(invalid.code).toBe(2); expect(invalid.stderr).toContain('Missing or invalid arguments for "contacts bogus".');
    const data = join(root, "data");
    const setup = await run(["setup", "--data-dir", data]);
    expect(setup.code).toBe(0);
    expect(JSON.parse(await readFile(join(data, "state/settings.json"), "utf8")).settings).toMatchObject({ paused: true, contacts: [] });
    const doctor = await run(["doctor", "--json", "--data-dir", data]);
    expect(doctor.stdout).not.toContain("UNSAFE-PRELOAD");
    expect(doctor.stderr).not.toContain("local installation");
    expect(JSON.parse(doctor.stdout)).toMatchObject({ canGenerateReplies: false, daemonConnected: false });
    const status = await run(["daemon", "status", "--data-dir", data]);
    expect(status.code).toBe(1); expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toMatchObject({ daemon: { ok: false, status: "disconnected" }, automaticReplies: "unavailable" });
    expect(result.manifest.providerAdmission).toBe("external-xcb");
    const notices = await readFile(join(installed.directory, "notices.md"), "utf8");
    expect(notices).toContain("xcb and provider executables are not bundled");
    expect(notices).toContain("Credentials and provider custody remain in xcb");
    expect(notices).toContain("does not qualify a provider or prove live message delivery");
    expect(notices).toContain("Claude API remains unavailable");
    expect(notices).toContain("MIT-licensed reference application");
    expect((await run(["setup", "--help"])).stdout).toContain("--xcb");
    expect(await readdir(home, { recursive: true })).toEqual([".bunfig.toml"]);
  } finally { await writable(root); await rm(root, { recursive: true, force: true }); }
}, 30_000);
