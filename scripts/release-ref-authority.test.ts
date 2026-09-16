import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertReviewedMainComparison,
  type GitCommandResult,
  type GitCommandRunner,
  parseGovernedRemoteSnapshot,
  parseRemoteMainSnapshot,
  parseRemoteSnapshot,
  verifyReleaseRefAuthority,
} from "./release-ref-authority";

const repositoryUrl = "https://github.com/hraness/textbutler.git";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function git(cwd: string, arguments_: readonly string[]): Uint8Array {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "buffer",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    maxBuffer: 512 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return new Uint8Array(result.stdout);
}

function preparePromotionCheckout(input: Fixture): void {
  git(input.work, ["update-ref", "-d", "refs/tags/v1.0.0"]);
  checkoutMain(input);
}

function checkoutMain(input: Fixture): void {
  git(input.work, [
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    input.remote,
    "refs/heads/main",
  ]);
  git(input.work, ["checkout", "--detach", "FETCH_HEAD"]);
}

function text(cwd: string, arguments_: readonly string[]): string {
  return new TextDecoder().decode(git(cwd, arguments_)).trim();
}

type Fixture = Readonly<{
  mainSha: string;
  releaseSha: string;
  remote: string;
  root: string;
  tagObjectSha: string;
  work: string;
}>;

