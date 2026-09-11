/**
 * Per-minute input-token budget. Google's free tier caps input tokens per minute per model
 * (250,000 for flash-lite); a 4,000-line log is a large share of that, and a second one within
 * the minute made the Gemini CLI wait 64s before retrying. Knowing the limit — learned from
 * the quota error itself — and what was sent recently, the bridge can pick another model or run
 * the request in the background instead of blocking Claude on that wait.
 */

export const WINDOW_MS = 60_000;
/** Logs and code full of numbers and symbols tokenize densely; this errs on the high side. */
export const CHARS_PER_INPUT_TOKEN = 2.5;

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_INPUT_TOKEN);
}

/** "Quota exceeded for metric: …input_token_count, limit: 250000, model: …" → 250000. */
export function parseTokenLimit(text: string): number | null {
  const match = /input_token_count[^\n]*?limit:\s*(\d+)/i.exec(text);
  const limit = match ? Number(match[1]) : Number.NaN;
  return limit > 0 ? limit : null;
}

export interface Spend {
  model: string;
  at: number;
  tokens: number;
}

/**
 * How long until `tokens` more fit under `limit` for `model`, given what was sent in the last
 * minute. 0 when it fits now — or when the request is bigger than the whole limit, since
 * waiting wouldn't help and the call should fail fast instead.
 */
export function predictWaitMs(spends: readonly Spend[], model: string, tokens: number, limit: number, now: number): number {
  if (tokens > limit) return 0;
  const recent = spends.filter((s) => s.model === model && now - s.at < WINDOW_MS).sort((a, b) => a.at - b.at);
  let used = recent.reduce((sum, s) => sum + s.tokens, 0);
  if (used + tokens <= limit) return 0;
  for (const spend of recent) {
    used -= spend.tokens;
    if (used + tokens <= limit) return Math.max(0, spend.at + WINDOW_MS - now);
  }
  return 0;
}

/** Requests in flight in this process, not yet in the shared history. */
export class SpendLedger {
  private readonly active = new Set<Spend>();

  start(spend: Spend): () => void {
    this.active.add(spend);
    return () => this.active.delete(spend);
  }

  list(): Spend[] {
    return [...this.active];
  }
}
