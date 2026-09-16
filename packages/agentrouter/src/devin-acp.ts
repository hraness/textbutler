import { Transform } from "node:stream";
import { boundedText, identifier, safeInteger } from "./validation.ts";

/** Bounded ACP v1 codec. Every inbound frame is withheld until its byte bound,
 * UTF-8, JSON object and JSON-RPC envelope pass; malformed recognized frames
 * close the client rather than being parsed hopefully. */
export const DEVIN_ACP_MAX_FRAME_BYTES = 1024 * 1024;
export const DEVIN_ACP_MAX_PROMPT_BYTES = 256 * 1024;
export const DEVIN_ACP_PROTOCOL_VERSION = 1;

export type DevinAcpError = Readonly<{ code: number; message: string }>;
export type DevinAcpInbound =
  | Readonly<{ kind: "request"; id: string | number; method: string; params: unknown }>
  | Readonly<{ kind: "notification"; method: string; params: unknown }>
  | Readonly<{ kind: "response"; id: string | number; result: unknown }>
  | Readonly<{ kind: "errorResponse"; id: string | number; error: DevinAcpError }>;

export type DevinStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type DevinPermissionOutcome =
  | Readonly<{ outcome: "cancelled" }>
  | Readonly<{ outcome: "selected"; optionId: string }>;
export type DevinPermissionOption = Readonly<{ optionId: string; name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }>;
export type DevinPermissionRequest = Readonly<{
  requestId: string;
  sessionId: string;
  toolCall: Readonly<{ toolCallId: string; title: string | null; kind: string | null; status: string | null }>;
  options: readonly DevinPermissionOption[];
}>;
export type DevinFact =
  | Readonly<{ type: "assistantDelta"; sessionId: string; text: string }>
  | Readonly<{ type: "usageUpdated"; sessionId: string; used: number; size: number;
      inputTokens: number | null; outputTokens: number | null }>
  | Readonly<{ type: "protocolNotice"; sessionId: string | null; method: string }>;

export type DevinSessionConfigOption = Readonly<{ id: string; currentValue: string }>;
export type DevinNewSession = Readonly<{ sessionId: string; currentMode: string | null;
  configOptions: readonly DevinSessionConfigOption[] }>;
export type DevinPromptUsage = Readonly<{ totalTokens: number | null; inputTokens: number | null;
  outputTokens: number | null }>;
export type DevinPromptResult = Readonly<{ stopReason: DevinStopReason; usage: DevinPromptUsage | null }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const code = (c: string): Error => new Error(`DEVIN_ACP_${c}`);
const record = (value: unknown, c: string): Record<string, unknown> =>
  isRecord(value) ? value : (() => { throw code(c); })();
const acpIdentifier = (value: unknown, c: string): string => {
  const text = boundedText(value, 256);
  if (/\p{C}/u.test(text)) throw code(c);
  return text;
};
const acpId = (value: unknown): string | number => typeof value === "number"
  ? safeInteger(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  : acpIdentifier(value, "ID_INVALID");
const optionalNumber = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER);
};

/** Splits a provider byte stream into validated single-line ACP frames. The
 * last partial line is still validated; a missing trailing LF is not evidence. */
export function devinAcpFraming(maximumFrameBytes = DEVIN_ACP_MAX_FRAME_BYTES): Transform {
  safeInteger(maximumFrameBytes, 1024, 16 * 1024 * 1024);
  let pending: Buffer = Buffer.alloc(0);
  const emit = (line: Buffer, push: (chunk: Buffer) => void): void => {
    if (line.byteLength > maximumFrameBytes) throw code("FRAME_LIMIT");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(line).trim(); }
    catch { throw code("FRAME_ENCODING"); }
    if (text.length === 0) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw code("FRAME_JSON"); }
    if (!isRecord(value)) throw code("FRAME_SHAPE");
    push(line);
  };
  // readableObjectMode keeps each validated frame a discrete item; byte-mode
  // reads may coalesce consecutive pushes and would hide frame boundaries.
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding, callback) {
      try {
        let start = 0;
        for (let index = 0; index < chunk.byteLength; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          const line = pending.byteLength === 0 ? chunk.subarray(start, index)
            : Buffer.concat([pending, chunk.subarray(start, index)]);
          emit(line, frame => this.push(frame));
          pending = Buffer.alloc(0);
          start = index + 1;
        }
        pending = pending.byteLength === 0 ? chunk.subarray(start) : Buffer.concat([pending, chunk.subarray(start)]);
        if (pending.byteLength > maximumFrameBytes) throw code("FRAME_LIMIT");
        callback();
      } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try { emit(pending, frame => this.push(frame)); pending = Buffer.alloc(0); callback(); }
      catch (error) { callback(error as Error); }
    },
  });
}