function fixture(options: Readonly<{
  divergent?: boolean;
  higherLightweight?: boolean;
  nonstable?: boolean;
  tagKind?: "annotated" | "lightweight" | "tag-of-tag";
}> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mlm-release-ref-authority-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  git(root, ["init", "--initial-branch=main", source]);
  git(source, ["config", "user.email", "release-ref-authority@example.invalid"]);
  git(source, ["config", "user.name", "Release Ref Authority Fixture"]);
  writeFileSync(join(source, "fixture.txt"), "release\n", "utf8");
  git(source, ["add", "fixture.txt"]);
  git(source, ["commit", "--no-gpg-sign", "-m", "release"]);
  const releaseBase = text(source, ["rev-parse", "HEAD"]);

  let releaseSha = releaseBase;
  if (options.divergent === true) {
    git(source, ["switch", "--create", "release-side"]);
    writeFileSync(join(source, "side.txt"), "side\n", "utf8");
    git(source, ["add", "side.txt"]);
    git(source, ["commit", "--no-gpg-sign", "-m", "side"]);
    releaseSha = text(source, ["rev-parse", "HEAD"]);
    git(source, ["switch", "main"]);
  }

  const kind = options.tagKind ?? "annotated";
  if (kind === "lightweight") {
    git(source, ["tag", "v1.0.0", releaseSha]);
  } else if (kind === "tag-of-tag") {
    git(source, ["tag", "--annotate", "inner-v1.0.0", "--message", "inner", releaseSha]);
    git(source, ["tag", "--annotate", "v1.0.0", "--message", "outer", "inner-v1.0.0"]);
  } else {
    git(source, ["tag", "--annotate", "v1.0.0", "--message", "release", releaseSha]);
  }
  if (options.higherLightweight === true) git(source, ["tag", "v1.0.1", releaseSha]);
  if (options.nonstable === true) git(source, ["tag", "v1.0.1-rc.1", releaseSha]);

  writeFileSync(join(source, "fixture.txt"), "main\n", "utf8");
  git(source, ["add", "fixture.txt"]);
  git(source, ["commit", "--no-gpg-sign", "-m", "main"]);
  const mainSha = text(source, ["rev-parse", "HEAD"]);
  git(root, ["init", "--bare", remote]);
  git(source, ["remote", "add", "fixture-origin", remote]);
  git(source, ["push", "fixture-origin", "refs/heads/main:refs/heads/main"]);
  for (const tag of ["inner-v1.0.0", "v1.0.0", "v1.0.1", "v1.0.1-rc.1"]) {
    if (spawnSync("git", ["show-ref", "--verify", `refs/tags/${tag}`], { cwd: source }).status === 0) {
      git(source, ["push", "fixture-origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    }
  }
  const tagObjectSha = text(source, ["rev-parse", "refs/tags/v1.0.0"]);
  git(root, ["init", work]);
  git(work, [
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    remote,
    "refs/tags/v1.0.0:refs/tags/v1.0.0",
  ]);
  git(work, ["checkout", "--detach", "refs/tags/v1.0.0^{commit}"]);
  return Object.freeze({
    mainSha,
    releaseSha,
    remote,
    root,
    tagObjectSha,
    work,
  });
}

type RunnerOptions = Readonly<{
  mutateResult?: (
    arguments_: readonly string[],
    invocation: number,
    result: GitCommandResult,
  ) => GitCommandResult;
}>;

function runnerFor(
  input: Fixture,
  options: RunnerOptions = {},
): Readonly<{ calls: readonly (readonly string[])[]; runner: GitCommandRunner }> {
  const calls: (readonly string[])[] = [];
  let invocation = 0;
  return Object.freeze({
    calls,
    runner: (arguments_) => {
      calls.push(Object.freeze([...arguments_]));
      invocation += 1;
      const rewritten = arguments_.map((argument) => argument === repositoryUrl ? input.remote : argument);
      const result = spawnSync("git", rewritten, {
        cwd: input.work,
        encoding: "buffer",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
        maxBuffer: 512 * 1_024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      const value: GitCommandResult = Object.freeze({
        exitCode: result.status ?? 127,
        stderr: new Uint8Array(result.stderr),
        stdout: new Uint8Array(result.stdout),
      });
      return options.mutateResult?.(arguments_, invocation, value) ?? value;
    },
  });
}

function inventory(...rows: readonly (readonly [string, string])[]): string {
  return rows.map(([oid, ref]) => `${oid}\t${ref}\n`).join("");
}

describe("bounded remote ref inventory", () => {
  const main = "1".repeat(40);
  const tag = "2".repeat(40);

  test("accepts one exact main and canonical stable plus nonstable v* tags", () => {
    expect(parseRemoteMainSnapshot(inventory([main, "refs/heads/main"]))).toBe(main);
    const parsed = parseRemoteSnapshot(inventory(
      [tag, "refs/tags/v1.2.3"],
      [tag, "refs/tags/v1.2.4-rc.1"],
    ), "v1.2.3");
    expect(parsed.requestedTagOid).toBe(tag);
    expect(parsed.entries).toHaveLength(2);
  });

  test("fails missing, duplicate, malformed, noncanonical, and unexpected rows closed", () => {
    for (const value of [
      "",
      inventory([tag, "refs/tags/v1.2.2"]),
      inventory([tag, "refs/tags/v1.2.3"], [tag, "refs/tags/v1.2.3"]),
      `${tag} refs/tags/v1.2.3\n`,
      inventory(["z".repeat(40), "refs/tags/v1.2.3"]),
      inventory([tag, "refs/tags/v1..2.3"]),
      inventory([main, "refs/heads/main"], [tag, "refs/tags/v1.2.3"]),
      inventory([tag, "refs/tags/v1.2.3^{}"]),
      `${tag}\trefs/tags/v1.2.3\r\n`,
      `${tag}\trefs/tags/v1.2.3`,
      inventory([tag, "refs/tags/v1.2.4"], [tag, "refs/tags/v1.2.3"]),
    ]) expect(() => parseRemoteSnapshot(value, "v1.2.3")).toThrow();
    expect(() => parseRemoteSnapshot(new Uint8Array([0xff]), "v1.2.3"))
      .toThrow("valid UTF-8");
    for (const value of [
      "",
      inventory([main, "refs/heads/other"]),
      inventory([main, "refs/heads/main"], [main, "refs/heads/main"]),
      inventory(["z".repeat(40), "refs/heads/main"]),
    ]) expect(() => parseRemoteMainSnapshot(value)).toThrow();
  });

  test("fails bounded inventory and a newer lightweight stable tag", () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => [
      tag,
      `refs/tags/v1.2.${String(index)}`,
    ] as const);
    expect(() => parseRemoteSnapshot(inventory(...tooMany), "v1.2.500"))
      .toThrow("row count");
    expect(() => parseRemoteSnapshot("x".repeat(64 * 1_024 + 1), "v1.2.3"))
      .toThrow("byte bound");
    expect(() => parseRemoteSnapshot(inventory(
      [tag, "refs/tags/v1.2.3"],
      [tag, "refs/tags/v1.2.4"],
    ), "v1.2.3")).toThrow("newest advertised stable tag");
  });

  test("rejects foreign tag namespaces in the governed inventory", () => {
    expect(() => parseRemoteSnapshot(inventory(
      [tag, "refs/tags/agentmixer-v0.1.0"],
      [tag, "refs/tags/agentmixer-v0.2.0-rc.1"],
    ), "agentmixer-v0.1.0")).toThrow("canonical stable version");
    expect(() => parseRemoteSnapshot(inventory(
      [tag, "refs/tags/agentmixer-v0.2.0"],
      [tag, "refs/tags/v0.1.0"],
    ), "v0.1.0")).toThrow("unexpected ref");
    expect(() => parseRemoteSnapshot(inventory(
      [tag, "refs/tags/v0.1.0"],
      [tag, "refs/tags/v9.9.9"],
    ), "v0.1.0")).toThrow("newest advertised stable tag");
    const parsed = parseRemoteSnapshot(inventory(
      [tag, "refs/tags/v0.1.0"],
    ), "v0.1.0");
    expect(parsed.requestedTagOid).toBe(tag);
  });

  test("bounds the combined main and tag inventory", () => {
    const mainInventory = inventory([main, "refs/heads/main"]);
    const maximumTags = [
      [tag, "refs/tags/v1.2.3"],
      ...Array.from({ length: 498 }, (_, index) => [
        tag,
        `refs/tags/v1.2.3-a${String(index).padStart(3, "0")}`,
      ] as const),
    ] as const;
    expect(() => parseGovernedRemoteSnapshot(
      mainInventory,
      inventory(...maximumTags),
      "v1.2.3",
    )).not.toThrow();
    expect(() => parseGovernedRemoteSnapshot(
      mainInventory,
      inventory(
        ...maximumTags,
        [tag, "refs/tags/v1.2.3-z999"],
      ),
      "v1.2.3",
    )).toThrow("row bound");

    const longTags = inventory(
      [tag, "refs/tags/v1.2.3"],
      ...Array.from({ length: 363 }, (_, index) => [
        tag,
        `refs/tags/v9${String(index).padStart(3, "0")}${"a".repeat(123)}`,
      ] as const),
      [tag, "refs/tags/vzz-a"],
      [tag, "refs/tags/vzz-b"],
    );
    expect(() => parseRemoteSnapshot(longTags, "v1.2.3")).not.toThrow();
    expect(() => parseGovernedRemoteSnapshot(mainInventory, longTags, "v1.2.3"))
      .toThrow("byte bound");
  });
});

describe("exact Git release-ref authority", () => {
  test("imports only exact governed refs and admits a direct annotated release", () => {
    const input = fixture({ nonstable: true });
    const local = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: local.runner,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });

    const snapshots = local.calls.filter((call) => call[0] === "ls-remote");
    expect(snapshots).toEqual([
      ["ls-remote", "--refs", repositoryUrl, "refs/heads/main"],
      ["ls-remote", "--refs", "--tags", repositoryUrl, "refs/tags/v*"],
      ["ls-remote", "--refs", repositoryUrl, "refs/heads/main"],
      ["ls-remote", "--refs", "--tags", repositoryUrl, "refs/tags/v*"],
    ]);
    const fetch = local.calls.find((call) => call[0] === "fetch");
    expect(fetch).toEqual([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--unshallow",
      repositoryUrl,
      "refs/heads/main:refs/remotes/origin/main",
      "refs/tags/v1.0.0:refs/tags/v1.0.0",
    ]);
    expect(fetch?.some((argument) => argument === "--force" || argument.startsWith("+"))).toBe(false);
    expect(text(input.work, ["for-each-ref", "--format=%(refname)"]))
      .toBe("refs/remotes/origin/main\nrefs/tags/v1.0.0");
  });

  test("keeps current-main workflow code separate from the verified release commit", () => {
    const input = fixture();
    expect(input.mainSha).not.toBe(input.releaseSha);
    preparePromotionCheckout(input);
    const local = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      expectedReleaseSha: input.releaseSha,
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: local.runner,
      workflowSha: input.mainSha,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });

    const wrongWorkflow = fixture();
    preparePromotionCheckout(wrongWorkflow);
    expect(() => verifyReleaseRefAuthority({
      expectedReleaseSha: wrongWorkflow.releaseSha,
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(wrongWorkflow).runner,
      workflowSha: "f".repeat(40),
    })).toThrow("exact advertised current main");

    const wrongUpstream = fixture();
    preparePromotionCheckout(wrongUpstream);
    expect(() => verifyReleaseRefAuthority({
      expectedReleaseSha: "f".repeat(40),
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(wrongUpstream).runner,
      workflowSha: wrongUpstream.mainSha,
    })).toThrow("Successful Release run and annotated tag target different commits");

    const wrongReleaseCheckout = fixture();
    checkoutMain(wrongReleaseCheckout);
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(wrongReleaseCheckout).runner,
    })).toThrow("Release checkout does not equal the verified tag commit");
  }, 15_000);

  test("conditionally unshallows exact refs and removes stale FETCH_HEAD authority", () => {
    const input = fixture();
    const shallowWork = join(input.root, "shallow");
    git(input.root, ["init", shallowWork]);
    git(shallowWork, [
      "fetch",
      "--depth",
      "1",
      "--no-tags",
      `file://${input.remote}`,
      "refs/heads/main",
    ]);
    git(shallowWork, ["checkout", "--detach", "FETCH_HEAD"]);
    const shallowInput = Object.freeze({ ...input, work: shallowWork });
    const fetchHeadValue = text(shallowWork, ["rev-parse", "--git-path", "FETCH_HEAD"]);
    const fetchHead = resolve(shallowWork, fetchHeadValue);
    writeFileSync(fetchHead, "stale and untrusted\n", "utf8");
    const local = runnerFor(shallowInput);

    expect(verifyReleaseRefAuthority({
      expectedReleaseSha: input.releaseSha,
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: local.runner,
      workflowSha: input.mainSha,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
    expect(local.calls.find((call) => call[0] === "fetch")).toContain("--unshallow");
    expect(spawnSync("test", ["-e", fetchHead]).status).not.toBe(0);
  });

  test("rejects a lightweight requested tag and an annotated tag-of-tag", () => {
    for (const tagKind of ["lightweight", "tag-of-tag"] as const) {
      const input = fixture({ tagKind });
      expect(() => verifyReleaseRefAuthority({
        mode: "release",
        requestedTag: "v1.0.0",
        runner: runnerFor(input).runner,
      })).toThrow();
    }
  });

  test("lets a nonstable tag remain visible but lets a higher lightweight stable block", () => {
    const allowed = fixture({ nonstable: true });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(allowed).runner,
    })).not.toThrow();

    const blocked = fixture({ higherLightweight: true });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(blocked).runner,
    })).toThrow("newest advertised stable tag");
  });

  test("rejects tag/main divergence and an unexpected preexisting local ref", () => {
    const divergent = fixture({ divergent: true });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(divergent).runner,
    })).toThrow("not an ancestor");

    const contaminated = fixture();
    git(contaminated.work, ["update-ref", "refs/heads/unexpected", contaminated.releaseSha]);
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(contaminated).runner,
    })).toThrow("does not contain the exact governed ref set");

    const postImport = fixture();
    const injectedRunner = runnerFor(postImport, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "fetch" && result.exitCode === 0) {
          git(postImport.work, ["update-ref", "refs/heads/injected", postImport.releaseSha]);
        }
        return result;
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: injectedRunner.runner,
    })).toThrow("post-import inventory does not contain the exact governed ref set");
  });

  test("rejects advertised/fetched OID drift and a changed terminal inventory", () => {
    const advertisedDrift = fixture();
    let snapshots = 0;
    const driftRunner = runnerFor(advertisedDrift, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] !== "ls-remote" || !arguments_.includes("--tags")) return result;
        snapshots += 1;
        if (snapshots !== 1) return result;
        const output = new TextDecoder().decode(result.stdout)
          .replace(advertisedDrift.tagObjectSha, "f".repeat(40));
        return Object.freeze({ ...result, stdout: new TextEncoder().encode(output) });
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: driftRunner.runner,
    })).toThrow("advertised direct annotated tag");

    const terminalDrift = fixture();
    let reads = 0;
    const terminalRunner = runnerFor(terminalDrift, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] !== "ls-remote" || arguments_.includes("--tags")) return result;
        reads += 1;
        if (reads !== 2) return result;
        const output = new TextDecoder().decode(result.stdout)
          .replace(terminalDrift.mainSha, "e".repeat(40));
        return Object.freeze({ ...result, stdout: new TextEncoder().encode(output) });
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: terminalRunner.runner,
    })).toThrow("changed during verification");
  });

  test("rejects an annotated tag whose embedded name differs from the requested ref", () => {
    const input = fixture();
    const local = runnerFor(input, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] !== "cat-file") return result;
        const output = new TextDecoder().decode(result.stdout)
          .replace("tag v1.0.0\n", "tag v1.0.9\n");
        return Object.freeze({ ...result, stdout: new TextEncoder().encode(output) });
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: local.runner,
    })).toThrow("does not directly name");
  });
});

