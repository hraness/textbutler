import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const REPOSITORY_URL = "https://github.com/hraness/textbutler.git";
const MAIN_BRANCH = "main";
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const LOCAL_MAIN_REF = `refs/remotes/origin/${MAIN_BRANCH}`;
const MAXIMUM_SNAPSHOT_BYTES = 64 * 1_024;
const MAXIMUM_SNAPSHOT_ROWS = 500;
const MAXIMUM_GIT_OUTPUT_BYTES = 256 * 1_024;
const GIT_TIMEOUT_MILLISECONDS = 120_000;
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const TAG_REF = /^refs\/tags\/(v[A-Za-z0-9][A-Za-z0-9._-]{0,126})$/u;

export type GitCommandResult = Readonly<{
  exitCode: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
}>;

export type GitCommandRunner = (arguments_: readonly string[]) => GitCommandResult;

type RemoteRef = Readonly<{
  oid: string;
  ref: string;
}>;

export type RemoteSnapshot = Readonly<{
  canonical: string;
  entries: readonly RemoteRef[];
  requestedTagOid: string;
}>;

type GovernedRemoteSnapshot = Readonly<{
  canonical: string;
  mainOid: string;
  requestedTagOid: string;
}>;

export type ReleaseRefAuthority = Readonly<{
  mainSha: string;
  sha: string;
  tag: string;
}>;

