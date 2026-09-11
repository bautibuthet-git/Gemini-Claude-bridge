import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../../src/cache.js";
import type { BridgeContext, WarmEngine } from "../../src/context.js";
import { classifyFailure, type GeminiRequest, type GeminiResponse } from "../../src/gemini/invoke.js";
import { runGemini, type RunRequest } from "../../src/gemini/runner.js";
import { History } from "../../src/history.js";
import { JobManager } from "../../src/jobs.js";
import { StateStore } from "../../src/state/store.js";
import { BridgeError } from "../../src/util/errors.js";
import { tempDir } from "../helpers.js";

const ANSWER: GeminiResponse = { text: "answer", model: "m", durationMs: 10, exitCode: 0, warnings: [], sessionId: "s-1" };
const NO_QUOTA = () =>
  classifyFailure(1, "TerminalQuotaError: You exceeded your current quota", undefined, "* Quota exceeded for metric: x, limit: 0, model: gemini-3.1-pro");

let root: string;
let ctx: BridgeContext;
let invoke: ReturnType<typeof vi.fn<(req: GeminiRequest) => Promise<GeminiResponse>>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  prompt: "p",
  chain: ["pro", "flash"],
  timeoutMs: 60_000,
  yolo: false,
  cwd: "C:\\scratch",
  includeDirectories: [],
  acpEligible: true,
  ...overrides,
});

function fakeWarmEngine(overrides: Partial<WarmEngine> = {}): WarmEngine {
  return {
    isHealthy: () => true,
    hasSession: () => false,
    describe: () => "fake",
    run: vi.fn(async () => ({ ...ANSWER, text: "warm answer" })),
    close: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await tempDir("gcb-runner-");
  invoke = vi.fn(async () => ({ ...ANSWER }));
  sleep = vi.fn(async () => undefined);
  ctx = {
    store: new StateStore(path.join(root, "state.json")),
    invoke,
    acp: null,
    cache: new ResponseCache(path.join(root, "cache")),
    history: new History(path.join(root, "history.jsonl")),
    jobs: new JobManager(),
    refreshCli: vi.fn(),
    projectDir: () => root,
    scratchDir: async () => root,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    sleep,
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("runGemini", () => {
  it("returns the first model's answer, cutting it short only if another model could follow", async () => {
    const outcome = await runGemini(ctx, request({ acpEligible: false }));
    expect(outcome.response.text).toBe("answer");
    expect(outcome.attempts.map((a) => [a.model, a.outcome])).toEqual([["pro", "ok"]]);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ model: "pro", failFast: true });
  });

  it("falls back past a model with no quota, benches it, and reports progress", async () => {
    invoke.mockRejectedValueOnce(NO_QUOTA());
    const progress: string[] = [];
    const outcome = await runGemini(ctx, request({ acpEligible: false, onProgress: (m) => progress.push(m) }));

    expect(outcome.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ["pro", "quota"],
      ["flash", "ok"],
    ]);
    expect(invoke.mock.calls[1]![0]).toMatchObject({ model: "flash", failFast: false });
    expect((await ctx.store.read()).modelCooldowns.pro).toMatchObject({ reason: "no quota for this model on this account" });
    expect(progress).toContain("pro: no quota for this model on this account — trying flash…");
  });

  it("skips a benched model on later calls", async () => {
    await ctx.store.update((s) => {
      s.modelCooldowns.pro = { until: "2026-09-11T00:00:00.000Z", reason: "no quota" };
    });
    const outcome = await runGemini(ctx, request({ acpEligible: false }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].model).toBe("flash");
    expect(outcome.skipped.map((s) => s.model)).toEqual(["pro"]);
  });

  it("treats a model the account can't use like one without quota", async () => {
    invoke.mockRejectedValueOnce(classifyFailure(1, "ModelNotFoundError: models/pro is not found for API version v1beta"));
    const outcome = await runGemini(ctx, request({ acpEligible: false }));
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(["unavailable", "ok"]);
    expect((await ctx.store.read()).modelCooldowns.pro?.reason).toBe("model not available to this account");
  });

  it("retries a temporary error once on the same model", async () => {
    invoke.mockRejectedValueOnce(classifyFailure(1, "503 UNAVAILABLE: The model is overloaded"));
    const outcome = await runGemini(ctx, request({ acpEligible: false }));
    expect(outcome.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ["pro", "transient"],
      ["pro", "ok"],
    ]);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("does not fall back on sign-in problems or timeouts", async () => {
    invoke.mockRejectedValueOnce(new BridgeError("not_authenticated", "expired", { exitCode: 41 }));
    const error = (await runGemini(ctx, request({ acpEligible: false })).catch((e: unknown) => e)) as BridgeError;
    expect(error.type).toBe("not_authenticated");
    expect(error.details.attempts).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when every model is out of quota", async () => {
    invoke.mockRejectedValue(NO_QUOTA());
    const error = (await runGemini(ctx, request({ acpEligible: false })).catch((e: unknown) => e)) as BridgeError;
    expect(error.type).toBe("quota");
    expect(error.message).toMatch(/No Gemini model could answer: tried pro .*; flash/);
  });

  it("uses the warm process when the call allows it", async () => {
    const warm = fakeWarmEngine();
    ctx.acp = warm;
    const outcome = await runGemini(ctx, request());
    expect(outcome.engine).toBe("acp");
    expect(outcome.response.text).toBe("warm answer");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back to a one-off process when the warm one fails, on the same model", async () => {
    ctx.acp = fakeWarmEngine({
      run: vi.fn(async () => {
        throw new BridgeError("gemini_error", "crashed", { failure: "engine" });
      }),
    });
    const outcome = await runGemini(ctx, request());
    expect(outcome.engine).toBe("cli");
    expect(outcome.attempts.map((a) => [a.model, a.engine, a.outcome])).toEqual([
      ["pro", "acp", "engine"],
      ["pro", "cli", "ok"],
    ]);
  });

  it("keeps calls the warm process can't serve, and the 'cli' preference, on one-off processes", async () => {
    ctx.acp = fakeWarmEngine();
    await runGemini(ctx, request({ acpEligible: false }));
    await ctx.store.update((s) => {
      s.preferences.engine = "cli";
    });
    await runGemini(ctx, request());
    expect(ctx.acp.run).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("resumes a follow-up with the CLI when the warm process no longer holds it", async () => {
    ctx.acp = fakeWarmEngine({ hasSession: () => false });
    await runGemini(ctx, request({ conversationId: "abc-12345" }));
    expect(invoke.mock.calls[0]![0].resumeSessionId).toBe("abc-12345");

    const warm = fakeWarmEngine({ hasSession: (id) => id === "abc-12345" });
    ctx.acp = warm;
    await runGemini(ctx, request({ conversationId: "abc-12345" }));
    expect(warm.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "abc-12345" }));
  });
});
