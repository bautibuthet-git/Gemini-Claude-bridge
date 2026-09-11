import fsp from "node:fs/promises";
import { countLines, type ResolvedPath } from "../util/paths.js";
import { escapeAtSigns } from "./atSyntax.js";

/**
 * Files are sent inside the prompt, complete, instead of as `@path` references: the CLI attaches
 * only the first 2000 lines of a referenced file, and reading the rest took Gemini ~95s of extra
 * tool calls on a 4000-line log. Inline, the same log took ~8s and nothing was missed.
 * The budget stays well under the CLI's 8 MB stdin cap, leaving room for the prompt itself.
 */
export const INLINE_BUDGET_BYTES = 6 * 1024 * 1024;
/** Line numbers and at-sign escapes make the inlined text a little larger than the file. */
const INLINE_GROWTH = 1.15;

export interface InlineFile {
  path: string;
  lines: number;
  /** Numbered, at-sign-escaped content, ready to paste into the prompt. */
  text: string;
}

export interface ReferencedFile {
  path: string;
  /** Known for text files that were too big to inline; null for folders and binaries. */
  lines: number | null;
  isDirectory: boolean;
}

export interface Attachments {
  inline: InlineFile[];
  /** Left to the CLI's own `@path` handling: folders, binaries (images, PDFs) and oversized files. */
  referenced: ReferencedFile[];
  inlineBytes: number;
}

export async function prepareAttachments(
  targets: readonly ResolvedPath[],
  budgetBytes: number = INLINE_BUDGET_BYTES,
): Promise<Attachments> {
  const inline: InlineFile[] = [];
  const referenced: ReferencedFile[] = [];
  let remaining = budgetBytes;

  for (const target of targets) {
    if (target.isDirectory) {
      referenced.push({ path: target.absolute, lines: null, isDirectory: true });
      continue;
    }
    const file = await readText(target.absolute, remaining);
    if (file.kind === "text") {
      const numbered = numberLines(file.content);
      inline.push({ path: target.absolute, lines: numbered.lines, text: numbered.text });
      remaining -= Buffer.byteLength(numbered.text, "utf8");
    } else {
      const lines = file.kind === "too_big" ? await countLines(target.absolute) : null;
      referenced.push({ path: target.absolute, lines, isDirectory: false });
    }
  }
  return { inline, referenced, inlineBytes: budgetBytes - remaining };
}

type ReadOutcome = { kind: "text"; content: string } | { kind: "binary" } | { kind: "too_big" };

async function readText(file: string, budget: number): Promise<ReadOutcome> {
  const { size } = await fsp.stat(file);
  if (size * INLINE_GROWTH > budget) return { kind: "too_big" };
  const buffer = await fsp.readFile(file);
  // Binary files (images, PDFs, archives) are left to the CLI, which knows how to send them.
  if (buffer.includes(0)) return { kind: "binary" };
  const content = buffer.toString("utf8");
  return { kind: "text", content: content.charCodeAt(0) === 0xfeff ? content.slice(1) : content };
}

/** "N: line" per line, so Gemini can cite exact line numbers; at-signs are escaped for the CLI. */
export function numberLines(content: string): { text: string; lines: number } {
  if (content === "") return { text: "", lines: 0 };
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return { text: lines.map((line, i) => `${i + 1}: ${escapeAtSigns(line)}`).join("\n"), lines: lines.length };
}
