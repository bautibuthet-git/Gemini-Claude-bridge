import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../../src/cache.js";
import type { BridgeContext } from "../../src/context.js";
import { SpendLedger } from "../../src/gemini/budget.js";
import type { CliStatus } from "../../src/gemini/detect.js";
import { classifyFailure, type GeminiRequest, type GeminiResponse } from "../../src/gemini/invoke.js";
import { ANSWER_RULES, FOLLOW_UP_HEADER, toAtReference } from "../../src/gemini/promptBuilder.js";
import { History, summarizeHistory, type HistoryEntry } from "../../src/history.js";
import { JobManager } from "../../src/jobs.js";
import { createServer } from "../../src/server.js";
import { defaultState } from "../../src/state/schema.js";
import { StateStore } from "../../src/state/store.js";
import { handleAsk, parseConfidence } from "../../src/tools/ask.js";
import { handleResult } from "../../src/tools/jobs.js";
import { formatStatus, handleStatus } from "../../src/tools/status.js";
import { handleToggle } from "../../src/tools/toggle.js";
import { BridgeError } from "../../src/util/errors.js";
import { tempDir } from "../helpers.js";

const CLI: CliStatus = {
  installed: true,
  path: "C:\\bin\\gemini.cmd",
  version: "0.59.0",
  authOk: true,
  authDetail: "The last Gemini call succeeded.",
  checkedAt: "2026-09-10T12:00:00.000Z",
  fromCache: false,
  ripgrep: { available: true, path: "C:\\Program Files\\rg.exe", detail: "installed" },
};
const SESSION = "11111111-2222-3333-4444-555555555555";
const ANSWER: GeminiResponse = { text: "Gemini says hi", model: "main-model", durationMs: 1234, exitCode: 0, warnings: [], sessionId: SESSION };
const ERROR_LINE = "2026-09-10T10:57:00Z ERROR db.pool: connection refused to 10.0.0.12:5432";

let root: string;
let project: string;
let bigFile: string;
let logFile: string;
let ctx: BridgeContext;
let invoke: ReturnType<typeof vi.fn<(req: GeminiRequest) => Promise<GeminiResponse>>>;
let refreshCli: ReturnType<typeof vi.fn<(force: boolean) => Promise<CliStatus>>>;

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

