import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MACOS_APP_BUNDLE_ID = "app.textbutler.desktop";
export const MACOS_APP_ICON_MAXIMUM = 1024 * 1024;
export interface MacosAppIdentity {
  schemaVersion: 1;
  bundleId: typeof MACOS_APP_BUNDLE_ID;
  signing: "ad-hoc" | "certificate";
  messagesBundleId: "com.apple.MobileSMS" | "com.apple.iChat";
  automationConsent: "native-api" | "synthetic";
  appPath: string;
  home: string;
  dataDir: string;
  runtime: string;
  entrypoint: string;
  runtimeSha256: string;
  entrypointSha256: string;
  executableSha256: string;
  infoPlistSha256: string;
  signatureSha256: string;
  sourceSha256: string;
  /** Contents/Resources/AppIcon.icns. Apps built before the icon have none. */
  iconSha256?: string;
}
const PATH_KEYS = ["appPath", "home", "dataDir", "runtime", "entrypoint"] as const;
const HASH_KEYS = ["runtimeSha256", "entrypointSha256", "executableSha256", "infoPlistSha256", "signatureSha256", "sourceSha256"] as const;
const BASE_KEYS = ["schemaVersion", "bundleId", "signing", "messagesBundleId", "automationConsent", ...PATH_KEYS, ...HASH_KEYS];
const KEYS = [BASE_KEYS.sort().join(","), [...BASE_KEYS, "iconSha256"].sort().join(",")];
function fail(): never { throw new Error("The TextButler app identity is missing, changed, or unsafe. Preserve it and reinstall the verified app before starting its service."); }
export function macosAppPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f{}"\\]/u.test(value)) fail();
  return value;
}
export function parseMacosAppIdentity(value: unknown): MacosAppIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (!KEYS.includes(Object.keys(row).sort().join(",")) || row.schemaVersion !== 1 || row.bundleId !== MACOS_APP_BUNDLE_ID || !["ad-hoc", "certificate"].includes(String(row.signing)) || !["com.apple.MobileSMS", "com.apple.iChat"].includes(String(row.messagesBundleId)) || !["native-api", "synthetic"].includes(String(row.automationConsent))) fail();
  for (const key of PATH_KEYS) macosAppPath(row[key]);
  for (const key of [...HASH_KEYS, ...("iconSha256" in row ? ["iconSha256"] : [])]) if (typeof row[key] !== "string" || !/^[a-f0-9]{64}$/u.test(row[key] as string)) fail();
  if (row.appPath !== join(String(row.home), "Applications", "TextButler.app")) fail();
  return Object.freeze({ ...row }) as unknown as MacosAppIdentity;
}
export const macosAppExecutable = (identity: Pick<MacosAppIdentity, "appPath">): string => join(identity.appPath, "Contents", "MacOS", "TextButler");
export const macosAppReceiptPath = (dataDir: string): string => join(dataDir, "state", "macos-app.json");
export function macosLaunchGeneration(stdout: string): string | null {
  const lines = stdout.split("\n").map(line => line.trim()), start = lines.indexOf("environment = {"), end = lines.indexOf("}", start + 1);
  if (start < 0 || end < 0 || lines.lastIndexOf("environment = {") !== start) return null;
  const values = lines.slice(start + 1, end).filter(line => line.startsWith("TEXTBUTLER_LAUNCH_AGENT_GENERATION => "));
  if (values.length !== 1) return null;
  const generation = values[0]!.slice("TEXTBUTLER_LAUNCH_AGENT_GENERATION => ".length);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(generation) ? generation : null;
}

export async function appPhysicalDirectory(path: string, ownerOnly = false): Promise<void> {
  macosAppPath(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) || ownerOnly && info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || await realpath(path) !== path) fail();
}
/** Stream hashes without exposing payload bytes or trusting pathname-only checks. */
export async function appFileDigest(path: string, options: { maximum?: number; executable?: boolean; private?: boolean } = {}): Promise<string> {
  macosAppPath(path); await appPhysicalDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(), maximum = options.maximum ?? 512 * 1024 * 1024;
    if (!before.isFile() || before.nlink !== 1 || ![0, process.getuid?.()].includes(before.uid) || before.size < 1 || before.size > maximum || (before.mode & 0o022) !== 0 || options.executable && !(before.mode & 0o111) || options.private && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) || await realpath(path) !== path) fail();
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < before.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset); if (bytesRead < 1) fail(); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    const after = await handle.stat(), current = await lstat(path);
    for (const key of ["dev", "ino", "size", "uid", "gid", "mode", "nlink", "mtimeMs", "ctimeMs"] as const) if (before[key] !== after[key] || after[key] !== current[key]) fail();
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function inventory(path: string, expected: readonly string[]): Promise<void> {
  await appPhysicalDirectory(path, true);
  if (JSON.stringify((await readdir(path)).sort()) !== JSON.stringify([...expected].sort())) fail();
}
/** The override is used only while the installer verifies its unpublished app. */
export async function verifyMacosApp(identity: MacosAppIdentity, physicalAppPath = identity.appPath): Promise<void> {
  parseMacosAppIdentity(identity);
  await inventory(physicalAppPath, ["Contents"]);
  const icon = identity.iconSha256;
  await inventory(join(physicalAppPath, "Contents"), ["Info.plist", "MacOS", "_CodeSignature", ...(icon === undefined ? [] : ["Resources"])]);
  if (icon !== undefined) await inventory(join(physicalAppPath, "Contents", "Resources"), ["AppIcon.icns"]);
  await inventory(join(physicalAppPath, "Contents", "MacOS"), ["TextButler"]);
  await inventory(join(physicalAppPath, "Contents", "_CodeSignature"), ["CodeResources"]);
  const files = [
    [identity.runtime, identity.runtimeSha256, true],
    [identity.entrypoint, identity.entrypointSha256, false],
    [join(physicalAppPath, "Contents", "MacOS", "TextButler"), identity.executableSha256, true],
    [join(physicalAppPath, "Contents", "Info.plist"), identity.infoPlistSha256, false],
    [join(physicalAppPath, "Contents", "_CodeSignature", "CodeResources"), identity.signatureSha256, false],
  ] as const;
  for (const [file, expected, executable] of files) if (await appFileDigest(file, { executable }) !== expected) fail();
  if (icon !== undefined && await appFileDigest(join(physicalAppPath, "Contents", "Resources", "AppIcon.icns"), { maximum: MACOS_APP_ICON_MAXIMUM }) !== icon) fail();
}
export async function readMacosAppReceipt(path: string): Promise<MacosAppIdentity> {
  macosAppPath(path); await appPhysicalDirectory(dirname(path), true);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 65536 || await realpath(path) !== path) fail();
    const bytes = Buffer.alloc(65537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat(), current = await lstat(path);
    if (bytesRead !== before.size) fail();
    for (const key of ["dev", "ino", "size", "uid", "gid", "mode", "nlink", "mtimeMs", "ctimeMs"] as const) if (before[key] !== after[key] || after[key] !== current[key]) fail();
    return parseMacosAppIdentity(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
  } finally { await handle.close(); }
}
export async function readInstalledMacosApp(expected: { home: string; dataDir: string; runtime: string; entrypoint: string }): Promise<MacosAppIdentity | null> {
  const receiptPath = macosAppReceiptPath(expected.dataDir);
  try { await lstat(receiptPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const identity = await readMacosAppReceipt(receiptPath);
  if (identity.automationConsent !== "native-api") fail();
  for (const key of ["home", "dataDir", "runtime", "entrypoint"] as const) if (identity[key] !== expected[key]) fail();
  await verifyMacosApp(identity);
  return identity;
}
