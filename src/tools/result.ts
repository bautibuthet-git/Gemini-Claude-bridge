import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, ERROR_HINTS, errorMessage, type BridgeErrorType } from "../util/errors.js";

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structuredContent) result.structuredContent = structuredContent;
  return result;
}

/** Tool-level failure: a clear errorType plus a next step for Claude, never a raw crash. */
export function errorResult(
  type: BridgeErrorType,
  message: string,
  details: Record<string, unknown> = {},
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Gemini bridge error (${type}): ${message}\nNext step: ${ERROR_HINTS[type]}` }],
    structuredContent: { ok: false, errorType: type, message, ...details },
  };
}

export function toBridgeError(err: unknown): BridgeError {
  return err instanceof BridgeError ? err : new BridgeError("gemini_error", errorMessage(err));
}

/** Prepends the one-time "state file was corrupt and got reset" warning, if there is one. */
export function withWarning(result: CallToolResult, warning: string | null): CallToolResult {
  if (!warning) return result;
  return { ...result, content: [{ type: "text", text: `Warning: ${warning}` }, ...result.content] };
}
