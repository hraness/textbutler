import { describe, expect, test } from "bun:test";

import {
  publicReleaseEnvironment,
  trustedPublishingEnvironment,
} from "./release-process-environment";

const trustedSource = Object.freeze({
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.test/oidc",
  GH_TOKEN: "github-token",
  GITHUB_REF: "refs/tags/v0.8.1",
  GITHUB_REPOSITORY: "hraness/textbutler",
  GITHUB_REPOSITORY_ID: "1342143606",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_RUN_ID: "123",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_TOKEN: "github-token-alias",
  GITHUB_WORKFLOW_REF:
    "hraness/textbutler/.github/workflows/release.yml@refs/tags/v0.8.1",
  HOME: "/tmp/home",
  NODE_AUTH_TOKEN: "traditional-npm-token",
  NPM_CONFIG_OTP: "123456",
  NPM_TOKEN: "traditional-npm-token-alias",
  PATH: "/usr/bin:/bin",
  RUNNER_ENVIRONMENT: "github-hosted",
  UNRELATED_PRIVATE_SECRET: "private",
} satisfies NodeJS.ProcessEnv);

describe("release subprocess environments", () => {
  test("public verification receives only runtime essentials and explicit public configuration", () => {
    expect(publicReleaseEnvironment({ CI: "true" }, trustedSource)).toEqual({
      CI: "true",
      HOME: "/tmp/home",
      PATH: "/usr/bin:/bin",
    });
  });

  test("trusted npm publishing keeps OIDC provenance metadata but no ambient credentials", () => {
    const environment = trustedPublishingEnvironment({ NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/" }, trustedSource);
    expect(environment).toMatchObject({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.test/oidc",
      GITHUB_REF: "refs/tags/v0.8.1",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      RUNNER_ENVIRONMENT: "github-hosted",
    });
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NODE_AUTH_TOKEN",
      "NPM_CONFIG_OTP",
      "NPM_TOKEN",
      "UNRELATED_PRIVATE_SECRET",
    ] as const) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("trusted publishing fails before npm when required OIDC metadata is missing", () => {
    expect(() => trustedPublishingEnvironment({}, { PATH: "/usr/bin" })).toThrow(
      "npm trusted publishing environment is missing ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    );
  });
});
