import { exact, object } from "./validation.ts";

/** Closed owner diagnostics. Never retain provider messages or response data. */
const STAGES = {
  "remote-invalid-request": "provider",
  "remote-not-ready": "provider",
  "remote-unavailable": "provider",
  "remote-recovery-required": "provider",
  "response-schema": "response-schema",
  "transport-unavailable": "transport",
  "queue-capacity": "transport",
  unknown: "unknown",
} as const;
export type AutomationFailureCode = keyof typeof STAGES;
const NATIVE_PHASES = ["admission", "native-preflight", "native-status", "native-chats", "native-projection", "reauthorization", "native-finalization", "host-status", "host-identity", "host-response"] as const;
const NATIVE_CODES = ["failed", "cancelled", "deadline", "cleanup-unverified", "process-failed", "process-stderr", "streams-failed", "response-invalid", "rpc-rejected", "rpc-invalid-params", "rpc-method-unavailable", "schema-invalid", "coordinate-invalid", "identity-changed", "database-unreadable"] as const;
export type NativeDiscoveryDiagnostic = Readonly<{ phase: typeof NATIVE_PHASES[number]; code: typeof NATIVE_CODES[number] }>;
export type AutomationFailure = Readonly<{ stage: typeof STAGES[AutomationFailureCode]; code: AutomationFailureCode; native?: NativeDiscoveryDiagnostic }>;

function parseNativeDiscoveryDiagnostic(value: unknown): NativeDiscoveryDiagnostic {
  const row = object(value); exact(row, ["phase", "code"]);
  const phase = NATIVE_PHASES.find(phase => phase === row.phase), code = NATIVE_CODES.find(code => code === row.code);
  if (phase === undefined || code === undefined) throw new Error("Unknown native discovery diagnostic");
  return { phase, code };
}

function nativeDiscoveryMarker(value: unknown): NativeDiscoveryDiagnostic | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const match = /^ghostget\.discovery\.v1:([a-z-]+):([a-z-]+)$/u.exec(value);
  if (!match || match[0] !== value) return undefined;
  try { return parseNativeDiscoveryDiagnostic({ phase: match[1], code: match[2] }); }
  catch { return undefined; }
}

export class AutomationOperationError extends Error {
  constructor(readonly code: AutomationFailureCode, readonly native?: NativeDiscoveryDiagnostic) {
    super(`Ghostget automation ${code}`);
    this.name = "AutomationOperationError";
  }
}

export function automationRemoteError(code: unknown, message?: unknown): AutomationOperationError {
  switch (code) {
    case "invalid-request": return new AutomationOperationError("remote-invalid-request");
    case "not-ready": return new AutomationOperationError("remote-not-ready");
    case "unavailable": return new AutomationOperationError("remote-unavailable", nativeDiscoveryMarker(message));
    case "recovery-required": return new AutomationOperationError("remote-recovery-required");
    default: throw new Error("Ghostget error contract changed");
  }
}

export function automationFailure(error: unknown): AutomationFailure {
  const code = error instanceof AutomationOperationError && Object.hasOwn(STAGES, error.code) ? error.code : "unknown";
  try { return parseAutomationFailure({ stage: STAGES[code], code,
    ...(error instanceof AutomationOperationError && error.native !== undefined ? { native: error.native } : {}) }); }
  catch { return { stage: "unknown", code: "unknown" }; }
}

export function parseAutomationFailure(value: unknown): AutomationFailure {
  const row = object(value); exact(row, ["stage", "code", ...(Object.hasOwn(row, "native") ? ["native"] : [])]);
  if (typeof row.code !== "string" || !Object.hasOwn(STAGES, row.code)) throw new Error("Unknown automation diagnostic");
  const code = row.code as AutomationFailureCode;
  if (row.stage !== STAGES[code]) throw new Error("Inconsistent automation diagnostic");
  if (Object.hasOwn(row, "native") && code !== "remote-unavailable") throw new Error("Unexpected native discovery diagnostic");
  return { stage: STAGES[code], code, ...(Object.hasOwn(row, "native") ? { native: parseNativeDiscoveryDiagnostic(row.native) } : {}) };
}
