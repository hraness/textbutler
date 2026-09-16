import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advanceWebsiteProductionRef,
  parseWebsiteProductionCanaryRequiredStatusDenial,
  parseWebsiteProductionRequiredStatusDenial,
  proveWebsiteProductionCanaryStaleLease,
  verifiedReleaseFetchArguments,
  websiteProductionPushArguments,
} from "./release-ref-writer.mjs";

const previousSha = "1".repeat(40);
const verifiedSha = "2".repeat(40);
const verifiedTag = "v0.8.0";
const token = "ghs_private-release-token-value";
const exactBareRepositoryConfigEntries = [
  "core.repositoryformatversion\n0",
  "core.filemode\ntrue",
  "core.bare\ntrue",
];
const sterileRepositoryConfig = (...entries: readonly string[]) => [
  ...exactBareRepositoryConfigEntries,
  ...entries,
  "",
].join("\0");
const exactBareRepositoryConfig = sterileRepositoryConfig();
const exactAppleBareRepositoryConfig = sterileRepositoryConfig(
  "core.ignorecase\ntrue",
  "core.precomposeunicode\ntrue",
);

function gitResult(
  stdout = "",
  status = 0,
  stderr = "",
) {
  return {
    error: undefined,
    signal: null,
    status,
    stderr,
    stdout,
  } as never;
}

function sterileBootstrapResult(call: number) {
  if (call === 1) return gitResult();
  if (call === 2) return gitResult(exactBareRepositoryConfig);
  return undefined;
}

function requiredStatusError(
  writerLabel: string,
  protectedRef: string,
  context: string,
  state = "errored.",
  gitDisplaySuffix = "",
) {
  return new Error([
    `${writerLabel} failed: remote: error: GH013: Repository rule violations found for ${protectedRef}.${gitDisplaySuffix}`,
    `remote: Review all repository rules at https://github.com/hraness/textbutler/rules?ref=refs%2Fheads%2Fmain${gitDisplaySuffix}`,
    "remote:",
    `remote: - Required status check "${context}" is ${state}${gitDisplaySuffix}`,
    "remote:",
    "error: failed to push some refs to 'https://github.com/hraness/textbutler.git'",
  ].join("\n"));
}

function alternateTransportRequiredStatusError(protectedRef: string, context: string) {
  return new Error([
    "website-production writer invocation failed: remote: Enumerating objects: 1, done.",
    "remote: Review all repository rules before retrying this push.",
    `git transport: remote: error: GH013: Repository rule violations found for ${protectedRef}.`,
    "remote: diagnostic transport trailer",
    `remote: - Required status check "${context}" is errored.`,
    "error: failed to push some refs to 'https://github.com/hraness/textbutler.git'",
  ].join("\n"));
}

