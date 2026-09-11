import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext, type BridgeContext } from "./context.js";
import { registerAskTool } from "./tools/ask.js";
import { registerResultTool } from "./tools/jobs.js";
import { registerStatusTool } from "./tools/status.js";
import { registerToggleTool } from "./tools/toggle.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "gemini-claude-bridge";

/** Claude Code adds this to Claude's system prompt every session, so it is kept short. */
export const INSTRUCTIONS = [
  "Gemini bridge: delegate self-contained subtasks to Google Gemini (through the user's local gemini CLI) to save your own context and tokens.",
  '- Delegate the reading, not the thinking: use gemini_ask to get facts, locations and exact quotes out of large files, logs or many files (e.g. "every place user input reaches a SQL query, with the line"), then make the judgments yourself. Put the files in `paths` instead of reading them, say in `goal` what the answer is for and in `format` what you need back.',
  "- The bridge checks Gemini's file:line quotes against the files and flags mismatches, and marks judgment answers from the lightest model as a first pass. Verify what you rely on (read just the cited lines) and use thorough: true for decisions that matter. Gemini only returns text; you make any edits.",
  "- Run independent tasks as parallel calls; long ones with background: true, collected with gemini_result. Do small or conversation-dependent tasks yourself.",
  '- When the user asks to turn the Gemini bridge (or Gemini delegation) on or off, in any language (e.g. "apagá el bridge"), call gemini_bridge_toggle. When they ask whether it is on or working, call gemini_bridge_status; /gemini-claude-bridge:setup walks them through fixing the setup.',
].join("\n");

/** The tool list is static; on/off is a flag checked inside gemini_ask. */
export function createServer(ctx: BridgeContext = createContext()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerAskTool(server, ctx);
  registerResultTool(server, ctx);
  registerStatusTool(server, ctx);
  registerToggleTool(server, ctx);
  return server;
}

export async function startServer(): Promise<void> {
  const ctx = createContext();
  // Claude Code ends a session by closing our stdin. A live warm Gemini process would otherwise
  // keep this server — and itself — running after the session is gone, so kill it first.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void Promise.resolve(ctx.acp?.close()).finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  await createServer(ctx).connect(new StdioServerTransport());
}
