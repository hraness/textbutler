import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunJournal } from "./journal.ts";
import { newContact, parseContact, parseRepoUrl, repoName } from "./config.ts";
import { createRepoShelf } from "./contact-repos.ts";
import { createRepoOwnerIntents } from "./reply-loop.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const at = Date.parse("2026-09-25T12:00:00.000Z");
const URL_A = "https://github.com/hraness/bio", URL_B = "https://github.com/hraness/other";

async function shelfFixture(files: Record<string, string>, options: { now?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "butler-repos-"))), remotes = new Map<string, string>();
  let clock = options.now ?? at;
  const shelf = createRepoShelf({ dataDir: root, now: () => clock, runGit: async args => {
    if (args[0] === "clone") {
      const target = args.at(-1)!, url = args.at(-2)!;
      remotes.set(join(dirname(target), repoName(url)!), url);
      for (const [name, content] of Object.entries(files)) { const path = join(target, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
      await mkdir(join(target, ".git"), { recursive: true });
      return "";
    }
    const dir = args[1]!;
    if (args[2] === "remote") return remotes.get(dir) ?? "";
    if (args[2] === "rev-parse") return "a1b2c3d4";
    return "";
  } });
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  return { shelf, root, remotes, advance(ms: number) { clock += ms; } };
}

test("repository URLs normalize to plain https without credentials, ports or escapes", () => {
  expect(parseRepoUrl("HTTPS://GitHub.com/hraness/bio.git")).toBe("https://github.com/hraness/bio.git");
  expect(parseRepoUrl("https://github.com:443/hraness/bio")).toBe("https://github.com/hraness/bio");
  for (const bad of ["http://github.com/hraness/bio", "https://user:token@example.com/hraness/bio", "https://user@example.com/hraness/bio",
    "https://example.com:8443/hraness/bio", "https://github.com/../etc", "https://github.com/a/./b", "git@example.com:hraness/bio",
    "ssh://git@example.com/hraness/bio", "https://github.com/hraness/bio?x=1", "https://github.com/hraness/bio#ref", "https://github.com",
    "https://github.com/hraness/bio\n", "https://github.com/hraness/bio space", `https://github.com/${"a".repeat(240)}`,
    "https://github.com/hraness/%2e%2e", "https://[::1]/repo", "ftp://github.com/x", "https://github..com/x", "https://github.com./x",
    "https://127.0.0.1/x", "https://2130706433/x", "https://0x7f.0.0.1/x", "https://localhost/x", "https://repo.local/x",
    "https://repo.internal/x", "https://repo.lan/x", "https://repo.invalid/x", "https://[fe80::1]/x"]) {
    expect(parseRepoUrl(bad), bad).toBeNull();
  }
  expect(repoName("https://github.com/hraness/bio.git")).toBe("bio");
  expect(repoName("https://github.com/hraness/bio")).toBe("bio");
  expect(repoName("https://github.com/hraness/.git")).toBeNull();
});

test("contact settings default, bound, dedupe and validate the repo allowlist", () => {
  const contact = newContact("contact-1", "Synthetic", "route-1");
  expect(contact.repos).toEqual([]);
  const legacy = parseContact({ ...contact, repos: undefined });
  expect(legacy.repos).toEqual([]);
  const withRepos = parseContact({ ...contact, repos: [URL_A, "https://github.com/hraness/other.git"] });
  expect(withRepos.repos).toEqual([URL_A, "https://github.com/hraness/other.git"]);
  expect(() => parseContact({ ...contact, repos: [URL_A, URL_A] })).toThrow();
  expect(() => parseContact({ ...contact, repos: ["http://github.com/x/y"] })).toThrow();
  expect(() => parseContact({ ...contact, repos: Array.from({ length: 17 }, (_, index) => `https://github.com/x/r${index}`) })).toThrow();
  expect(() => parseContact({ ...contact, repos: "https://github.com/x/y" })).toThrow();
});

test("repo approval requests are durable, idempotent, bounded and decided once", () => {
  const journal = RunJournal.memory();
  try {
    expect(journal.requestRepoApproval("contact-1", URL_A, at)).toBe("created");
    expect(journal.requestRepoApproval("contact-1", URL_A, at + 1)).toBe("pending");
    expect(journal.requestRepoApproval("contact-2", URL_A, at)).toBe("created");
    expect(journal.repoRequests("pending")).toHaveLength(2);
    const request = journal.repoRequests("pending").find(row => row.contactId === "contact-1")!;
    expect(journal.resolveRepoRequest(request.id, "approved", at + 2)).toBe(true);
    expect(journal.resolveRepoRequest(request.id, "denied", at + 3)).toBe(false);
    expect(journal.requestRepoApproval("contact-1", URL_A, at + 4)).toBe("approved");
    const denied = journal.repoRequests("pending").find(row => row.contactId === "contact-2")!;
    expect(journal.resolveRepoRequest(denied.id, "denied", at + 2)).toBe(true);
    expect(journal.requestRepoApproval("contact-2", URL_A, at + 4)).toBe("denied");
    for (let index = 0; index < 16; index++) journal.requestRepoApproval("contact-3", `https://github.com/x/r${index}`, at);
    expect(() => journal.requestRepoApproval("contact-3", "https://github.com/x/overflow", at)).toThrow("capacity");
    expect(() => journal.requestRepoApproval("bad id!", URL_A, at)).toThrow();
    expect(() => journal.requestRepoApproval("contact-4", `https://github.com/${"a".repeat(300)}`, at)).toThrow();
  } finally { journal.close(); }
});

test("the shelf clones once, persists entries and lists per contact", async () => {
  const f = await shelfFixture({ "README.md": "# bio\n", "src/index.ts": "export const x = 1;\n" });
  const entry = await f.shelf.sync("contact-1", URL_A);
  expect(entry).toMatchObject({ name: "bio", url: URL_A, commit: "a1b2c3d4" });
  const again = await f.shelf.sync("contact-1", URL_A);
  expect(again).toEqual(entry);
  expect(await f.shelf.list("contact-1")).toEqual([entry]);
  expect(await f.shelf.list("contact-2")).toEqual([]);
  await expect(f.shelf.sync("contact-1", "http://github.com/hraness/bio")).rejects.toThrow("Invalid repository URL");
});

test("the shelf refuses to fetch a checkout whose remote is a different URL", async () => {
  const f = await shelfFixture({ "README.md": "# bio\n" });
  await f.shelf.sync("contact-1", URL_A);
  // A second approved URL ending in the same path segment must never reuse or
  // fetch the first checkout.
  await expect(f.shelf.sync("contact-1", "https://gitlab.com/other/bio")).rejects.toThrow("different URL");
});

test("repo reads stay inside the checkout, skip .git and symlinks, and bound output", async () => {
  const f = await shelfFixture({ "README.md": "line1\nline2\n", ".git/config": "secret", "src/big.txt": "x".repeat(60000) });
  await f.shelf.sync("contact-1", URL_A);
  const page = await f.shelf.read("contact-1", "bio", "README.md");
  expect(page.text).toBe("line1\nline2\n");
  const big = await f.shelf.read("contact-1", "bio", "src/big.txt");
  expect(big.truncated).toBe(true); expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(16_384);
  for (const path of [".git/config", "../outside", "src/../../outside", "/etc/passwd", "a//b", "", "x".repeat(300)]) {
    await expect(f.shelf.read("contact-1", "bio", path), path).rejects.toThrow();
  }
  await expect(f.shelf.read("contact-1", "ghost", "README.md")).rejects.toThrow("not synced");
  const dir = join(f.root, "contacts", "contact-1", "repos", "bio");
  await symlink("/etc/hostname", join(dir, "escape"));
  await expect(f.shelf.read("contact-1", "bio", "escape")).rejects.toThrow();
  await expect(f.shelf.read("contact-2", "bio", "README.md")).rejects.toThrow("not synced");
});

test("repo search finds literal matches with bounds and skips binary content", async () => {
  const f = await shelfFixture({ "a.ts": "hello world\nno match\n", "b.ts": "HELLO again\n", "bin.dat": "hello\0binary", "node_modules/skip.ts": "hello hidden\n" });
  await f.shelf.sync("contact-1", URL_A);
  const found = await f.shelf.search("contact-1", "bio", "Hello");
  expect(found.matches.map(match => `${match.file}:${match.line}`).sort()).toEqual(["a.ts:1", "b.ts:1"]);
  expect(found.scanned).toBe(2);
  await expect(f.shelf.search("contact-1", "bio", "")).rejects.toThrow();
  await expect(f.shelf.search("contact-1", "bio", "x".repeat(300))).rejects.toThrow();
  const misses = await f.shelf.search("contact-1", "bio", "zzz");
  expect(misses.matches).toEqual([]);
});

test("owner intents list, approve and deny pending requests and nothing else", async () => {
  const journal = RunJournal.memory();
  try {
    const contact = { ...newContact("contact-1", "Mom", "route-1"), repos: [] as readonly string[] };
    const self = { ...newContact("self-1", "Self", "route-self"), selfChat: true };
    const allowed: [string, string][] = [], synced: string[] = [];
    const intents = createRepoOwnerIntents({ journal, contacts: () => [contact, self], now: () => at,
      allow: async (contactId, url) => { allowed.push([contactId, url]); return "added"; },
      sync: (_contactId, url) => { synced.push(url); } });
    expect(await intents(self, "butler tell me about the weather")).toBeNull();
    expect(await intents(self, "butler approvals")).toBe("No pending repository approvals.");
    journal.requestRepoApproval(contact.id, URL_A, at);
    journal.requestRepoApproval(contact.id, URL_B, at);
    expect(await intents(self, "butler approvals")).toContain(URL_A);
    expect(await intents(self, "butler allow")).toContain("requests pending");
    expect(await intents(self, `butler allow ${URL_A}`)).toBe(`Approved ${URL_A} for ${contact.label}; syncing it now.`);
    expect(allowed).toEqual([[contact.id, URL_A]]); expect(synced).toEqual([URL_A]);
    expect(await intents(self, `butler deny ${URL_B}`)).toBe(`Denied ${URL_B} for ${contact.label}.`);
    expect(await intents(self, "butler approvals")).toBe("No pending repository approvals.");
    expect(journal.repoRequests("approved")).toHaveLength(1);
    expect(journal.repoRequests("denied")).toHaveLength(1);
  } finally { journal.close(); }
});

test("owner intent arguments must match a pending URL substring", async () => {
  const journal = RunJournal.memory();
  try {
    const self = { ...newContact("self-1", "Self", "route-self"), selfChat: true };
    const intents = createRepoOwnerIntents({ journal, contacts: () => [self], now: () => at,
      allow: async () => "added", sync: () => {} });
    journal.requestRepoApproval("contact-9", URL_A, at);
    expect(await intents(self, "butler allow me")).toContain("No pending repository request matches");
    expect(journal.repoRequests("pending")).toHaveLength(1);
    expect(await intents(self, "butler allow bio")).toContain("Approved");
    expect(journal.repoRequests("pending")).toHaveLength(0);
  } finally { journal.close(); }
});

test("owner intents require the keyword command form", async () => {
  const journal = RunJournal.memory();
  try {
    const self = { ...newContact("self-1", "Self", "route-self"), selfChat: true };
    const intents = createRepoOwnerIntents({ journal, contacts: () => [self], now: () => at,
      allow: async () => "added", sync: () => {} });
    journal.requestRepoApproval("contact-9", URL_A, at);
    // Ordinary self-chat text containing an intent verb is not a decision.
    expect(await intents(self, "allow me to think about it")).toBeNull();
    expect(await intents(self, "please allow this")).toBeNull();
    expect(await intents(self, "butler, allow the repo")).toBeNull();
    expect(journal.repoRequests("pending")).toHaveLength(1);
  } finally { journal.close(); }
});

test("a full allowlist leaves the request pending for a later allow", async () => {
  const journal = RunJournal.memory();
  try {
    const contact = newContact("contact-1", "Mom", "route-1"), self = { ...newContact("self-1", "Self", "route-self"), selfChat: true };
    let full = true;
    const intents = createRepoOwnerIntents({ journal, contacts: () => [contact, self], now: () => at,
      allow: async () => full ? "full" as const : "added" as const, sync: () => {} });
    journal.requestRepoApproval(contact.id, URL_A, at);
    expect(await intents(self, `butler allow ${URL_A}`)).toContain("is full");
    expect(journal.repoRequests("pending")).toHaveLength(1);
    full = false;
    expect(await intents(self, `butler allow ${URL_A}`)).toContain("Approved");
    expect(journal.repoRequests("approved")).toHaveLength(1);
  } finally { journal.close(); }
});