export type ReleaseRefAuthorityInput = Readonly<{
  expectedReleaseSha?: string;
  mode: "promotion" | "release";
  requestedTag: string;
  runner?: GitCommandRunner;
  workingDirectory?: string;
  workflowSha?: string;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8.`);
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function inventoryRowCountBeforeParsing(value: Uint8Array | string): number {
  const inputBytes = typeof value === "string" ? bytes(value) : value;
  let rows = 0;
  for (const byte of inputBytes) {
    if (byte === 0x0a) rows += 1;
  }
  return rows;
}

function createDefaultGitRunner(workingDirectory: string): GitCommandRunner {
  return (arguments_) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        ...arguments_,
      ],
      {
        cwd: workingDirectory,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          SSH_ASKPASS: "/bin/false",
        },
        maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MILLISECONDS,
      },
    );
    if (result.error !== undefined) {
      return fail(`Git command could not complete within its fixed resource bounds.`);
    }
    if (result.status === null) return fail("Git command did not report an exit status.");
    return Object.freeze({
      exitCode: result.status,
      stderr: new Uint8Array(result.stderr),
      stdout: new Uint8Array(result.stdout),
    });
  };
}

function command(
  runner: GitCommandRunner,
  arguments_: readonly string[],
  label: string,
): Uint8Array {
  const result = runner(arguments_);
  if (result.exitCode !== 0) fail(`${label} failed closed.`);
  return result.stdout;
}

function validTagRef(ref: string): boolean {
  const match = TAG_REF.exec(ref);
  if (match === null) return false;
  const name = match[1];
  return name !== undefined
    && !name.includes("..")
    && !name.includes("@{")
    && !name.endsWith(".")
    && !name.endsWith(".lock");
}

type StableVersion = Readonly<{ namespace: string; version: readonly [bigint, bigint, bigint] }>;

/** A release tag carries the governed "v" namespace. Newest-tag admission
 * compares only within the requested tag's own namespace. */
function stableVersion(tag: string): StableVersion | undefined {
  const match = STABLE_TAG.exec(tag);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  return Object.freeze({
    namespace: "v",
    version: Object.freeze([BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]) as readonly [bigint, bigint, bigint],
  });
}

function compareVersions(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): number {
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) return fail("Stable version is incomplete.");
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parseInventoryRows(
  value: Uint8Array | string,
  label: string,
): Readonly<{ canonical: string; entries: readonly RemoteRef[] }> {
  const inputBytes = typeof value === "string" ? bytes(value) : value;
  if (inputBytes.byteLength === 0 || inputBytes.byteLength > MAXIMUM_SNAPSHOT_BYTES) {
    fail(`${label} is empty or exceeds its byte bound.`);
  }
  const input = typeof value === "string" ? value : decode(value, label);
  if (input.includes("\0") || input.includes("\r") || !input.endsWith("\n")) {
    fail(`${label} is not canonical line-oriented output.`);
  }
  const lines = input.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > MAXIMUM_SNAPSHOT_ROWS || lines.some((line) => line.length === 0)) {
    fail(`${label} has an invalid row count.`);
  }

  const entries: RemoteRef[] = [];
  const byRef = new Map<string, string>();
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 2) fail(`${label} row is malformed.`);
    const [oid, ref] = fields;
    if (oid === undefined || ref === undefined || !SHA.test(oid)) {
      fail(`${label} row has a malformed object ID.`);
    }
    if (byRef.has(ref)) fail(`${label} contains duplicate ref ${ref}.`);
    byRef.set(ref, oid);
    entries.push(Object.freeze({ oid, ref }));
  }

  const canonical = entries
    .toSorted((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
    .map((entry) => `${entry.oid}\t${entry.ref}\n`)
    .join("");
  if (canonical !== input) fail(`${label} is not in canonical ref order.`);
  return Object.freeze({ canonical, entries: Object.freeze(entries) });
}

export function parseRemoteMainSnapshot(value: Uint8Array | string): string {
  const parsed = parseInventoryRows(value, "Remote main-ref inventory");
  if (parsed.entries.length !== 1 || parsed.entries[0]?.ref !== MAIN_REF) {
    fail(`Remote main-ref inventory must contain exactly ${MAIN_REF}.`);
  }
  const mainOid = parsed.entries[0].oid;
  if (!SHA.test(mainOid)) fail("Remote main-ref inventory has no exact commit.");
  return mainOid;
}

export function parseRemoteSnapshot(
  value: Uint8Array | string,
  requestedTag: string,
): RemoteSnapshot {
  const requestedVersion = stableVersion(requestedTag);
  if (requestedVersion === undefined) fail("Requested release tag is not one canonical stable version.");
  const parsed = parseInventoryRows(value, "Remote tag inventory");
  for (const entry of parsed.entries) {
    if (!validTagRef(entry.ref)) fail(`Remote tag inventory contains unexpected ref ${entry.ref}.`);
  }

  const requestedTagOid = parsed.entries.find(
    (entry) => entry.ref === `refs/tags/${requestedTag}`,
  )?.oid;
  if (requestedTagOid === undefined) fail(`Remote tag inventory is missing refs/tags/${requestedTag}.`);

  let newestTag: string | undefined;
  let newestVersion: readonly [bigint, bigint, bigint] | undefined;
  for (const entry of parsed.entries) {
    if (!entry.ref.startsWith("refs/tags/")) continue;
    const tag = entry.ref.slice("refs/tags/".length);
    const stable = stableVersion(tag);
    if (stable === undefined || stable.namespace !== requestedVersion.namespace) continue;
    if (newestVersion === undefined || compareVersions(stable.version, newestVersion) > 0) {
      newestTag = tag;
      newestVersion = stable.version;
    }
  }
  if (newestTag !== requestedTag) {
    fail(`Requested release tag is not the newest advertised stable tag (${newestTag ?? "none"}).`);
  }

  return Object.freeze({
    canonical: parsed.canonical,
    entries: parsed.entries,
    requestedTagOid,
  });
}

export function parseGovernedRemoteSnapshot(
  mainValue: Uint8Array | string,
  tagValue: Uint8Array | string,
  requestedTag: string,
): GovernedRemoteSnapshot {
  const mainBytes = typeof mainValue === "string" ? bytes(mainValue) : mainValue;
  const tagBytes = typeof tagValue === "string" ? bytes(tagValue) : tagValue;
  if (mainBytes.byteLength + tagBytes.byteLength > MAXIMUM_SNAPSHOT_BYTES) {
    fail("Combined governed remote ref inventory exceeds its byte bound.");
  }
  if (
    inventoryRowCountBeforeParsing(mainValue) + inventoryRowCountBeforeParsing(tagValue)
    > MAXIMUM_SNAPSHOT_ROWS
  ) {
    fail("Combined governed remote ref inventory exceeds its row bound.");
  }
  const main = parseInventoryRows(mainValue, "Remote main-ref inventory");
  const tags = parseRemoteSnapshot(tagValue, requestedTag);
  if (main.entries.length + tags.entries.length > MAXIMUM_SNAPSHOT_ROWS) {
    fail("Combined governed remote ref inventory exceeds its row bound.");
  }
  if (main.entries.length !== 1 || main.entries[0]?.ref !== MAIN_REF) {
    fail(`Remote main-ref inventory must contain exactly ${MAIN_REF}.`);
  }
  const mainOid = main.entries[0].oid;
  if (!SHA.test(mainOid)) fail("Remote main-ref inventory has no exact commit.");
  return Object.freeze({
    canonical: `${main.canonical}${tags.canonical}`,
    mainOid,
    requestedTagOid: tags.requestedTagOid,
  });
}

function readSnapshot(runner: GitCommandRunner, requestedTag: string): GovernedRemoteSnapshot {
  const main = command(
    runner,
    ["ls-remote", "--refs", REPOSITORY_URL, MAIN_REF],
    "Remote main-ref inventory",
  );
  const namespace = stableVersion(requestedTag)?.namespace ?? fail("Requested release tag is not one canonical stable version.");
  const tags = command(
    runner,
    ["ls-remote", "--refs", "--tags", REPOSITORY_URL, `refs/tags/${namespace}*`],
    "Remote tag inventory",
  );
  return parseGovernedRemoteSnapshot(main, tags, requestedTag);
}

function removeStaleFetchHead(runner: GitCommandRunner): string {
  const gitDirectory = decode(command(
    runner,
    ["rev-parse", "--absolute-git-dir"],
    "Git directory identity",
  ), "Git directory identity").trim();
  const fetchHead = decode(command(
    runner,
    ["rev-parse", "--git-path", "FETCH_HEAD"],
    "FETCH_HEAD path identity",
  ), "FETCH_HEAD path identity").trim();
  if (gitDirectory.length === 0 || fetchHead.length === 0) fail("Git administrative paths are empty.");
  const expected = join(resolve(gitDirectory), "FETCH_HEAD");
  const actual = fetchHead.startsWith("/") ? resolve(fetchHead) : expected;
  if (!fetchHead.startsWith("/") && fetchHead !== ".git/FETCH_HEAD" && fetchHead !== "FETCH_HEAD") {
    fail("Relative FETCH_HEAD path is not canonical.");
  }
  if (actual !== expected) fail("FETCH_HEAD path escaped the exact Git administrative directory.");
  if (existsSync(actual)) {
    const information = lstatSync(actual);
    if (!information.isFile() || information.isSymbolicLink()) {
      fail("Preexisting FETCH_HEAD is not one removable regular file.");
    }
    unlinkSync(actual);
  }
  if (existsSync(actual)) fail("Preexisting FETCH_HEAD could not be removed.");
  return actual;
}

type LocalRef = Readonly<{
  objectName: string;
  objectType: string;
  peeledName: string;
  peeledType: string;
  ref: string;
}>;

function readLocalRefs(runner: GitCommandRunner): readonly LocalRef[] {
  const value = decode(command(
    runner,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
    ],
    "Local ref inventory",
  ), "Local ref inventory");
  if (value === "") return Object.freeze([]);
  if (value.includes("\r") || !value.endsWith("\n")) {
    fail("Local ref inventory is malformed.");
  }
  return Object.freeze(value.slice(0, -1).split("\n").map((line) => {
    const fields = line.split("\0");
    if (fields.length !== 5) fail("Local ref inventory record is malformed.");
    const [ref, objectName, objectType, peeledName, peeledType] = fields;
    if (
      ref === undefined
      || objectName === undefined
      || objectType === undefined
      || peeledName === undefined
      || peeledType === undefined
      || ref.length === 0
      || !SHA.test(objectName)
    ) fail("Local ref inventory record is incomplete.");
    return Object.freeze({ objectName, objectType, peeledName, peeledType, ref });
  }));
}

function expectExactLocalRefNames(
  runner: GitCommandRunner,
  expected: readonly string[],
  label: string,
): readonly LocalRef[] {
  const refs = readLocalRefs(runner);
  const names = refs.map((entry) => entry.ref);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail(`${label} does not contain the exact governed ref set.`);
  }
  return refs;
}

function parseAnnotatedTag(
  value: Uint8Array,
  requestedTag: string,
  expectedCommit: string,
): void {
  const input = decode(value, "Requested annotated tag object");
  if (input.includes("\r") || input.includes("\0")) fail("Requested annotated tag object is malformed.");
  const headerEnd = input.indexOf("\n\n");
  if (headerEnd <= 0) fail("Requested annotated tag object has no canonical header boundary.");
  const headers = input.slice(0, headerEnd).split("\n");
  const fields = new Map<string, string>();
  for (const line of headers) {
    if (line.startsWith(" ")) continue;
    const separator = line.indexOf(" ");
    if (separator <= 0) fail("Requested annotated tag object contains a malformed header.");
    const key = line.slice(0, separator);
    const field = line.slice(separator + 1);
    if (fields.has(key)) fail(`Requested annotated tag object duplicates ${key}.`);
    fields.set(key, field);
  }
  if (
    fields.get("object") !== expectedCommit
    || fields.get("type") !== "commit"
    || fields.get("tag") !== requestedTag
  ) fail("Requested annotated tag does not directly name and target the verified release commit.");
}

export function assertReviewedMainComparison(
  value: unknown,
  reviewedSha: string,
  currentMainSha: string,
  label = "reviewed-main ancestry comparison",
): void {
  if (!SHA.test(reviewedSha) || !SHA.test(currentMainSha)) fail(`${label} has invalid expected commits.`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is not an object.`);
  const comparison = value as Readonly<Record<string, unknown>>;
  const commitSha = (candidate: unknown, field: string): string => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return fail(`${label}.${field} is not an object.`);
    }
    const sha = (candidate as Readonly<Record<string, unknown>>).sha;
    if (typeof sha !== "string" || !SHA.test(sha)) return fail(`${label}.${field}.sha is invalid.`);
    return sha;
  };
  const base = commitSha(comparison.base_commit, "base_commit");
  const mergeBase = commitSha(comparison.merge_base_commit, "merge_base_commit");
  if (!Array.isArray(comparison.commits)) fail(`${label}.commits is not an array.`);
  const commits = comparison.commits;
  const ahead = comparison.ahead_by;
  const behind = comparison.behind_by;
  if (
    typeof ahead !== "number"
    || typeof behind !== "number"
    || !Number.isSafeInteger(ahead)
    || !Number.isSafeInteger(behind)
  ) {
    fail(`${label} has non-integer distance metadata.`);
  }
  if (base !== reviewedSha || mergeBase !== reviewedSha || behind !== 0) {
    fail(`${label} does not bind the reviewed base and merge base.`);
  }
  if (reviewedSha === currentMainSha) {
    if (comparison.status !== "identical" || ahead !== 0 || commits.length !== 0) {
      fail(`${label} does not prove one identical current-main commit.`);
    }
    return;
  }
  const terminal = commits.at(-1);
  if (
    comparison.status !== "ahead"
    || typeof ahead !== "number"
    || ahead <= 0
    || terminal === undefined
    || commitSha(terminal, "commits[-1]") !== currentMainSha
  ) fail(`${label} does not prove the exact terminal current-main commit.`);
}

