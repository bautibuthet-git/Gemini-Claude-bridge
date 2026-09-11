import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ResponseCache, type CachedAnswer } from "../cache.js";
import type { BridgeContext } from "../context.js";
import { prepareAttachments, type Attachments } from "../gemini/attachments.js";
import { estimateInputTokens } from "../gemini/budget.js";
import { loadSources, verifyCitations, type CitationReport } from "../gemini/citations.js";
import { modelChain, tierFor } from "../gemini/models.js";
import { allowsTools, buildPrompt, buildSecondPassPrompt, escapeAtSigns } from "../gemini/promptBuilder.js";
import { runGemini, shortestBudgetWait, type Attempt, type RunOutcome, type RunRequest } from "../gemini/runner.js";
import type { HistoryEntry } from "../history.js";
import { CHARS_PER_TOKEN, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, MODEL_PATTERN, MODES, type Mode } from "../state/schema.js";
import { asBridgeError, BridgeError } from "../util/errors.js";
import { estimateChars, includeDirectoriesFor, resolveInputPaths } from "../util/paths.js";
import { errorResult, textResult, withWarning } from "./result.js";

export const MAX_PATHS = 20;
const HEARTBEAT_MS = 10_000;
/** A wait this long on the per-minute quota is better spent in the background than blocking Claude. */
const AUTO_BACKGROUND_MS = 20_000;
/** Below this, a second pass can't finish in the time left. */
const MIN_SECOND_PASS_MS = 15_000;

export const ASK_DESCRIPTION = [
  "Delegate a self-contained task to Google Gemini (via the user's local, signed-in gemini CLI) to save your own context and tokens.",
  'Delegate the reading, not the thinking: ask for facts, locations and exact quotes you can reason about (e.g. "every place user input reaches a SQL query, with the line"), not for final verdicts ("is this secure?"), and make the judgment yourself.',
  "Pass files and folders in `paths` and do NOT read them yourself first: the bridge hands them to Gemini, so their contents never enter this conversation.",
  "Gemini sees only the prompt and the files: make the prompt stand alone, say in `goal` what the answer is for and in `format` what you need back.",
  "Gemini's file:line quotes are checked against the files and mismatches are flagged; judgment answers from the lightest model are marked as a first pass. Verify what you rely on, and use thorough: true for decisions that matter.",
  "Independent tasks can run as parallel calls; long ones with background: true, collected with gemini_result. Answers end with a followUp id to ask more about the same material without resending it.",
  'Not worth it for small files or quick questions. If the result has errorType "disabled", do the task yourself.',
].join(" ");