beforeEach(async () => {
  root = await tempDir("gcb-tools-");
  project = path.join(root, "project");
  bigFile = path.join(project, "src", "big file.ts");
  logFile = path.join(project, "build.log");
  await fs.mkdir(path.dirname(bigFile), { recursive: true });
  await fs.writeFile(bigFile, Array.from({ length: 1000 }, (_, i) => `const line${i} = ${i}; // padding padding padding`).join("\n"));
  await fs.writeFile(logFile, ["INFO start", ERROR_LINE, "INFO end"].join("\n"));

  invoke = vi.fn(async () => ({ ...ANSWER }));
  refreshCli = vi.fn(async () => CLI);
  const state = path.join(root, "state");
  ctx = {
    store: new StateStore(path.join(state, "state.json")),
    invoke,
    acp: null,
    cache: new ResponseCache(path.join(state, "cache")),
    history: new History(path.join(state, "history.jsonl")),
    jobs: new JobManager(),
    spend: new SpendLedger(),
    refreshCli,
    projectDir: () => project,
    scratchDir: async () => {
      const dir = path.join(root, "scratch");
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    sleep: async () => undefined,
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("gemini_ask", () => {
  it("sends files complete and numbered from the scratch folder, and records the call", async () => {
    const result = await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile], mode: "summarize" });

    expect(result.isError).toBeFalsy();
    const req = invoke.mock.calls[0]![0];
    expect(req.prompt).toContain(`===== FILE 1 of 1: ${bigFile} (1000 lines) =====`);
    expect(req.prompt).toContain("1000: const line999 = 999;");
    expect(req.prompt).not.toContain(toAtReference(bigFile));
    expect(req).toMatchObject({ model: "gemini-3.1-flash-lite", failFast: true, timeoutMs: 180_000, yolo: false });
    expect(req.cwd).toBe(path.join(root, "scratch"));
    // The file's folder is inside the project, so the project folder alone covers both.
    expect(req.includeDirectories).toEqual([project]);

    const text = textOf(result);
    expect(text.startsWith("Gemini says hi\n\n")).toBe(true);
    // An answer about attached files that quotes nothing checkable is flagged as unverified.
    expect(text).toContain("[no quotes the bridge could check against the files: treat the claims above as unverified]");
    expect(text).toMatch(/\[gemini-claude-bridge · summarize · main-model · 1\.2s · ~\d+ tokens of file content kept out of Claude's context\]/);
    expect(text).toContain(`[followUp: "${SESSION}"]`);
    // Claude Code shows the model structuredContent INSTEAD of the text, so a successful answer
    // must not carry one, or Gemini's answer would never reach Claude.
    expect(result.structuredContent).toBeUndefined();

    const state = await ctx.store.read();
    expect(state.usage).toMatchObject({ totalCalls: 1, totalErrors: 0, callsByMode: { summarize: 1 } });
    expect(state.geminiCli.lastAuthOk).toBe(true);
    expect(await ctx.history.recent(new Date(0))).toEqual([
      expect.objectContaining({ mode: "summarize", ok: true, engine: "cli", inlineFiles: 1, referencedFiles: 0, inputTokens: expect.any(Number) }),
    ]);
  });

  it("passes the goal on and asks for evidence, coverage and confidence", async () => {
    await handleAsk(ctx, { prompt: "What failed?", paths: [logFile], goal: "decide whether the export needs a retry" });
    const prompt = invoke.mock.calls[0]![0].prompt;
    expect(prompt).toContain("Purpose (what the answer will be used for): decide whether the export needs a retry.");
    expect(prompt).toContain(ANSWER_RULES);
  });

  it("checks Gemini's quotes against the file and shows the real text of a misquoted line", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, text: "The export failed: build.log:2 `2026-09-10T10:58:00Z ERROR db.pool: connection refused`" });
    const text = textOf(await handleAsk(ctx, { prompt: "What failed?", paths: [logFile] }));
    expect(text).toContain("[⚠ some quotes don't match the files (details below): double-check before relying on this answer.]");
    expect(text).toContain("[quotes checked by the bridge against the files: 0 exact · 1 misquoted]");
    expect(text).toContain("the file says `2026-09-10T10:57:00Z ERROR db.pool");
  });

  it("confirms exact quotes quietly", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, text: `The export failed: build.log:2 \`${ERROR_LINE}\`` });
    const text = textOf(await handleAsk(ctx, { prompt: "What failed?", paths: [logFile] }));
    expect(text).toContain("[quotes checked by the bridge against the files: 1 exact]");
    expect(text).not.toContain("⚠");
  });

  it("marks a review answered by the lightest model as a first pass, cached or not", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, model: "gemini-3.1-flash-lite" });
    const text = textOf(await handleAsk(ctx, { prompt: "Review", paths: [bigFile], mode: "review" }));
    expect(text).toContain("[⚠ first pass: answered by gemini-3.1-flash-lite, the lightest model. Verify the key findings in the code before acting on them.]");
    const cached = textOf(await handleAsk(ctx, { prompt: "Review", paths: [bigFile], mode: "review" }));
    expect(cached).toMatch(/cached answer from/);
    expect(cached).toContain("[⚠ first pass: answered by gemini-3.1-flash-lite, the lightest model.");
  });

  it("surfaces Gemini's own confidence in the footer", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, text: "Answer.\n\nCoverage: all of it\nConfidence: low, the log is ambiguous" });
    expect(textOf(await handleAsk(ctx, { prompt: "x" }))).toContain("· Gemini's confidence: low");
    expect(parseConfidence("**Confidence:** High — clear evidence")).toBe("high");
    expect(parseConfidence("no such line")).toBeNull();
  });

  it("thorough: a second pass checks the first answer in the same conversation", async () => {
    invoke
      .mockResolvedValueOnce({ ...ANSWER, text: "draft", inputTokens: 1_000 })
      .mockResolvedValueOnce({ ...ANSWER, text: "corrected answer", inputTokens: 3_000 });
    const text = textOf(await handleAsk(ctx, { prompt: "Review", paths: [logFile], mode: "review", thorough: true, goal: "ship or not" }));

    expect(invoke).toHaveBeenCalledTimes(2);
    // Two passes get twice the default time budget.
    expect(invoke.mock.calls[0]![0].timeoutMs).toBe(360_000);
    const second = invoke.mock.calls[1]![0];
    expect(second.resumeSessionId).toBe(SESSION);
    expect(second.prompt.startsWith("Second pass")).toBe(true);
    expect(second.prompt).toContain("for the purpose (ship or not)");
    expect(text.startsWith("corrected answer")).toBe(true);
    expect(text).toContain("· 2 passes");
    // Both passes count against the per-minute token budget.
    expect((await ctx.history.recent(new Date(0)))[0]).toMatchObject({ inputTokens: 4_000 });
  });

  it("thorough without a conversation to continue sends the material again with the draft", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, text: "draft", sessionId: null }).mockResolvedValueOnce({ ...ANSWER, text: "corrected" });
    await handleAsk(ctx, { prompt: "Review", paths: [logFile], thorough: true });
    const second = invoke.mock.calls[1]![0];
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toContain("===== FILE 1 of 1:");
    expect(second.prompt).toContain("A draft answer to check follows.\n\ndraft");
  });

  it("keeps the first answer, and says so, when the second pass fails", async () => {
    invoke.mockResolvedValueOnce({ ...ANSWER, text: "first answer" }).mockRejectedValueOnce(new BridgeError("timeout", "too slow"));
    const text = textOf(await handleAsk(ctx, { prompt: "x", paths: [logFile], thorough: true }));
    expect(text.startsWith("first answer")).toBe(true);
    expect(text).toContain("[second pass failed, so this is the first-pass answer: too slow]");
  });

  it("runs in the background when the per-minute token quota would make it wait", async () => {
    const busy = (model: string): HistoryEntry => ({
      at: "2026-09-10T11:59:50.000Z",
      mode: "ask",
      ok: true,
      engine: "cli",
      model,
      durationMs: 1,
      attempts: [{ model, outcome: "ok", ms: 1 }],
      inlineFiles: 1,
      referencedFiles: 0,
      charsSaved: 0,
      background: false,
      inputTokens: 240_000,
    });
    await ctx.store.update((s) => {
      for (const model of s.preferences.models.fast) s.modelLimits[model] = { inputTokensPerMinute: 250_000, learnedAt: "x" };
    });
    for (const model of defaultState().preferences.models.fast) await ctx.history.append(busy(model));

    const result = await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile] });
    expect(textOf(result)).toMatch(/per-minute token quota is still busy with earlier requests \(about 50s to go\), so this runs in the background/);
    const jobId = (result.structuredContent as { jobId: string }).jobId;
    const done = await handleResult(ctx, { jobId, waitSeconds: 5 });
    expect(textOf(done)).toContain("Gemini says hi");
  });

  it("resolves relative paths against the project folder", async () => {
    await handleAsk(ctx, { prompt: "x", paths: [path.join("src", "big file.ts")] });
    expect(invoke.mock.calls[0]![0].prompt).toContain(`FILE 1 of 1: ${bigFile}`);
  });

  it("refuses immediately when the bridge is off: no subprocess, nothing counted", async () => {
    await handleToggle(ctx, { enabled: false });
    const result = await handleAsk(ctx, { prompt: "x", paths: ["does/not/matter"] });

    expect(result.isError).toBe(true);
    // Both representations carry the next step, whichever one the client shows the model.
    expect(result.structuredContent).toMatchObject({ ok: false, errorType: "disabled", nextStep: expect.stringContaining("Do the task yourself") });
    expect(textOf(result)).toMatch(/Do the task yourself/);
    expect(invoke).not.toHaveBeenCalled();
    expect((await ctx.store.read()).usage.totalCalls).toBe(0);
  });

  it("reports missing paths without calling Gemini", async () => {
    const result = await handleAsk(ctx, { prompt: "x", paths: [bigFile, "nope.txt"] });
    expect(result.structuredContent).toMatchObject({ errorType: "invalid_paths" });
    expect(textOf(result)).toMatch(/nope\.txt/);
    expect(invoke).not.toHaveBeenCalled();
    expect((await ctx.store.read()).usage.totalErrors).toBe(1);
  });

  it("returns Gemini failures as typed errors and remembers sign-in problems", async () => {
    invoke.mockRejectedValue(new BridgeError("not_authenticated", "The Gemini CLI is not signed in: expired", { exitCode: 41 }));
    const result = await handleAsk(ctx, { prompt: "x" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorType: "not_authenticated", exitCode: 41 });
    expect(textOf(result)).toMatch(/run `gemini` once/);
    const state = await ctx.store.read();
    expect(state.geminiCli.lastAuthOk).toBe(false);
    expect(state.usage.totalErrors).toBe(1);
  });

  it("falls back to the next model when one is out of quota, and says so", async () => {
    invoke.mockRejectedValueOnce(classifyFailure(1, "TerminalQuotaError: You exceeded your current quota", undefined, "limit: 0"));
    const result = await handleAsk(ctx, { prompt: "x" });
    expect(invoke.mock.calls.map((c) => c[0].model)).toEqual(["gemini-3.1-flash-lite", "flash"]);
    expect(textOf(result)).toContain("[fell back past gemini-3.1-flash-lite (no quota for this model on this account)]");
  });

  it("uses preferences as defaults and lets arguments override them", async () => {
    await ctx.store.update((s) => {
      s.preferences.model = "pref-model";
      s.preferences.timeoutMs = 60_000;
      s.preferences.approvalMode = "yolo";
    });
    await handleAsk(ctx, { prompt: "x" });
    expect(invoke.mock.calls[0]![0]).toMatchObject({ model: "pref-model", timeoutMs: 60_000, yolo: true });

    await handleAsk(ctx, { prompt: "x", model: "arg-model", timeoutMs: 9_000, yolo: false });
    expect(invoke.mock.calls[1]![0]).toMatchObject({ model: "arg-model", timeoutMs: 9_000, yolo: false });
  });

  it("passes the cancellation signal through to the Gemini process", async () => {
    const controller = new AbortController();
    await handleAsk(ctx, { prompt: "x" }, { signal: controller.signal });
    expect(invoke.mock.calls[0]![0].signal).toBe(controller.signal);
  });

  it("answers an identical question about unchanged files from the cache", async () => {
    await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile] });
    const second = await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toMatch(/\[gemini-claude-bridge · ask · cached answer from/);
    expect((await ctx.store.read()).usage.cacheHits).toBe(1);

    await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile], fresh: true });
    expect(invoke).toHaveBeenCalledTimes(2);

    await fs.appendFile(bigFile, "\n// edited");
    await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile] });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("continues a conversation with followUp, without the cache", async () => {
    await handleAsk(ctx, { prompt: "And the errors?", followUp: SESSION });
    await handleAsk(ctx, { prompt: "And the errors?", followUp: SESSION });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ resumeSessionId: SESSION });
    expect(invoke.mock.calls[0]![0].prompt.startsWith(FOLLOW_UP_HEADER)).toBe(true);
  });

  it("reports progress while it works", async () => {
    const messages: string[] = [];
    await handleAsk(ctx, { prompt: "x", paths: [bigFile] }, { report: (m) => messages.push(m) });
    expect(messages).toEqual(["Sending 1 file(s), 1000 lines, inline to Gemini…", "Asking gemini-3.1-flash-lite…"]);
  });
});

