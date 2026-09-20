import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateFileOnce } from "@hraness/local-custody/atomic-publish";
import { parseLegacyCrash, parseLegacySetupWitness, parseReconcileArgs, releaseLegacyMarker, requireReconciliationHistorySpace,
  settleLegacySetup, validateExistingSettlement, validateLegacyAttempt, validateOriginalSetupEvidence, validateUnboundAuth,
  type ReconciliationPort, type ReconciliationSnapshot } from "./reconcile-imessage-setup.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const ATTEMPT = "11111111-1111-4111-8111-111111111111", GENERATION = "22222222-2222-4222-8222-222222222222";
const START = 1789918159063, END = 1789918172846;
function fixture() {
  const marker = { schemaVersion: 1, attemptId: ATTEMPT, startedAt: START, configurationDigest: "a".repeat(64), accountDigest: "b".repeat(64), status: "in-flight-or-unreconciled" };
  const result = { schemaVersion: 1, ok: false, status: "recovery-required", code: "process-custody-unproven", attemptId: ATTEMPT,
    startedAt: START, finishedAt: END, configurationDigest: marker.configurationDigest, accountDigest: marker.accountDigest,
    progress: { accountCreated: true, accountBound: false, managedEnabled: false, permissionsChanged: 0, subjectDigest: null },
    custody: "retained", automationPermission: "allowed", launchGeneration: GENERATION };
  const witness = parseLegacySetupWitness({ schemaVersion: 1, kind: "textbutler.imessage-setup-legacy-bind-crash.v1", attemptId: ATTEMPT,
    markerSha256: sha(bytes(marker)), resultSha256: sha(bytes(result)), configurationDigest: marker.configurationDigest, accountDigest: marker.accountDigest,
    applicationReceiptSha256: "c".repeat(64), crash: { path: "/synthetic/owner/Library/Logs/DiagnosticReports/imsg-2026-09-20-112942.ips", sha256: "d".repeat(64) } });
  const snapshot: ReconciliationSnapshot = { marker: { bytes: bytes(marker), sha256: witness.markerSha256, identity: { dev: 1, ino: 2, size: bytes(marker).length, mtimeMs: 3, ctimeMs: 4 } },
    resultSha256: witness.resultSha256, evidenceSha256: "e".repeat(64), witness,
    crash: { incident: "33333333-3333-4333-8333-333333333333", pid: 401, parentPid: 402, responsiblePid: 403, startedAt: START + 1, exitedAt: END - 1, imageUuid: "45f877b9-040f-32ee-b879-d572757cddf6" },
    authSha256: "f".repeat(64), launchGeneration: GENERATION, applicationReceiptSha256: witness.applicationReceiptSha256,
    observations: { processGroupsAbsent: true, launchJobsAbsent: true, cleanupAdmissionsEmpty: true, unboundAuth: true, permissionsAbsent: true } };
  return { marker, result, witness, snapshot };
}
function crashFixture() {
  const incident = "33333333-3333-4333-8333-333333333333";
  const header = { app_name: "imsg", bug_type: "309", incident_id: incident };
  const crash = { incident, procName: "imsg", parentProc: "bun", responsibleProc: "TextButler", coalitionName: "app.textbutler.imessage-setup", procPath: "/private/tmp/*/imsg",
    exception: { type: "EXC_BREAKPOINT", signal: "SIGTRAP" }, termination: { namespace: "SIGNAL", code: 5 }, procExitAbsTime: 6353014485175, procStartAbsTime: 6353005921799,
    procLaunch: "2026-09-20 11:29:32.3736 -0400", captureTime: "2026-09-20 11:29:32.7314 -0400",
    usedImages: [{ name: "imsg", uuid: "45f877b9-040f-32ee-b879-d572757cddf6", path: "/private/tmp/*/imsg" }],
    threads: [{ frames: [{ symbol: "closure #1 in variable initialization expression of static NSBundle.phoneNumberKit" }, { symbol: "specialized static RpcCommand.run(values:runtime:contactResolverFactory:)" }] }],
    faultingThread: 0, pid: 401, parentPid: 402, responsiblePid: 403 };
  return { header, crash, encode: () => Buffer.concat([bytes(header), bytes(crash)]) };
}
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "textbutler-legacy-reconcile-test-"))); roots.push(root); return root; }
function harness(snapshot = fixture().snapshot) {
  const calls: string[] = [], archives: Array<{ name: string; bytes: string }> = [];
  let retained = true;
  const port: ReconciliationPort = { async inspect() { calls.push("inspect"); return snapshot; },
    async archive(name, content) { calls.push("archive"); archives.push({ name, bytes: content }); },
    async release(marker) { calls.push("release"); expect(marker).toBe(snapshot.marker); retained = false; } };
  return { port, calls, archives, retained: () => retained };
}
async function diskMarker(root: string) {
  const content = bytes(fixture().marker), path = join(root, "imessage-setup-custody.json");
  await writeFile(path, content, { mode: 0o600, flag: "wx" });
  const stat = await lstat(path);
  return { path, captured: { bytes: content, sha256: sha(content), identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } } };
}

