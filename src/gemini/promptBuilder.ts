import type { Mode } from "../state/schema.js";

export const MODE_PREFIXES: Record<Mode, string> = {
  ask: "",
  analyze:
    "Analysis task. Examine the provided material and explain what matters in it: for code, its structure, responsibilities, data flow and notable design decisions; for logs or data, what happened and what stands out. Be concrete and cite specific files, lines or timestamps.",
  review:
    "Critical code review. Identify bugs, edge cases, security issues, performance problems and maintainability risks. Rank findings by severity, cite specific files and lines, and suggest a fix for each. Skip praise and generic advice.",
  refactor:
    "Refactoring proposal. Suggest behavior-preserving improvements to structure, naming, duplication, clarity and performance. Show the proposed code and briefly justify each change. Do not apply the changes yourself.",
  plan: "Implementation planning. Produce a concise, ordered plan: the files to create or change, what changes in each, risks, and open questions.",
  test: "Test design. Propose test cases covering the happy path, edge cases and failure modes, and write the test code using the project's existing test framework and conventions where visible.",
};

/**
 * Appended to every prompt: Gemini stays text-out and read-only; Claude is the only one that
 * edits. Reading has to be allowed explicitly — a blanket "do not run tools" made Gemini refuse
 * to read the untruncated part of a file and answer from half of it instead. The answer lands in
 * Claude's context (and Claude Code caps tool results at ~25k tokens), hence the concision.
 */
export const GUARDRAIL =
  "Respond in plain text only (Markdown and code blocks are fine). Use your read-only tools freely — reading files, listing and searching — but change nothing: no file edits, no writes, no shell commands. " +
  "Be concise: your answer is read by another AI assistant with a limited context window.";

/**
 * Gemini CLI `@path` reference. Mirrors the CLI's own escapePath()/unescapePath(): on Windows
 * the path is wrapped in double quotes (a quoted segment is one token and backslashes stay
 * literal); elsewhere special characters are backslash-escaped. Commas are escaped too because
 * the CLI's @-token regex stops at an unescaped comma.
 */
export function toAtReference(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `@"${absolutePath}"`;
  return `@${absolutePath.replace(/([ \t()[\]{};,|*?$`'"#&<>!~\\])/g, "\\$1")}`;
}

/**
 * A bare "@" in the task text ("@Component", "user@example.com", "@scope/pkg") would make the
 * Gemini CLI try to resolve and attach files. Escaping keeps `paths` the only way files get in.
 */
export function escapeAtSigns(text: string): string {
  return text.replace(/(?<!\\)@/g, "\\@");
}

/** The Gemini CLI attaches only this many lines per file (its DEFAULT_MAX_LINES_TEXT_FILE). */
export const ATTACHED_LINE_LIMIT = 2000;

/**
 * The truncation is silent: nothing in the attached content says it was cut. Without this
 * notice, a summary of a 4000-line log confidently reports "no errors" while the error sits on
 * line 2817 — which is exactly what happened before it was added.
 */
export const TRUNCATION_NOTICE =
  `Only the first ${ATTACHED_LINE_LIMIT} lines of each file are attached. If a file listed above as partly attached matters for this task, you MUST read its remaining lines yourself before answering — your read-only file tools can read any line range, and reading is allowed. Never conclude anything (such as "no errors") from the attached excerpt alone, and state plainly which parts you could not read.`;

export interface PromptFile {
  /** Absolute, existence-checked path. */
  path: string;
  /** Total lines, when known: shows the model how much of the file is missing. */
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
  files: readonly PromptFile[];
  platform?: NodeJS.Platform;
}

export function buildPrompt({ prompt, mode, files, platform }: PromptInput): string {
  const sections: string[] = [];
  const prefix = MODE_PREFIXES[mode];
  if (prefix) sections.push(prefix);
  sections.push(escapeAtSigns(prompt.trim()));
  if (files.length > 0) {
    sections.push(
      [
        "Referenced files and folders (their contents are attached):",
        ...files.map((file) => fileReferenceLine(file, platform)),
        TRUNCATION_NOTICE,
      ].join("\n"),
    );
  }
  sections.push(GUARDRAIL);
  return sections.join("\n\n");
}
