// Smoke test of the BUILT server (dist/index.js) over real stdio, using a fake `gemini`
// executable. Exercises the parts unit tests fake out: cross-spawn resolving a .cmd shim on
// Windows, the prompt travelling over stdin through cmd.exe, and tree-kill on timeout.
// Never touches your real ~/.gemini-claude-bridge and never calls Gemini.   Usage: npm run smoke
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gcb-smoke-"));
const bridgeHome = path.join(tmp, "bridge-home");
const project = path.join(tmp, "my project");
const log = path.join(tmp, "gemini-calls.jsonl");
const sample = path.join(project, "sample file.txt");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(sample, "hello from a file whose path has spaces\n".repeat(200));

// The fake CLI logs each call and answers like `gemini --output-format json`.
const fakeJs = path.join(tmp, "fake-gemini.mjs");
fs.writeFileSync(
  fakeJs,
  `import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.0.0-fake"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), input, pid: process.pid }) + "\\n");
  if (input.includes("PLEASE_HANG")) { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({ response: "fake gemini got " + input.split("\\n").length + " lines",
    stats: { models: { "fake-model": { tokens: { candidates: 5 } } } } }, null, 2));
});
`,
);

let fakeBin;
if (process.platform === "win32") {
  // Same shape as npm's gemini.cmd shim, and a space in the path to exercise quoting.
  fakeBin = path.join(tmp, "fake gemini.cmd");
  fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
} else {
  fakeBin = path.join(tmp, "fake-gemini");
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
}

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "ok  " : "FAIL"} - ${message}`);
  if (!condition) failures++;
}
const calls = () =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const textOf = (result) => result.content.map((c) => c.text ?? "").join("\n");

async function connect(geminiBin) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, GEMINI_CLAUDE_BRIDGE_HOME: bridgeHome, GEMINI_CLAUDE_BRIDGE_GEMINI_BIN: geminiBin, CLAUDE_PROJECT_DIR: project },
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  const client = await connect(fakeBin);

  const { tools } = await client.listTools();
  check(
    JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(["gemini_ask", "gemini_bridge_status", "gemini_bridge_toggle"]),
    `exactly 3 tools: ${tools.map((t) => t.name).join(", ")}`,
  );

  let r = await client.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: false } });
  check(!r.isError && /now OFF/.test(textOf(r)), "toggle off");
  r = await client.callTool({ name: "gemini_ask", arguments: { prompt: "hi", paths: [sample] } });
  check(r.isError && r.structuredContent?.errorType === "disabled", "gemini_ask refused while disabled");
  check(calls().length === 0, "no Gemini process was spawned while disabled");
  check((await client.listTools()).tools.length === 3, "tool list unchanged while disabled");

  await client.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: true } });
  const trickyPrompt = 'Summarize this.\nSecond line with & "quotes" %PATH% ^caret <angle> | pipe';
  r = await client.callTool({ name: "gemini_ask", arguments: { prompt: trickyPrompt, paths: [sample], mode: "analyze" } });
  check(!r.isError && /fake gemini got \d+ lines/.test(textOf(r)), `round trip: ${textOf(r).split("\n")[0]}`);
  const call = calls()[0];
  check(Boolean(call?.input.includes(trickyPrompt)), "multi-line prompt with cmd.exe metacharacters arrived intact on stdin");
  if (process.platform === "win32") check(Boolean(call?.input.includes(`@"${sample}"`)), 'file passed as @"<path>" (spaces intact)');
  check(Boolean(call?.args.includes("--skip-trust") && call.args.includes("json")), "headless JSON args");
  check(Boolean(call?.args.includes(`--include-directories=${project}`)), "project folder readable, path with spaces intact");
  check(path.resolve(call?.cwd ?? "") === path.resolve(bridgeHome, "workspace"), "Gemini ran from the bridge's scratch folder");
  check((r.structuredContent?.estimatedCharsSaved ?? 0) > 0, `estimated chars saved: ${r.structuredContent?.estimatedCharsSaved}`);

  r = await client.callTool({ name: "gemini_bridge_status", arguments: { forceRefresh: true } });
  check(/Gemini bridge: ON/.test(textOf(r)) && /v0\.0\.0-fake/.test(textOf(r)), "status: ON, CLI version detected through the .cmd shim");
  check(/2 calls, 0 errors/.test(textOf(r)) === false && /1 call, 0 errors/.test(textOf(r)), "status: usage counted (disabled call not counted)");

  const started = Date.now();
  r = await client.callTool({ name: "gemini_ask", arguments: { prompt: "PLEASE_HANG", timeoutMs: 5000 } });
  const took = Date.now() - started;
  check(r.isError && r.structuredContent?.errorType === "timeout", `hung Gemini reported as timeout after ${took} ms`);
  check(took < 5000 + 8000, "returned promptly after the 5 s timeout");
  const hung = calls().at(-1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check(Boolean(hung) && !alive(hung.pid), `hung fake gemini (node pid ${hung?.pid}, a grandchild via cmd.exe) was killed`);
  await client.close();

  const missing = await connect("gemini-cli-that-does-not-exist");
  r = await missing.callTool({ name: "gemini_ask", arguments: { prompt: "hi" } });
  check(r.isError && r.structuredContent?.errorType === "not_installed", `missing CLI -> ${r.structuredContent?.errorType}`);
  await missing.close();
} catch (err) {
  failures++;
  console.error("FAIL - smoke test crashed:", err);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold files of just-killed processes.
  }
}

console.log(failures === 0 ? "\nSmoke test passed." : `\nSmoke test FAILED (${failures}).`);
process.exit(failures === 0 ? 0 : 1);