test("explicit evidence is a closed schema with no success flags, commands, or caller process claims", () => {
  const { witness } = fixture();
  expect(parseLegacySetupWitness(witness)).toEqual(witness);
  for (const changed of [{ approved: true }, { pid: 401 }, { command: "/bin/true" }, { schemaVersion: 2 }, { attemptId: "../other" }, { markerSha256: "BAD" }, { crash: { ...witness.crash, path: "relative.ips" } }]) {
    expect(() => parseLegacySetupWitness({ ...witness, ...changed })).toThrow();
  }
  expect(() => parseLegacySetupWitness({ ...witness, crash: { ...witness.crash, trusted: true } })).toThrow();
});

test("only the exact unbound, ungranted failed attempt can be reconciled", () => {
  const { marker, result, witness } = fixture();
  expect(validateLegacyAttempt(marker, result, witness)).toEqual({ startedAt: START, finishedAt: END, launchGeneration: GENERATION });
  for (const progress of [{ accountCreated: false }, { accountBound: true }, { managedEnabled: true }, { permissionsChanged: 1 }, { subjectDigest: "f".repeat(64) }]) {
    expect(() => validateLegacyAttempt(marker, { ...result, progress: { ...result.progress, ...progress } }, witness)).toThrow("reconcile-not-an-unbound-prepermission-failure");
  }
  for (const changed of [{ accountDigest: "f".repeat(64) }, { configurationDigest: "f".repeat(64) }, { attemptId: GENERATION }, { startedAt: START - 1 }, { finishedAt: START + 120_000 }, { finishedAt: START - 1 }, { automationPermission: "denied" }, { custody: "released" }, { code: "timeout" }, { ok: true }, { launchGeneration: null }, { extra: 1 }]) {
    expect(() => validateLegacyAttempt(marker, { ...result, ...changed }, witness)).toThrow();
  }
  expect(() => validateLegacyAttempt({ ...marker, attemptId: GENERATION }, result, witness)).toThrow("reconcile-attempt-binding-mismatch");
});

test("original marker, latest result and immutable original archive must all match exact bytes", () => {
  const { marker, result, witness } = fixture(), markerBytes = bytes(marker), resultBytes = bytes(result);
  expect(validateOriginalSetupEvidence(markerBytes, resultBytes, resultBytes, witness).launchGeneration).toBe(GENERATION);
  expect(() => validateOriginalSetupEvidence(Buffer.concat([markerBytes, Buffer.from(" ")]), resultBytes, resultBytes, witness)).toThrow("reconcile-original-evidence-changed");
  expect(() => validateOriginalSetupEvidence(markerBytes, Buffer.concat([resultBytes, Buffer.from(" ")]), resultBytes, witness)).toThrow("reconcile-original-evidence-changed");
  expect(() => validateOriginalSetupEvidence(markerBytes, resultBytes, bytes({ ...result, custody: "released" }), witness)).toThrow("reconcile-original-result-not-archived");
});