export const askInputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe("The task for Gemini, written to stand alone: include any context it needs. Ask for facts and quotes rather than verdicts."),
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
      "Framing preset. ask (default): general. summarize: key facts, errors with line numbers. analyze: explain code or data. review: problems with the exact code. refactor: behavior-preserving proposals. plan: ordered implementation plan. test: test cases plus code. review/refactor/plan/test use the strongest model with quota; the others the fastest.",
    ),
  goal: z
    .string()
    .max(500)
    .optional()
    .describe(
      'What the answer is for: the decision or next step it feeds (e.g. "decide whether the nightly export needs a retry"). Gemini keeps what matters for it and says when the material cannot support it.',
    ),
  format: z
    .string()
    .max(500)
    .optional()
    .describe('What you need back, e.g. "5 bullets", "only issues as file:line — problem — fix", "max 200 words". Short, targeted answers cost you fewer tokens.'),
  thorough: z
    .boolean()
    .optional()
    .describe(
      "Second pass: Gemini re-checks its answer against the material (quotes, omissions, overstatements) and returns a corrected one. About twice the time and quota (the default time budget doubles); use it for reviews and decisions that matter, with background: true for big ones.",
    ),
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
    .describe("Hard time budget in milliseconds, fallbacks and second pass included (default 180000, doubled with thorough). When it runs out, Gemini is stopped."),
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
  goal?: string;
  format?: string;
  thorough?: boolean;
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
  /** Set when running as a background job (for the history, and so it never re-queues itself). */
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
    const yolo = args.yolo ?? state.preferences.approvalMode === "yolo";
    const prompt = buildPrompt({
      prompt: args.prompt,
      mode,
      goal: args.goal,
      format: args.format,
      inline: prepared.inline,
      referenced: prepared.referenced,
      followUp: Boolean(args.followUp),
      yolo,
    });
    const chain = modelChain(state.preferences, mode, args.model);
    const inputTokens = estimateInputTokens(prompt);
    // Two passes get twice the default budget, or a slow first pass leaves no time for the second.
    const timeoutMs = args.timeoutMs ?? Math.min(MAX_TIMEOUT_MS, state.preferences.timeoutMs * (args.thorough ? 2 : 1));

    // Folders can change without a cheap way to notice, and follow-ups depend on conversation state.
    const cacheTtlMs = state.preferences.cacheTtlMinutes * 60_000;
    const cacheKey =
      cacheTtlMs > 0 && !args.followUp && !prepared.referenced.some((file) => file.isDirectory)
        ? ResponseCache.key({
            v: 3,
            prompt,
            model: args.model ?? null,
            yolo,
            thorough: Boolean(args.thorough),
            refs: await fingerprints(prepared.referenced.map((file) => file.path)),
          })
        : null;
    if (cacheKey && !args.fresh) {
      const cached = await ctx.cache.get(cacheKey, cacheTtlMs, ctx.now());
      if (cached) {
        const report = await checkQuotes(cached.text, prepared);
        const caution = cautionFor(mode, cached.model, [], report);
        const charsSaved = Math.max(0, fileChars - cached.text.length);
        await record(ctx, { ...call, ok: true, engine: "cache", model: cached.model, durationMs: elapsed(), attempts: [], attachments, charsSaved });
        return withWarning(
          textResult(compose(cached.text, [], [...(caution ? [caution] : []), ...reportLines(report), cachedFooter(mode, cached)])),
          warning,
        );
      }
    }

    // A foreground call that would sit out the per-minute quota runs in the background instead,
    // so Claude isn't blocked on the wait.
    if (!options.background) {
      const waitMs = await shortestBudgetWait(ctx, chain, args.model, inputTokens);
      if (waitMs >= AUTO_BACKGROUND_MS) {
        const seconds = Math.ceil(waitMs / 1000);
        return withWarning(
          await startBackground(
            ctx,
            args,
            `Gemini's per-minute token quota is still busy with earlier requests (about ${seconds}s to go), so this runs in the background instead of blocking you.`,
            seconds,
          ),
          warning,
        );
      }
    }

    options.report?.(describeAttachments(prepared));
    const heartbeat = options.report
      ? setInterval(() => options.report?.(`Gemini is still working… ${Math.round(elapsed() / 1000)}s`), HEARTBEAT_MS)
      : undefined;
    const request: RunRequest = {
      prompt,
      chain,
      explicitModel: args.model,
      timeoutMs,
      yolo,
      cwd,
      includeDirectories: includeDirectoriesFor(resolved, ctx.projectDir()),
      acpEligible: prepared.referenced.length === 0 && !yolo,
      conversationId: args.followUp,
      inputTokens,
      signal: options.signal,
      onProgress: options.report,
    };
    let outcome: RunOutcome;
    let passes = 1;
    let secondPassNote: string | null = null;
    // What Gemini reports it read (else the estimate), for the per-minute budget of later calls.
    let tokensSent: number;
    try {
      outcome = await runGemini(ctx, request);
      tokensSent = outcome.response.inputTokens ?? inputTokens;
      if (args.thorough) {
        const tools = allowsTools({ followUp: Boolean(args.followUp), yolo, referenced: prepared.referenced });
        const checkPrompt = buildSecondPassPrompt(args.goal, tools);
        const second = await secondPass(ctx, request, outcome, checkPrompt, timeoutMs - elapsed(), options.report);
        if (second.outcome) {
          tokensSent += second.outcome.response.inputTokens ?? inputTokens;
          outcome = { ...second.outcome, attempts: [...outcome.attempts, ...second.outcome.attempts] };
          passes = 2;
        }
        secondPassNote = second.note;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const { response } = outcome;
    const report = await checkQuotes(response.text, prepared);
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
      inputTokens: tokensSent,
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

    const caution = cautionFor(mode, response.model, outcome.attempts, report);
    const footer = answerFooter(mode, outcome, charsSaved, { passes, secondPassNote, confidence: parseConfidence(response.text) });
    // Deliberately no structuredContent: Claude Code would show the model that payload instead
    // of the text, and Gemini's answer must reach Claude as readable text. The footer carries
    // the metadata a structured payload would have held.
    return withWarning(
      textResult(compose(response.text, response.warnings, [...(caution ? [caution] : []), ...reportLines(report), footer])),
      warning,
    );
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

/**
 * thorough: true. Gemini checks its first answer against the material, in the same
 * conversation when there is one, and returns a corrected answer. A failed second pass keeps
 * the first answer, with a note saying so.
 */
async function secondPass(
  ctx: BridgeContext,
  request: RunRequest,
  first: RunOutcome,
  checkPrompt: string,
  remainingMs: number,
  report?: (message: string) => void,
): Promise<{ outcome: RunOutcome | null; note: string | null }> {
  if (remainingMs < MIN_SECOND_PASS_MS) return { outcome: null, note: "second pass skipped: not enough time left in the budget" };
  const sessionId = first.response.sessionId ?? undefined;
  report?.("Second pass: Gemini is checking its answer against the files…");
  try {
    const outcome = await runGemini(ctx, {
      ...request,
      // Without a conversation to continue, the material and the draft go along again.
      prompt: sessionId
        ? checkPrompt
        : `${request.prompt}\n\nA draft answer to check follows.\n\n${escapeAtSigns(first.response.text)}\n\n${checkPrompt}`,
      conversationId: sessionId,
      timeoutMs: remainingMs,
    });
    return { outcome, note: null };
  } catch (err) {
    return { outcome: null, note: `second pass failed, so this is the first-pass answer: ${asBridgeError(err).message}` };
  }
}

async function startBackground(ctx: BridgeContext, args: AskArgs, why?: string, expectedSeconds?: number): Promise<CallToolResult> {
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
  const waitSeconds = Math.min(120, (expectedSeconds ?? 30) + 30);
  const message =
    `${why ? `${why} ` : ""}Started background Gemini job ${job.id} (${label}). ` +
    `Keep working; collect the answer with gemini_result({ jobId: "${job.id}", waitSeconds: ${waitSeconds} }).`;
  return textResult(message, { message, jobId: job.id, status: "running" });
}

/** Checks Gemini's file:line quotes against the attached files (no-op when nothing was attached). */
async function checkQuotes(answer: string, attachments: Attachments): Promise<CitationReport | null> {
  if (attachments.inline.length === 0 && attachments.referenced.length === 0) return null;
  const sources = await loadSources(attachments.inline, attachments.referenced, answer);
  return verifyCitations(answer, sources, true);
}

/**
 * A reasoning task answered by the lightest model is marked as a first pass: the review that
 * flagged a non-bug as "critical" came from it. Quote mismatches earn a warning in any mode.
 */
function cautionFor(mode: Mode, model: string | null, attempts: readonly Attempt[], report: CitationReport | null): string | null {
  if (model && /lite/i.test(model) && tierFor(mode) === "strong") {
    const passedOver = attempts.some((a) => a.outcome === "quota" || a.outcome === "unavailable");
    return `[⚠ first pass: answered by ${model}, the lightest model${passedOver ? " (the stronger ones had no quota)" : ""}. Verify the key findings in the code before acting on them.]`;
  }
  if (report && report.problems > 0) return "[⚠ some quotes don't match the files (details below): double-check before relying on this answer.]";
  return null;
}

/** Gemini ends its answer with "Confidence: high|medium|low"; surfaced in the footer. */
export function parseConfidence(answer: string): "high" | "medium" | "low" | null {
  const match = /(?:^|\n)[\s>*_-]*Confidence[*_]*\s*:[*_\s]*(high|medium|low)\b/i.exec(answer);
  return match ? (match[1]!.toLowerCase() as "high" | "medium" | "low") : null;
}

function compose(answer: string, warnings: readonly string[], trailer: readonly string[]): string {
  const cliWarnings = warnings.length > 0 ? `\n\nGemini CLI warnings:\n${warnings.join("\n")}` : "";
  return `${answer}${cliWarnings}\n\n${trailer.join("\n")}`;
}

function reportLines(report: CitationReport | null): string[] {
  return report?.text ? [report.text] : [];
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
  inputTokens?: number;
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
      ...(call.inputTokens ? { inputTokens: call.inputTokens } : {}),
    })
    .catch(() => undefined);
}

interface FooterExtras {
  passes: number;
  secondPassNote: string | null;
  confidence: "high" | "medium" | "low" | null;
}

function answerFooter(mode: Mode, outcome: RunOutcome, charsSaved: number, extras: FooterExtras): string {
  const { response, engine, attempts } = outcome;
  const tokens = Math.round(charsSaved / CHARS_PER_TOKEN);
  const parts = ["gemini-claude-bridge", mode, response.model ?? "default model", `${(response.durationMs / 1000).toFixed(1)}s`];
  if (engine === "acp") parts.push("warm process");
  if (extras.passes > 1) parts.push("2 passes");
  if (extras.confidence) parts.push(`Gemini's confidence: ${extras.confidence}`);
  if (tokens > 0) parts.push(`~${tokens} tokens of file content kept out of Claude's context`);
  const lines = [`[${parts.join(" · ")}]`];
  const passedOver = attempts.filter((a) => a.outcome === "quota" || a.outcome === "unavailable");
  if (passedOver.length > 0) lines.push(`[fell back past ${passedOver.map((a) => `${a.model} (${a.detail})`).join("; ")}]`);
  if (extras.secondPassNote) lines.push(`[${extras.secondPassNote}]`);
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
