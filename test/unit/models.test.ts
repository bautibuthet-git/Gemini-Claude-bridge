import { describe, expect, it } from "vitest";
import {
  cooldownFor,
  isModelUnavailable,
  isTransient,
  modelChain,
  nextPacificMidnight,
  parseQuota,
  planChain,
  tierFor,
} from "../../src/gemini/models.js";
import { defaultState } from "../../src/state/schema.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("tierFor and modelChain", () => {
  it("sends reasoning-heavy modes to the strong chain and the rest to the fast one", () => {
    expect(["review", "refactor", "plan", "test"].map((m) => tierFor(m as never))).toEqual(["strong", "strong", "strong", "strong"]);
    expect(["ask", "summarize", "analyze"].map((m) => tierFor(m as never))).toEqual(["fast", "fast", "fast"]);
  });

  it("puts an explicit model first, then the forced preference, then the chain, without duplicates", () => {
    const preferences = defaultState().preferences;
    preferences.model = "flash";
    expect(modelChain(preferences, "ask", "my-model")).toEqual(["my-model", "flash", "gemini-3.1-flash-lite", "auto"]);
    expect(modelChain(defaultState().preferences, "review")).toEqual(["pro", "flash", "gemini-3.1-flash-lite"]);
  });
});

describe("planChain", () => {
  it("skips models that are still cooling down", () => {
    const plan = planChain(["pro", "flash"], { pro: { until: later(60_000), reason: "no quota" } }, NOW);
    expect(plan.tryOrder).toEqual(["flash"]);
    expect(plan.skipped).toEqual([{ model: "pro", until: later(60_000), reason: "no quota" }]);
  });

  it("tries a model again once its cooldown has passed", () => {
    expect(planChain(["pro"], { pro: { until: later(-1), reason: "x" } }, NOW).tryOrder).toEqual(["pro"]);
  });

  it("still tries the soonest-recovering model when every model is cooling down", () => {
    const cooldowns = { a: { until: later(90_000), reason: "x" }, b: { until: later(30_000), reason: "y" } };
    expect(planChain(["a", "b"], cooldowns, NOW).tryOrder).toEqual(["b"]);
  });

  it("never skips an explicitly requested model", () => {
    expect(planChain(["pro", "flash"], { pro: { until: later(60_000), reason: "x" } }, NOW, "pro").tryOrder).toEqual(["pro", "flash"]);
  });
});

describe("failure classification", () => {
  it.each([
    [
      "TerminalQuotaError: You exceeded your current quota\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\nPlease retry in 31.7s.",
      "no_quota",
    ],
    [
      "TerminalQuotaError: You have exhausted your daily quota on this model.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\nPlease retry in 39.5s.",
      "daily",
    ],
    ["429 Too Many Requests. Please retry in 12s", "rate"],
  ])("recognizes quota errors: %#", (message, kind) => {
    expect(parseQuota(message)?.kind).toBe(kind);
  });

  it("reads the retry delay and ignores unrelated errors", () => {
    expect(parseQuota("RESOURCE_EXHAUSTED. Please retry in 12.5s")?.retryAfterMs).toBe(12_500);
    expect(parseQuota("socket hang up")).toBeNull();
  });

  it("recognizes models the account can't use and temporary failures", () => {
    expect(isModelUnavailable("ModelNotFoundError: models/gemini-3.1-pro is not found for API version v1beta")).toBe(true);
    expect(isModelUnavailable("models/gemini-2.5-flash-lite is no longer available to new users")).toBe(true);
    expect(isTransient("503 UNAVAILABLE: The model is overloaded")).toBe(true);
    expect(isTransient("429 RESOURCE_EXHAUSTED overloaded")).toBe(false);
  });
});

describe("cooldownFor", () => {
  it("benches a model with no quota, or unknown to the account, for a day", () => {
    expect(cooldownFor({ kind: "no_quota", retryAfterMs: 30_000 }, NOW).until).toBe(later(24 * 60 * 60_000));
    expect(cooldownFor("unavailable", NOW).until).toBe(later(24 * 60 * 60_000));
  });

  it("waits out a per-minute limit, at least 15 seconds", () => {
    expect(cooldownFor({ kind: "rate", retryAfterMs: 5_000 }, NOW).until).toBe(later(15_000));
    expect(cooldownFor({ kind: "rate", retryAfterMs: null }, NOW).until).toBe(later(60_000));
  });

  it("waits for a daily quota until midnight Pacific time", () => {
    expect(cooldownFor({ kind: "daily", retryAfterMs: 39_000 }, NOW).until).toBe(nextPacificMidnight(NOW).toISOString());
  });
});

describe("nextPacificMidnight", () => {
  it("returns the next 00:00 in Los Angeles", () => {
    // 12:00Z on 10 Sep 2026 is 05:00 PDT (UTC-7), so the next midnight is 07:00Z the next day.
    expect(nextPacificMidnight(NOW).toISOString()).toBe("2026-09-11T07:00:00.000Z");
  });
});
