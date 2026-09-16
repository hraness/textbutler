import { describe, expect, test } from "bun:test";

import { parseVerifiedNpmProvenance } from "./npm-provenance-verification";
import {
  rootReleasePackage,
  type ReleasePackage,
} from "./release-distribution-policy";

const version = "0.8.1";
const verifiedTag = `v${version}`;
const verifiedSha = "b".repeat(40);
const sha512 = "a".repeat(128);

function audit(
  overrides: Readonly<Record<string, unknown>> = {},
  invocation = "https://github.com/hraness/textbutler/actions/runs/123/attempts/3",
  releasePackage: ReleasePackage = rootReleasePackage,
): unknown {
  const tag = `${releasePackage.tagPrefix}${version}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{
      digest: { sha512 },
      name: `pkg:npm/${releasePackage.name.replace(/^@/, "%40")}@${version}`,
    }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: releasePackage.workflowPath,
            ref: `refs/tags/${tag}`,
            repository: "https://github.com/hraness/textbutler",
          },
        },
        internalParameters: {
          github: {
            event_name: "push",
            repository_id: "1342143606",
          },
        },
        resolvedDependencies: [{
          digest: { gitCommit: verifiedSha },
          uri: `git+https://github.com/hraness/textbutler@refs/tags/${tag}`,
        }],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: invocation,
        },
      },
    },
    ...overrides,
  };
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: releasePackage.name,
      version,
      location: `node_modules/${releasePackage.name}`,
      registry: "https://registry.npmjs.org/",
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${releasePackage.name.replaceAll("/", "%2f")}@${version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
            payloadType: "application/vnd.in-toto+json",
            signatures: [{ sig: "verified-by-npm" }],
          },
        },
      }],
    }],
  };
}

const coordinate = Object.freeze({
  releasePackage: rootReleasePackage,
  sha512,
  verifiedSha,
  verifiedTag,
  version,
});

describe("npm provenance verification policy", () => {
  test("rejects an old-name invocation as authority for a new canonical repository release", () => {
    expect(() => parseVerifiedNpmProvenance(audit(
      {}, "https://github.com/hraness/message-like-me/actions/runs/123/attempts/3",
    ), coordinate)).toThrow("invocation");
  });

  test("binds npm's verified Sigstore result to the exact workflow, tag, commit, and tarball", () => {
    expect(() => parseVerifiedNpmProvenance(audit(), coordinate)).not.toThrow();
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      maximumAttempt: 4,
      requiredRunId: "123",
    })).not.toThrow();
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      requiredAttempt: 3,
      requiredRunId: "123",
    })).not.toThrow();
  });

  test("rejects a different run or a provenance attempt outside the admitted retry window", () => {
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      maximumAttempt: 2,
      requiredRunId: "123",
    })).toThrow("allowed workflow run attempt");
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      maximumAttempt: 3,
      requiredRunId: "999",
    })).toThrow("allowed workflow run attempt");
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      requiredAttempt: 2,
      requiredRunId: "123",
    })).toThrow("allowed workflow run attempt");
    expect(() => parseVerifiedNpmProvenance(
      audit({}, "https://github.com/hraness/textbutler/actions/runs/123/attempts/0"),
      coordinate,
    )).toThrow("invocation");
  });

  test("rejects a different source commit or release workflow", () => {
    const wrongCommit = audit({
      predicate: {
        buildDefinition: {
          buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              path: ".github/workflows/release.yml",
              ref: `refs/tags/${verifiedTag}`,
              repository: "https://github.com/hraness/textbutler",
            },
          },
          internalParameters: { github: { event_name: "push", repository_id: "1342143606" } },
          resolvedDependencies: [{
            digest: { gitCommit: "c".repeat(40) },
            uri: `git+https://github.com/hraness/textbutler@refs/tags/${verifiedTag}`,
          }],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
          metadata: {
            invocationId: "https://github.com/hraness/textbutler/actions/runs/123/attempts/3",
          },
        },
      },
    });
    expect(() => parseVerifiedNpmProvenance(wrongCommit, coordinate)).toThrow("reviewed Git commit");
  });

  test("rejects the former scoped release tag in a coordinate", () => {
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      verifiedTag: `agentrouter-v${version}`,
    })).toThrow("coordinate is invalid");
    expect(() => parseVerifiedNpmProvenance(audit(), {
      ...coordinate,
      verifiedTag: `agentmixer-v${version}`,
    })).toThrow("coordinate is invalid");
  });

  test("rejects missing, invalid, or ambiguous npm verification results", () => {
    expect(() => parseVerifiedNpmProvenance({
      ...(audit() as Record<string, unknown>),
      missing: [{ name: "@hraness/message-like-me" }],
    }, coordinate)).toThrow("exactly one provenance-bearing release package");
    expect(() => parseVerifiedNpmProvenance({
      ...(audit() as Record<string, unknown>),
      verified: [],
    }, coordinate)).toThrow("exactly one provenance-bearing release package");
    expect(() => parseVerifiedNpmProvenance({
      ...(audit() as Record<string, unknown>),
      invalid: [{ name: "zod" }],
    }, coordinate)).toThrow("invalid package signature");
    expect(() => parseVerifiedNpmProvenance({
      ...(audit() as Record<string, unknown>),
      verified: [
        ...((audit() as Record<string, unknown>).verified as unknown[]),
        { name: "@hraness/message-like-me" },
      ],
    }, coordinate)).toThrow("exactly one provenance-bearing release package");
  });

  test("admits dependency attestations alongside the verified release package", () => {
    const base = audit() as Record<string, unknown>;
    expect(() => parseVerifiedNpmProvenance({
      ...base,
      missing: [{ name: "@anthropic-ai/sdk", version: "0.0.0" }],
      verified: [
        ...(base.verified as unknown[]),
        { name: "zod", version: "4.0.0" },
      ],
    }, coordinate)).not.toThrow();
  });
});