describe("reviewed-main compare authority", () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const ahead = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    ahead_by: 2,
    base_commit: { sha: base },
    behind_by: 0,
    commits: [{ sha: "c".repeat(40) }, { sha: head }],
    merge_base_commit: { sha: base },
    status: "ahead",
    ...overrides,
  });

  test("binds ahead and identical responses without a response head field", () => {
    expect(() => assertReviewedMainComparison(ahead(), base, head)).not.toThrow();
    expect(() => assertReviewedMainComparison({
      ahead_by: 0,
      base_commit: { sha: base },
      behind_by: 0,
      commits: [],
      merge_base_commit: { sha: base },
      status: "identical",
    }, base, base)).not.toThrow();
  });

  test("rejects malformed distance, bases, status, and terminal commits", () => {
    for (const candidate of [
      ahead({ status: "diverged" }),
      ahead({ ahead_by: 0 }),
      ahead({ ahead_by: 1.5 }),
      ahead({ behind_by: 1 }),
      ahead({ base_commit: { sha: "d".repeat(40) } }),
      ahead({ merge_base_commit: { sha: "d".repeat(40) } }),
      ahead({ commits: [] }),
      ahead({ commits: [{ sha: head }, { sha: "d".repeat(40) }] }),
      ahead({ commits: null }),
      null,
    ]) expect(() => assertReviewedMainComparison(candidate, base, head)).toThrow();
  });
});