test("positive native crash proof binds exit, binary, startup frame, lineage and attempt time", () => {
  const f = crashFixture();
  expect(parseLegacyCrash(f.encode(), { startedAt: START, finishedAt: END })).toMatchObject({ pid: 401, parentPid: 402, responsiblePid: 403, startedAt: 1789918172373, exitedAt: 1789918172731 });
  const badCases: Array<Record<string, unknown>> = [{ parentProc: "other" }, { responsibleProc: "Terminal" }, { coalitionName: "other" }, { procExitAbsTime: f.crash.procStartAbsTime },
    { termination: { namespace: "SIGNAL", code: 9 } }, { exception: { type: "EXC_CRASH", signal: "SIGABRT" } }, { procLaunch: "2026-09-20 11:28:00.0000 -0400" },
    { captureTime: "2026-09-20 11:30:00.0000 -0400" }, { usedImages: [{ ...f.crash.usedImages[0], uuid: GENERATION }] }, { usedImages: [...f.crash.usedImages, ...f.crash.usedImages] },
    { threads: [{ frames: [{ symbol: "a different crash" }] }] }, { faultingThread: -1 }, { parentPid: 401 }, { pid: 2 ** 31 }, { incident: GENERATION }];
  for (const changed of badCases) expect(() => parseLegacyCrash(Buffer.concat([bytes(f.header), bytes({ ...f.crash, ...changed })]), { startedAt: START, finishedAt: END })).toThrow();
  expect(() => parseLegacyCrash(Buffer.from('{"app_name":"imsg","app_name":"imsg"}\n{}'), { startedAt: START, finishedAt: END })).toThrow();
});

test("readback must remain the exact unbound local iMessage locator with no permissions or subject", () => {
  const home = "/synthetic/owner", id = "synthetic-imessage", path = join(home, "Library/Messages");
  const auth = { schemaVersion: 1, id, kind: "linked-device-store", provider: "imessage", path,
    realmKey: sha(`io-linked-device-realm-v1\0${JSON.stringify({ kind: "linked-device-store", provider: "imessage", storePath: path })}`) };
  expect(() => validateUnboundAuth(auth, id, home)).not.toThrow();
  for (const changed of [{ subject: "imessage:other" }, { provider: "whatsapp" }, { id: "other" }, { path: "/synthetic/other/Library/Messages" }, { realmKey: "f".repeat(64) }, { permissions: [] }]) {
    expect(() => validateUnboundAuth({ ...auth, ...changed }, id, home)).toThrow();
  }
});

test("settlement archives positive evidence before a third identical observation and exact release", async () => {
  const f = harness();
  expect(await settleLegacySetup(f.port)).toEqual({ ok: true, status: "reconciled", attemptId: ATTEMPT });
  expect(f.calls).toEqual(["inspect", "inspect", "archive", "inspect", "release"]);
  expect(f.retained()).toBe(false);
  expect(f.archives).toHaveLength(1);
  expect(f.archives[0]!.name).toBe(`${ATTEMPT}.reconciled.json`);
  expect(Buffer.byteLength(f.archives[0]!.bytes)).toBeLessThanOrEqual(16384);
  expect(JSON.parse(f.archives[0]!.bytes)).toMatchObject({ status: "settled-failed-before-permissions", noReplay: true,
    originalMarker: fixture().marker, originalMarkerSha256: fixture().witness.markerSha256, originalMarkerIdentity: fixture().snapshot.marker.identity,
    originalResultSha256: fixture().witness.resultSha256, launchGeneration: GENERATION });
});

