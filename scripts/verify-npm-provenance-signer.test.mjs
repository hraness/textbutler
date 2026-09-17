import { describe, expect, test } from "bun:test";

import { releaseSignerIdentity } from "./verify-npm-provenance-signer.mjs";

const tag = "v0.8.1";
const sha = "a".repeat(40);
const workflow = ".github/workflows/release.yml";
const ref = `refs/tags/${tag}`;
const identity =
  `https://github.com/hraness/textbutler/${workflow}@${ref}`;
const invocation = "https://github.com/hraness/textbutler/actions/runs/123/attempts/3";
const derUtf8String = (value) => Buffer.concat([Buffer.from([0x0c, Buffer.byteLength(value, "utf8")]), Buffer.from(value, "utf8")]);

describe("npm Sigstore release signer policy", () => {
  test("binds the Fulcio signer to the exact GitHub Actions workflow, tag, repository, and commit", () => {
    const policy = releaseSignerIdentity(tag, sha, invocation, workflow);
    expect(policy.identity).toBe(identity);
    expect(policy.options.certificateIssuer).toBe("https://token.actions.githubusercontent.com");
    expect(new RegExp(policy.options.certificateIdentityURI, "u").test(identity)).toBe(true);
    expect(new RegExp(policy.options.certificateIdentityURI, "u").test(`${identity}-attacker`)).toBe(false);
    expect(policy.options.certificateOIDs).toEqual({
      "1.3.6.1.4.1.57264.1.2": "push",
      "1.3.6.1.4.1.57264.1.3": sha,
      "1.3.6.1.4.1.57264.1.5": "hraness/textbutler",
      "1.3.6.1.4.1.57264.1.6": ref,
      "1.3.6.1.4.1.57264.1.11": derUtf8String("github-hosted"),
      "1.3.6.1.4.1.57264.1.12": derUtf8String("https://github.com/hraness/textbutler"),
      "1.3.6.1.4.1.57264.1.13": derUtf8String(sha),
      "1.3.6.1.4.1.57264.1.14": derUtf8String(ref),
      "1.3.6.1.4.1.57264.1.15": derUtf8String("1342143606"),
      "1.3.6.1.4.1.57264.1.18": derUtf8String(identity),
      "1.3.6.1.4.1.57264.1.19": derUtf8String(sha),
      "1.3.6.1.4.1.57264.1.20": derUtf8String("push"),
      "1.3.6.1.4.1.57264.1.21": derUtf8String(invocation),
      "1.3.6.1.4.1.57264.1.22": derUtf8String("public"),
      "1.3.6.1.4.1.57264.1.24": derUtf8String(
        `repo:hraness@307125679/textbutler@1342143606:ref:${ref}`,
      ),
    });
  });

  test("rejects the former scoped package tag namespace", () => {
    expect(() => releaseSignerIdentity("agentrouter-v0.1.0", sha, invocation, workflow))
      .toThrow("coordinates");
    expect(() => releaseSignerIdentity("agentmixer-v0.1.0", sha, invocation, workflow))
      .toThrow("coordinates");
  });

  test("rejects non-stable tags and malformed commits before verification", () => {
    expect(() => releaseSignerIdentity("latest", sha, invocation, workflow)).toThrow("coordinates");
    expect(() => releaseSignerIdentity("agentrouter-v1.2.3.4", sha, invocation, workflow)).toThrow("coordinates");
    expect(() => releaseSignerIdentity(tag, "not-a-commit", invocation, workflow)).toThrow("coordinates");
    expect(() => releaseSignerIdentity(tag, sha, `${invocation}-attacker`, workflow)).toThrow("coordinates");
    expect(() => releaseSignerIdentity(tag, sha, invocation, "release.yml")).toThrow("coordinates");
    expect(() => releaseSignerIdentity(tag, sha, invocation, ".github/workflows/evil.yaml")).toThrow("coordinates");
    expect(() => releaseSignerIdentity(tag, sha, invocation, undefined)).toThrow("coordinates");
  });
});

describe("npm Sigstore extension encoding", () => {
  test("wraps Fulcio v2 extension values as DER UTF8Strings and keeps deprecated values raw", () => {
    const policy = releaseSignerIdentity(tag, sha, invocation, workflow);
    const oids = policy.options.certificateOIDs;
    expect(oids["1.3.6.1.4.1.57264.1.2"]).toBe("push");
    const runner = oids["1.3.6.1.4.1.57264.1.11"];
    expect(Buffer.isBuffer(runner)).toBe(true);
    expect(runner[0]).toBe(0x0c);
    expect(runner[1]).toBe(Buffer.byteLength("github-hosted"));
    expect(runner.subarray(2).toString("utf8")).toBe("github-hosted");
    const identityExtension = oids["1.3.6.1.4.1.57264.1.18"];
    expect(identityExtension.subarray(2).toString("utf8")).toBe(identity);
    expect(identityExtension[1]).toBe(Buffer.byteLength(identity));
  });
});