export function parseAcpInbound(value: unknown): DevinAcpInbound {
  if (Array.isArray(value)) throw code("BATCH_UNSUPPORTED");
  const message = record(value, "ENVELOPE");
  if (message.jsonrpc !== "2.0") throw code("ENVELOPE_VERSION");
  const hasMethod = Object.hasOwn(message, "method"), hasId = Object.hasOwn(message, "id");
  const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
  if (hasMethod) {
    const method = acpIdentifier(message.method, "METHOD_INVALID");
    if (hasResult || hasError) throw code("CALL_WITH_RESPONSE");
    if (!hasId) return Object.freeze({ kind: "notification", method, params: message.params });
    if (message.id === null) throw code("ID_INVALID");
    return Object.freeze({ kind: "request", id: acpId(message.id), method, params: message.params });
  }
  if (!hasId || hasResult === hasError || message.id === null) throw code("RESPONSE_MALFORMED");
  const id = acpId(message.id);
  if (hasResult) return Object.freeze({ kind: "response", id, result: message.result });
  const error = record(message.error, "ERROR_SHAPE");
  return Object.freeze({ kind: "errorResponse", id, error: Object.freeze({
    code: safeInteger(error.code, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    message: boundedText(error.message, 4 * 1024, true),
  }) });
}

export function parseInitializeResult(value: unknown): Readonly<{ protocolVersion: number; loadSession: boolean }> {
  const result = record(value, "INITIALIZE_RESULT");
  if (result.protocolVersion !== DEVIN_ACP_PROTOCOL_VERSION) throw code("PROTOCOL_MISMATCH");
  let loadSession = false;
  if (result.agentCapabilities !== undefined) {
    const capabilities = record(result.agentCapabilities, "CAPABILITIES");
    if (capabilities.loadSession !== undefined && typeof capabilities.loadSession !== "boolean") throw code("CAPABILITY_INVALID");
    loadSession = capabilities.loadSession === true;
  }
  return Object.freeze({ protocolVersion: DEVIN_ACP_PROTOCOL_VERSION, loadSession });
}

const MODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export function parseNewSessionResult(value: unknown): DevinNewSession {
  const result = record(value, "NEW_SESSION_RESULT");
  const sessionId = acpIdentifier(result.sessionId, "SESSION_ID_INVALID");
  let currentMode: string | null = null;
  const options: DevinSessionConfigOption[] = [];
  if (result.modes !== undefined && result.modes !== null) {
    const modes = record(result.modes, "MODES");
    if (modes.currentModeId !== undefined && modes.currentModeId !== null)
      currentMode = acpIdentifier(modes.currentModeId, "MODE_INVALID");
  }
  if (result.configOptions !== undefined && result.configOptions !== null) {
    if (!Array.isArray(result.configOptions) || result.configOptions.length > 32) throw code("CONFIG_OPTIONS");
    for (const raw of result.configOptions) {
      const option = record(raw, "CONFIG_OPTION");
      const id = acpIdentifier(option.id, "CONFIG_OPTION_ID");
      if (option.type !== undefined && option.type !== "select") continue;
      const current = option.currentValue === undefined || option.currentValue === null ? null
        : acpIdentifier(option.currentValue, "CONFIG_OPTION_VALUE");
      if (current !== null) options.push(Object.freeze({ id, currentValue: current }));
    }
  }
  return Object.freeze({ sessionId, currentMode, configOptions: Object.freeze(options) });
}

const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
export function parsePromptResult(value: unknown): DevinPromptResult {
  const result = record(value, "PROMPT_RESULT");
  const reason = result.stopReason;
  if (typeof reason !== "string" || !STOP_REASONS.includes(reason as DevinStopReason)) throw code("STOP_REASON");
  let usage: DevinPromptUsage | null = null;
  if (result.usage !== undefined && result.usage !== null) {
    const u = record(result.usage, "PROMPT_USAGE");
    usage = Object.freeze({ totalTokens: optionalNumber(u.totalTokens),
      inputTokens: optionalNumber(u.inputTokens), outputTokens: optionalNumber(u.outputTokens) });
  }
  return Object.freeze({ stopReason: reason as DevinStopReason, usage });
}

export function parseSessionUpdate(value: unknown): readonly DevinFact[] {
  const params = record(value, "UPDATE_PARAMS");
  const sessionId = acpIdentifier(params.sessionId, "SESSION_ID_INVALID");
  const update = record(params.update, "UPDATE");
  const type = acpIdentifier(update.sessionUpdate, "UPDATE_TYPE");
  if (type === "agent_message_chunk") {
    const content = record(update.content, "UPDATE_CONTENT");
    if (content.type !== "text") return [Object.freeze({ type: "protocolNotice", sessionId, method: `session/update:${type}` })];
    return [Object.freeze({ type: "assistantDelta", sessionId, text: boundedText(content.text, 64 * 1024, true) })];
  }
  if (type === "usage_update") {
    return [Object.freeze({ type: "usageUpdated", sessionId,
      used: safeInteger(update.used, 0, Number.MAX_SAFE_INTEGER),
      size: safeInteger(update.size, 0, Number.MAX_SAFE_INTEGER),
      inputTokens: optionalNumber(update.inputTokens), outputTokens: optionalNumber(update.outputTokens) })];
  }
  return [Object.freeze({ type: "protocolNotice", sessionId, method: `session/update:${type}` })];
}

const PERMISSION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;
export function parsePermissionRequest(requestId: string | number, value: unknown): DevinPermissionRequest {
  const params = record(value, "PERMISSION_PARAMS");
  const toolCall = record(params.toolCall, "PERMISSION_TOOL_CALL");
  const toolCallId = acpIdentifier(toolCall.toolCallId, "TOOL_CALL_ID");
  const title = toolCall.title === undefined || toolCall.title === null ? null : boundedText(toolCall.title, 4 * 1024, true);
  const kind = toolCall.kind === undefined || toolCall.kind === null ? null : acpIdentifier(toolCall.kind, "TOOL_KIND");
  const status = toolCall.status === undefined || toolCall.status === null ? null : acpIdentifier(toolCall.status, "TOOL_STATUS");
  if (!Array.isArray(params.options) || params.options.length === 0 || params.options.length > 16) throw code("PERMISSION_OPTIONS");
  const options = params.options.map((raw): DevinPermissionOption => {
    const option = record(raw, "PERMISSION_OPTION");
    const optionId = acpIdentifier(option.optionId, "PERMISSION_OPTION_ID");
    const name = boundedText(option.name, 256);
    const kind = option.kind;
    if (typeof kind !== "string" || !PERMISSION_KINDS.includes(kind as typeof PERMISSION_KINDS[number])) throw code("PERMISSION_KIND");
    return Object.freeze({ optionId, name, kind: kind as DevinPermissionOption["kind"] });
  });
  if (new Set(options.map(option => option.optionId)).size !== options.length) throw code("PERMISSION_OPTIONS");
  return Object.freeze({ requestId: typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`,
    sessionId: acpIdentifier(params.sessionId, "SESSION_ID_INVALID"),
    toolCall: Object.freeze({ toolCallId, title, kind, status }), options: Object.freeze(options) });
}

export function validatePermissionOutcome(value: unknown, options: readonly DevinPermissionOption[]): DevinPermissionOutcome {
  if (!isRecord(value) || (value.outcome !== "cancelled" && value.outcome !== "selected")) throw code("PERMISSION_OUTCOME");
  if (value.outcome === "cancelled") return Object.freeze({ outcome: "cancelled" });
  const optionId = identifier(value.optionId);
  if (!options.some(option => option.optionId === optionId)) throw code("PERMISSION_OPTION_UNKNOWN");
  return Object.freeze({ outcome: "selected", optionId });
}

/** Chooses the first reject option; absent one, cancels the request. The host's
 * allow decision must come from its own policy callback, never from the frame. */
export function denyPermissionOutcome(options: readonly DevinPermissionOption[]): DevinPermissionOutcome {
  const reject = options.find(option => option.kind === "reject_once") ?? options.find(option => option.kind === "reject_always");
  return reject === undefined ? Object.freeze({ outcome: "cancelled" })
    : Object.freeze({ outcome: "selected", optionId: reject.optionId });
}

export function boundedDevinPrompt(value: unknown): string {
  return boundedText(value, DEVIN_ACP_MAX_PROMPT_BYTES);
}
export function boundedDevinSessionId(value: unknown): string {
  return identifier(value);
}
export function devinModeId(value: unknown): string {
  const text = acpIdentifier(value, "MODE_INVALID");
  if (!MODE_ID.test(text)) throw code("MODE_INVALID");
  return text;
}