test("config, auth, crash, marker identity, result and witness drift before archive retain custody", async () => {
  const original = fixture().snapshot;
  const changed = [ { ...original, authSha256: "0".repeat(64) }, { ...original, resultSha256: "0".repeat(64) }, { ...original, evidenceSha256: "0".repeat(64) },
    { ...original, witness: { ...original.witness, configurationDigest: "0".repeat(64) } }, { ...original, crash: { ...original.crash, pid: 501 } },
    { ...original, marker: { ...original.marker, identity: { ...original.marker.identity, ino: 99 } } } ];
  for (const replacement of changed) {
    const f = harness(original); let reads = 0;
    f.port.inspect = async () => ++reads === 1 ? original : replacement;
    await expect(settleLegacySetup(f.port)).rejects.toThrow("reconcile-observation-drift");
    expect(f.retained()).toBe(true); expect(f.archives).toHaveLength(0);
  }
});

test("drift after durable archive never releases the marker and retains the settlement evidence", async () => {
  const original = fixture().snapshot, f = harness(original); let reads = 0;
  f.port.inspect = async () => ++reads < 3 ? original : { ...original, authSha256: "0".repeat(64) };
  await expect(settleLegacySetup(f.port)).rejects.toThrow("reconcile-observation-drift-after-archive");
  expect(f.retained()).toBe(true); expect(f.archives).toHaveLength(1);
});

test("any unproven observation or failed settlement publication keeps the original marker", async () => {
  for (const failAt of [1, 2, 3]) {
    const f = harness(); let reads = 0;
    f.port.inspect = async () => { if (++reads === failAt) throw new Error("synthetic quiescence unproven"); return fixture().snapshot; };
    await expect(settleLegacySetup(f.port)).rejects.toThrow("synthetic quiescence unproven");
    expect(f.retained()).toBe(true); expect(f.archives).toHaveLength(failAt === 3 ? 1 : 0);
  }
  const f = harness(); f.port.archive = async () => { throw new Error("synthetic archive publication failed"); };
  await expect(settleLegacySetup(f.port)).rejects.toThrow("synthetic archive publication failed");
  expect(f.retained()).toBe(true); expect(f.calls).not.toContain("release");
});

test("original archive corruption aborts without changing marker or latest result", async () => {
  const root = await temporary(), disk = await diskMarker(root), { marker, result, witness } = fixture();
  const resultPath = join(root, "imessage-setup-result.json"), originalPath = join(root, `${ATTEMPT}.recovery-required.json`);
  await writeFile(resultPath, bytes(result), { mode: 0o600 });
  await writeFile(originalPath, bytes({ ...result, custody: "released" }), { mode: 0o600 });
  const f = harness(); f.port.inspect = async () => { validateOriginalSetupEvidence(bytes(marker), await readFile(resultPath), await readFile(originalPath), witness); return fixture().snapshot; };
  await expect(settleLegacySetup(f.port)).rejects.toThrow("reconcile-original-result-not-archived");
  expect(await readFile(disk.path)).toEqual(disk.captured.bytes); expect(await readFile(resultPath)).toEqual(bytes(result));
  expect(f.archives).toHaveLength(0); expect(f.calls).not.toContain("release");
});

test("write-once settlement conflict preserves both conflicting record and original marker", async () => {
  const root = await temporary(), disk = await diskMarker(root), archive = join(root, "archive"); await mkdir(archive, { mode: 0o700 });
  const f = harness(), name = `${ATTEMPT}.reconciled.json`, prior = bytes({ schemaVersion: 1, kind: "other-settlement" });
  await writeFile(join(archive, name), prior, { mode: 0o600, flag: "wx" });
  f.port.archive = async (name_, proposed) => { if (await createPrivateFileOnce(archive, name_, proposed) !== "created") validateExistingSettlement(await readFile(join(archive, name_)), proposed); };
  f.port.release = async () => { await releaseLegacyMarker(root, disk.captured); };
  await expect(settleLegacySetup(f.port)).rejects.toThrow();
  expect(await readFile(disk.path)).toEqual(disk.captured.bytes); expect(await readFile(join(archive, name))).toEqual(prior);
});

