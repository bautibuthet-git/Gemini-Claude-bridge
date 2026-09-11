import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ResponseCache, type CachedAnswer } from "../cache.js";
import type { BridgeContext } from "../context.js";
import { prepareAttachments, type Attachments } from "../gemini/attachments.js";
import { modelChain } from "../gemini/models.js";
import { buildPrompt } from "../gemini/promptBuilder.js";
import { runGemini, type Attempt, type RunOutcome } from "../gemini/runner.js";
import type { HistoryEntry } from "../history.js";
import { CHARS_PER_TOKEN, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, MODEL_PATTERN, MODES, type Mode } from "../state/schema.js";
import { asBridgeError, BridgeError } from "../util/errors.js";
import { estimateChars, includeDirectoriesFor, resolveInputPaths } from "../util/paths.js";
import { errorResult, textResult, withWarning } from "./result.js";

export const MAX_PATHS = 20;
const HEARTBEAT_MS = 10_000;

export const ASK_DESCRIPTION = [
  "Delegate a self-contained task to Google Gemini (via the user's local, signed-in gemini CLI) to save your own context and tokens.",
  "Good fits: summarizing or analyzing large files, logs or many files; broad codebase questions; second-opinion reviews; drafting boilerplate, docs or tests; plans.",
  "Pass files and folders in `paths` and do NOT read them yourself first: the bridge hands them to Gemini, so their contents never enter this conversation.",
  "Gemini sees only `prompt` and `paths` (not this conversation): make the prompt stand alone and use `format` to say exactly what you need back.",
  "Independent tasks can run as parallel gemini_ask calls; for long ones pass background: true and collect the answer with gemini_result.",
  "Gemini only returns text; you apply any changes. Its citations can be slightly off, so before relying on a specific line or value, read just those lines.",
  "Answers end with a followUp id: pass it as `followUp` to ask more about the same material without resending it.",
  "Not worth it for small files or quick questions. If the result has errorType \"disabled\", do the task yourself.",
].join(" ");

export const askInputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe("The task for Gemini, written to stand alone: include any context it needs. Refer to attached files by name."),
  paths: z
    .array(z.string().min(1))
    .max(MAX_PATHS)
    .optional()
    .describe(
      `Files or folders for Gemini (max ${MAX_PATHS}). Absolute paths preferred; relative ones resolve against the project folder. Files are sent complete with line numbers; folders are read recursively, so prefer specific files.`,
    ),
  mode: z
    .enum(MODES)
    .optional()
    .describe(
      "Framing preset. ask (default): general. summarize: key facts, errors with line numbers. analyze: explain code or data. review: critical review citing files and lines. refactor: behavior-preserving proposals. plan: ordered implementation plan. test: test cases plus code. review/refactor/plan/test use the strongest model with quota; the others the fastest.",
    ),
  format: z
    .string()
    .max(500)
    .optional()
    .describe('What you need back, e.g. "5 bullets", "only issues as file:line — problem — fix", "max 200 words". Short, targeted answers cost you fewer tokens.'),
  followUp: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, "Use the followUp id printed at the end of an earlier answer")
    .optional()
    .describe("The followUp id from an earlier answer: continues that conversation, so Gemini still has its files and answer. Don't resend the same paths."),
  background: z
    .boolean()
    .optional()
    .describe("Return immediately with a jobId and let Gemini work while you continue; collect the answer with gemini_result."),
  fresh: z.boolean().optional().describe("Ask Gemini again even if an identical question about the same files was answered recently."),
  model: z
    .string()
    .regex(MODEL_PATTERN, "Model names contain only letters, digits and . _ : / -")
    .optional()
    .describe("Try this Gemini model first (the preference chain still backs it up). Omit to let the bridge pick (recommended)."),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Hard time budget in milliseconds, fallbacks included (default 180000). When it runs out, Gemini is stopped."),
  yolo: z
    .boolean()
    .optional()
    .describe(
      "Auto-approve Gemini's own tool calls (e.g. web fetches). Default false. Gemini is still told not to edit files or run commands. Only set this if the user asks.",
    ),
};

