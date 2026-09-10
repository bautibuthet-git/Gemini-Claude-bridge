import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext, type BridgeContext } from "./context.js";
import { registerAskTool } from "./tools/ask.js";
import { registerStatusTool } from "./tools/status.js";
import { registerToggleTool } from "./tools/toggle.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "gemini-claude-bridge";

/** Claude Code adds this to Claude's system prompt every session, so it is kept short. */
export const INSTRUCTIONS = [
  "Gemini bridge: delegate self-contained subtasks to Google Gemini (through the user's local gemini CLI) to save your own context and tokens.",
  "- gemini_ask: for reading or summarizing large files and logs, analyzing many files, broad codebase questions, second-opinion reviews, drafting boilerplate/tests/docs, and plans. Put the files in `paths` instead of reading them yourself. Gemini sees only the prompt and those files and only returns text; you make any edits. Do small or conversation-dependent tasks yourself.",
  '- When the user asks to turn the Gemini bridge (or Gemini delegation) on or off, in any language (e.g. "apagá el bridge"), call gemini_bridge_toggle. When they ask whether it is on or working, call gemini_bridge_status.',
].join("\n");

/** The tool list is static (always these 3 tools); on/off is a flag checked inside gemini_ask. */
export function createServer(ctx: BridgeContext = createContext()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerAskTool(server, ctx);
  registerStatusTool(server, ctx);
  registerToggleTool(server, ctx);
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
