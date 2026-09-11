import type { Mode } from "../state/schema.js";
import type { InlineFile, ReferencedFile } from "./attachments.js";
import { escapeAtSigns, toAtReference } from "./atSyntax.js";

export { escapeAtSigns, toAtReference };

/**
 * Every prompt opens with a fixed header. Besides framing the task, it guarantees the input
 * never starts with "/" or "$", which the Gemini CLI would take for one of its own commands.
 */
export const MODE_PREFIXES: Record<Mode, string> = {
  ask: "Task:",
  summarize:
    "Summary task. Report the key facts and anything that looks wrong, most important first. For logs: whether the run succeeded, and every error or warning with its line number and timestamp. For documents: the main points and decisions.",
  analyze:
    "Analysis task. Examine the provided material and explain what matters in it: for code, its structure, responsibilities, data flow and notable design decisions; for logs or data, what happened and what stands out. Be concrete and cite specific files, lines or timestamps.",
  review:
    "Critical code review. Report only problems you can point to in the code: file, line, what is wrong, why it matters and a concrete fix. Rank them critical (bugs, security), major or minor. Skip praise, style nitpicks and generic advice.",
  refactor:
    "Refactoring proposal. Suggest behavior-preserving improvements to structure, naming, duplication, clarity and performance. Show the proposed code and briefly justify each change. Do not apply the changes yourself.",
  plan: "Implementation planning. Produce a concise, ordered plan: the files to create or change, what changes in each, risks, and open questions.",
  test: "Test design. Propose test cases covering the happy path, edge cases and failure modes, and write the test code using the project's existing test framework and conventions where visible.",
};

export const FOLLOW_UP_HEADER = "Follow-up question about the material and answer above:";

/**
 * Appended to every prompt: Gemini stays text-out and read-only; Claude is the only one that
 * edits. Reading has to be allowed explicitly — a blanket "do not run tools" made Gemini refuse
 * to read the rest of a file and answer from half of it. Citations let Claude check claims
 * cheaply. The answer lands in Claude's context (Claude Code caps tool results at ~25k tokens),
 * hence the concision.
 */
export const GUARDRAIL =
  "Respond in plain text only (Markdown and code blocks are fine). Use your read-only tools freely — reading files, listing and searching — but change nothing: no file edits, no writes, no shell commands. " +
  "Cite file names and line numbers for specific claims so they can be checked. " +
  "Be concise: your answer is read by another AI assistant with a limited context window.";

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
  /** What Claude needs back, e.g. "5 bullets" or "only issues as file:line — problem — fix". */
  format?: string;
  inline?: readonly InlineFile[];
  referenced?: readonly (ReferencedFile | PromptFile)[];
  /** Continues an earlier conversation, whose history already holds the files. */
  followUp?: boolean;
  platform?: NodeJS.Platform;
}

export function buildPrompt(input: PromptInput): string {
  const inline = input.inline ?? [];
  const referenced = input.referenced ?? [];
  const sections = [input.followUp ? FOLLOW_UP_HEADER : MODE_PREFIXES[input.mode], escapeAtSigns(input.prompt.trim())];
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
  sections.push(GUARDRAIL);
  return sections.join("\n\n");
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