describe("background jobs", () => {
  it("starts a job at once and hands the answer to gemini_result when it's ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    invoke.mockImplementationOnce(async () => {
      await gate;
      return { ...ANSWER, text: "late answer" };
    });

    const started = await handleAsk(ctx, { prompt: "Long task", background: true });
    const jobId = (started.structuredContent as { jobId: string }).jobId;
    expect(textOf(started)).toMatch(/Started background Gemini job [a-f0-9]{8}/);
    expect(textOf(await handleResult(ctx, { jobId }))).toMatch(/still running/);

    release();
    const done = await handleResult(ctx, { jobId, waitSeconds: 5 });
    expect(textOf(done)).toMatch(new RegExp(`^Background job ${jobId} \\(ask: Long task\\) finished`));
    expect(textOf(done)).toContain("late answer");
    expect(textOf(await handleResult(ctx, {}))).toMatch(new RegExp(`${jobId} · done`));
    expect((await ctx.history.recent(new Date(0)))[0]).toMatchObject({ background: true, ok: true });
  });

  it("refuses up front when the bridge is off or a path is wrong", async () => {
    expect((await handleAsk(ctx, { prompt: "x", paths: ["missing.txt"], background: true })).structuredContent).toMatchObject({
      errorType: "invalid_paths",
    });
    await handleToggle(ctx, { enabled: false });
    expect((await handleAsk(ctx, { prompt: "x", background: true })).structuredContent).toMatchObject({ errorType: "disabled" });
    expect(ctx.jobs.list()).toHaveLength(0);
  });

  it("says when a job id is unknown", async () => {
    expect((await handleResult(ctx, { jobId: "deadbeef" })).structuredContent).toMatchObject({ errorType: "unknown_job" });
  });
});

