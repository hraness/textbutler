import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { describeCliError, runTextbutlerCli } from "./cli.ts";
import { BARE_INTRO, HELP_TOPICS, ROOT_HELP, topicHelp } from "./cli-help.ts";
import { CliUsageError, closest, detectAudience, symbolsFor } from "./cli-style.ts";
import { TEXTBUTLER_VERSION } from "./version.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const human = { LANG: "en_US.UTF-8" };
const run = async (argv: string[], options: { env?: Record<string, string>; audience?: "human" | "agent" | "quiet" } = {}) => {
  let text = "";
  const code = await runTextbutlerCli(argv, { write: value => { text += value; } }, { env: options.env ?? human, audience: options.audience ?? "human" });
  return { code, text };
};
const failure = async (argv: string[], env: Record<string, string> = human, audience: "human" | "agent" | "quiet" = "human") => {
  try { await runTextbutlerCli(argv, { write: () => {} }, { env, audience }); }
  catch (error) { return describeCliError(error, argv, env, audience); }
  throw new Error("Expected the command to fail");
};
const width = (text: string) => Math.max(...text.split("\n").map(line => [...line].length));

describe("Textbutler CLI style contract", () => {
  test("bare invocation off a terminal is a short, runnable intro", async () => {
    const bare = await run([]);
    expect(bare.code).toBe(0);
    expect(bare.text).toBe(`${BARE_INTRO}\n`);
    expect(bare.text.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
    expect(width(bare.text)).toBeLessThanOrEqual(80);
    expect(bare.text).toMatchSnapshot();
  });
  test("root help is grouped, at most 60 lines, and hides internal commands", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const help = await run([flag]);
      expect(help.code).toBe(0);
      expect(help.text).toBe(`${ROOT_HELP}\n`);
    }
    expect(ROOT_HELP.split("\n").length).toBeLessThanOrEqual(60);
    expect(width(ROOT_HELP)).toBeLessThanOrEqual(80);
    for (const hidden of ["imessage-setup", "habitat", "digest", "grant", "reconcile", "XCB", "native-claude-code"]) expect(ROOT_HELP).not.toContain(hidden);
    expect(ROOT_HELP).toMatchSnapshot();
  });
  test("every command and topic has help that exits 0 and fits the terminal", async () => {
    for (const topic of HELP_TOPICS) {
      const text = topicHelp(topic)!;
      expect(text.startsWith("Usage: textbutler")).toBe(true);
      expect(width(text)).toBeLessThanOrEqual(80);
      for (const argv of [["help", topic], [topic, "--help"], [topic, "-h"]]) {
        if (argv[0] === "help" && argv[1] === "help" || argv[0] === "version") continue;
        const shown = await run(argv);
        expect(shown.code).toBe(0);
        expect(shown.text).toBe(`${text}\n`);
      }
    }
    expect((await run(["replies", "send", "--help"])).text).toBe(`${topicHelp("replies")}\n`);
    expect(topicHelp("habitats")).toContain("A habitat is");
    expect(topicHelp("replies")).toContain("is the digest");
    expect(Object.fromEntries(HELP_TOPICS.map(topic => [topic, topicHelp(topic)]))).toMatchSnapshot();
  });
  test("--version prints the bin name and version, or JSON", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(TEXTBUTLER_VERSION).toBe(pkg.version);
    for (const flag of ["--version", "-V", "version"]) expect(await run([flag])).toEqual({ code: 0, text: `textbutler ${pkg.version}\n` });
    expect(JSON.parse((await run(["--version", "--json"])).text)).toEqual({ name: "textbutler", version: pkg.version });
    expect(JSON.parse((await run(["--version"], { audience: "agent" })).text)).toEqual({ name: "textbutler", version: pkg.version });
  });
  test("unknown commands and topics are one line with a guess and one next step", async () => {
    expect(await failure(["stauts"])).toEqual({ stdout: "", stderr: '✗ Unknown command "stauts". Did you mean "status"?\n→ textbutler --help\n', exitCode: 2 });
    expect(await failure(["zzzzzz"])).toEqual({ stdout: "", stderr: '✗ Unknown command "zzzzzz".\n→ textbutler --help\n', exitCode: 2 });
    expect(await failure(["help", "contact"])).toEqual({ stdout: "", stderr: '✗ No help topic "contact". Did you mean "contacts"?\n→ textbutler --help\n', exitCode: 2 });
    expect(await failure(["app", "imessage-setup", "--force"])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("Unknown command") });
  });
  test("malformed known commands point at their own help", async () => {
    expect(await failure(["contacts", "bogus"])).toEqual({ stdout: "", stderr: '✗ Missing or invalid arguments for "contacts bogus".\n→ textbutler help contacts\n', exitCode: 2 });
    expect(await failure(["replies", "send"])).toEqual({ stdout: "", stderr: '✗ Missing or invalid arguments for "replies send".\n→ textbutler help replies\n', exitCode: 2 });
    expect(await failure(["daemon", "restart"])).toMatchObject({ stderr: expect.stringContaining("→ textbutler help daemon"), exitCode: 2 });
    expect(await failure(["setup", "--account"])).toMatchObject({ stderr: "✗ Setup needs different options.\n→ textbutler help setup\n", exitCode: 2 });
    expect(await failure(["status", "--data-dir", "relative"])).toMatchObject({ stderr: expect.stringContaining("--data-dir needs an absolute folder path"), exitCode: 2 });
  });
  test("errors use ASCII without UTF-8 and JSON for --json or agents", async () => {
    expect((await failure(["stauts"], { TERM: "dumb", LANG: "en_US.UTF-8" })).stderr).toBe('FAIL Unknown command "stauts". Did you mean "status"?\n-> textbutler --help\n');
    expect((await failure(["stauts"], {})).stderr.startsWith("FAIL ")).toBe(true);
    expect((await failure(["stauts"], { HRANESS_ASCII: "1", LANG: "en_US.UTF-8" })).stderr.startsWith("FAIL ")).toBe(true);
    expect((await failure(["stauts"], { NO_COLOR: "1", LANG: "en_US.UTF-8" })).stderr.startsWith("✗ ")).toBe(true);
    const agent = await failure(["stauts"], human, "agent");
    expect(agent.stderr).toBe("");
    expect(JSON.parse(agent.stdout)).toEqual({ ok: false, error: { code: "unknown-command", message: 'Unknown command "stauts". Did you mean "status"?', next: "textbutler --help" } });
    expect(JSON.parse((await failure(["contacts", "bogus", "--json"])).stdout).error.code).toBe("usage");
    expect(JSON.parse((await failure(["contacts", "bogus", "--json", "--data-dir", "/tmp/x"])).stdout).error.code).toBe("usage");
    expect((await failure(["replies", "send", "--json"])).stderr).toContain("replies send");
    expect(describeCliError(new Error("secret /Users/x/path"), ["status"], human, "human")).toEqual({ stdout: "", stderr: "✗ Textbutler couldn't finish this command.\n→ textbutler doctor\n", exitCode: 1 });
  });
  test("doctor is text for people and the full report with --json or for agents", async () => {
    const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-golden-")); roots.push(dataDir);
    const text = await run(["doctor", "--data-dir", dataDir]);
    expect(text.code).toBe(1);
    expect(text.text.split("\n").slice(0, 9).join("\n")).toBe([
      "Textbutler readiness", "",
      "⚠ Private settings", "  Create your private settings. Automatic replies start paused.",
      "⚠ Messaging apps", "  Connect iMessage, WhatsApp, or Beeper (for Signal, Telegram and more). Sign-in and permissions for each app happen in Ghostget.",
      "⚠ Background service", "  Start the background service. It keeps running after you close the terminal or menu.",
      "⚠ Choose conversations",
    ].join("\n"));
    expect(text.text.trimEnd().split("\n").slice(-2)).toEqual(["6 steps left.", "→ textbutler setup"]);
    expect(text.text).not.toContain("{");
    for (const json of [await run(["doctor", "--json", "--data-dir", dataDir]), await run(["doctor", "--data-dir", dataDir, "--json"]), await run(["doctor", "--data-dir", dataDir], { audience: "agent" })]) {
      expect(json.code).toBe(1);
      expect(JSON.parse(json.text)).toMatchObject({ ok: false, initialized: false, daemonConnected: false });
    }
    const ascii = await run(["doctor", "--data-dir", dataDir], { env: { TERM: "dumb" } });
    expect(ascii.text).toContain("WARN Private settings");
    expect(ascii.text).toContain("-> textbutler setup");
  });
  test("a trailing --json is never taken from the text of a literal reply", async () => {
    const dataDir = await mkdtemp(join(await realpath("/tmp"), "textbutler-golden-")); roots.push(dataDir);
    // With no daemon the send fails closed as JSON; the point is that parsing kept "--json" as text.
    const send = await run(["replies", "send", "contact-1", "hi", "--json", "--data-dir", dataDir]);
    expect(JSON.parse(send.text)).toMatchObject({ ok: false });
  });
});

