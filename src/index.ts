import { runCheck } from "./check.js";
import { startServer } from "./server.js";

if (process.argv.includes("--check")) {
  await runCheck();
} else {
  // stdout carries the MCP protocol, so diagnostics go to stderr only.
  startServer().catch((err: unknown) => {
    console.error("[gemini-claude-bridge] failed to start:", err);
    process.exit(1);
  });
}