describe("gemini_bridge_toggle", () => {
  it("persists the flag and says when nothing changed", async () => {
    expect(textOf(await handleToggle(ctx, { enabled: false }))).toMatch(/now OFF/);
    expect(textOf(await handleToggle(ctx, { enabled: false }))).toMatch(/already OFF/);
    expect((await ctx.store.read()).enabled).toBe(false);
    expect(textOf(await handleToggle(ctx, { enabled: true }))).toMatch(/now ON/);
  });
});

describe("gemini_bridge_status", () => {
  it("covers setup, CLI, ripgrep, sign-in, models, cooldowns, limits, speed and usage", async () => {
    await handleAsk(ctx, { prompt: "x", paths: [bigFile], mode: "review" });
    await ctx.store.update((s) => {
      s.modelCooldowns.pro = { until: "2026-09-11T07:00:00.000Z", reason: "daily quota used up" };
      s.modelCooldowns.old = { until: "2026-09-01T00:00:00.000Z", reason: "expired" };
      s.modelLimits["gemini-3.1-flash-lite"] = { inputTokensPerMinute: 250_000, learnedAt: "2026-09-10T11:00:00.000Z" };
    });
    const result = await handleStatus(ctx, { forceRefresh: true });
    const text = textOf(result);

    expect(refreshCli).toHaveBeenCalledWith(true);
    expect(text).toMatch(/Gemini bridge: ON\nSetup: all set/);
    expect(text).toMatch(/Gemini CLI: installed v0\.59\.0 at C:\\bin\\gemini\.cmd · ripgrep: yes/);
    expect(text).toMatch(/Sign-in: OK/);
    expect(text).toMatch(/Models: fast tasks gemini-3\.1-flash-lite → flash → auto; strong tasks pro → flash → gemini-3\.1-flash-lite/);
    expect(text).toMatch(/Cooling down: pro \(daily quota used up; until 2026-09-11 07:00Z\)$/m);
    expect(text).toMatch(/Per-minute input-token limits \(learned from Google's quota errors\): gemini-3\.1-flash-lite 250\.0k\/min/);
    // The test clock stands still, so durations are 0 and the overall average is left out.
    expect(text).toMatch(/Last 7 days: 1 call \(1 ok, 0 cached, 0 failed\); pro 1 ok avg 0\.0s/);
    expect(text).toMatch(/Usage: 1 call, 0 errors \(review 1\); 0 cache hits;/);
    expect(result.structuredContent).toMatchObject({ enabled: true, setup: [], usage: { totalCalls: 1 }, summary: expect.stringContaining("Gemini bridge: ON") });
  });

  it("lists what's missing from the setup with the command for the user's system", () => {
    const base = {
      state: defaultState(),
      week: summarizeHistory([]),
      now: new Date(),
      stateFile: "state.json",
      engine: "idle",
      runningJobs: 0,
      nodeVersion: "22.1.0",
    };
    const noRipgrep: CliStatus = { ...CLI, ripgrep: { available: false, path: null, detail: "not installed" } };
    expect(formatStatus({ ...base, cli: noRipgrep, platform: "win32" })).toContain("winget install --id BurntSushi.ripgrep.MSVC --scope machine");
    expect(formatStatus({ ...base, cli: noRipgrep, platform: "darwin" })).toContain("brew install ripgrep");
    expect(formatStatus({ ...base, cli: noRipgrep, platform: "linux" })).toContain("sudo apt install ripgrep");
    const missing = formatStatus({ ...base, cli: { ...CLI, installed: false }, platform: "linux", nodeVersion: "18.19.0" });
    expect(missing).toContain("Setup: 2 thing(s) to fix:");
    expect(missing).toContain("Node.js 18.19.0 is too old");
    expect(missing).toContain("npm install -g @google/gemini-cli");
  });

  it("works while the bridge is off", async () => {
    await handleToggle(ctx, { enabled: false });
    expect(textOf(await handleStatus(ctx, {}))).toMatch(/Gemini bridge: OFF/);
  });
});

describe("MCP server", () => {
  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(ctx).connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("always lists the same four tools with the expected schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gemini_ask", "gemini_bridge_status", "gemini_bridge_toggle", "gemini_result"]);

    const ask = tools.find((t) => t.name === "gemini_ask")!;
    expect(ask.inputSchema.required).toEqual(["prompt"]);
    const props = ask.inputSchema.properties as Record<string, { maxItems?: number; enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual([
      "background",
      "followUp",
      "format",
      "fresh",
      "goal",
      "mode",
      "model",
      "paths",
      "prompt",
      "thorough",
      "timeoutMs",
      "yolo",
    ]);
    expect(props.paths?.maxItems).toBe(20);
    expect(props.mode?.enum).toEqual(["ask", "summarize", "analyze", "review", "refactor", "plan", "test"]);
    expect(ask.description).toMatch(/Delegate the reading, not the thinking/);
    expect(client.getInstructions()).toMatch(/Delegate the reading, not the thinking/);
    expect(client.getInstructions()).toMatch(/gemini_bridge_toggle/);
    await client.close();
  });

  it("short-circuits a disabled bridge end to end without spawning Gemini", async () => {
    const client = await connect();
    await client.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: false } });
    const result = (await client.callTool({ name: "gemini_ask", arguments: { prompt: "hello" } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorType: "disabled" });
    expect(invoke).not.toHaveBeenCalled();
    expect((await client.listTools()).tools).toHaveLength(4);
    await client.close();
  });

  it("streams progress notifications to a client that asks for them", async () => {
    const client = await connect();
    const messages: string[] = [];
    await client.callTool({ name: "gemini_ask", arguments: { prompt: "hello" } }, undefined, {
      onprogress: (progress) => messages.push(String(progress.message)),
    });
    expect(messages).toContain("Asking gemini-3.1-flash-lite…");
    await client.close();
  });

  it("rejects invalid arguments before doing anything", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "gemini_ask", arguments: { prompt: "x", model: "--yolo" } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await client.close();
  });
});