export function verifyReleaseRefAuthority(input: ReleaseRefAuthorityInput): ReleaseRefAuthority {
  const requestedTag = input.requestedTag;
  if (stableVersion(requestedTag) === undefined) fail("Requested release tag is not one canonical stable version.");
  const workingDirectory = resolve(input.workingDirectory ?? process.cwd());
  const runner = input.runner ?? createDefaultGitRunner(workingDirectory);
  if (input.mode === "release") {
    if (input.workflowSha !== undefined || input.expectedReleaseSha !== undefined) {
      fail("Release authority received unexpected promotion coordinates.");
    }
  } else {
    if (input.workflowSha === undefined || !SHA.test(input.workflowSha)) {
      fail("Promotion authority requires one exact current-main workflow SHA.");
    }
    if (input.expectedReleaseSha !== undefined && !SHA.test(input.expectedReleaseSha)) {
      fail("Promotion authority received a malformed upstream release SHA.");
    }
  }

  const first = readSnapshot(runner, requestedTag);
  const localTagRef = `refs/tags/${requestedTag}`;
  expectExactLocalRefNames(
    runner,
    input.mode === "release" ? [localTagRef] : [],
    "Local release-ref preflight",
  );
  const fetchHead = removeStaleFetchHead(runner);
  const shallow = decode(command(
    runner,
    ["rev-parse", "--is-shallow-repository"],
    "Repository shallow-state check",
  ), "Repository shallow-state check").trim();
  if (shallow !== "true" && shallow !== "false") fail("Repository shallow-state check was not exact.");
  command(
    runner,
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      ...(shallow === "true" ? ["--unshallow"] : []),
      REPOSITORY_URL,
      `${MAIN_REF}:${LOCAL_MAIN_REF}`,
      `${localTagRef}:${localTagRef}`,
    ],
    "Exact governed release-ref import",
  );
  if (existsSync(fetchHead)) fail("Exact governed import wrote forbidden FETCH_HEAD state.");

  const refs = expectExactLocalRefNames(
    runner,
    [LOCAL_MAIN_REF, localTagRef],
    "Local release-ref post-import inventory",
  );
  const main = refs[0];
  const tag = refs[1];
  if (
    main === undefined
    || main.objectType !== "commit"
    || main.objectName !== first.mainOid
    || main.peeledName !== ""
    || main.peeledType !== ""
  ) fail("Imported main ref does not match the advertised exact commit.");
  if (
    tag === undefined
    || tag.objectType !== "tag"
    || tag.objectName !== first.requestedTagOid
    || tag.peeledType !== "commit"
    || !SHA.test(tag.peeledName)
  ) fail("Imported requested ref is not the advertised direct annotated tag.");
  parseAnnotatedTag(command(
    runner,
    ["cat-file", "tag", localTagRef],
    "Requested annotated tag object read",
  ), requestedTag, tag.peeledName);

  const head = decode(command(
    runner,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Checked-out workflow source identity",
  ), "Checked-out workflow source identity").trim();
  if (!SHA.test(head)) fail("Checked-out workflow source identity is malformed.");
  if (input.mode === "release") {
    if (head !== tag.peeledName) fail("Release checkout does not equal the verified tag commit.");
  } else {
    if (head !== first.mainOid || input.workflowSha !== head) {
      fail("Promotion helper is not executing from the exact advertised current main.");
    }
    if (input.expectedReleaseSha !== undefined && input.expectedReleaseSha !== tag.peeledName) {
      fail("Successful Release run and annotated tag target different commits.");
    }
  }

  const ancestry = runner(["merge-base", "--is-ancestor", tag.peeledName, LOCAL_MAIN_REF]);
  if (ancestry.exitCode !== 0) fail("Verified release commit is not an ancestor of exact advertised main.");
  const second = readSnapshot(runner, requestedTag);
  if (second.canonical !== first.canonical) fail("Remote release-ref inventory changed during verification.");

  return Object.freeze({ mainSha: first.mainOid, sha: tag.peeledName, tag: requestedTag });
}

function main(): void {
  const [mode, requestedTag, workflowSha, expectedReleaseSha, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || requestedTag === undefined || (mode !== "release" && mode !== "promotion")) {
    fail(
      "Usage: release-ref-authority.ts release TAG | promotion TAG WORKFLOW_SHA [EXPECTED_RELEASE_SHA]",
    );
  }
  if (process.env.GITHUB_REPOSITORY !== "hraness/textbutler" || process.env.DEFAULT_BRANCH !== MAIN_BRANCH) {
    fail("Release-ref authority must run for hraness/textbutler on exact default branch main.");
  }
  const authority = verifyReleaseRefAuthority({
    mode,
    requestedTag,
    ...(expectedReleaseSha === undefined || expectedReleaseSha === ""
      ? {}
      : { expectedReleaseSha }),
    ...(workflowSha === undefined ? {} : { workflowSha }),
  });
  process.stdout.write(`sha=${authority.sha}\ntag=${authority.tag}\nmain_sha=${authority.mainSha}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
