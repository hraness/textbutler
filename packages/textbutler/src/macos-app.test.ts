import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appFileDigest, MACOS_APP_BUNDLE_ID, macosAppReceiptPath, parseMacosAppIdentity, readInstalledMacosApp, readMacosAppReceipt, verifyMacosApp, type MacosAppIdentity } from "./macos-app.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(await realpath("/tmp"), "tb-app-")); roots.push(root);
  const home = join(root, "home"), dataDir = join(root, "data"), appPath = join(home, "Applications", "TextButler.app"), runtime = join(root, "runtime"), entrypoint = join(root, "entrypoint");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true, mode: 0o700 }); await mkdir(join(appPath, "Contents", "_CodeSignature"), { mode: 0o700 }); await mkdir(join(dataDir, "state"), { recursive: true, mode: 0o700 });
  const files = [runtime, entrypoint, join(appPath, "Contents", "MacOS", "TextButler"), join(appPath, "Contents", "Info.plist"), join(appPath, "Contents", "_CodeSignature", "CodeResources")];
  for (const file of files) await writeFile(file, `synthetic ${file}`, { mode: 0o700 });
  const identity: MacosAppIdentity = { schemaVersion: 1, bundleId: MACOS_APP_BUNDLE_ID, signing: "ad-hoc", messagesBundleId: "com.apple.MobileSMS", automationConsent: "native-api", appPath, home, dataDir, runtime, entrypoint,
    runtimeSha256: await appFileDigest(runtime), entrypointSha256: await appFileDigest(entrypoint), executableSha256: await appFileDigest(files[2]!), infoPlistSha256: await appFileDigest(files[3]!), signatureSha256: await appFileDigest(files[4]!), sourceSha256: "a".repeat(64) };
  const receipt = macosAppReceiptPath(dataDir); await writeFile(receipt, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  return { root, identity, receipt, expected: { home, dataDir, runtime, entrypoint } };
}
test("private installed app receipt binds exact app and payload bytes", async () => {
  const f = await fixture(); expect(await readInstalledMacosApp(f.expected)).toEqual(f.identity);
  await writeFile(f.identity.entrypoint, "changed admitted entrypoint");
  await expect(readInstalledMacosApp(f.expected)).rejects.toThrow("changed");
});
test("missing app admission is distinct from invalid admission", async () => {
  const f = await fixture(); await rm(f.receipt); expect(await readInstalledMacosApp(f.expected)).toBeNull();
  await writeFile(f.receipt, "{}", { mode: 0o600 }); await expect(readInstalledMacosApp(f.expected)).rejects.toThrow("identity");
});
test("app receipt cannot add fields, redirect executable identity, or change owner binding", async () => {
  const f = await fixture(); expect(() => parseMacosAppIdentity({ ...f.identity, command: "/bin/sh" })).toThrow();
  expect(() => parseMacosAppIdentity({ ...f.identity, appPath: join(f.identity.home, "Other.app") })).toThrow();
  await expect(readInstalledMacosApp({ ...f.expected, entrypoint: join(f.root, "other-entrypoint") })).rejects.toThrow();
  await expect(readInstalledMacosApp({ ...f.expected, dataDir: join(f.root, "other-data") })).resolves.toBeNull();
});
test("app receipt admits only the two known signing classes", async () => {
  const f = await fixture();
  expect(parseMacosAppIdentity({ ...f.identity, signing: "certificate" }).signing).toBe("certificate");
  expect(() => parseMacosAppIdentity({ ...f.identity, signing: "developer-id" })).toThrow();
});
test("app verification rejects added code, linked receipts and shared writable artifacts", async () => {
  const f = await fixture(), contents = await readFile(f.receipt);
  await writeFile(join(f.identity.appPath, "Contents", "MacOS", "extra"), "unknown code", { mode: 0o700 });
  await expect(verifyMacosApp(f.identity)).rejects.toThrow(); await rm(join(f.identity.appPath, "Contents", "MacOS", "extra"));
  await chmod(f.identity.runtime, 0o777); await expect(verifyMacosApp(f.identity)).rejects.toThrow(); await chmod(f.identity.runtime, 0o700);
  const target = join(f.root, "receipt-target"); await writeFile(target, contents, { mode: 0o600 }); await rm(f.receipt); await symlink(target, f.receipt);
  await expect(readMacosAppReceipt(f.receipt)).rejects.toThrow(); await rm(f.receipt); await writeFile(f.receipt, contents, { mode: 0o644 });
  await expect(readMacosAppReceipt(f.receipt)).rejects.toThrow();
});
test("an app built with the icon binds its Resources folder; older apps without one still verify", async () => {
  const f = await fixture();
  await verifyMacosApp(f.identity);
  const resources = join(f.identity.appPath, "Contents", "Resources"), icon = join(resources, "AppIcon.icns");
  // Without iconSha256 in the receipt, an added Resources folder is unadmitted code.
  await mkdir(resources, { mode: 0o700 }); await writeFile(icon, "icns synthetic", { mode: 0o600 });
  await expect(verifyMacosApp(f.identity)).rejects.toThrow("identity");
  const withIcon = parseMacosAppIdentity({ ...f.identity, iconSha256: await appFileDigest(icon) });
  await verifyMacosApp(withIcon);
  await writeFile(join(resources, "Extra.icns"), "extra", { mode: 0o600 });
  await expect(verifyMacosApp(withIcon)).rejects.toThrow("identity");
  await rm(join(resources, "Extra.icns")); await writeFile(icon, "icns changed", { mode: 0o600 });
  await expect(verifyMacosApp(withIcon)).rejects.toThrow("identity");
  expect(() => parseMacosAppIdentity({ ...f.identity, iconSha256: "not-a-digest" })).toThrow();
});