describe("required-status-errored GitHub denial", () => {
  const canaryLabel = "website-production writer canary Git push";
  const canaryRef = "refs/heads/website-production-writer-canary";
  const canaryContext = "message-like-me/website-production-writer-canary-authority";
  const productionLabel = "website-production Git push";
  const productionRef = "refs/heads/website-production";
  const productionContext = "message-like-me/website-production-authority";

  test("accepts only GitHub's exact errored required-status reason for each protected ref", () => {
    expect(parseWebsiteProductionCanaryRequiredStatusDenial(
      requiredStatusError(canaryLabel, canaryRef, canaryContext),
    )).toEqual({
      classification: "required-status-errored",
      diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseWebsiteProductionRequiredStatusDenial(
      requiredStatusError(productionLabel, productionRef, productionContext),
    )).toEqual({
      classification: "required-status-errored",
      diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("accepts the exact semantic denial across mutable Git transport framing", () => {
    expect(parseWebsiteProductionCanaryRequiredStatusDenial(
      alternateTransportRequiredStatusError(canaryRef, canaryContext),
    )).toEqual({
      classification: "required-status-errored",
      diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseWebsiteProductionRequiredStatusDenial(
      alternateTransportRequiredStatusError(productionRef, productionContext),
    )).toEqual({
      classification: "required-status-errored",
      diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("accepts only Git's known non-TTY display suffixes without changing the semantic proof", () => {
    for (const gitDisplaySuffix of [" ", "        "] as const) {
      const canaryError = requiredStatusError(
        canaryLabel,
        canaryRef,
        canaryContext,
        "errored.",
        gitDisplaySuffix,
      );
      expect(parseWebsiteProductionCanaryRequiredStatusDenial(canaryError)).toEqual({
        classification: "required-status-errored",
        diagnosticSha256: createHash("sha256").update(canaryError.message, "utf8").digest("hex"),
      });
      expect(parseWebsiteProductionRequiredStatusDenial(
        requiredStatusError(productionLabel, productionRef, productionContext, "errored.", gitDisplaySuffix),
      )).toEqual({
        classification: "required-status-errored",
        diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });

  test("rejects every other trailing transport mutation", () => {
    for (const suffix of [
      "  ",
      "       ",
      "         ",
      "                ",
      "\t",
      "\u00a0",
      "\u001b[K",
      " trailing prose",
      " trailing prose        ",
    ] as const) {
      expect(() => parseWebsiteProductionCanaryRequiredStatusDenial(
        requiredStatusError(canaryLabel, canaryRef, canaryContext, "errored.", suffix),
      )).toThrow(
        "writer canary push failure is not the exact required-status-errored ruleset denial",
      );
      expect(() => parseWebsiteProductionRequiredStatusDenial(
        requiredStatusError(productionLabel, productionRef, productionContext, "errored.", suffix),
      )).toThrow(
        "production push failure is not the exact required-status-errored ruleset denial",
      );
    }

    const exact = requiredStatusError(canaryLabel, canaryRef, canaryContext).message;
    const violation = `GH013: Repository rule violations found for ${canaryRef}.`;
    const reason = `remote: - Required status check "${canaryContext}" is errored.`;
    for (const [violationSuffix, reasonSuffix] of [
      ["        ", ""],
      ["", " "],
      [" ", "        "],
      ["        ", " "],
    ] as const) {
      expect(() => parseWebsiteProductionCanaryRequiredStatusDenial(
        new Error(exact
          .replace(violation, `${violation}${violationSuffix}`)
          .replace(reason, `${reason}${reasonSuffix}`)),
      )).toThrow(
        "writer canary push failure is not the exact required-status-errored ruleset denial",
      );
    }
  });

  test("rejects old, ambiguous, duplicated, or differently bound GitHub denial prose", () => {
    const exactCanary = requiredStatusError(canaryLabel, canaryRef, canaryContext).message;
    const canaryViolation = `GH013: Repository rule violations found for ${canaryRef}.`;
    const canaryReason = `remote: - Required status check "${canaryContext}" is errored.`;
    const rejectedCanary = [
      requiredStatusError(canaryLabel, canaryRef, canaryContext, "expected."),
      requiredStatusError(canaryLabel, productionRef, canaryContext),
      requiredStatusError(canaryLabel, canaryRef, productionContext),
      requiredStatusError(canaryLabel, canaryRef, canaryContext, "pending."),
      requiredStatusError(canaryLabel, canaryRef, canaryContext, "errored"),
      new Error(requiredStatusError(canaryLabel, canaryRef, canaryContext).message.replace("GH013: ", "")),
      new Error(`${exactCanary}\nremote: error: ${canaryViolation}`),
      new Error(exactCanary.replace(canaryViolation, `GH013: ambiguous ${canaryViolation}`)),
      new Error(exactCanary.replace(canaryViolation, `${canaryViolation} trailing prose`)),
      new Error(`${exactCanary}\nremote: - Required status check "another/context" is errored.`),
      new Error(`${exactCanary}\n${canaryReason}`),
      new Error(`${exactCanary}\nremote: - Changes must be made through a pull request.`),
      new Error(exactCanary.replace(
        canaryReason,
        `${canaryReason}\nremote: diagnostic says Required status check "another/context" is errored.`,
      )),
    ];
    for (const error of rejectedCanary) {
      expect(() => parseWebsiteProductionCanaryRequiredStatusDenial(error)).toThrow(
        "writer canary push failure is not the exact required-status-errored ruleset denial",
      );
    }

    expect(() => parseWebsiteProductionRequiredStatusDenial(
      requiredStatusError(productionLabel, canaryRef, productionContext),
    )).toThrow("production push failure is not the exact required-status-errored ruleset denial");
  });
});

describe("website-production Git writer", () => {
  test("preserves Git's known sideband suffix through the bounded failure wrapper", () => {
    const protectedRef = "refs/heads/website-production";
    const context = "message-like-me/website-production-authority";
    const writerLabel = "website-production Git push";
    const wrapped = requiredStatusError(
      writerLabel,
      protectedRef,
      context,
      "errored.",
      "        ",
    );
    const stderr = wrapped.message.slice(`${writerLabel} failed: `.length);
    let calls = 0;
    let denial: unknown;
    try {
      advanceWebsiteProductionRef({
        environment: { MLM_RELEASE_REF_TOKEN: token },
        expectedOldSha: previousSha,
        repository: "hraness/textbutler",
        spawnImplementation() {
          calls += 1;
          const bootstrap = sterileBootstrapResult(calls);
          if (bootstrap !== undefined) return bootstrap;
          if (calls === 4) return gitResult(`${verifiedSha}\n`);
          if (calls === 6) return gitResult("", 1, stderr);
          return gitResult();
        },
        verifiedSha,
        verifiedTag,
      });
    } catch (error) {
      denial = parseWebsiteProductionRequiredStatusDenial(error);
    }
    expect(calls).toBe(6);
    expect(denial).toEqual({
      classification: "required-status-errored",
      diagnosticSha256: createHash("sha256").update(wrapped.message, "utf8").digest("hex"),
    });
  });

  test("does not erase an unknown suffix at the terminal stderr boundary", () => {
    const protectedRef = "refs/heads/website-production";
    const context = "message-like-me/website-production-authority";
    const stderr = [
      `remote: error: GH013: Repository rule violations found for ${protectedRef}.`,
      `remote: - Required status check "${context}" is errored.  `,
      "",
    ].join("\n");
    let calls = 0;
    let failure: unknown;
    try {
      advanceWebsiteProductionRef({
        environment: { MLM_RELEASE_REF_TOKEN: token },
        expectedOldSha: previousSha,
        repository: "hraness/textbutler",
        spawnImplementation() {
          calls += 1;
          const bootstrap = sterileBootstrapResult(calls);
          if (bootstrap !== undefined) return bootstrap;
          if (calls === 4) return gitResult(`${verifiedSha}\n`);
          if (calls === 6) return gitResult("", 1, stderr);
          return gitResult();
        },
        verifiedSha,
        verifiedTag,
      });
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(6);
    expect(() => parseWebsiteProductionRequiredStatusDenial(failure)).toThrow(
      "production push failure is not the exact required-status-errored ruleset denial",
    );
  });

  test("builds one fixed refspec with one nonempty exact explicit lease", () => {
    const arguments_ = websiteProductionPushArguments(previousSha, verifiedSha);
    expect(arguments_).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "http.extraHeader=",
      "-c",
      "http.sslVerify=true",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.proxy=",
      "-c",
      "push.followTags=false",
      "-c",
      "push.gpgSign=false",
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/website-production:${previousSha}`,
      "--no-follow-tags",
      "--no-tags",
      "--no-signed",
      "--no-verify",
      "--recurse-submodules=no",
      "https://github.com/hraness/textbutler.git",
      `${verifiedSha}:refs/heads/website-production`,
    ]);
    expect(arguments_.filter((value) => value.startsWith("--force-with-lease="))).toHaveLength(1);
    expect(arguments_.filter((value) => value.endsWith(":refs/heads/website-production")))
      .toEqual([`${verifiedSha}:refs/heads/website-production`]);
    expect(arguments_).not.toContain("--force");
    expect(arguments_.join(" ")).not.toContain("*");
    expect(arguments_.join(" ")).not.toContain(" :refs/heads/website-production");
  });

  test("fetches only one exact stable tag without following tags or submodules", () => {
    expect(verifiedReleaseFetchArguments(verifiedTag)).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "http.extraHeader=",
      "-c",
      "http.sslVerify=true",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.proxy=",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=251",
      "https://github.com/hraness/textbutler.git",
      "refs/tags/v0.8.0",
    ]);
    for (const value of ["", "0.8.0", "v01.2.3", "v1.2", "v1.2.3\nmain"] as const) {
      expect(() => verifiedReleaseFetchArguments(value)).toThrow(
        "verified release tag is not one stable semantic-version tag",
      );
    }
  });

  test("uses one sterile repository despite caller Git config poisoning", async () => {
    let askpassPath = "";
    let askpass = "";
    let sterileRoot = "";
    const calls: Array<Readonly<{
      arguments: readonly string[];
      cwd: string;
      environment: Readonly<Record<string, string>>;
    }>> = [];
    const receipt = advanceWebsiteProductionRef({
      environment: {
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_GLOBAL: "/caller/poisoned-global-config",
        GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
        GIT_CONFIG_KEY_1: "url.https://attacker.invalid/.pushInsteadOf",
        GIT_CONFIG_KEY_2: "http.sslVerify",
        GIT_CONFIG_VALUE_0: "https://github.com/",
        GIT_CONFIG_VALUE_1: "https://github.com/",
        GIT_CONFIG_VALUE_2: "false",
        GIT_DIR: "/caller/poisoned.git",
        HOME: "/caller/poisoned-home",
        MLM_RELEASE_REF_TOKEN: token,
      },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation(command, arguments_, options) {
        expect(command).toBe("/usr/bin/git");
        expect(arguments_.join(" ")).not.toContain(token);
        expect(arguments_.join(" ")).not.toContain("MLM_RELEASE_REF_TOKEN");
        expect(arguments_.join(" ")).not.toContain("attacker.invalid");
        expect(options.encoding).toBe("utf8");
        expect(options.killSignal).toBe("SIGKILL");
        expect(options.maxBuffer).toBe(4096);
        expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
        expect(options.timeout).toBe(60_000);
        const cwd = String(options.cwd);
        const environment = options.env as Readonly<Record<string, string>>;
        calls.push({ arguments: [...arguments_], cwd, environment });
        if (calls.length === 1) {
          sterileRoot = cwd;
          askpassPath = join(sterileRoot, "askpass.sh");
          askpass = readFileSync(askpassPath, "utf8");
          expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
        } else {
          expect(cwd).toBe(sterileRoot);
        }
        const bootstrap = calls.length === 2
          ? gitResult(exactAppleBareRepositoryConfig)
          : sterileBootstrapResult(calls.length);
        if (bootstrap !== undefined) return bootstrap;
        if (calls.length === 4) return gitResult(`${verifiedSha}\n`);
        if (calls.length === 5) return gitResult();
        return gitResult(
          `To https://github.com/hraness/textbutler.git\n \t${verifiedSha}:refs/heads/website-production\t${previousSha.slice(0, 7)}..${verifiedSha.slice(0, 7)}\nDone\n`,
        );
      },
      verifiedSha,
      verifiedTag,
    });

    expect(calls.map((call) => call.arguments)).toEqual([
      [
        "-c",
        "init.defaultBranch=main",
        "init",
        "--bare",
        "--object-format=sha1",
        `--template=${join(sterileRoot, "empty-template")}`,
        join(sterileRoot, "repository.git"),
      ],
      ["config", "--local", "--null", "--list"],
      verifiedReleaseFetchArguments(verifiedTag),
      ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-base",
        "--is-ancestor",
        previousSha,
        verifiedSha,
      ],
      websiteProductionPushArguments(previousSha, verifiedSha),
    ]);
    expect(askpass).toContain("x-access-token");
    expect(askpass).toContain('"$MLM_RELEASE_REF_TOKEN"');
    expect(askpass).not.toContain(token);
    const bootstrapEnvironment = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    };
    const commonEnvironment = {
      GIT_ALLOW_PROTOCOL: "https",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_DIR: join(sterileRoot, "repository.git"),
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    };
    const authenticatedEnvironment = {
      ...commonEnvironment,
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      MLM_RELEASE_REF_TOKEN: token,
    };
    expect(calls.map((call) => call.cwd)).toEqual(Array(6).fill(sterileRoot));
    expect(calls[0]?.environment).toEqual(bootstrapEnvironment);
    expect(calls[1]?.environment).toEqual(commonEnvironment);
    expect(calls[2]?.environment).toEqual(authenticatedEnvironment);
    expect(calls[3]?.environment).toEqual(commonEnvironment);
    expect(calls[4]?.environment).toEqual(commonEnvironment);
    expect(calls[5]?.environment).toEqual(authenticatedEnvironment);
    for (const call of calls) {
      expect(Object.keys(call.environment).some((key) => key.startsWith("GIT_CONFIG_KEY_")))
        .toBe(false);
      expect(call.environment.GIT_CONFIG_COUNT).toBeUndefined();
      expect(call.environment.HOME).toBeUndefined();
    }
    expect(receipt).toEqual({
      classification: "fast-forward",
      fromSha: previousSha,
      protectedRef: "refs/heads/website-production",
      summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      toSha: verifiedSha,
    });
    expect(await Bun.file(askpassPath).exists()).toBe(false);
  });

  test("accepts only the exact optional Git filesystem probe values", () => {
    const accepted = [
      sterileRepositoryConfig("core.ignorecase\ntrue"),
      sterileRepositoryConfig("core.precomposeunicode\ntrue"),
      sterileRepositoryConfig("core.precomposeunicode\nfalse"),
      sterileRepositoryConfig("core.ignorecase\ntrue", "core.precomposeunicode\nfalse"),
    ];
    for (const config of accepted) {
      let calls = 0;
      const receipt = advanceWebsiteProductionRef({
        environment: { MLM_RELEASE_REF_TOKEN: token },
        expectedOldSha: previousSha,
        repository: "hraness/textbutler",
        spawnImplementation() {
          calls += 1;
          if (calls === 1) return gitResult();
          if (calls === 2) return gitResult(config);
          if (calls === 4) return gitResult(`${verifiedSha}\n`);
          if (calls === 5) return gitResult();
          return gitResult(
            `To https://github.com/hraness/textbutler.git\n \t${verifiedSha}:refs/heads/website-production\t${previousSha.slice(0, 7)}..${verifiedSha.slice(0, 7)}\nDone\n`,
          );
        },
        verifiedSha,
        verifiedTag,
      });
      expect(calls).toBe(6);
      expect(receipt.classification).toBe("fast-forward");
    }

    for (const config of [
      sterileRepositoryConfig("core.ignorecase\nfalse"),
      sterileRepositoryConfig("core.ignorecase\nTRUE"),
      sterileRepositoryConfig("core.precomposeunicode\nmaybe"),
      sterileRepositoryConfig("core.precomposeunicode\n"),
    ]) {
      let calls = 0;
      expect(() => advanceWebsiteProductionRef({
        environment: { MLM_RELEASE_REF_TOKEN: token },
        expectedOldSha: previousSha,
        repository: "hraness/textbutler",
        spawnImplementation() {
          calls += 1;
          return calls === 1 ? gitResult() : gitResult(config);
        },
        verifiedSha,
        verifiedTag,
      })).toThrow("sterile release-writer repository config is not exact");
      expect(calls).toBe(2);
    }
  });

  test("accepts this host Git's fresh bare repository config before mocked remote calls", () => {
    let calls = 0;
    let inspectedConfig = "";
    const receipt = advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation(command, arguments_, options) {
        calls += 1;
        if (calls <= 2) {
          const result = spawnSync(command, arguments_, options);
          if (calls === 2) inspectedConfig = result.stdout;
          return result;
        }
        if (calls === 4) return gitResult(`${verifiedSha}\n`);
        if (calls === 3 || calls === 5) return gitResult();
        return gitResult(
            `To https://github.com/hraness/textbutler.git\n \t${verifiedSha}:refs/heads/website-production\t${previousSha.slice(0, 7)}..${verifiedSha.slice(0, 7)}\nDone\n`,
        );
      },
      verifiedSha,
      verifiedTag,
    });
    expect(calls).toBe(6);
    expect(inspectedConfig).toContain("core.repositoryformatversion\n0\0");
    expect(inspectedConfig).toContain("core.bare\ntrue\0");
    expect(receipt.classification).toBe("fast-forward");
  });

  test("rejects repeated Git filesystem probe keys", () => {
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation() {
        calls += 1;
        return calls === 1
          ? gitResult()
          : gitResult(sterileRepositoryConfig(
            "core.ignorecase\ntrue",
            "core.ignorecase\ntrue",
          ));
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("sterile release-writer repository config repeats a key");
    expect(calls).toBe(2);
  });

  test("rejects any unexpected entry in the sterile repository config", () => {
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation(_command, arguments_) {
        calls += 1;
        if (calls === 1) return gitResult();
        expect(arguments_).toEqual(["config", "--local", "--null", "--list"]);
        return gitResult([
          exactBareRepositoryConfig,
          "url.https://attacker.invalid/.insteadof\nhttps://github.com/",
          "",
        ].join("\0"));
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("sterile release-writer repository config is not exact");
    expect(calls).toBe(2);
  });

  test("rejects an exit-zero up-to-date race instead of claiming this writer advanced the ref", () => {
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation() {
        calls += 1;
        const bootstrap = sterileBootstrapResult(calls);
        if (bootstrap !== undefined) return bootstrap;
        if (calls === 3) return gitResult();
        if (calls === 4) return gitResult(`${verifiedSha}\n`);
        if (calls === 5) return gitResult();
        if (calls === 6) {
          return gitResult(
            `To https://github.com/hraness/textbutler.git\n=\t${verifiedSha}:refs/heads/website-production\t[up to date]\nDone\n`,
          );
        }
        return gitResult();
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("was not one attributable fast-forward update");
    expect(calls).toBe(6);
  });

  test("rejects bare, empty, remote-tracking, wildcard, creation, deletion, and multi-ref shapes", () => {
    for (const value of ["", "0".repeat(39), "A".repeat(40), "refs/remotes/origin/main", "*"] as const) {
      expect(() => websiteProductionPushArguments(value, verifiedSha)).toThrow(
        "expected website-production SHA is not one exact lowercase SHA",
      );
    }
    expect(() => websiteProductionPushArguments(previousSha, "")).toThrow(
      "verified release SHA is not one exact lowercase SHA",
    );
    expect(() => websiteProductionPushArguments(previousSha, previousSha)).toThrow(
      "website-production is already exact",
    );
  });

  test("rejects a fetched tag that peels to another commit before push", () => {
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation() {
        calls += 1;
        const bootstrap = sterileBootstrapResult(calls);
        if (bootstrap !== undefined) return bootstrap;
        return gitResult(calls === 4 ? `${"3".repeat(40)}\n` : "");
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("fetched release tag does not peel to the verified release SHA");
    expect(calls).toBe(4);
  });

  test("rejects a release target that is not a proven descendant before push", () => {
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation(_command, arguments_) {
        calls += 1;
        const bootstrap = sterileBootstrapResult(calls);
        if (bootstrap !== undefined) return bootstrap;
        if (calls === 3) return gitResult();
        if (calls === 4) return gitResult(`${verifiedSha}\n`);
        if (arguments_.includes("merge-base")) return gitResult("", 1);
        throw new Error("production push must remain unreachable");
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("website-production fast-forward ancestry failed");
    expect(calls).toBe(5);
  });

  test("redacts token-bearing push failures and leaves no askpass material", async () => {
    let askpassPath = "";
    let calls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { MLM_RELEASE_REF_TOKEN: token },
      expectedOldSha: previousSha,
      repository: "hraness/textbutler",
      spawnImplementation(_command, _arguments, options) {
        calls += 1;
        if (calls === 1) askpassPath = join(String(options.cwd), "askpass.sh");
        const bootstrap = sterileBootstrapResult(calls);
        if (bootstrap !== undefined) return bootstrap;
        if (calls === 3) return gitResult();
        if (calls === 4) return gitResult(`${verifiedSha}\n`);
        if (calls === 5) return gitResult();
        return gitResult("", 1, `stale info accidentally contained ${token}`);
      },
      verifiedSha,
      verifiedTag,
    })).toThrow("stale info accidentally contained [redacted]");
    expect(calls).toBe(6);
    expect(await Bun.file(askpassPath).exists()).toBe(false);
  });
});

describe("website-production canary stale lease", () => {
  test("binds the real porcelain stale-info stream instead of relying on stderr prose", () => {
    let calls = 0;
    const currentSha = "3".repeat(40);
    const receipt = proveWebsiteProductionCanaryStaleLease({
      currentSha,
      environment: { MLM_RELEASE_REF_TOKEN: token },
      repository: "hraness/textbutler",
      spawnImplementation(_command, arguments_) {
        calls += 1;
        const bootstrap = sterileBootstrapResult(calls);
        if (bootstrap !== undefined) return bootstrap;
        if (calls === 5 || calls === 6) return gitResult(`${currentSha}\n`);
        if (calls === 8) return gitResult(`${previousSha}\n`);
        if (calls === 10) {
          expect(arguments_).toContain("--porcelain");
          return gitResult(
            `To https://github.com/hraness/textbutler.git\n!\t${previousSha}:refs/heads/website-production-writer-canary\t[rejected] (stale info)\nDone\n`,
            1,
            "error: failed to push some refs to 'https://github.com/hraness/textbutler.git'\n",
          );
        }
        return gitResult();
      },
      staleExpectedSha: previousSha,
    });
    expect(receipt).toEqual({
      classification: "stale-info",
      diagnosticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(calls).toBe(10);
  });
});

describe("explicit lease integration", () => {
  test("a stale expected-old lease rejects without mutating the remote ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-ref-lease-"));
    const remote = join(directory, "remote.git");
    const source = join(directory, "source");
    const run = (arguments_: readonly string[], cwd = source) => {
      const result = Bun.spawnSync(["git", ...arguments_], { cwd, stderr: "pipe", stdout: "pipe" });
      return Object.freeze({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      });
    };
    const checked = (arguments_: readonly string[], cwd = source) => {
      const result = run(arguments_, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };

    try {
      checked(["init", "--bare", remote], directory);
      checked(["init", source], directory);
      checked(["config", "user.name", "Message Like Me test"]);
      checked(["config", "user.email", "test@example.invalid"]);
      const file = join(source, "value.txt");
      await writeFile(file, "one\n", "utf8");
      checked(["add", "value.txt"]);
      checked(["commit", "-m", "one"]);
      const first = checked(["rev-parse", "HEAD"]);
      checked(["push", remote, `${first}:refs/heads/website-production`]);

      await writeFile(file, "two\n", "utf8");
      checked(["commit", "-am", "two"]);
      const second = checked(["rev-parse", "HEAD"]);
      const firstArguments = websiteProductionPushArguments(first, second).map((value) =>
        value === "https://github.com/hraness/textbutler.git" ? remote : value
      );
      checked(firstArguments);
      expect(checked(["--git-dir", remote, "rev-parse", "refs/heads/website-production"], directory))
        .toBe(second);

      await writeFile(file, "three\n", "utf8");
      checked(["commit", "-am", "three"]);
      const third = checked(["rev-parse", "HEAD"]);
      const staleArguments = websiteProductionPushArguments(first, third).map((value) =>
        value === "https://github.com/hraness/textbutler.git" ? remote : value
      );
      const stale = run(staleArguments);
      expect(stale.exitCode).not.toBe(0);
      expect(`${stale.stdout}${stale.stderr}`).toContain("failed to push some refs");
      expect(checked(["--git-dir", remote, "rev-parse", "refs/heads/website-production"], directory))
        .toBe(second);
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("exact release tag fetch integration", () => {
  test("imports only the annotated tag commit into FETCH_HEAD without moving workflow HEAD", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-tag-fetch-"));
    const remote = join(directory, "remote.git");
    const source = join(directory, "source");
    const checkout = join(directory, "checkout");
    const run = (arguments_: readonly string[], cwd: string) => {
      const result = Bun.spawnSync(["git", ...arguments_], { cwd, stderr: "pipe", stdout: "pipe" });
      return Object.freeze({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      });
    };
    const checked = (arguments_: readonly string[], cwd: string) => {
      const result = run(arguments_, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };

    try {
      checked(["init", "--bare", remote], directory);
      checked(["init", "--initial-branch=main", source], directory);
      checked(["config", "user.name", "Message Like Me test"], source);
      checked(["config", "user.email", "test@example.invalid"], source);
      const file = join(source, "value.txt");
      await writeFile(file, "release\n", "utf8");
      checked(["add", "value.txt"], source);
      checked(["commit", "-m", "release"], source);
      const releaseSha = checked(["rev-parse", "HEAD"], source);
      checked(["tag", "-a", verifiedTag, "-m", "release"], source);
      const tagObjectSha = checked(["rev-parse", verifiedTag], source);
      expect(tagObjectSha).not.toBe(releaseSha);

      await writeFile(file, "current workflow\n", "utf8");
      checked(["commit", "-am", "current workflow"], source);
      const workflowSha = checked(["rev-parse", "HEAD"], source);
      checked(["push", remote, "main", `refs/tags/${verifiedTag}`], source);

      checked(["init", "--initial-branch=main", checkout], directory);
      checked(["fetch", "--no-tags", `file://${remote}`, "refs/heads/main"], checkout);
      checked(["checkout", "--detach", "FETCH_HEAD"], checkout);
      expect(checked(["rev-parse", "HEAD"], checkout)).toBe(workflowSha);

      const fetchArguments = verifiedReleaseFetchArguments(verifiedTag).map((value) =>
        value === "https://github.com/hraness/textbutler.git" ? `file://${remote}` : value
      );
      checked(fetchArguments, checkout);
      expect(checked(["rev-parse", "HEAD"], checkout)).toBe(workflowSha);
      expect(checked(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], checkout)).toBe(releaseSha);
      expect(run(["show-ref", "--tags"], checkout)).toMatchObject({ exitCode: 1, stdout: "" });
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("retains bounded tag ancestry and reports the real leased update as a fast-forward", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-like-me-tag-ancestry-"));
    const remote = join(directory, "remote.git");
    const remoteUrl = `file://${remote}`;
    const source = join(directory, "source");
    const fixedRemote = "https://github.com/hraness/textbutler.git";
    const run = (arguments_: readonly string[], cwd: string) => {
      const result = Bun.spawnSync(["git", ...arguments_], { cwd, stderr: "pipe", stdout: "pipe" });
      return Object.freeze({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      });
    };
    const checked = (arguments_: readonly string[], cwd: string) => {
      const result = run(arguments_, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };

    try {
      checked(["init", "--bare", remote], directory);
      checked(["init", "--initial-branch=main", source], directory);
      checked(["config", "user.name", "Message Like Me test"], source);
      checked(["config", "user.email", "test@example.invalid"], source);
      const file = join(source, "value.txt");
      await writeFile(file, "baseline\n", "utf8");
      checked(["add", "value.txt"], source);
      checked(["commit", "-m", "baseline"], source);
      const expectedOldSha = checked(["rev-parse", "HEAD"], source);
      checked(["push", remote, `${expectedOldSha}:refs/heads/website-production`], source);

      for (const value of ["one", "two", "release"] as const) {
        await writeFile(file, `${value}\n`, "utf8");
        checked(["commit", "-am", value], source);
      }
      const releaseSha = checked(["rev-parse", "HEAD"], source);
      checked(["tag", "-a", verifiedTag, "-m", "release"], source);
      checked(["push", remote, `refs/tags/${verifiedTag}`], source);

      let rawPushStdout = "";
      const receipt = advanceWebsiteProductionRef({
        environment: { MLM_RELEASE_REF_TOKEN: token },
        expectedOldSha,
        repository: "hraness/textbutler",
        spawnImplementation(command, arguments_, options) {
          const mappedArguments = arguments_.map((value) => value === fixedRemote ? remoteUrl : value);
          const result = spawnSync(command, mappedArguments, {
            ...options,
            env: {
              ...(options.env as Readonly<Record<string, string>>),
              GIT_ALLOW_PROTOCOL: "file",
            },
          });
          const stdout = String(result.stdout ?? "");
          const stderr = String(result.stderr ?? "");
          if (mappedArguments.includes("push") && mappedArguments.includes("--porcelain")) {
            rawPushStdout = stdout;
          }
          return {
            ...result,
            stderr: stderr.replaceAll(remoteUrl, fixedRemote),
            stdout: stdout.replaceAll(remoteUrl, fixedRemote),
          } as never;
        },
        verifiedSha: releaseSha,
        verifiedTag,
      });

      expect(rawPushStdout).toContain(`${expectedOldSha.slice(0, 7)}..${releaseSha.slice(0, 7)}`);
      expect(rawPushStdout).not.toContain("forced update");
      expect(receipt).toEqual({
        classification: "fast-forward",
        fromSha: expectedOldSha,
        protectedRef: "refs/heads/website-production",
        summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        toSha: releaseSha,
      });
      expect(checked(["--git-dir", remote, "rev-parse", "refs/heads/website-production"], directory))
        .toBe(releaseSha);
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
