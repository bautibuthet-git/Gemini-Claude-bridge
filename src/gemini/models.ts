import type { Mode, Preferences } from "../state/schema.js";

export type Tier = "fast" | "strong";

const STRONG_MODES: ReadonlySet<Mode> = new Set<Mode>(["review", "refactor", "plan", "test"]);

/** Reviews, refactors, plans and tests get the strongest model with quota; the rest get the fastest. */
export function tierFor(mode: Mode): Tier {
  return STRONG_MODES.has(mode) ? "strong" : "fast";
}

/** The models to try, in order: an explicit request, then the forced preference, then the mode's chain. */
export function modelChain(preferences: Preferences, mode: Mode, explicit?: string): string[] {
  const chain = [explicit, preferences.model, ...preferences.models[tierFor(mode)]];
  return [...new Set(chain.filter((model): model is string => Boolean(model)))];
}

export interface Cooldown {
  until: string;
  reason: string;
}

export interface SkippedModel extends Cooldown {
  model: string;
}

export interface ChainPlan {
  tryOrder: string[];
  skipped: SkippedModel[];
}

/**
 * Drops models that are still cooling down. If that leaves nothing, the one that recovers first
 * is tried anyway, since the cooldown is only an estimate. An explicit request is never skipped.
 */
export function planChain(
  chain: readonly string[],
  cooldowns: Readonly<Record<string, Cooldown>>,
  now: Date,
  explicit?: string,
): ChainPlan {
  const tryOrder: string[] = [];
  const skipped: SkippedModel[] = [];
  for (const model of chain) {
    const cooldown = cooldowns[model];
    if (model !== explicit && cooldown && Date.parse(cooldown.until) > now.getTime()) {
      skipped.push({ model, ...cooldown });
    } else {
      tryOrder.push(model);
    }
  }
  if (tryOrder.length === 0 && skipped.length > 0) {
    const soonest = [...skipped].sort((a, b) => Date.parse(a.until) - Date.parse(b.until))[0]!;
    tryOrder.push(soonest.model);
  }
  return { tryOrder, skipped };
}

export interface QuotaInfo {
  /** no_quota: the account has none for this model ("limit: 0"); daily: used up for today; rate: per-minute limit. */
  kind: "no_quota" | "daily" | "rate";
  retryAfterMs: number | null;
}

const QUOTA_PATTERN =
  /(TerminalQuotaError|RetryableQuotaError|RESOURCE_EXHAUSTED|exceeded your current quota|exhausted your daily quota|quota exceeded|\b429\b|too many requests|rate.?limit)/i;
const UNAVAILABLE_PATTERN =
  /(ModelNotFoundError|is not found for API version|not supported for generateContent|no longer available|unknown model|invalid model)/i;
const TRANSIENT_PATTERN =
  /(overloaded|\bUNAVAILABLE\b|\b50[0234]\b|internal error|deadline exceeded|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error)/i;

export function parseQuota(message: string): QuotaInfo | null {
  if (!QUOTA_PATTERN.test(message)) return null;
  const retry = /retry in\s+([\d.]+)\s*s/i.exec(message);
  const retryAfterMs = retry ? Math.ceil(Number(retry[1]) * 1000) : null;
  // Order matters: a daily-quota error also carries a misleading per-minute "retry in".
  if (/limit:\s*0\b/.test(message)) return { kind: "no_quota", retryAfterMs };
  if (/daily|per.?day/i.test(message)) return { kind: "daily", retryAfterMs };
  return { kind: "rate", retryAfterMs };
}

export function isModelUnavailable(message: string): boolean {
  return UNAVAILABLE_PATTERN.test(message);
}

export function isTransient(message: string): boolean {
  return TRANSIENT_PATTERN.test(message) && !QUOTA_PATTERN.test(message);
}

const HOUR = 60 * 60_000;

export function cooldownFor(failure: QuotaInfo | "unavailable", now: Date): Cooldown {
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  if (failure === "unavailable") return { until: at(24 * HOUR), reason: "model not available to this account" };
  switch (failure.kind) {
    case "no_quota":
      return { until: at(24 * HOUR), reason: "no quota for this model on this account" };
    case "daily":
      return {
        until: nextPacificMidnight(now).toISOString(),
        reason: "daily quota used up (resets at midnight Pacific time)",
      };
    case "rate":
      return { until: at(Math.max(15_000, failure.retryAfterMs ?? 60_000)), reason: "rate limited" };
  }
}

/** Google resets daily quotas at midnight Pacific time. Off by an hour at most around DST changes. */
export function nextPacificMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnightMs = ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs + 24 * HOUR);
}
