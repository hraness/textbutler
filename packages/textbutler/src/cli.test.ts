import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { newContact } from "./config.ts";
import { runTextbutlerCli, CLI_USAGE } from "./cli.ts";
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
      ["inbox", "extra"],
    ]) await expect(runTextbutlerCli(argv, { write: () => {} })).rejects.toThrow(CLI_USAGE);
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
    const send = await run(["replies", "send", "draft:abc", "--data-dir", dataDir]);
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
