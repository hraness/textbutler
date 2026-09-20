import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contactCapabilityIdentity } from "../packages/textbutler/src/contact-capabilities.ts";
import { sha256 } from "./textbutler-distribution.ts";
import { validateXcbIntegrationAdmission, XCB_INTEGRATION_RECEIPT, XCB_INTEGRATION_SOURCES } from "./xcb-integration-admission.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Synthetic evidence is confined to disposable test roots. Production receipt
 * creation remains an independent review/integration-owner operation. */
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "xcb-admission-test-")); roots.push(root);
  const sources: Record<string, string> = {};
  for (const source of XCB_INTEGRATION_SOURCES) {
    const path = join(root, source), bytes = `synthetic reviewed source: ${source}\n`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 }); sources[source] = sha256(bytes);
  }
  const receipt = { version: 1, profiles: { classify: { ...contactCapabilityIdentity("classify") }, respond: { ...contactCapabilityIdentity("respond") } },
    sources, validation: { command: "bun test synthetic-composition.test.ts", receiptSha256: sha256("synthetic independent validation") } };
  await mkdir(join(root, "qualification"), { mode: 0o700 });
  const save = async (value: unknown = receipt) => {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    await writeFile(join(root, XCB_INTEGRATION_RECEIPT), bytes, { mode: 0o600 }); return bytes;
  };
  await save();
  return { root, receipt, save };
}

test("reviewed composition binds exact source bytes, both profiles and receipt bytes", async () => {
  const f = await fixture(), bytes = await f.save();
  const admission = await validateXcbIntegrationAdmission(f.root);
  const canonical = Object.fromEntries(Object.entries(f.receipt.sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  expect(admission).toEqual({ version: 1, evidenceDigest: sha256(bytes), sourceDigest: sha256(JSON.stringify(canonical)), profiles: f.receipt.profiles });
  expect(Object.isFrozen(admission)).toBe(true);
  expect(Object.isFrozen(admission.profiles.respond)).toBe(true);
  const reordered = { ...f.receipt, sources: Object.fromEntries(Object.entries(f.receipt.sources).reverse()) };
  await f.save(reordered);
  const next = await validateXcbIntegrationAdmission(f.root);
  expect(next.sourceDigest).toBe(admission.sourceDigest);
  expect(next.evidenceDigest).not.toBe(admission.evidenceDigest);
});

test("source hashes and current contact profile identities cannot be replaced", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "packages/textbutler/src/xcb-client.ts"), "changed source");
  await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("reviewed sources");
  const clean = await fixture();
  for (const field of ["id", "version", "digest"] as const) {
    const wrong = structuredClone(clean.receipt);
    if (field === "id") wrong.profiles.respond.id = "different.profile";
    else if (field === "version") wrong.profiles.respond.version++;
    else wrong.profiles.respond.digest = sha256("different profile");
    await clean.save(wrong);
    await expect(validateXcbIntegrationAdmission(clean.root)).rejects.toThrow("admission");
  }
  await clean.save({ ...clean.receipt, profiles: { classify: clean.receipt.profiles.respond, respond: clean.receipt.profiles.classify } });
  await expect(validateXcbIntegrationAdmission(clean.root)).rejects.toThrow("admission");
});

test("missing evidence and incomplete validation records fail closed", async () => {
  const f = await fixture();
  await rm(join(f.root, XCB_INTEGRATION_RECEIPT));
  await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  for (const validation of [undefined, {}, { command: "bun test" }, { command: "", receiptSha256: sha256("x") },
    { command: "bun test\nignored", receiptSha256: sha256("x") }, { command: "bun test", receiptSha256: "not-a-digest" }]) {
    await f.save({ ...f.receipt, validation });
    await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  }
});

test("the exact source inventory rejects omissions, unknown files and unsafe paths before reads", async () => {
  const f = await fixture(), sources = { ...f.receipt.sources };
  delete sources["packages/textbutler/src/xcb-client.ts"];
  await f.save({ ...f.receipt, sources });
  await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  for (const path of ["../outside.ts", "/absolute.ts", "packages/textbutler/src/unknown.ts", "packages/textbutler/src/./xcb-host.ts", "__proto__"]) {
    await f.save({ ...f.receipt, sources: { ...f.receipt.sources, [path]: sha256("unknown") } });
    await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  }
});

test("unreadable or linked reviewed files cannot satisfy admission", async () => {
  const f = await fixture(), source = "packages/textbutler/src/xcb-host.ts", path = join(f.root, source);
  await rm(path);
  await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  const target = join(f.root, "linked-source.ts");
  await writeFile(target, `synthetic reviewed source: ${source}\n`, { mode: 0o600 });
  await symlink(target, path);
  await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
});

test("unknown receipt fields and malformed schemas do not become evidence", async () => {
  const f = await fixture();
  for (const invalid of [null, [], { ...f.receipt, version: 2 }, { ...f.receipt, qualified: true },
    { ...f.receipt, profiles: { ...f.receipt.profiles, other: f.receipt.profiles.classify } },
    { ...f.receipt, validation: { ...f.receipt.validation, signedIn: true } }]) {
    await f.save(invalid);
    await expect(validateXcbIntegrationAdmission(f.root)).rejects.toThrow("admission");
  }
});

test("post-bundle verification rejects missing or stale source and receipt observations", async () => {
  const f = await fixture(), bytes = await f.save(), observed = new Map(Object.entries(f.receipt.sources));
  observed.set(XCB_INTEGRATION_RECEIPT, sha256(bytes));
  expect(await validateXcbIntegrationAdmission(f.root, observed)).toEqual(await validateXcbIntegrationAdmission(f.root));
  const missing = new Map(observed); missing.delete("packages/textbutler/src/native-task.ts");
  await expect(validateXcbIntegrationAdmission(f.root, missing)).rejects.toThrow("admission");
  const wrong = new Map(observed); wrong.set("packages/textbutler/src/native-task.ts", sha256("other bundle bytes"));
  await expect(validateXcbIntegrationAdmission(f.root, wrong)).rejects.toThrow("admission");
  const missingReceipt = new Map(observed); missingReceipt.delete(XCB_INTEGRATION_RECEIPT);
  await expect(validateXcbIntegrationAdmission(f.root, missingReceipt)).rejects.toThrow("admission");
  const changedSource = "packages/textbutler/src/native-task.ts", changed = "source changed after the build read it";
  await writeFile(join(f.root, changedSource), changed);
  f.receipt.sources[changedSource] = sha256(changed);
  observed.set(XCB_INTEGRATION_RECEIPT, sha256(await f.save()));
  await expect(validateXcbIntegrationAdmission(f.root, observed)).rejects.toThrow("admission");
});
