import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProductSupportCommand } from "./support";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "product-support-"));
  const env = { HOME: root, XDG_DATA_HOME: root, HRANESS_SUPPORT_EMAIL: "off", HRANESS_SUPPORT_AUDIENCE: "agent" };
  return { root, env, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function output() {
  let stdout = "", stderr = "";
  return { write: { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } }, read: () => ({ stdout, stderr }) };
}

test("read-only protocol preserves account-free discovery and creates no local state", async () => {
  const f = await fixture();
  try {
    const sink = output();
    expect(await runProductSupportCommand(["protocol", "--json"], sink.write, { env: f.env, stateDirectory: f.root })).toBe(0);
    const text = sink.read();
    expect(text.stderr).toBe("");
    expect(JSON.parse(text.stdout)).toBeObject();
    expect(text.stdout).toContain('messagelikeme');
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("offer acknowledgement, suite opt-out and quiet results use the shared protocol", async () => {
  const f = await fixture();
  try {
    const options = { env: f.env, stateDirectory: f.root, now: 1000000000000 };
    const call = async (args: string[]) => {
      const sink = output();
      const code = await runProductSupportCommand(args, sink.write, options);
      expect(sink.read().stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(sink.read().stdout);
    };
    const offer = await call(["offer", "--json"]);
    expect(offer.kind).toBe("offer");
    expect(offer.invitation.emailSuggestion).toBeUndefined();
    expect((await call(["offer", "--json"])).kind).toBe("quiet");
    expect((await call(["shown", offer.invitation.id])).kind).toBe("shown");
    expect((await call(["shown", offer.invitation.id])).kind).toBe("shown");
    expect((await call(["offer", "--json"])).kind).toBe("quiet");
    expect((await call(["dismiss"])).kind).toBe("dismissed");
    expect((await call(["status", "--json"])).optedOut).toBe(true);
    const off = output();
    expect(await runProductSupportCommand(["offer", "--json"], off.write, { env: { ...f.env, HRANESS_SUPPORT_AUDIENCE: "off" }, stateDirectory: f.root })).toBe(0);
    expect(JSON.parse(off.read().stdout).kind).toBe("quiet");
  } finally { await f.cleanup(); }
});

test("real standalone support works with piped JSON before product setup", async () => {
  const f = await fixture();
  try {
    const entry = resolve(import.meta.dir, "../src/cli.ts");
    const child = Bun.spawn([process.execPath, entry, "support", "offer", "--json"], {
      cwd: f.root, env: { ...f.env, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).kind).toBe("offer");
    expect(JSON.parse(stdout).invitation.emailSuggestion).toBeUndefined();
  } finally { await f.cleanup(); }
});

test("a useful standalone result keeps JSON exact and discovers without consuming an offer", async () => {
  const f = await fixture();
  try {
    const entry = resolve(import.meta.dir, "cli.ts");
    const call = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, entry, ...args], {
        cwd: f.root, env: { ...f.env, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const root = join(f.root, "messages");
    const initialized = await call(["--data-dir", root, "init", "--json"]);
    expect(initialized.code).toBe(0);
    expect(initialized.stderr).toBe("");
    const listed = await call(["--data-dir", root, "sources", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toBeObject();
    expect(listed.stdout).not.toContain("hraness-support");
    expect(JSON.parse(listed.stderr).schemaVersion).toBe("hraness-support-discovery-v1");
    const repeated = await call(["--data-dir", root, "sources", "list", "--json"]);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toBe(listed.stdout);
    expect(repeated.stderr).toBe("");
    const offer = await call(["support", "offer", "--json"]);
    expect(JSON.parse(offer.stdout).kind).toBe("offer");
    const help = await call(["--data-dir", root, "sources", "list", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
  } finally { await f.cleanup(); }
});

test("programmatic main stays quiet and classifiers exclude nested help and version", async () => {
  const { main, isUsefulSupportResult } = await import("./cli.ts");
  const f = await fixture();
  const before = process.env.HRANESS_SUPPORT_AUDIENCE;
  try {
    const sink = output();
    const io = { ...sink.write, now: () => new Date("2026-01-01T00:00:00.000Z") };
    const root = join(f.root, "messages");
    expect(await main(["--data-dir", root, "init", "--json"], io)).toBe(0);
    expect(await main(["--data-dir", root, "sources", "list", "--json"], io)).toBe(0);
    expect(sink.read().stderr).toBe("");
    expect(process.env.HRANESS_SUPPORT_AUDIENCE).toBe(before);
    expect(isUsefulSupportResult(["sources", "list", "--help"])).toBe(false);
    expect(isUsefulSupportResult(["sources", "list", "--version"])).toBe(false);
    expect(isUsefulSupportResult(["doctor", "--json"])).toBe(false);
  } finally { await f.cleanup(); }
});
