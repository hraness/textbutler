import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertCanaryControlEpochReceipt,
  assertProductionControlEpochReceipt,
  assertWorkflowRangeReceipt,
  CONTROL_EPOCH_CANARY_NO_TAG,
  ControlEpochAdmissionError,
  decodeControlEpochReceipt,
  decodeWorkflowAdmissionReceipt,
  decodeWorkflowRangeReceipt,
  describeControlEpoch,
  encodeControlEpochReceipt,
  encodeWorkflowAdmissionReceipt,
  encodeWorkflowRangeReceipt,
  MAXIMUM_WORKFLOW_RANGE_COMMITS,
  verifyCanaryWorkflowAdmission,
  verifyWorkflowRange,
  verifyProductionWorkflowAdmission,
  type WorkflowRangeGitResult,
  type WorkflowRangeGitRunner,
} from "./release-workflow-range.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function git(cwd: string, arguments_: readonly string[]): Uint8Array {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "buffer",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return new Uint8Array(result.stdout);
}

function text(cwd: string, arguments_: readonly string[]): string {
  return new TextDecoder().decode(git(cwd, arguments_)).trim();
}

type Fixture = Readonly<{
  oldSha: string;
  repository: string;
  root: string;
  workflow: string;
}>;

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mlm-workflow-range-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.email", "workflow-range@example.invalid"]);
  git(repository, ["config", "user.name", "Workflow Range Fixture"]);
  const workflowDirectory = join(repository, ".github", "workflows");
  mkdirSync(workflowDirectory, { recursive: true });
  const workflow = join(workflowDirectory, "release.yml");
  writeFileSync(workflow, "name: release\n", "utf8");
  writeFileSync(join(repository, "product.txt"), "baseline\n", "utf8");
  commit(repository, "baseline");
  return Object.freeze({
    oldSha: text(repository, ["rev-parse", "HEAD"]),
    repository,
    root,
    workflow,
  });
}

function commit(repository: string, message: string): string {
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--no-gpg-sign", "-m", message]);
  return text(repository, ["rev-parse", "HEAD"]);
}

function result(exitCode: number, stdout = "", stderr = ""): WorkflowRangeGitResult {
  return Object.freeze({
    exitCode,
    stderr: new TextEncoder().encode(stderr),
    stdout: new TextEncoder().encode(stdout),
  });
}

