import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { runCommand } from "./commands.ts";
import { installSkillProgram, SkillInstallPlatform } from "./skill-install-program.ts";
import { skillInstallPlatform, skillInstallPlatformLive } from "./skill-install-platform.ts";
import { bundledSkillPath, type SkillInstallOptions } from "./skill-install.ts";
import type { SkillInstallOutcome } from "./skill-install-model.ts";

const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.reverse()) restore();
  restores.length = 0;
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function fixture(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "mlm-installer-")));
  roots.push(root);
  return root;
}
const options = (root: string, force = false): SkillInstallOptions => ({ target: "agents", scope: "project", projectDirectory: root, force });
const program = (root: string, force = false) => installSkillProgram(options(root, force)).pipe(Effect.provide(skillInstallPlatformLive));
const execute = (root: string, force = false) => Effect.runPromise(program(root, force));
function failure(outcome: SkillInstallOutcome): unknown {
  expect(Exit.isFailure(outcome.operation)).toBe(true);
  if (Exit.isSuccess(outcome.operation)) throw new Error("Expected failure");
  const value = Cause.failureOption(outcome.operation.cause);
  if (Option.isNone(value)) throw new Error("Expected typed failure");
  return value.value.cause;
}
async function seed(root: string): Promise<void> {
  expect((await execute(root)).operation._tag).toBe("Success");
  for (const name of ["message-like-me", "ensoul"]) await fs.writeFile(join(root, ".agents", "skills", name, "previous.txt"), name);
}
async function expectPrevious(root: string): Promise<void> {
  for (const name of ["message-like-me", "ensoul"]) {
    expect(await fs.readFile(join(root, ".agents", "skills", name, "previous.txt"), "utf8")).toBe(name);
  }
  expect((await fs.readdir(join(root, ".agents", "skills"))).sort()).toEqual(["ensoul", "message-like-me"]);
}
async function installed(root: string): Promise<void> {
  for (const name of ["message-like-me", "ensoul"]) expect((await fs.lstat(join(root, ".agents", "skills", name, "SKILL.md"))).isFile()).toBe(true);
}
function deferred<A>() {
  let resolveValue!: (value: A) => void;
  const promise = new Promise<A>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}
const command = (root: string, stdout: (text: string) => void, stderr: (text: string) => void, force = false) =>
  runCommand(["skill", "install", "--target", "agents", "--scope", "project", "--project", root, "--json", ...(force ? ["--force"] : [])], { stdout, stderr, now: () => new Date(0) });

