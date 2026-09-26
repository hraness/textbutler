import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseRepoUrl, repoName } from "./config.ts";

export const REPO_LIMITS = Object.freeze({ readBytes: 16_384, fileBytes: 1_048_576, checkoutBytes: 128 * 1024 * 1024,
  filesWalked: 8_000, searchMatches: 25, contextChars: 160, scanBytes: 8 * 1024 * 1024, syncMs: 120_000, staleMs: 300_000, maxRepos: 16 });

/** Public checkout shelves live beside the brokered workspace, never inside its
 * file contract. Git runs only through argv spawns with a locked environment:
 * no shell, no user or system gitconfig (so url.insteadOf cannot redirect an
 * approved remote), no credential helpers, and no terminal prompt — an approved
 * public URL can never touch the owner's git credentials or any other host. */
export type RepoEntry = Readonly<{ name: string; url: string; commit: string; syncedAt: number }>;
export type RepoSearchMatch = Readonly<{ file: string; line: number; text: string }>;

const GIT_ENV = Object.freeze({ PATH: "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ASKPASS: "/usr/bin/true" });

async function defaultGit(args: readonly string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  const child = spawn("/usr/bin/git", ["-c", "credential.helper=", ...args], { shell: false, cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { if (out.length < 65_536) out += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { if (err.length < 16_384) err += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(0, 240) || `exit ${code}`}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(path) !== path)
    throw new Error("Repo shelf directory must be owned and private");
}

async function checkoutSize(root: string): Promise<number> {
  let total = 0, seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(path); continue; }
      const info = await lstat(path);
      total += info.size; if (++seen > 200_000) throw new Error("Repo checkout exceeds file bound");
      if (total > REPO_LIMITS.checkoutBytes) throw new Error("Repo checkout exceeds size bound");
    }
  }
  return total;
}

async function* walk(root: string, skip: ReadonlySet<string>): AsyncGenerator<{ path: string; rel: string }> {
  const stack = [{ dir: root, rel: "" }];
  let seen = 0;
  while (stack.length) {
    const { dir, rel } = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push({ dir: path, rel: join(rel, entry.name) }); continue; }
      if (++seen > REPO_LIMITS.filesWalked) return;
      yield { path, rel: join(rel, entry.name).split(sep).join("/") };
    }
  }
}