describe("complete workflow-control range", () => {
  test("admits linear and merged product-only histories", () => {
    const linear = fixture();
    writeFileSync(join(linear.repository, "product.txt"), "linear\n", "utf8");
    const linearSha = commit(linear.repository, "linear product");
    expect(verifyWorkflowRange({
      previousSha: linear.oldSha,
      verifiedSha: linearSha,
      workingDirectory: linear.repository,
    })).toMatchObject({
      newCommitCount: 1,
      previousSha: linear.oldSha,
      verifiedSha: linearSha,
    });

    const merged = fixture();
    git(merged.repository, ["switch", "--create", "product-side"]);
    writeFileSync(join(merged.repository, "side.txt"), "side\n", "utf8");
    commit(merged.repository, "side product");
    git(merged.repository, ["switch", "main"]);
    writeFileSync(join(merged.repository, "main.txt"), "main\n", "utf8");
    commit(merged.repository, "main product");
    git(merged.repository, ["merge", "--no-ff", "product-side", "-m", "merge product"]);
    const mergedSha = text(merged.repository, ["rev-parse", "HEAD"]);
    expect(verifyWorkflowRange({
      previousSha: merged.oldSha,
      verifiedSha: mergedSha,
      workingDirectory: merged.repository,
    })).toMatchObject({
      newCommitCount: 3,
      previousSha: merged.oldSha,
      verifiedSha: mergedSha,
    });
  });

  test("rejects workflow add, delete, rename, mode, and content changes", () => {
    const mutations = [
      ["add", (input: Fixture) => {
        writeFileSync(join(input.repository, ".github", "workflows", "added.yml"), "name: added\n", "utf8");
      }],
      ["delete", (input: Fixture) => rmSync(input.workflow)],
      ["rename", (input: Fixture) => {
        renameSync(input.workflow, join(input.repository, ".github", "workflows", "renamed.yml"));
      }],
      ["mode", (input: Fixture) => chmodSync(input.workflow, 0o755)],
      ["edit", (input: Fixture) => writeFileSync(input.workflow, "name: changed\n", "utf8")],
    ] as const;

    for (const [name, mutate] of mutations) {
      const input = fixture();
      mutate(input);
      const verifiedSha = commit(input.repository, `workflow ${name}`);
      expect(() => verifyWorkflowRange({
        previousSha: input.oldSha,
        verifiedSha,
        workingDirectory: input.repository,
      })).toThrow(name === "delete" ? "Workflow tree inventory failed closed" : ".github/workflows");
    }
  });

  test("rejects a workflow touch-and-revert hidden on a merged side branch", () => {
    const input = fixture();
    git(input.repository, ["switch", "--create", "workflow-side"]);
    writeFileSync(input.workflow, "name: transient-change\n", "utf8");
    commit(input.repository, "touch workflow");
    writeFileSync(input.workflow, "name: release\n", "utf8");
    commit(input.repository, "revert workflow");
    git(input.repository, ["switch", "main"]);
    writeFileSync(join(input.repository, "product.txt"), "main product\n", "utf8");
    commit(input.repository, "main product");
    git(input.repository, ["merge", "--no-ff", "workflow-side", "-m", "merge reverted workflow side"]);
    const verifiedSha = text(input.repository, ["rev-parse", "HEAD"]);

    expect(text(input.repository, ["rev-parse", `${input.oldSha}:.github/workflows`]))
      .toBe(text(input.repository, ["rev-parse", `${verifiedSha}:.github/workflows`]));
    expect(() => verifyWorkflowRange({
      previousSha: input.oldSha,
      verifiedSha,
      workingDirectory: input.repository,
    })).toThrow("changes .github/workflows");
  });

  test("fails closed for shallow, incomplete, non-ancestor, and malformed ranges", () => {
    const shallowSource = fixture();
    writeFileSync(join(shallowSource.repository, "product.txt"), "new\n", "utf8");
    const shallowNew = commit(shallowSource.repository, "new");
    const remote = join(shallowSource.root, "remote.git");
    git(shallowSource.root, ["init", "--bare", remote]);
    git(shallowSource.repository, ["remote", "add", "origin", remote]);
    git(shallowSource.repository, ["push", "origin", "main"]);
    const shallow = join(shallowSource.root, "shallow");
    git(shallowSource.root, ["clone", "--depth=1", "--branch", "main", `file://${remote}`, shallow]);
    expect(() => verifyWorkflowRange({
      previousSha: shallowSource.oldSha,
      verifiedSha: shallowNew,
      workingDirectory: shallow,
    })).toThrow("complete, non-shallow Git history");

    const incompleteOld = "1".repeat(40);
    const incompleteNew = "2".repeat(40);
    const incompleteRunner: WorkflowRangeGitRunner = (arguments_) => {
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--is-shallow-repository") {
        return result(0, "false\n");
      }
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--verify") {
        const sha = arguments_[2]?.slice(0, 40) ?? "";
        return result(0, `${sha}\n`);
      }
      if (arguments_[0] === "merge-base") return result(0);
      if (arguments_[0] === "rev-list") return result(128, "", "missing commit object");
      return result(127);
    };
    expect(() => verifyWorkflowRange({
      previousSha: incompleteOld,
      runner: incompleteRunner,
      verifiedSha: incompleteNew,
    })).toThrow("Newly reachable commit inventory failed closed");

    const malformedInventoryRunner: WorkflowRangeGitRunner = (arguments_) => {
      if (arguments_[0] === "rev-list") return result(0, "not-an-object-id\n");
      return incompleteRunner(arguments_);
    };
    expect(() => verifyWorkflowRange({
      previousSha: incompleteOld,
      runner: malformedInventoryRunner,
      verifiedSha: incompleteNew,
    })).toThrow("commit inventory is noncanonical");

    const divergent = fixture();
    git(divergent.repository, ["switch", "--create", "candidate"]);
    writeFileSync(join(divergent.repository, "candidate.txt"), "candidate\n", "utf8");
    const candidateSha = commit(divergent.repository, "candidate");
    git(divergent.repository, ["switch", "main"]);
    writeFileSync(join(divergent.repository, "production.txt"), "production\n", "utf8");
    const currentProductionSha = commit(divergent.repository, "production");
    expect(() => verifyWorkflowRange({
      previousSha: currentProductionSha,
      verifiedSha: candidateSha,
      workingDirectory: divergent.repository,
    })).toThrow("complete fast-forward ancestry");

    let malformedCalls = 0;
    expect(() => verifyWorkflowRange({
      previousSha: "A".repeat(40),
      runner: () => {
        malformedCalls += 1;
        return result(127);
      },
      verifiedSha: "b".repeat(40),
    })).toThrow("previous SHA");
    expect(malformedCalls).toBe(0);
  });

  test("rejects a newly reachable history over the fixed commit bound", () => {
    const commits = Array.from(
      { length: MAXIMUM_WORKFLOW_RANGE_COMMITS + 1 },
      (_, index) => (index + 3).toString(16).padStart(40, "0"),
    );
    const oldSha = "1".repeat(40);
    const verifiedSha = commits.at(-1) as string;
    const runner: WorkflowRangeGitRunner = (arguments_) => {
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--is-shallow-repository") {
        return result(0, "false\n");
      }
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--verify") {
        const sha = arguments_[2]?.slice(0, 40) ?? "";
        return result(0, `${sha}\n`);
      }
      if (arguments_[0] === "merge-base") return result(0);
      if (arguments_[0] === "rev-list") return result(0, `${commits.join("\n")}\n`);
      return result(127);
    };
    expect(() => verifyWorkflowRange({ previousSha: oldSha, runner, verifiedSha }))
      .toThrow(`${String(MAXIMUM_WORKFLOW_RANGE_COMMITS)}-commit bound`);
  });

  test("binds a canonical receipt and models the canary contract", () => {
    const positiveCanary = fixture();
    writeFileSync(join(positiveCanary.repository, "canary.txt"), "non-workflow\n", "utf8");
    const positiveSha = commit(positiveCanary.repository, "positive canary");
    const receipt = verifyWorkflowRange({
      previousSha: positiveCanary.oldSha,
      verifiedSha: positiveSha,
      workingDirectory: positiveCanary.repository,
    });
    const encoded = encodeWorkflowRangeReceipt(receipt);
    expect(decodeWorkflowRangeReceipt(encoded)).toEqual(receipt);
    expect(assertWorkflowRangeReceipt(decodeWorkflowRangeReceipt(encoded), {
      previousSha: positiveCanary.oldSha,
      verifiedSha: positiveSha,
    })).toEqual(receipt);
    expect(() => assertWorkflowRangeReceipt(receipt, {
      previousSha: "f".repeat(40),
      verifiedSha: positiveSha,
    })).toThrow("does not bind");
    for (const malformed of ["", "***", encoded.toUpperCase(), "a".repeat(4 * 1024 + 1)]) {
      expect(() => decodeWorkflowRangeReceipt(malformed)).toThrow();
    }

    const negativeCanary = fixture();
    writeFileSync(negativeCanary.workflow, "name: forbidden-canary-change\n", "utf8");
    const negativeSha = commit(negativeCanary.repository, "negative canary");
    expect(() => verifyWorkflowRange({
      previousSha: negativeCanary.oldSha,
      verifiedSha: negativeSha,
      workingDirectory: negativeCanary.repository,
    })).toThrow("changes .github/workflows");
  });
});

