import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeContext } from "../context.js";
import { buildPrompt } from "../gemini/promptBuilder.js";
import {
  CHARS_PER_TOKEN,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MODES,
  type BridgeState,
  type Mode,
} from "../state/schema.js";
import { BridgeError } from "../util/errors.js";
import { countLines, estimateChars, includeDirectoriesFor, resolveInputPaths } from "../util/paths.js";
import { errorResult, textResult, toBridgeError, withWarning } from "./result.js";

export const MAX_PATHS = 20;
/** No leading "-" (can't be mistaken for a CLI flag), no whitespace or shell metacharacters. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const ASK_DESCRIPTION =
  "Delegate a self-contained task to Google Gemini (via the user's local, already signed-in gemini CLI) to save your own context and tokens. " +
  "Good fits: summarizing or analyzing large files, logs or many files at once; broad codebase questions; second-opinion code reviews; drafting boilerplate, docs or tests; implementation plans. " +
  "Pass files and folders in `paths` and do NOT read them yourself first: Gemini reads them directly, so their contents never enter this conversation. " +
  "Gemini sees only `prompt` and `paths` (not this conversation), so make the prompt stand alone. It returns text only and never edits files; you apply any changes. " +
  "Not worth it for small files or quick questions you can answer directly. If the result has errorType \"disabled\", do the task yourself.";

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
      `Files or folders for Gemini to read directly (max ${MAX_PATHS}). Absolute paths preferred; relative ones resolve against the project folder. Folders are read recursively, so prefer specific files or subfolders.`,
    ),
  mode: z
    .enum(MODES)
    .optional()
    .describe(
      "Framing preset. ask (default): general. analyze: explain code or architecture. review: critical code review citing files and lines. refactor: behavior-preserving improvement proposals. plan: ordered implementation plan. test: test cases plus test code.",
    ),
  model: z
    .string()
    .regex(MODEL_PATTERN, "Model names contain only letters, digits and . _ : / -")
    .optional()
    .describe("Gemini model override. Omit to use the Gemini CLI's default (recommended)."),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Hard timeout in milliseconds (default 180000). When it expires the whole Gemini process tree is killed."),
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
  model?: string;
  timeoutMs?: number;
  yolo?: boolean;
}

export async function handleAsk(ctx: BridgeContext, args: AskArgs, signal?: AbortSignal): Promise<CallToolResult> {
  const state = await ctx.store.read();
  const warning = ctx.store.takeWarning();
  // Checked before anything else: when off, no path checks and no subprocess at all.
  if (!state.enabled) {
    return withWarning(errorResult("disabled", "The Gemini bridge is turned off, so nothing was sent to Gemini."), warning);
  }

  const mode = args.mode ?? "ask";
  const startedAt = ctx.now().getTime();
  try {
    const { resolved, missing } = await resolveInputPaths(args.paths ?? [], ctx.projectDir());
    if (missing.length > 0) {
      throw new BridgeError("invalid_paths", `These paths do not exist: ${missing.join("; ")}`, { missing });
    }

    const [fileChars, cwd, files] = await Promise.all([
      estimateChars(resolved),
      ctx.scratchDir(),
      Promise.all(
        resolved.map(async (p) => ({
          path: p.absolute,
          lines: p.isDirectory ? null : await countLines(p.absolute),
        })),
      ),
    ]);
    const response = await ctx.invoke({
      prompt: buildPrompt({ prompt: args.prompt, mode, files }),
      model: args.model ?? state.preferences.model ?? undefined,
      yolo: args.yolo ?? state.preferences.approvalMode === "yolo",
      timeoutMs: args.timeoutMs ?? state.preferences.timeoutMs,
      cwd,
      includeDirectories: includeDirectoriesFor(resolved, ctx.projectDir()),
      signal,
    });

    const charsSaved = Math.max(0, fileChars - response.text.length);
    const tokensSaved = Math.round(charsSaved / CHARS_PER_TOKEN);
    // Bookkeeping must never cost the user Gemini's answer.
    await ctx.store
      .update((s) => {
        recordCall(s, mode, ctx.now());
        s.usage.estimatedCharsSaved += charsSaved;
        s.geminiCli.lastAuthOk = true;
        s.geminiCli.lastAuthCheckAt = ctx.now().toISOString();
        s.geminiCli.lastAuthDetail = "The last Gemini call succeeded.";
      })
      .catch(() => undefined);

    const cliWarnings = response.warnings.length > 0 ? `\n\nGemini CLI warnings:\n${response.warnings.join("\n")}` : "";
    const footer =
      `\n\n[gemini-claude-bridge · ${mode} · ${response.model ?? "default model"} · ${(response.durationMs / 1000).toFixed(1)}s` +
      (tokensSaved > 0 ? ` · ~${tokensSaved} tokens of file content kept out of Claude's context]` : "]");
    // Deliberately no structuredContent: Claude Code would show the model that payload instead
    // of these text blocks, and Gemini's answer must reach Claude as readable text. The footer
    // carries the metadata a structured payload would have held.
    return withWarning(textResult(response.text + cliWarnings + footer), warning);
  } catch (err) {
    const error = toBridgeError(err);
    await ctx.store
      .update((s) => {
        recordCall(s, mode, ctx.now());
        s.usage.totalErrors += 1;
        const stamp = ctx.now().toISOString();
        if (error.type === "not_authenticated") {
          s.geminiCli.lastAuthOk = false;
          s.geminiCli.lastAuthCheckAt = stamp;
          s.geminiCli.lastAuthDetail = error.message;
        } else if (error.type === "not_installed") {
          s.geminiCli.lastDetectedVersion = null;
          s.geminiCli.lastInstalledCheckAt = stamp;
        }
      })
      .catch(() => undefined);
    return withWarning(
      errorResult(error.type, error.message, { mode, durationMs: ctx.now().getTime() - startedAt, ...error.details }),
      warning,
    );
  }
}

function recordCall(state: BridgeState, mode: Mode, when: Date): void {
  state.usage.totalCalls += 1;
  state.usage.callsByMode[mode] = (state.usage.callsByMode[mode] ?? 0) + 1;
  state.usage.lastUsedAt = when.toISOString();
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
    (args, extra) => handleAsk(ctx, args, extra.signal),
  );
}
