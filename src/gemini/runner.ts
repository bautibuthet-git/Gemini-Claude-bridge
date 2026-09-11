import type { BridgeContext } from "../context.js";
import { asBridgeError, BridgeError } from "../util/errors.js";
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
 * timeout) → stop, since another model wouldn't help.
 */
export async function runGemini(ctx: BridgeContext, req: RunRequest): Promise<RunOutcome> {
  const state = await ctx.store.read();
  const deadline = ctx.now().getTime() + req.timeoutMs;
  const plan = planChain(req.chain, state.modelCooldowns, ctx.now(), req.explicitModel);
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
  while (index < plan.tryOrder.length) {
    const model = plan.tryOrder[index]!;
    const remaining = deadline - ctx.now().getTime();
    if (attempts.length > 0 && remaining < MIN_ATTEMPT_MS) break;

    const engine: EngineName = useAcp ? "acp" : "cli";
    const startedAt = ctx.now().getTime();
    // Only worth cutting a model short if there is another one to try.
    const failFast = index < plan.tryOrder.length - 1;
    req.onProgress?.(`Asking ${model}${engine === "acp" ? " (warm process)" : ""}…`);
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
            });
      attempts.push({ model, engine, outcome: "ok", ms: ctx.now().getTime() - startedAt });
      return { response, engine, attempts, skipped: plan.skipped };
    } catch (err) {
      const error = asBridgeError(err);
      const ms = ctx.now().getTime() - startedAt;
      const failure = error.details.failure;

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
        const next = plan.tryOrder[index + 1];
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
    }
  }

  throw new BridgeError("quota", describeExhaustion(attempts, plan.skipped), { attempts, skipped: plan.skipped });
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
