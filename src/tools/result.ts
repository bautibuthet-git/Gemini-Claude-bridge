import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asBridgeError, ERROR_HINTS, type BridgeError, type BridgeErrorType } from "../util/errors.js";

/**
 * Claude Code hands the model a tool's `structuredContent` INSTEAD of its text blocks, so
 * anything the model must see has to be inside the structured payload as well. Hence the
 * readable `summary`/`message`/`nextStep` fields below — and hence gemini_ask returning its
 * answer as text only, rather than as a wall of JSON-escaped Markdown.
 */
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
  // A specific failure can carry its own next step (e.g. "switch the Gemini CLI to an API key").
  const nextStep = typeof details.nextStep === "string" ? details.nextStep : ERROR_HINTS[type];
  return {
    isError: true,
    content: [{ type: "text", text: `Gemini bridge error (${type}): ${message}\nNext step: ${nextStep}` }],
    structuredContent: { ok: false, errorType: type, message, nextStep, ...details },
  };
}

export function toBridgeError(err: unknown): BridgeError {
  return asBridgeError(err);
}

/** Prepends the one-time "state file was corrupt and got reset" warning, if there is one. */
export function withWarning(result: CallToolResult, warning: string | null): CallToolResult {
  if (!warning) return result;
  return { ...result, content: [{ type: "text", text: `Warning: ${warning}` }, ...result.content] };
}
