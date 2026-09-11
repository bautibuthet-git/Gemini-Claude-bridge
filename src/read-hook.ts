// Entry point for dist/read-hook.js (PreToolUse on Read). Never blocks or fails a Read by
// accident: any error, or no decision, means the Read goes through.
import { decideRead, denyOutput, loadHookSettings, SuggestionLog, type ReadHookInput } from "./hooks/readHook.js";

async function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

try {
  const input = JSON.parse(await readStdin(2_000)) as ReadHookInput;
  const reason = await decideRead(input, await loadHookSettings(), new SuggestionLog(), new Date());
  if (reason) process.stdout.write(denyOutput(reason));
} catch {
  // Let the Read through.
}
process.exit(0);
