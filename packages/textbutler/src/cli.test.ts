import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { newContact } from "./config.ts";
import { runTextbutlerCli } from "./cli.ts";
import { CliUsageError } from "./cli-style.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";

const roots: string[] = [], daemons: RunningDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> { const path = await mkdtemp(join(await realpath("/tmp"), "textbutler-cli-")); roots.push(path); return path; }
const run = async (argv: string[]) => { const lines: string[] = []; const code = await runTextbutlerCli(argv, { write: text => lines.push(text) }); return { code, lines, json: () => JSON.parse(lines.join("")) }; };

describe("owner reply CLI", () => {
  test("inbox and replies commands are admitted; malformed forms show usage", async () => {
    for (const argv of [
      ["replies"], ["replies", "bogus"], ["replies", "suggest"], ["replies", "send"], ["replies", "send", "contact-1"],
      ["replies", "discard"], ["replies", "send", "draft:x", "extra"],
      ["replies", "send", "draft:x"], ["replies", "show"], ["replies", "show", "contact-1"],
      ["inbox", "extra"],
    ]) await expect(runTextbutlerCli(argv, { write: () => {} })).rejects.toThrow(CliUsageError);
  });
  test("reply commands fail closed when no daemon is reachable", async () => {
    const dataDir = await root();
    const inbox = await run(["inbox", "--data-dir", dataDir]);
    expect(inbox.code).toBe(1);
    expect(inbox.json()).toMatchObject({ ok: false });
    const suggest = await run(["replies", "suggest", "someone", "--data-dir", dataDir]);
    expect(suggest.code).toBe(1);
  });
  test("a daemon without messaging automation reports replies unavailable", async () => {
    const dataDir = await root();
    const daemon = await startDaemon({ dataDir, initialSettings: { schemaVersion: 1, paused: true, maxActiveContacts: 5, contacts: [newContact("contact-1", "Alice Example", "route-1")] } });
    daemons.push(daemon);
    const inbox = await run(["inbox", "--data-dir", dataDir]);
    expect(inbox.code).toBe(1);
    expect(inbox.json()).toMatchObject({ ok: false, code: "unavailable" });
    const send = await run(["replies", "send", "draft:abc", "a".repeat(64), "--data-dir", dataDir]);
    expect(send.code).toBe(1);
    expect(send.json()).toMatchObject({ ok: false, code: "unavailable" });
    const discard = await run(["replies", "discard", "draft:abc", "--data-dir", dataDir]);
    expect(discard.code).toBe(1);
    expect(discard.json()).toMatchObject({ ok: false, code: "unavailable" });
  });
  test("contact names resolve exactly once and ambiguous labels fail safely", async () => {
    const dataDir = await root();
    const daemon = await startDaemon({ dataDir, initialSettings: { schemaVersion: 1, paused: true, maxActiveContacts: 5,
      contacts: [newContact("contact-1", "Alice Example", "route-1"), newContact("contact-2", "Alicia Sample", "route-2")] } });
    daemons.push(daemon);
    // "ali" matches both Alice Example and Alicia Sample — refuse to guess a recipient.
    await expect(runTextbutlerCli(["replies", "send", "ali", "hello", "--data-dir", dataDir], { write: () => {} })).rejects.toThrow("matches");
    await expect(runTextbutlerCli(["replies", "send", "nobody", "hello", "--data-dir", dataDir], { write: () => {} })).rejects.toThrow("No configured contact");
    // Exact-id sends still fail closed here (no messaging automation) but the contact resolved.
    const send = await run(["replies", "send", "contact-1", "hello", "--data-dir", dataDir]);
    expect(send.code).toBe(1);
    expect(send.json()).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("owner CLI entrypoint", () => {
  test("help gives a readable first task and distinguishes draft review from sending", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("")).toContain("Start here");
    expect(help.lines.join("")).toContain("replies <command>");
    const replies = await run(["help", "replies"]);
    expect(replies.lines.join("")).toContain("replies show <draft>");
    expect(replies.lines.join("")).toContain("replies send <draft> <check>");
    expect((await run(["help", "contacts"])).lines.join("")).toContain("contacts add <candidate> [--history]");
    const setup = (await run(["setup", "--help"])).lines.join("");
    expect(setup).toContain("--xcb-account <ai>:<id>");
    expect(setup).toContain("--xcb-model <ai>/<model>[/<effort>]");
    expect((await run(["providers", "-h"])).lines.join("")).toContain("providers check native-codex");
  });
  test("contact controls and pause use the running owner daemon", async () => {
    const dataDir = await root();
    const daemon = await startDaemon({ dataDir, initialSettings: { schemaVersion: 1, paused: true, maxActiveContacts: 5,
      contacts: [newContact("contact-1", "Alice Example", "route-1")] } });
    daemons.push(daemon);
    expect((await run(["contacts", "list", "--data-dir", dataDir])).json()).toMatchObject({ ok: true, paused: true, contacts: [{ id: "contact-1", settings: { enabled: false } }] });
    const mode = await run(["contacts", "mode", "Alice", "keyword", "--keyword", "help", "--data-dir", dataDir]);
    expect(mode.code).toBe(0);
    expect(mode.json()).toMatchObject({ kind: "snapshot", snapshot: { settings: { paused: true }, contacts: [{ settings: { enabled: false, responseMode: "keyword", keyword: "help" } }] } });
    const resume = await run(["resume", "--data-dir", dataDir]);
    expect(resume.json()).toMatchObject({ snapshot: { settings: { paused: false }, contacts: [{ settings: { enabled: false } }] } });
    const pause = await run(["pause", "--data-dir", dataDir]);
    expect(pause.json()).toMatchObject({ snapshot: { settings: { paused: true } } });
    expect((await run(["status", "--data-dir", dataDir])).json()).toMatchObject({ kind: "snapshot" });
  });
  test("owner commands report disconnected control without inventing completed changes", async () => {
    const dataDir = await root();
    const result = await run(["pause", "--data-dir", dataDir]);
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ ok: false, status: "disconnected", detail: expect.stringContaining("before repeating") });
  });
});
