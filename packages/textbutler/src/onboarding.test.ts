import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSetup, readReadiness } from "./onboarding.ts";
import { loadHostConfig } from "./host-config.ts";
import { startDaemon } from "./daemon.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(await realpath("/tmp"), "tb-setup-")); roots.push(root); return root; }
const quiet = { write: (_text: string) => {} };
test("guided setup is private, paused, repeatable and preserves owner state", async () => {
  const root = await fixture();
  await runSetup([], root, quiet);
  const settings = join(root, "state/settings.json"), before = await readFile(settings, "utf8");
  expect(JSON.parse(before).settings).toMatchObject({ paused: true, contacts: [] });
  expect((await stat(settings)).mode & 0o777).toBe(0o600);
  await runSetup([], root, quiet);
  expect(await readFile(settings, "utf8")).toBe(before);
  const readiness = await readReadiness(root);
  expect(readiness.daemonConnected).toBe(false);
  expect(readiness.canGenerateReplies).toBe(false);
  expect(readiness.automaticReplies).toBe("unavailable");
  expect(readiness.steps.find(step => step.id === "agent")?.status).toBe("blocked");
});
test("initial connection setup supports all three providers without executing the connector", async () => {
  const root = await fixture(), executable = join(root, "ghostget");
  await writeFile(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const args = ["--ghostget", executable, "--account", "imessage:messages", "--account", "whatsapp:personal", "--account", "beeper:beeper-main"];
  expect(await runSetup(args, root, quiet)).toBe(0);
  expect((await loadHostConfig(root)).ghostget?.automationAccounts?.length).toBe(3);
  const file = join(root, "state/host.json"), original = await readFile(file, "utf8");
  expect(await runSetup(args, root, quiet)).toBe(0);
  await expect(runSetup(["--ghostget", executable, "--account", "beeper:other"], root, quiet)).rejects.toThrow("different account");
  expect(await readFile(file, "utf8")).toBe(original);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
test("malformed setup cannot create settings or overwrite unsafe existing configuration", async () => {
  const root = await fixture();
  await expect(runSetup(["--account", "beeper:main"], root, quiet)).rejects.toThrow();
  await expect(stat(join(root, "state"))).rejects.toThrow();
  await runSetup([], root, quiet);
  const executable = join(root, "ghostget"), file = join(root, "state/host.json");
  await writeFile(executable, "fixture", { mode: 0o700 });
  await writeFile(file, "private-invalid-config", { mode: 0o600 });
  await expect(runSetup(["--ghostget", executable, "--account", "beeper:main"], root, quiet)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("private-invalid-config");
  await chmod(file, 0o644);
  expect((await readReadiness(root)).steps.find(step => step.id === "configuration")?.status).toBe("blocked");
});

test("adding Beeper preserves native and agent settings, and refuses an unexecutable connector", async () => {
  const root = await fixture(), executable = join(root, "ghostget");
  await writeFile(executable, "fixture", { mode: 0o600 });
  await expect(runSetup(["--ghostget", executable, "--account", "beeper:main"], root, quiet)).rejects.toThrow("cannot execute");
  await chmod(executable, 0o700);
  await runSetup(["--ghostget", executable, "--account", "imessage:messages"], root, quiet);
  const file = join(root, "state/host.json"), before = await loadHostConfig(root);
  await writeFile(file, JSON.stringify({ ...before, providerAccounts: [{ id: "my-agent", label: "Mine", route: "codex" }] }), { mode: 0o600 });
  await runSetup(["--ghostget", executable, "--account", "beeper:beeper-main"], root, quiet);
  const after = await loadHostConfig(root);
  expect(after.ghostget?.authId).toBe("messages");
  expect(after.ghostget?.automationAccounts?.map(account => account.provider)).toEqual(["imessage", "beeper"]);
  expect(after.providerAccounts?.[0]?.id).toBe("my-agent");
});

async function xcbFixture() {
  const root = await fixture(), executable = join(root, "xcb"), stateHome = join(root, "xcb-state");
  // Setup must hash this file without running it or reading XCB credentials.
  await writeFile(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await mkdir(stateHome, { mode: 0o700 });
  await writeFile(join(stateHome, "owner-sentinel"), "retain subscription state", { mode: 0o600 });
  const args = ["--xcb", executable, "--xcb-state", stateHome, "--xcb-account", "codex:synthetic-account", "--xcb-model", "codex/synthetic-model/high"];
  return { root, executable, stateHome, args };
}
test("XCB setup pins executable bytes, preserves all existing settings, and adds providers explicitly", async () => {
  const { root, executable, stateHome, args } = await xcbFixture();
  await runSetup(["--ghostget", executable, "--account", "imessage:messages"], root, quiet);
  const file = join(root, "state/host.json"), original = await loadHostConfig(root), settings = await readFile(join(root, "state/settings.json"), "utf8");
  await writeFile(file, JSON.stringify({ ...original, providerAccounts: [{ id: "other", label: "Other", route: "claude-code" }] }), { mode: 0o600 });
  await runSetup(args, root, quiet);
  const pinned = await loadHostConfig(root), bytes = await readFile(file, "utf8");
  expect(pinned.xcb).toEqual({ executable, stateHome, sha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    accounts: [{ provider: "codex", accountId: "synthetic-account", model: "codex/synthetic-model/high" }] });
  expect(pinned.ghostget).toEqual(original.ghostget);
  expect(pinned.providerAccounts?.[0]?.id).toBe("other");
  await runSetup(args, root, quiet);
  expect(await readFile(file, "utf8")).toBe(bytes);
  await runSetup(["--xcb", executable, "--xcb-state", stateHome, "--xcb-model", "claude/synthetic-claude", "--xcb-account", "claude:second-account"], root, quiet);
  expect((await loadHostConfig(root)).xcb?.accounts).toHaveLength(2);
  expect(await readFile(join(root, "state/settings.json"), "utf8")).toBe(settings);
  expect(await readFile(join(stateHome, "owner-sentinel"), "utf8")).toBe("retain subscription state");
  const readiness = await readReadiness(root), agent = readiness.steps.find(step => step.id === "agent");
  expect(readiness.canGenerateReplies).toBe(false);
  expect(agent).toMatchObject({ status: "blocked", command: "textbutler providers check native-codex" });
});
test("XCB setup refuses implicit mappings, changed pins, and silent account or model switches", async () => {
  const { root, executable, args } = await xcbFixture();
  for (const malformed of [args.slice(0, -2), [...args, "--xcb-model", "codex/other"], args.map(value => value === "codex/synthetic-model/high" ? "claude/other" : value)]) {
    await expect(runSetup(malformed, root, quiet)).rejects.toThrow();
  }
  await expect(stat(join(root, "state"))).rejects.toThrow();
  await runSetup(args, root, quiet);
  const file = join(root, "state/host.json"), saved = await readFile(file, "utf8");
  for (const [before, after] of [["codex:synthetic-account", "codex:other"], ["codex/synthetic-model/high", "codex/other/high"]]) {
    await expect(runSetup(args.map(value => value === before ? after! : value), root, quiet)).rejects.toThrow("different account or model");
  }
  await writeFile(executable, "#!/bin/sh\nexit 98\n");
  await expect(runSetup(args, root, quiet)).rejects.toThrow("digest");
  expect(await readFile(file, "utf8")).toBe(saved);
});
test("XCB setup rejects linked, writable or non-executable binaries and unsafe state homes", async () => {
  const { root, executable, stateHome, args } = await xcbFixture();
  await chmod(executable, 0o600);
  await expect(runSetup(args, root, quiet)).rejects.toThrow("physical xcb executable");
  await chmod(executable, 0o722);
  await expect(runSetup(args, root, quiet)).rejects.toThrow("physical xcb executable");
  await chmod(executable, 0o700);
  const other = join(root, "other-xcb");
  await link(executable, other);
  await expect(runSetup(args, root, quiet)).rejects.toThrow("physical xcb executable");
  await rm(other); await symlink(executable, other);
  await expect(runSetup(args.map(value => value === executable ? other : value), root, quiet)).rejects.toThrow("physical xcb executable");
  await chmod(stateHome, 0o755);
  await expect(runSetup(args, root, quiet)).rejects.toThrow("private, physical state directory");
  await expect(stat(join(root, "state"))).rejects.toThrow();
});
test("XCB configuration cannot change while the daemon owns settings", async () => {
  const { root, args } = await xcbFixture();
  const daemon = await startDaemon({ dataDir: root });
  try {
    await expect(runSetup(args, root, quiet)).rejects.toThrow("Stop the Textbutler service");
    expect((await loadHostConfig(root)).xcb).toBeUndefined();
    expect((await daemon.service.snapshot()).settings.paused).toBe(true);
  } finally { await daemon.close(); }
});
