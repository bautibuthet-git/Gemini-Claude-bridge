// Smoke test of the BUILT bundles (dist/) over real stdio, with a fake `gemini` that speaks both
// the one-shot JSON mode and the warm ACP mode. Covers what unit tests fake out: cross-spawn
// resolving a .cmd shim, the prompt on stdin and the ACP JSON-RPC stream through cmd.exe, quota
// fallback with fail-fast, tree-kill on timeout, the cache, background jobs, the Read hook, and
// that no Gemini process outlives the server.
// Never touches your real ~/.gemini-claude-bridge and never calls Gemini.   Usage: npm run smoke
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gcb-smoke-"));
const project = path.join(tmp, "my project");
const docs = path.join(project, "docs");
const log = path.join(tmp, "gemini-calls.jsonl");
const sample = path.join(project, "sample file.txt");
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(sample, ["contact: me@example.com", ...Array.from({ length: 199 }, (_, i) => `line ${i + 2}`)].join("\n"));
fs.writeFileSync(path.join(docs, "readme.md"), "# docs\n");

// The fake CLI logs every call. One-shot: answers like `--output-format json`; "--model=pro" has
// no quota (prints the real CLI's error, then lingers retrying, as the real one can). --acp:
// a minimal ACP agent that, like the real one, exits when its stdin closes.
const fakeJs = path.join(tmp, "fake-gemini.mjs");
fs.writeFileSync(
  fakeJs,
  `import fs from "node:fs";
const LOG = ${JSON.stringify(log)};
const logCall = (entry) => fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fake");
} else if (args.includes("--acp")) {
  logCall({ engine: "acp-start", args });
  let buffer = "";
  let sessions = 0;
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const handle = (m) => {
    if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
    if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "acp-session-" + ++sessions } });
    if (m.method === "session/prompt") {
      const input = m.params.prompt.map((p) => p.text).join("");
      const sessionId = m.params.sessionId;
      logCall({ engine: "acp", sessionId, input });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "warm fake gemini got " + input.split("\\n").length + " lines" } } } });
      return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", _meta: { quota: { model_usage: [{ model: "fake-acp-model" }] } } } });
    }
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) handle(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const flag = (name) => (args.find((a) => a.startsWith("--" + name + "=")) ?? "").slice(name.length + 3);
    const model = flag("model");
    const resume = flag("resume");
    logCall({ engine: "cli", args, cwd: process.cwd(), input, model, resume });
    if (model === "pro") {
      process.stderr.write("Error when talking to Gemini API TerminalQuotaError: You exceeded your current quota\\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\\nPlease retry in 30s.\\n");
      setInterval(() => {}, 1000);
      return;
    }
    if (input.includes("PLEASE_HANG")) {
      setInterval(() => {}, 1000);
      return;
    }
    if (input.includes("RATE_LIMITED")) {
      process.stderr.write("Attempt 1 failed: You exceeded your current quota\\n* Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.1-flash-lite\\nPlease retry in 1.2s.\\nSuggested retry after 1s.. Retrying after 1200ms...\\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ session_id: "cli-session-" + process.pid, response: "answered after waiting" }, null, 2)), 1500);
      return;
    }
    const answer = (resume ? "resumed " + resume + ": " : "") + "fake gemini got " + input.split("\\n").length + " lines";
    process.stdout.write(JSON.stringify({ session_id: "cli-session-" + process.pid, response: answer, stats: { models: { ["fake-" + (model || "auto")]: { tokens: { candidates: 5 } } } } }, null, 2));
  });
}
`,
);

let fakeBin;
if (process.platform === "win32") {
  // Same shape as npm's gemini.cmd shim, with a space in the path to exercise quoting.
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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (condition()) return true;
  return condition();
}

async function connect(home, geminiBin, state) {
  if (state) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, GEMINI_CLAUDE_BRIDGE_HOME: home, GEMINI_CLAUDE_BRIDGE_GEMINI_BIN: geminiBin, CLAUDE_PROJECT_DIR: project },
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
const ask = (client, args, options) => client.callTool({ name: "gemini_ask", arguments: args }, undefined, options);

