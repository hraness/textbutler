import { expect, test } from "bun:test";
import { PRIVATE_TEMPORARY_PATH, standaloneProblems, standaloneSourceProblems } from "./check-standalone.ts";

test("privacy scanning admits only the exact public macOS resolver socket", () => {
  for (const source of [
    '(literal "/private/var/run/mDNSResponder")',
    "'/private/var/run/mDNSResponder'",
    "`/private/var/run/mDNSResponder`",
    "/private/var/run/mDNSResponder",
  ]) expect(PRIVATE_TEMPORARY_PATH.test(source)).toBe(false);
});

test("resolver admission preserves temporary, sibling and suffix path detection", () => {
  for (const source of [
    '"/private/tmp/private-fixture"',
    '"/private/tmp/run/mDNSResponder"',
    '"/private/var/folders/private-fixture"',
    '"/private/var/run/other-socket"',
    '"/private/var/run/"',
    '"/private/var/run/mDNSResponder/private-fixture"',
    '"/private/var/run/mDNSResponder.log"',
    '"/private/var/run/mDNSResponder private-fixture"',
    '"/private/var/run/mDNSResponder\\private-fixture"',
    '"/private/var/run/mDNSResponder"; "/private/tmp/private-fixture"',
  ]) expect(PRIVATE_TEMPORARY_PATH.test(source)).toBe(true);
});

const protocol = (source: string) =>
  standaloneSourceProblems("fixture/package.json", source)
    .filter((problem) => problem.includes("private workspace dependency protocol"));

test("quoted workspace and catalog dependency specifiers remain refused", () => {
  for (const source of [
    '{ "dependencies": { "dep": "workspace:*" } }',
    '{ "dependencies": { "dep": "workspace:^1.2.3" } }',
    "{ 'dependencies': { 'dep': 'workspace:~' } }",
    '{ "dependencies": { "dep": "catalog:react18" } }',
    '{ "dependencies": { "dep": "catalog:" } }',
    'const specifier = `catalog:default`;',
    'const specifier = `workspace:*`;',
    'dep = "workspace:^"',
  ]) {
    expect(protocol(source)).toHaveLength(1);
  }
  expect(protocol('{ "a": "workspace:*", "b": "catalog:react18" }')).toHaveLength(1);
});

test("ordinary catalog and workspace properties are not dependency protocols", () => {
  for (const source of [
    "type Row = { catalog: unknown; workspace: string };",
    "const value = { catalog: { models: [] }, workspace: 1 };",
    'const value = { "catalog": { models: [] } };',
    'const doc = "the catalog: default entry and workspace: notes";',
    "// route through the workspace: shared host adapter",
    "label: for (const item of items) { catalog: count(item); }",
    'const value = { "catalog": "react18" };',
    "dep: catalog:react18",
    '"catalog: react18"',
  ]) {
    expect(protocol(source)).toEqual([]);
  }
});

test("the scanned repository tree remains standalone-clean", async () => {
  expect(await standaloneProblems()).toEqual([]);
});
