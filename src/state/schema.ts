import { z } from "zod";

export const MODES = ["ask", "summarize", "analyze", "review", "refactor", "plan", "test"] as const;
export type Mode = (typeof MODES)[number];

export const ENGINES = ["auto", "cli", "acp"] as const;
export type EnginePreference = (typeof ENGINES)[number];

export const SCHEMA_VERSION = 1;
/**
 * Measured: summarizing a 4000-line log took ~95s while Gemini had to read past the CLI's
 * 2000-line attachment limit on its own. Inlining files brought that to ~8s, but reviews that
 * span many files still need the headroom.
 */
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
/** Rough chars-per-token ratio used only for the "context saved" estimates. */
export const CHARS_PER_TOKEN = 4;

/** No leading "-" (can't be mistaken for a CLI flag), no whitespace or shell metacharacters. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Tried in order until one model answers. The Gemini CLI resolves the aliases ("pro", "flash",
 * "auto") to its current models, so they don't go stale; flash-lite has no alias. Measured on a
 * free API key: pro had no quota at all, flash allowed 20 requests a day, flash-lite handled
 * everything. Paid accounts simply succeed on the first entry.
 */
export const DEFAULT_MODELS = {
  /** ask, summarize, analyze: speed matters most. */
  fast: ["gemini-3.1-flash-lite", "flash", "auto"],
  /** review, refactor, plan, test: reasoning matters most. */
  strong: ["pro", "flash", "gemini-3.1-flash-lite"],
} as const;

/** A nested section missing from an older or partial file is rebuilt from its field defaults. */
const orEmpty = (value: unknown) => (value === undefined ? {} : value);
const modelName = z.string().regex(MODEL_PATTERN);

// Object and array defaults are factories: a shared default instance would be mutated by one
// parse and leak into the next.
export const stateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  enabled: z.boolean().default(true),
  preferences: z.preprocess(
    orEmpty,
    z.object({
      /** Tried first for every mode, before the chains. null = just use the chains. */
      model: modelName.nullable().default(null),
      models: z.preprocess(
        orEmpty,
        z.object({
          fast: z.array(modelName).min(1).default(() => [...DEFAULT_MODELS.fast]),
          strong: z.array(modelName).min(1).default(() => [...DEFAULT_MODELS.strong]),
        }),
      ),
      /** "yolo" auto-approves Gemini's own tool calls. The prompt still asks it to stay read-only. */
      approvalMode: z.enum(["default", "yolo"]).default("default"),
      timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
      /** auto: reuse a warm Gemini process when a call allows it, otherwise start one per call. */
      engine: z.enum(ENGINES).default("auto"),
      /** The same question about unchanged files is answered from cache for this long. 0 = off. */
      cacheTtlMinutes: z.number().int().min(0).max(7 * 24 * 60).default(24 * 60),
      /** Before Claude reads a big file whole, suggest delegating it (once per file per session). */
      suggestDelegation: z.preprocess(
        orEmpty,
        z.object({
          enabled: z.boolean().default(true),
          minLines: z.number().int().min(50).default(800),
        }),
      ),
    }),
  ),
  /** Models that recently ran out of quota (or don't exist for this account) are skipped until `until`. */
  modelCooldowns: z.record(z.string(), z.object({ until: z.string(), reason: z.string() })).default(() => ({})),
  geminiCli: z.preprocess(
    orEmpty,
    z.object({
      /** null = not found on the last check; "unknown" = found but `gemini --version` gave nothing usable. */
      lastDetectedVersion: z.string().nullable().default(null),
      lastInstalledCheckAt: z.string().nullable().default(null),
      lastAuthOk: z.boolean().nullable().default(null),
      lastAuthCheckAt: z.string().nullable().default(null),
      lastAuthDetail: z.string().nullable().default(null),
    }),
  ),
  usage: z.preprocess(
    orEmpty,
    z.object({
      totalCalls: z.number().int().nonnegative().default(0),
      totalErrors: z.number().int().nonnegative().default(0),
      callsByMode: z.record(z.string(), z.number().int().nonnegative()).default(() => ({})),
      lastUsedAt: z.string().nullable().default(null),
      estimatedCharsSaved: z.number().nonnegative().default(0),
      cacheHits: z.number().int().nonnegative().default(0),
    }),
  ),
});

export type BridgeState = z.infer<typeof stateSchema>;
export type Preferences = BridgeState["preferences"];

export function defaultState(): BridgeState {
  return stateSchema.parse({});
}
