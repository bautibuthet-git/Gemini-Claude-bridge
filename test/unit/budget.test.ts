import { describe, expect, it } from "vitest";
import { estimateInputTokens, parseTokenLimit, predictWaitMs, SpendLedger } from "../../src/gemini/budget.js";

describe("parseTokenLimit", () => {
  it("reads the per-minute input-token limit from Google's quota message, and nothing else", () => {
    expect(
      parseTokenLimit(
        "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.1-flash-lite",
      ),
    ).toBe(250_000);
    expect(parseTokenLimit("* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: x")).toBeNull();
    expect(parseTokenLimit("socket hang up")).toBeNull();
  });
});

describe("predictWaitMs", () => {
  const now = 100_000;

  it("is 0 when the request fits under the limit", () => {
    expect(predictWaitMs([{ model: "m", at: now - 10_000, tokens: 100_000 }], "m", 100_000, 250_000, now)).toBe(0);
  });

  it("waits until enough of the last minute's tokens expire", () => {
    const spends = [
      { model: "m", at: now - 50_000, tokens: 120_000 },
      { model: "m", at: now - 10_000, tokens: 100_000 },
    ];
    // 220k used + 100k new > 250k; the older 120k leaves the window in 10s, which makes room.
    expect(predictWaitMs(spends, "m", 100_000, 250_000, now)).toBe(10_000);
  });

  it("ignores other models, spends older than a minute, and requests bigger than the whole limit", () => {
    expect(predictWaitMs([{ model: "other", at: now, tokens: 250_000 }], "m", 100_000, 250_000, now)).toBe(0);
    expect(predictWaitMs([{ model: "m", at: now - 61_000, tokens: 250_000 }], "m", 100_000, 250_000, now)).toBe(0);
    expect(predictWaitMs([{ model: "m", at: now, tokens: 10 }], "m", 300_000, 250_000, now)).toBe(0);
  });
});

describe("estimateInputTokens and SpendLedger", () => {
  it("estimates on the high side, since logs and code tokenize densely", () => {
    expect(estimateInputTokens("x".repeat(250))).toBe(100);
  });

  it("tracks calls in flight until they are released", () => {
    const ledger = new SpendLedger();
    const release = ledger.start({ model: "m", at: 1, tokens: 5 });
    expect(ledger.list()).toEqual([{ model: "m", at: 1, tokens: 5 }]);
    release();
    expect(ledger.list()).toEqual([]);
  });
});