describe("paired native skill installation", () => {
  for (const name of ["message-like-me", "ensoul"] as const) {
    for (const phase of ["copy", "backup", "publish"] as const) {
      test(`${phase} failure for ${name} restores both originals`, async () => {
        const root = await fixture();
        await seed(root);
        const primary = new Error(`private ${phase} detail`);
        if (phase === "copy") {
          const original = fs.cp;
          let failed = false;
          const spy = spyOn(fs, "cp").mockImplementation(async (source, destination, flags) => {
            if (!failed && String(destination).includes(`/${name}.stage/`)) { failed = true; throw primary; }
            return original(source, destination, flags);
          });
          restores.push(() => spy.mockRestore());
        } else {
          const original = fs.rename;
          const spy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            if ((phase === "backup" && String(destination).endsWith(`/${name}.backup`))
              || (phase === "publish" && String(source).endsWith(`/${name}.stage`))) throw primary;
            return original(source, destination);
          });
          restores.push(() => spy.mockRestore());
        }
        const outcome = await execute(root, true);
        expect(failure(outcome)).toBe(primary);
        expect(outcome.committed).toBe(false);
        expect(outcome.residuals).toHaveLength(0);
        await expectPrevious(root);
      });
    }
  }

  for (const primary of [undefined, null, false, new Error("private primary")]) {
    test(`keeps ${String(primary)} primary when rollback and warning fail`, async () => {
      const root = await fixture();
      await seed(root);
      const rename = fs.rename;
      const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(source).endsWith("/ensoul.stage")) throw primary;
        return rename(source, destination);
      });
      const unlink = fs.unlink;
      const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async path => {
        if (String(path).includes("/message-like-me/") && !String(path).includes(".backup")) throw new Error("private cleanup");
        return unlink(path);
      });
      restores.push(() => renameSpy.mockRestore(), () => unlinkSpy.mockRestore());
      const warnings: string[] = [];
      let caught = false;
      try {
        await command(root, () => { throw new Error("unexpected stdout"); }, text => { warnings.push(text); throw new Error("stderr failure"); }, true);
      } catch (error) { caught = true; expect(error).toBe(primary); }
      expect(caught).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not committed");
      expect(warnings[0]).not.toContain(root);
      expect(warnings[0]).not.toContain("private");
      // Independent reverse-pair recovery succeeds despite the first residual.
      expect(await fs.readFile(join(root, ".agents", "skills", "ensoul", "previous.txt"), "utf8")).toBe("ensoul");
    });
  }

  test("a rename that moves bytes before rejecting remains recoverable without replay", async () => {
    const root = await fixture();
    await seed(root);
    const original = fs.rename;
    let calls = 0;
    const primary = new Error("lost acknowledgement");
    const spy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await original(source, destination);
      if (String(source).endsWith("/ensoul.stage")) { calls++; throw primary; }
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root, true);
    expect(failure(result)).toBe(primary);
    expect(calls).toBe(1);
    await expectPrevious(root);
  });

  test("both publications commit before backup cleanup, and both cleanups are attempted", async () => {
    const root = await fixture();
    await seed(root);
    const original = fs.unlink;
    const paths: string[] = [];
    const spy = spyOn(fs, "unlink").mockImplementation(async path => {
      paths.push(String(path));
      if (String(path).includes("/message-like-me.backup/")) throw undefined;
      return original(path);
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root, true);
    expect(result.committed).toBe(true);
    expect(result.operation._tag).toBe("Success");
    expect(result.residuals.map(item => `${item.skill}:${item.phase}`)).toEqual(["message-like-me:backup-cleanup", "pair:transaction-cleanup"]);
    expect(paths.some(path => path.includes("/ensoul.backup/"))).toBe(true);
    await installed(root);
    await expect(fs.lstat(join(root, ".agents", "skills", ".message-like-me.install-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("postcommit realpath failure reports committed and never rolls back", async () => {
    const root = await fixture();
    const original = fs.realpath;
    const spy = spyOn(fs, "realpath").mockImplementation(new Proxy(original, {
      apply(target, receiver, args) {
        if (String(args[0]) === join(root, ".agents", "skills", "ensoul")) return Promise.reject(null);
        return Reflect.apply(target, receiver, args);
      },
    }));
    restores.push(() => spy.mockRestore());
    const warnings: string[] = [];
    let caught = false;
    try { await command(root, () => { throw new Error("unexpected stdout"); }, text => { warnings.push(text); }); }
    catch (error) { caught = true; expect(error).toBeNull(); }
    expect(caught).toBe(true);
    expect(warnings.join("")).toContain("committed; output confirmation failed");
    await installed(root);
  });

  test("postcommit stdout failure keeps its identity even when warning output fails", async () => {
    const root = await fixture();
    let warnings = 0;
    let caught = false;
    try { await command(root, () => { throw false; }, text => { expect(text).toContain("committed;"); warnings++; throw new Error("diagnostic"); }); }
    catch (error) { caught = true; expect(error).toBe(false); }
    expect(caught).toBe(true);
    expect(warnings).toBe(1);
    await installed(root);
  });

  test("observer interruption waits for admitted native copy and never duplicates publication", async () => {
    const root = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = fs.cp;
    let calls = 0;
    const spy = spyOn(fs, "cp").mockImplementation(async (source, destination, flags) => {
      calls++;
      if (calls === 1) { entered.resolve(); await release.promise; }
      return original(source, destination, flags);
    });
    restores.push(() => spy.mockRestore());
    const fiber = Effect.runFork(program(root));
    try {
      await entered.promise;
      let settled = false;
      const interrupt = Effect.runPromise(Fiber.interrupt(fiber)).then(result => { settled = true; return result; });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(calls).toBe(1);
      expect((await fs.lstat(join(root, ".agents", "skills", ".message-like-me.install-lock"))).isDirectory()).toBe(true);
      release.resolve();
      await interrupt;
    } finally { release.resolve(); await Effect.runPromise(Fiber.await(fiber)); }
    expect(calls).toBe(22);
    await installed(root);
    expect((await fs.readdir(join(root, ".agents", "skills"))).sort()).toEqual(["ensoul", "message-like-me"]);
  });

  test("symlinked installation parents are rejected before target mutation", async () => {
    const root = await fixture();
    const other = await fixture();
    await fs.symlink(other, join(root, ".agents"));
    expect(failure(await execute(root))).toMatchObject({ kind: "unsafe-path" });
    expect(await fs.readdir(other)).toEqual([]);
  });

  test("physical project aliases work but an observed source/root alias is refused", async () => {
    const root = await fixture();
    const anchor = await fixture();
    await fs.symlink(root, join(anchor, "project"));
    expect((await execute(join(anchor, "project"))).operation._tag).toBe("Success");
    const source = bundledSkillPath();
    const result = await execute(source);
    expect(failure(result)).toMatchObject({ kind: "unsafe-path" });
    await expect(fs.lstat(join(source, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an existing lock remains untouched and no transaction is created", async () => {
    const root = await fixture();
    const target = join(root, ".agents", "skills");
    await fs.mkdir(join(target, ".message-like-me.install-lock"), { recursive: true });
    await fs.writeFile(join(target, ".message-like-me.install-lock", "owner"), "other");
    const result = await execute(root);
    expect(failure(result)).toMatchObject({ code: "EEXIST" });
    expect(await fs.readdir(target)).toEqual([".message-like-me.install-lock"]);
    expect(await fs.readFile(join(target, ".message-like-me.install-lock", "owner"), "utf8")).toBe("other");
  });

  test("a destination that appears after preflight is never overwritten", async () => {
    const root = await fixture();
    const result = await Effect.runPromise(installSkillProgram(options(root)).pipe(Effect.provideService(SkillInstallPlatform, {
      ...skillInstallPlatform,
      acquire: token => skillInstallPlatform.acquire(token).pipe(Effect.tap(() => Effect.promise(async () => {
        await fs.mkdir(join(root, ".agents", "skills", "ensoul"));
        await fs.writeFile(join(root, ".agents", "skills", "ensoul", "new"), "other");
      }))),
    })));
    expect(failure(result)).toMatchObject({ kind: "unsafe-path" });
    expect(await fs.readFile(join(root, ".agents", "skills", "ensoul", "new"), "utf8")).toBe("other");
    await expect(fs.lstat(join(root, ".agents", "skills", "message-like-me"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-copy type substitution cannot publish or sweep an unknown symlink", async () => {
    const root = await fixture();
    const original = fs.cp;
    let substituted = false;
    let path = "";
    const spy = spyOn(fs, "cp").mockImplementation(async (source, destination, flags) => {
      if (!substituted) {
        substituted = true;
        path = String(destination);
        await fs.symlink(resolve("README.md"), path);
        return;
      }
      return original(source, destination, flags);
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root);
    expect(failure(result)).toMatchObject({ kind: "unsafe-path" });
    expect(result.residuals.length).toBeGreaterThan(0);
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(join(root, ".agents", "skills", "message-like-me"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a replaced published destination is retained and its backup is not restored over it", async () => {
    const root = await fixture();
    await seed(root);
    const original = fs.rename;
    const primary = new Error("second publication failed");
    const target = join(root, ".agents", "skills", "message-like-me");
    const spy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(source).endsWith("/ensoul.stage")) {
        await original(target, `${target}.moved`);
        await fs.mkdir(target);
        await fs.writeFile(join(target, "other"), "do not remove");
        throw primary;
      }
      return original(source, destination);
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root, true);
    expect(failure(result)).toBe(primary);
    expect(result.residuals.map(item => item.phase)).toContain("restore-backup");
    expect(await fs.readFile(join(target, "other"), "utf8")).toBe("do not remove");
    expect(await fs.readFile(join(root, ".agents", "skills", "ensoul", "previous.txt"), "utf8")).toBe("ensoul");
  });

  test("post-copy byte mismatch is rejected before either publication", async () => {
    const root = await fixture();
    const original = fs.cp;
    let changed = false;
    const spy = spyOn(fs, "cp").mockImplementation(async (source, destination, flags) => {
      expect(flags).toMatchObject({ force: false, errorOnExist: true, dereference: false });
      await original(source, destination, flags);
      if (!changed) { changed = true; await fs.writeFile(destination, "different bytes"); }
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root);
    expect(failure(result)).toMatchObject({ kind: "unsafe-path" });
    expect(result.residuals).toHaveLength(0);
    expect(await fs.readdir(join(root, ".agents", "skills"))).toEqual([]);
  });

  for (const collision of ["transaction", "stage"] as const) {
    test(`${collision} acquisition collision retains the unowned directory`, async () => {
      const root = await fixture();
      const original = fs.mkdir;
      let unknown = "";
      const spy = spyOn(fs, "mkdir").mockImplementation(new Proxy(original, {
        async apply(target, receiver, args) {
          const path = String(args[0]);
          const match = collision === "transaction" ? /\/\.skill-install\.[a-f0-9]+$/.test(path) : path.endsWith("/message-like-me.stage");
          if (match && unknown === "") {
            unknown = join(path, "other-owner");
            await Reflect.apply(target, receiver, args);
            await fs.writeFile(unknown, "retained");
            throw undefined;
          }
          return Reflect.apply(target, receiver, args);
        },
      }));
      restores.push(() => spy.mockRestore());
      const result = await execute(root);
      expect(failure(result)).toBeUndefined();
      expect(result.residuals.map(item => item.phase)).toContain("transaction-cleanup");
      expect(await fs.readFile(unknown, "utf8")).toBe("retained");
      await expect(fs.lstat(join(root, ".agents", "skills", ".message-like-me.install-lock"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  test("cleanup refuses a substituted parent after the pair commits", async () => {
    const root = await fixture();
    const other = await fixture();
    await fs.writeFile(join(other, "innocent"), "keep");
    await seed(root);
    const original = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await original(source, destination);
      if (String(source).endsWith("/ensoul.stage")) {
        await original(join(root, ".agents"), join(root, "retained-agents"));
        await fs.symlink(other, join(root, ".agents"));
      }
    });
    restores.push(() => spy.mockRestore());
    const result = await execute(root, true);
    expect(result.committed).toBe(true);
    expect(failure(result)).toMatchObject({ kind: "unsafe-path" });
    expect(result.residuals.map(item => item.phase)).toEqual(["backup-cleanup", "backup-cleanup", "transaction-cleanup", "lock-cleanup"]);
    expect(await fs.readFile(join(other, "innocent"), "utf8")).toBe("keep");
    for (const name of ["message-like-me", "ensoul"]) expect((await fs.lstat(join(root, "retained-agents", "skills", name, "SKILL.md"))).isFile()).toBe(true);
  });

  test("forced replacement bounds old inventory before any transaction mutation", async () => {
    const root = await fixture();
    const old = join(root, ".agents", "skills", "ensoul");
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(join(old, "large"), Buffer.alloc(256 * 1024 + 1));
    const result = await execute(root, true);
    expect(failure(result)).toMatchObject({ kind: "invalid-data" });
    expect(await fs.readdir(join(root, ".agents", "skills"))).toEqual(["ensoul"]);
    expect((await fs.stat(join(old, "large"))).size).toBe(256 * 1024 + 1);
  });

  test("nested read and close failures retain exact primary and every private cleanup value", async () => {
    const root = await fixture();
    const sourceRoot = bundledSkillPath();
    const open = fs.open;
    const openSpy = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (String(path) === join(sourceRoot, "SKILL.md")) {
        const close = handle.close.bind(handle);
        const readSpy = spyOn(handle, "read").mockImplementation(() => Promise.reject(undefined));
        const closeSpy = spyOn(handle, "close").mockImplementation(async () => { await close(); throw false; });
        restores.push(() => readSpy.mockRestore(), () => closeSpy.mockRestore());
      }
      return handle;
    });
    const opendir = fs.opendir;
    const directorySpy = spyOn(fs, "opendir").mockImplementation(async (path, flags) => {
      const directory = await opendir(path, flags);
      if (String(path) === sourceRoot) {
        const close = directory.close.bind(directory);
        const closeSpy = spyOn(directory, "close").mockImplementation(async () => { await close(); throw null; });
        restores.push(() => closeSpy.mockRestore());
      }
      return directory;
    });
    restores.push(() => openSpy.mockRestore(), () => directorySpy.mockRestore());
    const result = await execute(root);
    expect(failure(result)).toBeUndefined();
    if (Exit.isFailure(result.operation)) {
      const selected = Cause.failureOption(result.operation.cause);
      expect(Option.isSome(selected)).toBe(true);
      if (Option.isSome(selected)) expect(selected.value).toHaveProperty("nativeCleanupCauses", [false, null]);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("missing project directories are acquired beneath the existing physical alias", async () => {
    const physical = await fixture();
    const aliasRoot = await fixture();
    await fs.symlink(physical, join(aliasRoot, "project"));
    const requested = join(aliasRoot, "project", "new", "nested");
    const outcome = await execute(requested);
    expect(outcome.operation._tag).toBe("Success");
    if (Exit.isSuccess(outcome.operation)) expect(outcome.operation.value.messageLikeMe).toBe(join(physical, "new", "nested", ".agents", "skills", "message-like-me"));
    await installed(join(physical, "new", "nested"));
  });

  test("a missing project suffix inside a bundled source is rejected without creating it", async () => {
    const path = join(bundledSkillPath(), "uncreated-project", "nested");
    expect(failure(await execute(path))).toMatchObject({ kind: "unsafe-path" });
    await expect(fs.lstat(join(bundledSkillPath(), "uncreated-project"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an excessive missing project suffix is refused before creating directories", async () => {
    const root = await fixture();
    expect(failure(await execute(join(root, ...Array.from({ length: 65 }, () => "next"))))).toMatchObject({ kind: "unsafe-path" });
    expect(await fs.readdir(root)).toEqual([]);
  });
});