test("an interrupted exact settlement accepts only its original write-once receipt without rewriting", async () => {
  const f = harness(); f.port.release = async () => { throw new Error("synthetic interruption after durable archive"); };
  await expect(settleLegacySetup(f.port)).rejects.toThrow("synthetic interruption");
  const original = f.archives[0]!.bytes, parsed = JSON.parse(original) as Record<string, unknown>;
  expect(() => validateExistingSettlement(Buffer.from(original), JSON.stringify({ ...parsed, reconciledAt: Date.now() + 10 }))).not.toThrow();
  for (const changed of [{ originalResultSha256: "0".repeat(64) }, { accountDigest: "0".repeat(64) }, { reconciledAt: Date.now() + 60_000 }, { extra: true }, { noReplay: false }]) {
    expect(() => validateExistingSettlement(bytes({ ...parsed, ...changed }), original)).toThrow();
  }
  const retry = harness(); retry.port.archive = async (_name, proposed) => validateExistingSettlement(Buffer.from(original), proposed);
  expect(await settleLegacySetup(retry.port)).toMatchObject({ status: "reconciled" });
  expect(original).toBe(f.archives[0]!.bytes);
});

test("exact marker release leaves every original result and unrelated entry intact", async () => {
  const root = await temporary(), disk = await diskMarker(root), result = bytes(fixture().result);
  const latest = join(root, "imessage-setup-result.json"), original = join(root, `${ATTEMPT}.recovery-required.json`);
  await writeFile(latest, result, { mode: 0o600 }); await writeFile(original, result, { mode: 0o600 });
  await releaseLegacyMarker(root, disk.captured);
  await expect(lstat(disk.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(latest)).toEqual(result); expect(await readFile(original)).toEqual(result);
});

test("replacement inode, changed bytes, symlinks or unsafe mode can never be released", async () => {
  for (const mode of ["replacement", "bytes", "symlink", "mode"]) {
    const root = await temporary(), disk = await diskMarker(root);
    if (mode === "replacement") { await rename(disk.path, `${disk.path}.old`); await writeFile(disk.path, disk.captured.bytes, { mode: 0o600 }); }
    if (mode === "bytes") await writeFile(disk.path, Buffer.concat([disk.captured.bytes, Buffer.from(" ")]));
    if (mode === "symlink") { await rename(disk.path, `${disk.path}.old`); await symlink(`${disk.path}.old`, disk.path); }
    if (mode === "mode") await chmod(disk.path, 0o644);
    await expect(releaseLegacyMarker(root, disk.captured)).rejects.toThrow();
    expect(await lstat(disk.path)).toBeDefined();
  }
});

test("settlement history reserves one of 256 entries and counts hidden entries", async () => {
  const root = await temporary();
  await expect(requireReconciliationHistorySpace(root)).resolves.toBeUndefined();
  for (let index = 0; index < 255; index++) await writeFile(join(root, `.synthetic-${index}`), "{}", { mode: 0o600 });
  await expect(requireReconciliationHistorySpace(root)).resolves.toBeUndefined();
  await writeFile(join(root, ".entry-256"), "{}", { mode: 0o600 });
  await expect(requireReconciliationHistorySpace(root)).rejects.toThrow("reconcile-history-full");
});

test("CLI admits only two explicit absolute paths and no recovery, command or override flags", () => {
  expect(parseReconcileArgs(["--data-dir", "/private/synthetic-data", "--evidence", "/private/synthetic-evidence.json"])).toEqual({ dataDir: "/private/synthetic-data", evidence: "/private/synthetic-evidence.json" });
  for (const args of [[], ["--data-dir", "relative", "--evidence", "/private/evidence"], ["--data-dir", "/private/data", "--evidence", "/private/evidence", "--force"],
    ["--evidence", "/private/evidence", "--data-dir", "/private/data"], ["--data-dir", "/private/data", "--command", "/bin/true"]]) expect(() => parseReconcileArgs(args)).toThrow();
});
