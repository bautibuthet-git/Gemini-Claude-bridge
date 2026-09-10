import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeContext } from "../context.js";
import type { CliStatus } from "../gemini/detect.js";
import { CHARS_PER_TOKEN, type BridgeState } from "../state/schema.js";
import { textResult, withWarning } from "./result.js";

export const STATUS_DESCRIPTION =
  "Report whether the Gemini bridge is on, whether the gemini CLI is installed and signed in, usage so far (calls, errors, estimated context saved) and current preferences. Use it when the user asks whether the bridge or Gemini is on, set up or working. Works even while the bridge is off.";

export const statusInputSchema = {
  forceRefresh: z
    .boolean()
    .optional()
    .describe("Re-check the Gemini CLI install and sign-in now instead of reusing the last check (cached up to 10 minutes)."),
};

export async function handleStatus(ctx: BridgeContext, args: { forceRefresh?: boolean }): Promise<CallToolResult> {
  const cli = await ctx.refreshCli(args.forceRefresh ?? false);
  const state = await ctx.store.read();
  const usage = { ...state.usage, estimatedTokensSaved: Math.round(state.usage.estimatedCharsSaved / CHARS_PER_TOKEN) };
  return withWarning(
    textResult(formatStatus(state, cli, ctx.store.file), {
      enabled: state.enabled,
      geminiCli: cli,
      usage,
      preferences: state.preferences,
      stateFile: ctx.store.file,
    }),
    ctx.store.takeWarning(),
  );
}

export function formatStatus(state: BridgeState, cli: CliStatus, stateFile: string): string {
  const lines = [`Gemini bridge: ${state.enabled ? "ON" : "OFF"}`];

  if (cli.installed) {
    const version = cli.version && cli.version !== "unknown" ? ` v${cli.version}` : " (version unknown)";
    lines.push(`Gemini CLI: installed${version}${cli.path ? ` at ${cli.path}` : ""}`);
    const auth = cli.authOk === true ? "OK" : cli.authOk === false ? "NOT signed in" : "unknown";
    lines.push(`Sign-in: ${auth}${cli.authDetail ? ` (${cli.authDetail})` : ""}`);
  } else {
    lines.push("Gemini CLI: NOT FOUND on PATH. Install it with `npm install -g @google/gemini-cli`, then restart Claude Code.");
  }

  const u = state.usage;
  const byMode = Object.entries(u.callsByMode)
    .filter(([, n]) => n > 0)
    .map(([mode, n]) => `${mode} ${n}`)
    .join(", ");
  lines.push(
    `Usage: ${plural(u.totalCalls, "call")}, ${plural(u.totalErrors, "error")}${byMode ? ` (${byMode})` : ""}; ` +
      `~${compact(u.estimatedCharsSaved)} chars (~${compact(u.estimatedCharsSaved / CHARS_PER_TOKEN)} tokens) of file content kept out of Claude's context` +
      (u.lastUsedAt ? `; last used ${u.lastUsedAt}` : ""),
  );

  const p = state.preferences;
  lines.push(`Preferences: model ${p.model ?? "(Gemini CLI default)"}, timeout ${p.timeoutMs / 1000}s, approval mode ${p.approvalMode}`);
  lines.push(`State file: ${stateFile}${cli.checkedAt ? ` (CLI last checked ${cli.checkedAt})` : ""}`);
  return lines.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function registerStatusTool(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "gemini_bridge_status",
    {
      title: "Gemini bridge status",
      description: STATUS_DESCRIPTION,
      inputSchema: statusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => handleStatus(ctx, args),
  );
}
