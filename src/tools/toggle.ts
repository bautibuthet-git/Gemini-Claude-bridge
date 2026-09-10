import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeContext } from "../context.js";
import { textResult, withWarning } from "./result.js";

export const TOGGLE_DESCRIPTION =
  "Turn Gemini delegation on or off. Call this whenever the user asks to enable/disable, turn on/off, pause or resume the Gemini bridge, in any language (e.g. \"apagá el bridge\", \"prendé gemini\", \"stop using Gemini\"). While off, gemini_ask refuses immediately without contacting Gemini. The setting is global and persists across sessions and projects. Works whether the bridge is currently on or off.";

export const toggleInputSchema = {
  enabled: z.boolean().describe("true = turn Gemini delegation on, false = turn it off."),
};

export async function handleToggle(ctx: BridgeContext, args: { enabled: boolean }): Promise<CallToolResult> {
  const before = { enabled: true };
  await ctx.store.update((state) => {
    before.enabled = state.enabled;
    state.enabled = args.enabled;
  });
  const changed = before.enabled !== args.enabled;
  const text = args.enabled
    ? changed
      ? "The Gemini bridge is now ON: gemini_ask delegates to Gemini again."
      : "The Gemini bridge was already ON."
    : changed
      ? "The Gemini bridge is now OFF: gemini_ask refuses immediately without contacting Gemini, so handle tasks yourself until it is turned back on."
      : "The Gemini bridge was already OFF.";
  const message = `${text} (Global setting: applies to every project and session.)`;
  return withWarning(textResult(message, { message, enabled: args.enabled, changed }), ctx.store.takeWarning());
}

export function registerToggleTool(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "gemini_bridge_toggle",
    {
      title: "Turn the Gemini bridge on or off",
      description: TOGGLE_DESCRIPTION,
      inputSchema: toggleInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => handleToggle(ctx, args),
  );
}