describe("audience and symbols", () => {
  test("audience follows HRANESS_AUDIENCE, exact agent markers, then the terminal", () => {
    expect(detectAudience({ env: { HRANESS_AUDIENCE: "human", CLAUDECODE: "1" }, stderrIsTTY: false })).toBe("human");
    expect(detectAudience({ env: { HRANESS_AUDIENCE: "off" }, stderrIsTTY: true })).toBe("quiet");
    for (const marker of ["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI"]) expect(detectAudience({ env: { [marker]: "1" }, stderrIsTTY: true })).toBe("agent");
    expect(detectAudience({ env: { CODEX_HOME: "/x", DEVIN_API_KEY: "k", CLAUDECODE: "" }, stderrIsTTY: true })).toBe("human");
    expect(detectAudience({ env: {}, stderrIsTTY: false })).toBe("quiet");
  });
  test("symbols fall back to ASCII and suggestions stay within two edits", () => {
    expect(symbolsFor({ LANG: "en_US.UTF-8" }).ok).toBe("✓");
    expect(symbolsFor({ LC_ALL: "C" }).ok).toBe("OK");
    expect(closest("contcts", ["contacts", "status"])).toBe("contacts");
    expect(closest("xyz", ["contacts"])).toBeUndefined();
    expect(new CliUsageError("x", "y").code).toBe("usage");
  });
});

