import type { BridgeContext } from "../context.js";
import type { BridgeState } from "../state/schema.js";
import { asBridgeError, BridgeError } from "../util/errors.js";
import { predictWaitMs, WINDOW_MS, type Spend } from "./budget.js";
import type { GeminiResponse } from "./invoke.js";
import { cooldownFor, planChain, type QuotaInfo, type SkippedModel } from "./models.js";

export type EngineName = "cli" | "acp";

export interface Attempt {
  model: string;
  engine: EngineName;
  outcome: "ok" | "quota" | "unavailable" | "transient" | "engine" | "error";
  ms: number;
  detail?: string;
}

export interface RunRequest {
  prompt: string;
  chain: readonly string[];
  explicitModel?: string;
  /** Budget for the whole call, fallbacks included. */
  timeoutMs: number;
  yolo: boolean;
  cwd: string;
  includeDirectories: readonly string[];
  /** The warm process can serve this call: no `@path` references (they need per-call folders) and no yolo. */
  acpEligible: boolean;
  conversationId?: string;
  /** Estimated input tokens of `prompt`, for the per-minute budget. */
  inputTokens?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RunOutcome {
  response: GeminiResponse;
  engine: EngineName;
  attempts: Attempt[];
  skipped: SkippedModel[];
}

/** Below this, starting another attempt is pointless. */
const MIN_ATTEMPT_MS = 4_000;
const TRANSIENT_RETRY_DELAY_MS = 2_000;

/**
 * Tries the model chain in order. Out of quota or unknown to the account → the model cools down
 * and the next one is tried at once. A temporary error → one retry. Anything else (sign-in,
 * timeout) → stop, since another model wouldn't help. Models whose per-minute token budget is
 * still busy are tried last rather than first.
 */
export async function runGemini(ctx: BridgeContext, req: RunRequest): Promise<RunOutcome> {
  const state = await ctx.store.read();
  const deadline = ctx.now().getTime() + req.timeoutMs;
  const plan = planChain(req.chain, state.modelCooldowns, ctx.now(), req.explicitModel);
  const waits = budgetWaits(state, await recentSpends(ctx), plan.tryOrder, req.inputTokens ?? 0, ctx.now().getTime());
  const tryOrder = orderByBudget(plan.tryOrder, waits, req.explicitModel);
  const first = plan.tryOrder[0];
  if (first && tryOrder[0] !== first) {
    req.onProgress?.(`${first}'s per-minute token quota is busy for ~${Math.ceil((waits.get(first) ?? 0) / 1000)}s; trying ${tryOrder[0]} first…`);
  }

  const attempts: Attempt[] = [];
  const preference = state.preferences.engine;
  let useAcp =
    ctx.acp !== null &&
    preference !== "cli" &&
    req.acpEligible &&
    ctx.acp.isHealthy() &&
    (!req.conversationId || ctx.acp.hasSession(req.conversationId));

  let index = 0;
  let retriedTransient = false;
  while (index < tryOrder.length) {
    const model = tryOrder[index]!;
    const remaining = deadline - ctx.now().getTime();
    if (attempts.length > 0 && remaining < MIN_ATTEMPT_MS) break;

    const engine: EngineName = useAcp ? "acp" : "cli";
    const startedAt = ctx.now().getTime();
    // Only worth cutting a model short if there is another one to try.
    const failFast = index < tryOrder.length - 1;
    const onLimit = (limit: number) => void learnLimit(ctx, model, limit);
    req.onProgress?.(`Asking ${model}${engine === "acp" ? " (warm process)" : ""}…`);
    const release = ctx.spend.start({ model, at: startedAt, tokens: req.inputTokens ?? 0 });
    try {
      const response =
        engine === "acp"
          ? await ctx.acp!.run({
              prompt: req.prompt,
              model,
              timeoutMs: remaining,
              signal: req.signal,
              sessionId: req.conversationId,
              failFast,
              onNotice: req.onProgress,
              onLimit,
            })
          : await ctx.invoke({
              prompt: req.prompt,
              model,
              yolo: req.yolo,
              timeoutMs: remaining,
              cwd: req.cwd,
              includeDirectories: req.includeDirectories,
              signal: req.signal,
              resumeSessionId: req.conversationId,
              failFast,
              onNotice: req.onProgress,
              onLimit,
            });
      attempts.push({ model, engine, outcome: "ok", ms: ctx.now().getTime() - startedAt });
      return { response, engine, attempts, skipped: plan.skipped };
    } catch (err) {
      const error = asBridgeError(err);
      const ms = ctx.now().getTime() - startedAt;
      const failure = error.details.failure;
      if (typeof error.details.tokenLimit === "number") await learnLimit(ctx, model, error.details.tokenLimit);

      if (failure === "engine") {
        attempts.push({ model, engine, outcome: "engine", ms, detail: error.message });
        useAcp = false; // same model again, as a one-off process
        req.onProgress?.("The warm Gemini process is unavailable; using a one-off process.");
        continue;
      }

      if (error.type === "quota" || failure === "unavailable") {
        const cooldown = cooldownFor(failure === "unavailable" ? "unavailable" : (error.details.quota as QuotaInfo), ctx.now());
        await ctx.store
          .update((s) => {
            s.modelCooldowns[model] = cooldown;
          })
          .catch(() => undefined);
        attempts.push({ model, engine, outcome: failure === "unavailable" ? "unavailable" : "quota", ms, detail: cooldown.reason });
        const next = tryOrder[index + 1];
        if (next) req.onProgress?.(`${model}: ${cooldown.reason} — trying ${next}…`);
        index++;
        retriedTransient = false;
        continue;
      }

      if (failure === "transient" && !retriedTransient && deadline - ctx.now().getTime() > MIN_ATTEMPT_MS + TRANSIENT_RETRY_DELAY_MS) {
        retriedTransient = true;
        attempts.push({ model, engine, outcome: "transient", ms, detail: error.message });
        req.onProgress?.(`${model}: temporary error, retrying once…`);
        await ctx.sleep(TRANSIENT_RETRY_DELAY_MS);
        continue;
      }

      attempts.push({ model, engine, outcome: "error", ms, detail: error.message });
      throw new BridgeError(error.type, error.message, { ...error.details, attempts });
    } finally {
      release();
    }
  }

  throw new BridgeError("quota", describeExhaustion(attempts, plan.skipped), { attempts, skipped: plan.skipped });
}

/**
 * The shortest wait the per-minute budget would impose on any usable model for a request of
 * `tokens`: 0 if some model can take it now. Lets a foreground call move to the background
 * instead of blocking Claude on that wait.
 */
export async function shortestBudgetWait(
  ctx: BridgeContext,
  chain: readonly string[],
  explicitModel: string | undefined,
  tokens: number,
): Promise<number> {
  const state = await ctx.store.read();
  const now = ctx.now();
  const plan = planChain(chain, state.modelCooldowns, now, explicitModel);
  const waits = budgetWaits(state, await recentSpends(ctx), plan.tryOrder, tokens, now.getTime());
  return plan.tryOrder.length === 0 ? 0 : Math.min(...plan.tryOrder.map((model) => waits.get(model) ?? 0));
}

/** Input tokens sent in the last minute: finished calls from the shared history, plus calls in flight here. */
export async function recentSpends(ctx: BridgeContext): Promise<Spend[]> {
  const now = ctx.now().getTime();
  const entries = await ctx.history.recent(new Date(now - WINDOW_MS)).catch(() => []);
  const spends: Spend[] = [];
  for (const entry of entries) {
    if (entry.engine === "cache" || !entry.inputTokens) continue;
    const answered = entry.attempts.filter((a) => a.outcome === "ok");
    for (const attempt of answered) {
      spends.push({ model: attempt.model, at: Date.parse(entry.at), tokens: Math.round(entry.inputTokens / answered.length) });
    }
  }
  return [...spends, ...ctx.spend.list()];
}

function budgetWaits(state: BridgeState, spends: readonly Spend[], models: readonly string[], tokens: number, now: number): Map<string, number> {
  const waits = new Map<string, number>();
  for (const model of models) {
    const limit = state.modelLimits[model]?.inputTokensPerMinute;
    waits.set(model, limit && tokens > 0 ? predictWaitMs(spends, model, tokens, limit, now) : 0);
  }
  return waits;
}

/** Models free to take the request now keep their order and go first; busy ones follow, shortest wait first. */
function orderByBudget(models: readonly string[], waits: ReadonlyMap<string, number>, explicitModel?: string): string[] {
  const free = models.filter((m) => m === explicitModel || !waits.get(m));
  const busy = models.filter((m) => m !== explicitModel && waits.get(m)).sort((a, b) => (waits.get(a) ?? 0) - (waits.get(b) ?? 0));
  return [...free, ...busy];
}

async function learnLimit(ctx: BridgeContext, model: string, inputTokensPerMinute: number): Promise<void> {
  await ctx.store
    .update((s) => {
      s.modelLimits[model] = { inputTokensPerMinute, learnedAt: ctx.now().toISOString() };
    })
    .catch(() => undefined);
}

function describeExhaustion(attempts: readonly Attempt[], skipped: readonly SkippedModel[]): string {
  const tried = attempts.filter((a) => a.outcome !== "ok").map((a) => `${a.model} (${a.detail ?? a.outcome})`);
  const cooling = skipped.map((s) => `${s.model} (${s.reason}, until ${s.until})`);
  const parts = [
    tried.length > 0 ? `tried ${tried.join("; ")}` : "",
    cooling.length > 0 ? `skipped ${cooling.join("; ")}` : "",
  ].filter(Boolean);
  return `No Gemini model could answer: ${parts.join(". ") || "the time budget ran out"}.`;
}
