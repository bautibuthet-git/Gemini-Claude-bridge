import type { Mode } from "../state/schema.js";
import type { InlineFile, ReferencedFile } from "./attachments.js";
import { escapeAtSigns, toAtReference } from "./atSyntax.js";

export { escapeAtSigns, toAtReference };

/**
 * Every prompt opens with a fixed header. Besides framing the task, it guarantees the input
 * never starts with "/" or "$", which the Gemini CLI would take for one of its own commands.
 * The framing asks for what the material shows, tied to the exact lines, rather than for
 * verdicts: Claude only ever sees this answer, so a shallow reading would otherwise become
 * Claude's picture of the file.
 */
export const MODE_PREFIXES: Record<Mode, string> = {
  ask: "Task:",
  summarize:
    "Summary task. Report the key facts and anything that looks wrong, most important first. For logs: whether the run succeeded, and every error or warning with its line number and timestamp. For documents: the main points and decisions.",
  analyze:
    "Analysis task. Explain what matters in the material: for code, its structure, responsibilities, data flow and notable design decisions; for logs or data, what happened and what stands out.",
  review:
    "Critical code review. List only problems you can point to in the code, most severe first: the location and exact code, what is wrong, why it matters, a concrete fix, and how sure you are. Rank them critical (bugs, security), major or minor. Leave out style nitpicks, generic advice and anything you cannot show in the code.",
  refactor:
    "Refactoring proposal. Suggest behavior-preserving improvements to structure, naming, duplication, clarity and performance, each tied to the exact code it changes. Show the proposed code and briefly justify each change. Do not apply the changes yourself.",
  plan: "Implementation planning. Produce a concise, ordered plan: the files to create or change and the exact code each change touches, risks, and open questions.",
  test: "Test design. Propose test cases covering the happy path, edge cases and failure modes, each tied to the code it exercises, and write the test code using the project's existing test framework and conventions where visible.",
};

export const FOLLOW_UP_HEADER = "Follow-up question about the material and answer above:";

/**
 * Evidence, coverage and confidence, in a shape the bridge can check: every `file:line` quote is
 * compared with the real file afterwards, and the Confidence line is surfaced to Claude.
 */
export const ANSWER_RULES = [
  "How to answer:",
  "- Back every factual claim and finding with evidence: the file name, the line number and the exact text, written as file:line followed by that line in backticks, for example: app.ts:42 `const total = price * qty;`. Copy quoted text character for character.",
  "- Report what the material shows. Leave final decisions to the reader; when you do judge something, say how sure you are.",
  "- If the material is not enough to answer well, say what is missing instead of guessing.",
  '- End with two lines: "Coverage:" what you read fully, partly or not at all; and "Confidence:" high, medium or low, with the reason.',
].join("\n");

/**
 * Appended to every prompt: Gemini stays text-out and read-only; Claude is the only one that
 * edits. The answer lands in Claude's context (Claude Code caps tool results at ~25k tokens),
 * hence the concision.
 */
export const GUARDRAIL =
  "Respond in plain text only (Markdown and code blocks are fine). Change nothing: no file edits, no writes, no shell commands. " +
  "Be concise: your answer is read by another AI assistant with a limited context window.";

/**
 * For material Gemini has to fetch itself (referenced files and folders, an earlier conversation,
 * yolo). Reading has to be allowed explicitly: a blanket "do not run tools" made Gemini refuse
 * to read the rest of a file and answer from half of it.
 */
export const TOOLS_ALLOWED =
  "Use your read-only tools freely (reading files, listing, searching) when the task needs material that is not in this conversation.";

/**
 * For material attached complete. Invited to use tools anyway, flash re-read an attached file
 * and browsed unrelated project files: a review of a 20-line file took three model round trips,
 * 47k input tokens and 47s, and another ran past the 180s budget.
 */
export const TOOLS_DISCOURAGED =
  "Everything you need is in this conversation, and attached files are complete: answer directly, without using tools to re-read attachments or to explore other files.";

/** The Gemini CLI attaches only this many lines of each `@path` file (its DEFAULT_MAX_LINES_TEXT_FILE). */
export const ATTACHED_LINE_LIMIT = 2000;

/**
 * For files left as `@path` references (folders, oversized files). The truncation is silent:
 * nothing in the attached content says it was cut, and a summary once reported "no errors"
 * while the error sat on line 2817 of a 4000-line log.
 */
export const TRUNCATION_NOTICE =
  `Only the first ${ATTACHED_LINE_LIMIT} lines of each referenced file are attached. If a file listed above as partly attached matters for this task, you MUST read its remaining lines yourself before answering — your read-only file tools can read any line range, and reading is allowed. Never conclude anything (such as "no errors") from the attached excerpt alone, and state plainly which parts you could not read.`;