try {
  // ── Server A: default preferences, so eligible calls use the warm (ACP) process ──────────
  const a = await connect(path.join(tmp, "home-a"), fakeBin);
  const { tools } = await a.listTools();
  check(
    JSON.stringify(tools.map((t) => t.name).sort()) ===
      JSON.stringify(["gemini_ask", "gemini_bridge_status", "gemini_bridge_toggle", "gemini_result"]),
    `four tools: ${tools.map((t) => t.name).join(", ")}`,
  );

  await a.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: false } });
  let r = await ask(a, { prompt: "hi", paths: [sample] });
  check(r.isError && r.structuredContent?.errorType === "disabled" && calls().length === 0, "refused while off, no Gemini process started");
  await a.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: true } });

  const progress = [];
  r = await ask(a, { prompt: "Summarize.\nSecond line & \"quotes\" %PATH%", paths: [sample], mode: "summarize" }, {
    onprogress: (p) => progress.push(String(p.message)),
  });
  const warm = calls().filter((c) => c.engine === "acp");
  check(!r.isError && /^warm fake gemini got \d+ lines/.test(textOf(r)) && /warm process/.test(textOf(r)), `warm round trip: ${textOf(r).split("\n")[0]}`);
  check(warm.length === 1 && warm[0].input.includes('Second line & "quotes" %PATH%'), "multi-line prompt with cmd.exe metacharacters arrived intact over ACP");
  check(Boolean(warm[0]?.input.includes("===== FILE 1 of 1:") && warm[0].input.includes("200: line 200")), "file sent complete and numbered, not as an @reference");
  check(Boolean(warm[0]?.input.includes("contact: me\\@example.com")), "at-signs inside file content are escaped for the CLI");
  check(progress.some((m) => m.startsWith("Sending 1 file(s)")), `progress notifications: ${progress.join(" | ")}`);

  r = await ask(a, { prompt: "A different question", paths: [sample] });
  const starts = calls().filter((c) => c.engine === "acp-start");
  check(!r.isError && starts.length === 1, "second call reused the warm process (one start)");
  check(starts[0]?.args.includes(`--include-directories=${project}`), "warm process can read the project folder");

  r = await ask(a, { prompt: "And the details?", followUp: "acp-session-1" });
  check(calls().filter((c) => c.engine === "acp").at(-1)?.sessionId === "acp-session-1", "follow-up continued the same warm session");

  const before = calls().length;
  r = await ask(a, { prompt: "A different question", paths: [sample] });
  check(calls().length === before && /cached answer from/.test(textOf(r)), "identical question answered from the cache without Gemini");

  r = await ask(a, { prompt: "Background task", background: true });
  const jobId = r.structuredContent?.jobId;
  r = await a.callTool({ name: "gemini_result", arguments: { jobId, waitSeconds: 30 } });
  check(/finished/.test(textOf(r)) && /warm fake gemini got/.test(textOf(r)), `background job ${jobId} collected with gemini_result`);

  const warmPid = starts[0]?.pid;
  await a.close();
  check(await waitFor(() => !alive(warmPid), 5_000), `warm Gemini process (pid ${warmPid}) did not outlive the server`);

  // ── Server B: engine "cli", one process per call ────────────────────────────────────────
  // One fast model only, so a rate-limited fast call has nothing to fall back to and must wait.
  const b = await connect(path.join(tmp, "home-b"), fakeBin, {
    preferences: { engine: "cli", models: { fast: ["gemini-3.1-flash-lite"], strong: ["pro", "flash", "gemini-3.1-flash-lite"] } },
  });
  r = await ask(b, { prompt: "Summarize", paths: [sample] });
  let call = calls().filter((c) => c.engine === "cli").at(-1);
  check(!r.isError && /^fake gemini got/.test(textOf(r)), `one-off round trip: ${textOf(r).split("\n")[0]}`);
  check(Boolean(call?.input.includes("200: line 200")) && !call.input.includes(`@"${sample}"`), "one-off call also gets the file inline");
  check(Boolean(call?.args.includes("--skip-trust") && call.args.includes(`--include-directories=${project}`)), "headless args, project folder readable");
  check(path.resolve(call?.cwd ?? "") === path.resolve(tmp, "home-b", "workspace"), "Gemini ran from the bridge's scratch folder");

  r = await ask(b, { prompt: "What's in here?", paths: [docs] });
  call = calls().at(-1);
  if (process.platform === "win32") check(Boolean(call?.input.includes(`@"${docs}"`)), "a folder stays an @reference for the CLI");
  check(Boolean(call?.input.includes("Only the first 2000 lines")), "referenced items carry the truncation notice");

  const t0 = Date.now();
  r = await ask(b, { prompt: "Review this", paths: [sample], mode: "review" });
  const took = Date.now() - t0;
  const models = calls().slice(-2).map((c) => c.model);
  check(!r.isError && /fell back past pro \(no quota/.test(textOf(r)), `pro out of quota → fell back (tried ${models.join(" → ")})`);
  check(took < 6_000, `fail-fast: the lingering no-quota process was cut short (${took} ms, not 30 s)`);
  r = await b.callTool({ name: "gemini_bridge_status", arguments: {} });
  check(/Cooling down: pro \(no quota/.test(textOf(r)), "status shows pro cooling down");
  r = await ask(b, { prompt: "Review that too", paths: [sample], mode: "review" });
  check(calls().at(-1)?.model === "flash" && !calls().slice(-1).some((c) => c.model === "pro"), "benched pro is skipped on the next call");

  const waits = [];
  r = await ask(b, { prompt: "RATE_LIMITED question" }, { onprogress: (p) => waits.push(String(p.message)) });
  check(!r.isError && /^answered after waiting/.test(textOf(r)), "a rate-limited last model is waited out, not abandoned");
  check(waits.some((m) => /per-minute quota; the Gemini CLI waits ~1s/.test(m)), `the wait is announced: ${waits.join(" | ")}`);

  r = await ask(b, { prompt: "More?", followUp: "cli-session-123" });
  check(/^resumed cli-session-123/.test(textOf(r)), "follow-up resumes the CLI session with --resume");

  const t1 = Date.now();
  r = await ask(b, { prompt: "PLEASE_HANG", timeoutMs: 5000 });
  const hangTook = Date.now() - t1;
  check(r.isError && r.structuredContent?.errorType === "timeout" && hangTook < 13_000, `hung Gemini → timeout after ${hangTook} ms`);
  const hung = calls().at(-1);
  check(await waitFor(() => !alive(hung.pid), 3_000), `hung process (pid ${hung?.pid}, a grandchild via cmd.exe) was killed`);
  await b.close();

  const c = await connect(path.join(tmp, "home-c"), "gemini-cli-that-does-not-exist");
  r = await ask(c, { prompt: "hi" });
  check(r.isError && r.structuredContent?.errorType === "not_installed", `missing CLI → ${r.structuredContent?.errorType}`);
  await c.close();

  // ── Read hook (dist/read-hook.js) ──────────────────────────────────────────────────────
  const hookHome = path.join(tmp, "home-hook");
  fs.mkdirSync(hookHome, { recursive: true });
  fs.writeFileSync(path.join(hookHome, "state.json"), JSON.stringify({ geminiCli: { lastAuthOk: true, lastDetectedVersion: "1.0.0" } }));
  const bigLog = path.join(project, "big.log");
  fs.writeFileSync(bigLog, Array.from({ length: 3000 }, (_, i) => `2026-09-10 INFO event ${i} processed`).join("\n"));
  const runHook = (input) =>
    spawnSync(process.execPath, [path.join(root, "dist", "read-hook.js")], {
      input: JSON.stringify(input),
      env: { ...process.env, GEMINI_CLAUDE_BRIDGE_HOME: hookHome },
      encoding: "utf8",
    });
  const readInput = { session_id: "smoke", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: bigLog } };
  const first = runHook(readInput);
  const decision = first.stdout ? JSON.parse(first.stdout).hookSpecificOutput : null;
  check(first.status === 0 && decision?.permissionDecision === "deny" && /3,000 lines/.test(decision.permissionDecisionReason), "read hook suggests delegating a 3,000-line file");
  const second = runHook(readInput);
  check(second.status === 0 && second.stdout === "", "…once: repeating the Read goes through");
  check(runHook({ ...readInput, tool_input: { file_path: bigLog, limit: 50 } }).stdout === "", "a ranged Read goes straight through");
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
