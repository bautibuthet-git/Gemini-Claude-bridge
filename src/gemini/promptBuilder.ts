import type { Mode } from "../state/schema.js";

export const MODE_PREFIXES: Record<Mode, string> = {
  ask: "",
  analyze:
    "Analysis task. Examine the provided material and explain how it works: structure, responsibilities, data flow and notable design decisions. Be concrete and cite specific files, functions and line numbers.",
  review:
    "Critical code review. Identify bugs, edge cases, security issues, performance problems and maintainability risks. Rank findings by severity, cite specific files and lines, and suggest a fix for each. Skip praise and generic advice.",
  refactor:
    "Refactoring proposal. Suggest behavior-preserving improvements to structure, naming, duplication, clarity and performance. Show the proposed code and briefly justify each change. Do not apply the changes yourself.",
  plan: "Implementation planning. Produce a concise, ordered plan: the files to create or change, what changes in each, risks, and open questions.",
  test: "Test design. Propose test cases covering the happy path, edge cases and failure modes, and write the test code using the project's existing test framework and conventions where visible.",
};

/**
 * Appended to every prompt: Gemini stays text-out and read-only; Claude is the only one that
 * edits. The answer lands in Claude's context (and Claude Code caps tool results at ~25k
 * tokens), hence the request for concision.
 */
export const GUARDRAIL =
  "Respond in plain text only (Markdown and code blocks are fine). Do not run shell commands or edit files. " +
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

export interface PromptInput {
  prompt: string;
  mode: Mode;
  /** Absolute, existence-checked paths. */
  paths: readonly string[];
  platform?: NodeJS.Platform;
}

export function buildPrompt({ prompt, mode, paths, platform }: PromptInput): string {
  const sections: string[] = [];
  const prefix = MODE_PREFIXES[mode];
  if (prefix) sections.push(prefix);
  sections.push(escapeAtSigns(prompt.trim()));
  if (paths.length > 0) {
    sections.push(
      ["Referenced files and folders (their contents are attached):", ...paths.map((p) => toAtReference(p, platform))].join(
        "\n",
      ),
    );
  }
  sections.push(GUARDRAIL);
  return sections.join("\n\n");
}