export const INLINE_INTRO =
  "Attached files, complete. Every line starts with its line number and a colon. Inside file content each at-sign is preceded by a backslash (an escape the Gemini CLI requires); ignore that backslash.";

export interface PromptFile {
  path: string;
  /** Total lines, when known: shows the model how much of a referenced file is missing. */
  lines?: number | null;
}

export function fileReferenceLine(file: PromptFile, platform: NodeJS.Platform = process.platform): string {
  const reference = toAtReference(file.path, platform);
  if (file.lines == null) return reference;
  return file.lines > ATTACHED_LINE_LIMIT
    ? `${reference} (${file.lines} lines, only the first ${ATTACHED_LINE_LIMIT} attached)`
    : `${reference} (${file.lines} lines)`;
}

export interface PromptInput {
  prompt: string;
  mode: Mode;
  /** What the answer will be used for; lets Gemini keep what matters for that decision. */
  goal?: string;
  /** What Claude needs back, e.g. "5 bullets" or "only issues as file:line — problem — fix". */
  format?: string;
  inline?: readonly InlineFile[];
  referenced?: readonly (ReferencedFile | PromptFile)[];
  /** Continues an earlier conversation, whose history already holds the files. */
  followUp?: boolean;
  /** Gemini's tool calls are auto-approved (e.g. web fetches the user asked for). */
  yolo?: boolean;
  platform?: NodeJS.Platform;
}

/** Gemini needs its tools only for material it must fetch itself: referenced items, an earlier conversation, or yolo. */
export function allowsTools(input: Pick<PromptInput, "followUp" | "yolo" | "referenced">): boolean {
  return Boolean(input.followUp || input.yolo || (input.referenced?.length ?? 0) > 0);
}

export function buildPrompt(input: PromptInput): string {
  const inline = input.inline ?? [];
  const referenced = input.referenced ?? [];
  const sections = [input.followUp ? FOLLOW_UP_HEADER : MODE_PREFIXES[input.mode], escapeAtSigns(input.prompt.trim())];
  if (input.goal?.trim()) sections.push(purposeLine(input.goal));
  if (input.format?.trim()) sections.push(`Answer format: ${escapeAtSigns(input.format.trim())}`);
  if (inline.length > 0) sections.push(inlineSection(inline));
  if (referenced.length > 0) {
    sections.push(
      [
        "Referenced files and folders (attached by the Gemini CLI):",
        ...referenced.map((file) => fileReferenceLine(file, input.platform)),
        TRUNCATION_NOTICE,
      ].join("\n"),
    );
  }
  sections.push(ANSWER_RULES, allowsTools(input) ? TOOLS_ALLOWED : TOOLS_DISCOURAGED, GUARDRAIL);
  return sections.join("\n\n");
}

/**
 * The optional second pass (thorough: true), sent as a follow-up in the same conversation:
 * Gemini checks its own answer against the material and returns a corrected one.
 */
export function buildSecondPassPrompt(goal?: string, allowTools = false): string {
  const purpose = goal?.trim() ? ` for the purpose (${escapeAtSigns(goal.trim())})` : "";
  return [
    "Second pass: check your previous answer against the material before it is used.",
    [
      "- Is every quote exact and at the line you cited, and does it really support the claim?",
      `- What did you miss that matters${purpose}?`,
      "- What did you get wrong, overstate, or leave without evidence?",
    ].join("\n"),
    "Then write the corrected final answer in full, in the same format, ending with the Coverage and Confidence lines. Output only that final answer, not a list of your changes.",
    allowTools ? TOOLS_ALLOWED : TOOLS_DISCOURAGED,
    GUARDRAIL,
  ].join("\n\n");
}

function purposeLine(goal: string): string {
  return `Purpose (what the answer will be used for): ${escapeAtSigns(goal.trim())}. Keep everything that matters for this purpose, and say plainly if the material cannot support it.`;
}

function inlineSection(files: readonly InlineFile[]): string {
  const blocks = files.map((file, i) => {
    const n = `${i + 1} of ${files.length}`;
    // Content lines always start with a number, so they can never be mistaken for these markers.
    return [`===== FILE ${n}: ${escapeAtSigns(file.path)} (${file.lines} lines) =====`, file.text, `===== END OF FILE ${i + 1} =====`]
      .filter((part) => part !== "")
      .join("\n");
  });
  return [INLINE_INTRO, ...blocks].join("\n\n");
}