export interface AskArgs {
  prompt: string;
  paths?: string[];
  mode?: Mode;
  format?: string;
  followUp?: string;
  background?: boolean;
  fresh?: boolean;
  model?: string;
  timeoutMs?: number;
  yolo?: boolean;
}

export interface AskOptions {
  signal?: AbortSignal;
  /** Progress messages for the client while Gemini works. */
  report?: (message: string) => void;
  /** Set when running as a background job (for the history). */
  background?: boolean;
}

export async function handleAsk(ctx: BridgeContext, args: AskArgs, options: AskOptions = {}): Promise<CallToolResult> {
  return args.background ? startBackground(ctx, args) : executeAsk(ctx, args, options);
}

export async function executeAsk(ctx: BridgeContext, args: AskArgs, options: AskOptions = {}): Promise<CallToolResult> {
  const state = await ctx.store.read();
  const warning = ctx.store.takeWarning();
  // Checked before anything else: when off, no path checks and no subprocess at all.
  if (!state.enabled) {
    return withWarning(errorResult("disabled", "The Gemini bridge is turned off, so nothing was sent to Gemini."), warning);
  }

  const mode = args.mode ?? "ask";
  const startedAt = ctx.now().getTime();
  const elapsed = () => ctx.now().getTime() - startedAt;
  const call = { mode, background: options.background ?? false };
  let attachments: Attachments = { inline: [], referenced: [], inlineBytes: 0 };

  try {
    const { resolved, missing } = await resolveInputPaths(args.paths ?? [], ctx.projectDir());
    if (missing.length > 0) {
      throw new BridgeError("invalid_paths", `These paths do not exist: ${missing.join("; ")}`, { missing });
    }

    const [fileChars, cwd, prepared] = await Promise.all([
      estimateChars(resolved),
      ctx.scratchDir(),
      prepareAttachments(resolved),
    ]);
    attachments = prepared;
    const prompt = buildPrompt({
      prompt: args.prompt,
      mode,
      format: args.format,
      inline: prepared.inline,
      referenced: prepared.referenced,
      followUp: Boolean(args.followUp),
    });
    const yolo = args.yolo ?? state.preferences.approvalMode === "yolo";

    // Folders can change without a cheap way to notice, and follow-ups depend on conversation state.
    const cacheTtlMs = state.preferences.cacheTtlMinutes * 60_000;
    const cacheKey =
      cacheTtlMs > 0 && !args.followUp && !prepared.referenced.some((file) => file.isDirectory)
        ? ResponseCache.key({
            v: 2,
            prompt,
            model: args.model ?? null,
            yolo,
            refs: await fingerprints(prepared.referenced.map((file) => file.path)),
          })
        : null;
    if (cacheKey && !args.fresh) {
      const cached = await ctx.cache.get(cacheKey, cacheTtlMs, ctx.now());
      if (cached) {
        const charsSaved = Math.max(0, fileChars - cached.text.length);
        await record(ctx, { ...call, ok: true, engine: "cache", model: cached.model, durationMs: elapsed(), attempts: [], attachments, charsSaved });
        return withWarning(textResult(`${cached.text}\n\n${cachedFooter(mode, cached)}`), warning);
      }
    }

    options.report?.(describeAttachments(prepared));
    const heartbeat = options.report
      ? setInterval(() => options.report?.(`Gemini is still working… ${Math.round(elapsed() / 1000)}s`), HEARTBEAT_MS)
      : undefined;
    let outcome: RunOutcome;
    try {
      outcome = await runGemini(ctx, {
        prompt,
        chain: modelChain(state.preferences, mode, args.model),
        explicitModel: args.model,
        timeoutMs: args.timeoutMs ?? state.preferences.timeoutMs,
        yolo,
        cwd,
        includeDirectories: includeDirectoriesFor(resolved, ctx.projectDir()),
        acpEligible: prepared.referenced.length === 0 && !yolo,
        conversationId: args.followUp,
        signal: options.signal,
        onProgress: options.report,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const { response } = outcome;
    const charsSaved = Math.max(0, fileChars - response.text.length);
    await record(ctx, {
      ...call,
      ok: true,
      engine: outcome.engine,
      model: response.model,
      durationMs: elapsed(),
      attempts: outcome.attempts,
      attachments,
      charsSaved,
    });
    if (cacheKey) {
      await ctx.cache
        .set(cacheKey, {
          text: response.text,
          model: response.model,
          createdAt: ctx.now().toISOString(),
          durationMs: response.durationMs,
          conversationId: response.sessionId,
        })
        .catch(() => undefined);
    }

    const cliWarnings = response.warnings.length > 0 ? `\n\nGemini CLI warnings:\n${response.warnings.join("\n")}` : "";
    // Deliberately no structuredContent: Claude Code would show the model that payload instead
    // of the text, and Gemini's answer must reach Claude as readable text. The footer carries
    // the metadata a structured payload would have held.
    return withWarning(textResult(`${response.text}${cliWarnings}\n\n${answerFooter(mode, outcome, charsSaved)}`), warning);
  } catch (err) {
    const error = asBridgeError(err);
    const attempts = Array.isArray(error.details.attempts) ? (error.details.attempts as Attempt[]) : [];
    await record(ctx, {
      ...call,
      ok: false,
      engine: attempts[attempts.length - 1]?.engine ?? "none",
      model: null,
      durationMs: elapsed(),
      attempts,
      attachments,
      charsSaved: 0,
      error,
    });
    const { attempts: _full, skipped, ...details } = error.details;
    return withWarning(
      errorResult(error.type, error.message, {
        mode,
        durationMs: elapsed(),
        ...details,
        ...(attempts.length > 0 ? { attempts: attempts.map(({ model, outcome, detail }) => ({ model, outcome, detail })) } : {}),
        ...(Array.isArray(skipped) && skipped.length > 0 ? { skipped } : {}),
      }),
      warning,
    );
  }
}

async function startBackground(ctx: BridgeContext, args: AskArgs): Promise<CallToolResult> {
  // Fail fast on what can be checked now, so a doomed job never gets started.
  const state = await ctx.store.read();
  if (!state.enabled) return errorResult("disabled", "The Gemini bridge is turned off, so nothing was sent to Gemini.");
  const { missing } = await resolveInputPaths(args.paths ?? [], ctx.projectDir());
  if (missing.length > 0) return errorResult("invalid_paths", `These paths do not exist: ${missing.join("; ")}`, { missing });

  const label = `${args.mode ?? "ask"}: ${truncate(args.prompt, 80)}`;
  const job = ctx.jobs.start(
    label,
    () => executeAsk(ctx, { ...args, background: false }, { background: true }),
    (err) => errorResult("gemini_error", asBridgeError(err).message),
  );
  const message = `Started background Gemini job ${job.id} (${label}). Keep working; collect the answer with gemini_result({ jobId: "${job.id}", waitSeconds: 60 }).`;
  return textResult(message, { message, jobId: job.id, status: "running" });
}

interface CallRecord {
  mode: Mode;
  background: boolean;
  ok: boolean;
  engine: HistoryEntry["engine"];
  model: string | null;
  durationMs: number;
  attempts: readonly Attempt[];
  attachments: Attachments;
  charsSaved: number;
  error?: BridgeError;
}

/** Usage counters, sign-in state and history. Bookkeeping must never cost the user an answer. */
async function record(ctx: BridgeContext, call: CallRecord): Promise<void> {
  const stamp = ctx.now().toISOString();
  await ctx.store
    .update((s) => {
      s.usage.totalCalls += 1;
      s.usage.callsByMode[call.mode] = (s.usage.callsByMode[call.mode] ?? 0) + 1;
      s.usage.lastUsedAt = stamp;
      s.usage.estimatedCharsSaved += call.charsSaved;
      if (call.engine === "cache") s.usage.cacheHits += 1;
      if (!call.ok) s.usage.totalErrors += 1;
      if (call.ok && call.engine !== "cache") {
        s.geminiCli.lastAuthOk = true;
        s.geminiCli.lastAuthCheckAt = stamp;
        s.geminiCli.lastAuthDetail = "The last Gemini call succeeded.";
      } else if (call.error?.type === "not_authenticated") {
        s.geminiCli.lastAuthOk = false;
        s.geminiCli.lastAuthCheckAt = stamp;
        s.geminiCli.lastAuthDetail = call.error.message;
      } else if (call.error?.type === "not_installed") {
        s.geminiCli.lastDetectedVersion = null;
        s.geminiCli.lastInstalledCheckAt = stamp;
      }
    })
    .catch(() => undefined);
  await ctx.history
    .append({
      at: stamp,
      mode: call.mode,
      ok: call.ok,
      engine: call.engine,
      model: call.model,
      durationMs: call.durationMs,
      ...(call.error ? { errorType: call.error.type } : {}),
      attempts: call.attempts.map(({ model, outcome, ms }) => ({ model, outcome, ms })),
      inlineFiles: call.attachments.inline.length,
      referencedFiles: call.attachments.referenced.length,
      charsSaved: call.charsSaved,
      background: call.background,
    })
    .catch(() => undefined);
}

function answerFooter(mode: Mode, outcome: RunOutcome, charsSaved: number): string {
  const { response, engine, attempts } = outcome;
  const tokens = Math.round(charsSaved / CHARS_PER_TOKEN);
  const parts = ["gemini-claude-bridge", mode, response.model ?? "default model", `${(response.durationMs / 1000).toFixed(1)}s`];
  if (engine === "acp") parts.push("warm process");
  if (tokens > 0) parts.push(`~${tokens} tokens of file content kept out of Claude's context`);
  const lines = [`[${parts.join(" · ")}]`];
  const passedOver = attempts.filter((a) => a.outcome === "quota" || a.outcome === "unavailable");
  if (passedOver.length > 0) lines.push(`[fell back past ${passedOver.map((a) => `${a.model} (${a.detail})`).join("; ")}]`);
  if (response.sessionId) lines.push(`[followUp: "${response.sessionId}"]`);
  return lines.join("\n");
}

function cachedFooter(mode: Mode, cached: CachedAnswer): string {
  const lines = [
    `[gemini-claude-bridge · ${mode} · cached answer from ${cached.createdAt} (${cached.model ?? "default model"}) · pass fresh: true to ask Gemini again]`,
  ];
  if (cached.conversationId) lines.push(`[followUp: "${cached.conversationId}"]`);
  return lines.join("\n");
}

function describeAttachments(attachments: Attachments): string {
  const lines = attachments.inline.reduce((sum, file) => sum + file.lines, 0);
  const parts = [];
  if (attachments.inline.length > 0) parts.push(`${attachments.inline.length} file(s), ${lines} lines, inline`);
  if (attachments.referenced.length > 0) parts.push(`${attachments.referenced.length} by reference`);
  return parts.length > 0 ? `Sending ${parts.join(" and ")} to Gemini…` : "Asking Gemini…";
}

/** Size and mtime of each file left as a reference, so an edit invalidates the cached answer. */
async function fingerprints(paths: readonly string[]): Promise<Array<[string, number, number]>> {
  return Promise.all(
    paths.map(async (file): Promise<[string, number, number]> => {
      const stat = await fs.stat(file).catch(() => null);
      return [file, stat?.size ?? -1, stat?.mtimeMs ?? -1];
    }),
  );
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * MCP progress notifications while Gemini works. Claude Code resets its idle timeout on each
 * one, and clients that display them show what the bridge is doing.
 */
export function progressReporter(extra: Extra): ((message: string) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } }).catch(() => undefined);
  };
}

export function registerAskTool(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "gemini_ask",
    {
      title: "Ask Gemini",
      description: ASK_DESCRIPTION,
      inputSchema: askInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) => handleAsk(ctx, args, { signal: extra.signal, report: progressReporter(extra) }),
  );
}