describe("the real entrypoint in a pipe", () => {
  const entry = join(import.meta.dir, "cli.ts");
  const shell = async (script: string, env: Record<string, string> = {}) => {
    const child = Bun.spawn(["/bin/sh", "-c", script], { env: { PATH: `${process.env.PATH}`, HOME: "/nonexistent", LANG: "en_US.UTF-8", HRANESS_AUDIENCE: "quiet", ...env }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  test("help | head -1 exits quietly and --help exits 0 off a terminal", async () => {
    const bun = JSON.stringify(process.execPath), file = JSON.stringify(entry);
    expect(await shell(`${bun} ${file} --help | head -1`)).toEqual({ code: 0, stdout: "Textbutler is an AI butler for the iMessage, WhatsApp, and Beeper chats\n", stderr: "" });
    expect(await shell(`${bun} ${file} help contacts --help 2>&1 | head -1; exit 0`)).toMatchObject({ code: 0 });
    const unknown = await shell(`${bun} ${file} stauts`, { NO_COLOR: "1" });
    expect(unknown).toEqual({ code: 2, stdout: "", stderr: '✗ Unknown command "stauts". Did you mean "status"?\n→ textbutler --help\n' });
    const agent = await shell(`${bun} ${file} stauts`, { HRANESS_AUDIENCE: "agent" });
    expect(agent.code).toBe(2); expect(JSON.parse(agent.stdout).error.code).toBe("unknown-command");
  }, 30_000);
});
