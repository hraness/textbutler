import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSetup, readReadiness } from "./onboarding.ts";
import { loadHostConfig } from "./host-config.ts";
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
