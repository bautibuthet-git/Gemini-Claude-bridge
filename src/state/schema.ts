import { z } from "zod";

export const MODES = ["ask", "analyze", "review", "refactor", "plan", "test"] as const;
export type Mode = (typeof MODES)[number];

export const SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
/** Rough chars-per-token ratio used only for the "context saved" estimate. */
export const CHARS_PER_TOKEN = 4;

/** A nested section missing from an older or partial file is rebuilt from its field defaults. */
const orEmpty = (value: unknown) => (value === undefined ? {} : value);

export const stateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  enabled: z.boolean().default(true),
  preferences: z.preprocess(
    orEmpty,
    z.object({
      /** Default Gemini model; null lets the Gemini CLI use its own default. */
      model: z.string().min(1).nullable().default(null),
      /** "yolo" auto-approves Gemini's own tool calls. The prompt still asks it to stay read-only. */
      approvalMode: z.enum(["default", "yolo"]).default("default"),
      timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    }),
  ),
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
      callsByMode: z.record(z.string(), z.number().int().nonnegative()).default({}),
      lastUsedAt: z.string().nullable().default(null),
      estimatedCharsSaved: z.number().nonnegative().default(0),
    }),
  ),
});

export type BridgeState = z.infer<typeof stateSchema>;

export function defaultState(): BridgeState {
  return stateSchema.parse({});
}