function controlEpochFixture() {
  const input = fixture();
  writeFileSync(input.workflow, "name: control-epoch\n", "utf8");
  const targetSha = commit(input.repository, "workflow control epoch");
  git(input.repository, ["tag", "--annotate", "v1.2.3", "--message", "v1.2.3", targetSha]);
  return Object.freeze({ ...input, targetSha });
}

function productionAdmission(
  input: ReturnType<typeof controlEpochFixture>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    controlEpochDigest: undefined,
    currentMainSha: input.targetSha,
    eventName: "workflow_dispatch",
    eventRef: "refs/heads/main",
    eventSha: input.targetSha,
    githubActions: "true",
    previousSha: input.oldSha,
    protectedRef: "refs/heads/website-production",
    repository: "hraness/textbutler",
    repositoryId: 1_342_143_606,
    runAttempt: 1,
    tag: "v1.2.3",
    targetSha: input.targetSha,
    workflowSha: input.targetSha,
    workingDirectory: input.repository,
    ...overrides,
  } as const;
}

describe("v2 workflow-control epochs", () => {
  test("keeps the frozen v1 decoder and routine semantics separate", () => {
    const input = fixture();
    writeFileSync(join(input.repository, "routine.txt"), "routine\n", "utf8");
    const targetSha = commit(input.repository, "routine");
    git(input.repository, ["tag", "--annotate", "v1.2.3", "--message", "v1.2.3", targetSha]);
    const receipt = verifyWorkflowRange({
      previousSha: input.oldSha,
      verifiedSha: targetSha,
      workingDirectory: input.repository,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "newCommitCount",
      "newCommitDigest",
      "previousSha",
      "productionRef",
      "schema",
      "verifiedSha",
      "workflowTreeOid",
    ]);
    const encoded = encodeWorkflowRangeReceipt(receipt);
    expect(decodeWorkflowRangeReceipt(encoded)).toEqual(receipt);
    expect(decodeWorkflowAdmissionReceipt(encoded)).toEqual(receipt);
    expect(() => verifyProductionWorkflowAdmission({
      ...productionAdmission({ ...input, targetSha }),
      controlEpochDigest: "1".repeat(64),
      tag: "v1.2.3",
    })).toThrow("forbidden for a routine");
  });

  test("binds every production coordinate and emits a distinct v2 receipt", () => {
    const input = controlEpochFixture();
    const described = describeControlEpoch({
      ...productionAdmission(input),
      mode: "production",
    });
    expect(described).toMatchObject({
      domain: "message-like-me/control-epoch/production/v2",
      previousSha: input.oldSha,
      protectedRef: "refs/heads/website-production",
      repositoryId: 1_342_143_606,
      schema: "message-like-me-production-control-epoch-v2",
      tag: "v1.2.3",
      targetSha: input.targetSha,
      workflowSha: input.targetSha,
    });
    expect(described.inventory.map((entry) => entry.commitSha)).toEqual([
      input.oldSha,
      input.targetSha,
    ]);
    expect(described.changes).toHaveLength(1);

    let missing: unknown;
    try {
      verifyProductionWorkflowAdmission(productionAdmission(input));
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(ControlEpochAdmissionError);
    expect((missing as ControlEpochAdmissionError).receipt).toEqual(described);

    const expectedTransition = {
      previousSha: input.oldSha,
      tag: "v1.2.3",
      targetSha: input.targetSha,
      workflowSha: input.targetSha,
    } as const;
    const accepted = assertProductionControlEpochReceipt(
      verifyProductionWorkflowAdmission(productionAdmission(input, {
        controlEpochDigest: described.digest,
      })),
      expectedTransition,
    );
    expect(accepted).toEqual(described);
    const encoded = encodeControlEpochReceipt(accepted);
    expect(decodeControlEpochReceipt(encoded)).toEqual(accepted);
    expect(encodeWorkflowAdmissionReceipt(accepted)).toBe(encoded);
    expect(decodeWorkflowAdmissionReceipt(encoded)).toEqual(accepted);
    expect(assertProductionControlEpochReceipt(accepted, expectedTransition)).toEqual(accepted);
    expect(() => decodeWorkflowRangeReceipt(encoded)).toThrow();
  });

  test("inventories through a newer workflow source while binding an older release target", () => {
    const input = controlEpochFixture();
    writeFileSync(input.workflow, "name: later-control-source\n", "utf8");
    const workflowSha = commit(input.repository, "later workflow control source");
    const admission = productionAdmission(input, {
      currentMainSha: workflowSha,
      eventSha: workflowSha,
      workflowSha,
    });
    const described = describeControlEpoch({ ...admission, mode: "production" });

    expect(described.targetSha).toBe(input.targetSha);
    expect(described.workflowSha).toBe(workflowSha);
    expect(described.inventory.map((entry) => entry.commitSha)).toEqual([
      input.oldSha,
      input.targetSha,
      workflowSha,
    ]);
    expect(described.changes.map((entry) => entry.commitSha)).toEqual([
      input.targetSha,
      workflowSha,
    ]);
    expect(verifyProductionWorkflowAdmission({
      ...admission,
      controlEpochDigest: described.digest,
    })).toEqual(described);
  });

  test("requires a digest when only the newer executing workflow source changes controls", () => {
    const input = fixture();
    writeFileSync(join(input.repository, "release.txt"), "product release\n", "utf8");
    const targetSha = commit(input.repository, "product-only release target");
    git(input.repository, ["tag", "--annotate", "v1.2.3", "--message", "v1.2.3", targetSha]);
    writeFileSync(input.workflow, "name: post-release-control-source\n", "utf8");
    const workflowSha = commit(input.repository, "post-release workflow control source");
    const admission = productionAdmission({ ...input, targetSha }, {
      currentMainSha: workflowSha,
      eventSha: workflowSha,
      workflowSha,
    });

    let rejected: unknown;
    try {
      verifyProductionWorkflowAdmission(admission);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(ControlEpochAdmissionError);
    expect((rejected as ControlEpochAdmissionError).receipt).toMatchObject({
      previousSha: input.oldSha,
      targetSha,
      workflowSha,
    });
    expect((rejected as ControlEpochAdmissionError).receipt.inventory.map((entry) => entry.commitSha))
      .toEqual([input.oldSha, targetSha, workflowSha]);
    expect((rejected as ControlEpochAdmissionError).receipt.changes.map((entry) => entry.commitSha))
      .toEqual([workflowSha]);
  });

  test("persists the rejected CLI review before exact-digest attempt-1 admission", () => {
    const input = controlEpochFixture();
    const output = join(input.root, "github-output.txt");
    const summary = join(input.root, "github-summary.md");
    writeFileSync(output, "", "utf8");
    writeFileSync(summary, "", "utf8");
    const script = join(import.meta.dir, "release-workflow-range.mjs");
    const environment = {
      ...process.env,
      CONTROL_EPOCH_DIGEST: "",
      CURRENT_MAIN_SHA: input.targetSha,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_OUTPUT: output,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "hraness/textbutler",
      GITHUB_REPOSITORY_ID: "1342143606",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: input.targetSha,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_WORKFLOW_SHA: input.targetSha,
      VERIFIED_TAG: "v1.2.3",
    };
    const invoke = (digest: string) => spawnSync(
      process.execPath,
      [script, input.oldSha, input.targetSha, "--admit-production"],
      {
        cwd: input.repository,
        encoding: "utf8",
        env: { ...environment, CONTROL_EPOCH_DIGEST: digest },
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    const outputValue = (body: string, name: string) => body
      .split("\n")
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1);

    const rejected = invoke("");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("exact reviewed control-epoch digest");
    const rejectedOutput = readFileSync(output, "utf8");
    const digest = outputValue(rejectedOutput, "control_epoch_digest");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(outputValue(rejectedOutput, "control_epoch_old_sha")).toBe(input.oldSha);
    expect(outputValue(rejectedOutput, "control_epoch_target_sha")).toBe(input.targetSha);
    expect(outputValue(rejectedOutput, "control_epoch_workflow_sha")).toBe(input.targetSha);
    expect(JSON.parse(outputValue(rejectedOutput, "control_epoch_inventory") ?? "null"))
      .toHaveLength(2);
    expect(outputValue(rejectedOutput, "receipt")).toBeUndefined();
    expect(readFileSync(summary, "utf8")).toContain(`Control epoch ${String(digest)}`);
    expect(git(input.repository, ["status", "--short"]).byteLength).toBe(0);

    writeFileSync(output, "", "utf8");
    writeFileSync(summary, "", "utf8");
    const accepted = invoke(String(digest));
    expect(accepted.status).toBe(0);
    const acceptedOutput = readFileSync(output, "utf8");
    const encoded = outputValue(acceptedOutput, "receipt");
    expect(encoded).toBeDefined();
    expect(decodeWorkflowAdmissionReceipt(encoded)).toMatchObject({
      digest,
      previousSha: input.oldSha,
      targetSha: input.targetSha,
      workflowSha: input.targetSha,
    });
    expect(readFileSync(summary, "utf8")).toContain("Changed from preceding row");
    expect(git(input.repository, ["status", "--short"]).byteLength).toBe(0);
  });

  test("domain-separates canary with an explicit no-tag sentinel", () => {
    const input = controlEpochFixture();
    const base = productionAdmission(input);
    const canary = describeControlEpoch({
      ...base,
      mode: "canary",
      protectedRef: "refs/heads/website-production-writer-canary",
      tag: CONTROL_EPOCH_CANARY_NO_TAG,
    });
    const production = describeControlEpoch({ ...base, mode: "production" });
    expect(canary).toMatchObject({
      domain: "message-like-me/control-epoch/canary/v2",
      protectedRef: "refs/heads/website-production-writer-canary",
      schema: "message-like-me-canary-control-epoch-v2",
      tag: "no-tag",
    });
    expect(canary.digest).not.toBe(production.digest);
    const accepted = verifyCanaryWorkflowAdmission({
      ...base,
      controlEpochDigest: canary.digest,
      protectedRef: "refs/heads/website-production-writer-canary",
      tag: CONTROL_EPOCH_CANARY_NO_TAG,
    });
    expect(assertCanaryControlEpochReceipt(accepted, {
      previousSha: input.oldSha,
      targetSha: input.targetSha,
      workflowSha: input.targetSha,
    })).toEqual(canary);
  });

  test("rejects digest and execution-boundary substitution before authority", () => {
    const input = controlEpochFixture();
    const receipt = describeControlEpoch({ ...productionAdmission(input), mode: "production" });
    for (const overrides of [
      { controlEpochDigest: "0".repeat(64) },
      { controlEpochDigest: receipt.digest, eventName: "workflow_run" },
      { controlEpochDigest: receipt.digest, eventRef: "refs/heads/not-main" },
      { controlEpochDigest: receipt.digest, eventSha: "1".repeat(40) },
      { controlEpochDigest: receipt.digest, githubActions: "false" },
      { controlEpochDigest: receipt.digest, runAttempt: 2 },
    ]) {
      expect(() => verifyProductionWorkflowAdmission(productionAdmission(input, overrides))).toThrow();
    }
    expect(() => describeControlEpoch({
      ...productionAdmission(input),
      mode: "production",
      currentMainSha: "1".repeat(40),
    })).toThrow("drifted");
    expect(() => describeControlEpoch({
      ...productionAdmission(input),
      mode: "canary",
    })).toThrow("protected ref");
    expect(() => describeControlEpoch({
      ...productionAdmission(input),
      mode: "production",
      repositoryId: 1,
    })).toThrow("1342143606");
    expect(() => verifyProductionWorkflowAdmission(productionAdmission(input, {
      controlEpochDigest: receipt.digest,
      previousSha: input.targetSha,
    }))).toThrow("advancing transition");
  });

  test("rejects wrong tag, old, target, inventory, and digest in decoded receipts", () => {
    const input = controlEpochFixture();
    const receipt = describeControlEpoch({ ...productionAdmission(input), mode: "production" });
    expect(() => assertProductionControlEpochReceipt(receipt, {
      previousSha: "1".repeat(40),
      tag: receipt.tag,
      targetSha: receipt.targetSha,
      workflowSha: receipt.workflowSha,
    })).toThrow("does not bind");
    expect(() => assertProductionControlEpochReceipt(receipt, {
      previousSha: receipt.previousSha,
      tag: "v9.9.9",
      targetSha: receipt.targetSha,
      workflowSha: receipt.workflowSha,
    })).toThrow("does not bind");
    const mutations = [
      { ...receipt, digest: "0".repeat(64) },
      { ...receipt, domain: "message-like-me/control-epoch/canary/v2" },
      { ...receipt, protectedRef: "refs/heads/website-production-writer-canary" },
      { ...receipt, repositoryId: 1 },
      { ...receipt, targetSha: "2".repeat(40) },
      { ...receipt, workflowSha: "3".repeat(40) },
      {
        ...receipt,
        inventory: receipt.inventory.map((entry, index) => index === 1
          ? { ...entry, workflowTreeOid: "4".repeat(40) }
          : entry),
      },
    ];
    for (const mutation of mutations) {
      const encoded = Buffer.from(JSON.stringify(mutation), "utf8").toString("base64url");
      expect(() => decodeControlEpochReceipt(encoded)).toThrow();
    }
  });
});