export function createRepoShelf(options: { dataDir: string; now?: () => number;
  /** Test seam: real deployments use the locked git spawn above. */
  runGit?: (args: readonly string[], cwd: string | undefined, timeoutMs: number) => Promise<string> }) {
  const now = options.now ?? Date.now, git = options.runGit ?? defaultGit;
  const root = (contactId: string) => join(options.dataDir, "contacts", contactId, "repos");
  const synced = new Map<string, number>();
  const inflight = new Map<string, Promise<RepoEntry>>();

  async function state(contactId: string): Promise<Record<string, RepoEntry>> {
    try {
      const parsed = JSON.parse(await readFile(join(root(contactId), ".shelf.json"), "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  async function writeEntry(contactId: string, entry: RepoEntry): Promise<void> {
    // Concurrent syncs on different repos merge against fresh state so no
    // completed entry is lost to a stale read.
    const entries = await state(contactId), dir = root(contactId), target = join(dir, ".shelf.json"), staged = join(dir, `.shelf-${Math.random().toString(36).slice(2)}`);
    await writeFile(staged, JSON.stringify({ ...entries, [entry.name]: entry }), { mode: 0o600 });
    await rename(staged, target);
  }

  async function sync(contactId: string, url: string): Promise<RepoEntry> {
    const normalized = parseRepoUrl(url), name = normalized === null ? null : repoName(normalized);
    if (normalized === null || name === null) throw new Error("Invalid repository URL");
    const key = `${contactId}:${normalized}`;
    let pending = inflight.get(key);
    if (pending) return pending;
    pending = (async (): Promise<RepoEntry> => {
      const dir = join(root(contactId), name), marker = synced.get(key) ?? 0;
      const existing = (await state(contactId))[name];
      const checkout = await lstat(dir).then(info => info.isDirectory(), () => false);
      if (checkout) {
        // A different approved URL can derive the same final path segment; the
        // on-disk remote is the identity, and a mismatch never fetches.
        const remote = await git(["-C", dir, "remote", "get-url", "origin"], undefined, 15_000);
        if (remote !== normalized || (existing !== undefined && existing.url !== normalized)) throw new Error("Repository name is used by a different URL");
      }
      if (checkout && now() - marker < REPO_LIMITS.staleMs) return existing ?? { name, url: normalized, commit: await git(["-C", dir, "rev-parse", "HEAD"], undefined, 15_000), syncedAt: marker };
      if (checkout) {
        await git(["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin"], undefined, REPO_LIMITS.syncMs);
        await git(["-C", dir, "reset", "--hard", "FETCH_HEAD"], undefined, 60_000);
      } else {
        const names = await readdir(root(contactId)).catch(() => [] as string[]);
        if (names.filter(entry => !entry.startsWith(".")).length >= REPO_LIMITS.maxRepos) throw new Error("Repo shelf capacity reached");
        await privateDir(root(contactId));
        for (const orphan of names.filter(entry => entry.startsWith(".clone-"))) {
          const stagedOrphan = join(root(contactId), orphan);
          try { const info = await lstat(stagedOrphan); if (now() - info.mtimeMs > 3_600_000) await rm(stagedOrphan, { recursive: true, force: true }); } catch { /* A vanished orphan is already reclaimed. */ }
        }
        const staged = join(root(contactId), `.clone-${Math.random().toString(36).slice(2)}`);
        try {
          await git(["clone", "--depth", "1", "--single-branch", "--no-tags", "--", normalized, staged], undefined, REPO_LIMITS.syncMs);
          await checkoutSize(staged);
          await rename(staged, dir);
        } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
      }
      const commit = await git(["-C", dir, "rev-parse", "HEAD"], undefined, 15_000);
      const entry: RepoEntry = { name, url: normalized, commit, syncedAt: now() };
      synced.set(key, now());
      await writeEntry(contactId, entry);
      return entry;
    })();
    inflight.set(key, pending);
    try { return await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
  }

  async function checkoutDir(contactId: string, repo: string): Promise<string> {
    if (!/^[\w][\w.-]{0,79}$/u.test(repo)) throw new Error("Invalid repository name");
    const dir = join(root(contactId), repo);
    const resolved = await realpath(dir).catch(() => null);
    if (resolved === null || resolved !== dir || !(await lstat(dir)).isDirectory()) throw new Error("Repository is not synced");
    return dir;
  }

  async function read(contactId: string, repo: string, path: string): Promise<{ file: string; text: string; truncated: boolean }> {
    const dir = await checkoutDir(contactId, repo);
    if (typeof path !== "string" || !path.length || Buffer.byteLength(path) > 240 || path.startsWith("/") || path.includes("\0") || path.includes("\\")
      || path.split("/").some(part => !part || part === "." || part === "..") || path.split("/")[0] === ".git") throw new Error("Invalid repository path");
    const target = join(dir, path), resolved = await realpath(target).catch(() => null);
    if (resolved === null || !resolved.startsWith(dir + sep) || resolved.split(sep).includes(".git")) throw new Error("Repository path escapes the checkout");
    const info = await lstat(resolved);
    if (!info.isFile() || info.size > REPO_LIMITS.fileBytes) throw new Error("Repository file exceeds its bound");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(resolved)).slice(0, REPO_LIMITS.readBytes);
    return { file: resolved.slice(dir.length + 1), text, truncated: text.length >= REPO_LIMITS.readBytes };
  }

  async function search(contactId: string, repo: string, query: string): Promise<{ matches: RepoSearchMatch[]; scanned: number; truncated: boolean }> {
    const dir = await checkoutDir(contactId, repo);
    if (typeof query !== "string" || !query.trim() || Buffer.byteLength(query) > 256 || query.includes("\0")) throw new Error("Invalid repository search");
    const needle = query.trim().toLocaleLowerCase("en-US"), matches: RepoSearchMatch[] = [];
    let scanned = 0, scannedBytes = 0, truncated = false;
    for await (const { path, rel } of walk(dir, new Set(["node_modules", "dist", "build", ".next", "target", "vendor"]))) {
      if (scannedBytes >= REPO_LIMITS.scanBytes) { truncated = true; break; }
      const info = await lstat(path).catch(() => null);
      if (info === null || !info.isFile() || info.size > REPO_LIMITS.fileBytes || info.size === 0) continue;
      const resolved = await realpath(path).catch(() => null);
      if (resolved === null || !resolved.startsWith(dir + sep)) continue;
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const bytes = Buffer.alloc(Math.min(Number(info.size), REPO_LIMITS.fileBytes));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (bytes.subarray(0, Math.min(bytesRead, 8_192)).includes(0)) continue;
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, bytesRead));
          scanned++; scannedBytes += bytesRead;
          text.split("\n").forEach((line, index) => {
            if (matches.length >= REPO_LIMITS.searchMatches) { truncated = true; return; }
            if (line.toLocaleLowerCase("en-US").includes(needle)) matches.push({ file: rel, line: index + 1, text: line.trim().slice(0, REPO_LIMITS.contextChars) });
          });
        } finally { await handle.close(); }
      } catch { continue; }
      if (matches.length >= REPO_LIMITS.searchMatches) truncated = true;
    }
    return { matches, scanned, truncated };
  }

  async function list(contactId: string): Promise<readonly RepoEntry[]> {
    const entries = await state(contactId);
    return Object.values(entries).filter(entry => entry && typeof entry.name === "string" && typeof entry.url === "string").slice(0, REPO_LIMITS.maxRepos);
  }

  return { sync, read, search, list };
}
export type RepoShelf = ReturnType<typeof createRepoShelf>;
