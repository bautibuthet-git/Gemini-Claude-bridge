import fsp from "node:fs/promises";
import path from "node:path";
import { splitLines } from "./attachments.js";

/**
 * Checks the `file:line` quotes in Gemini's answer against the real files, which the bridge
 * already has. The light model does misquote: it once turned "10:57:00Z" into "10:58:00Z" in
 * the very line it was citing. A mismatch is reported with the file's actual text, so Claude
 * gets the truth without reading the file itself.
 */

export interface SourceText {
  path: string;
  lines: readonly string[];
}

export interface Citation {
  file: string;
  line: number;
  lineEnd: number;
  quote: string;
}

export type CitationStatus = "ok" | "wrong_line" | "misquoted" | "out_of_range";

export interface CheckedCitation extends Citation {
  status: CitationStatus;
  /** Where the quote really is (wrong_line), or the cited line (misquoted). */
  actualLine?: number;
  actualText?: string;
  totalLines?: number;
}

/** Quotes shorter than this say too little to check ("x", "true"). */
const MIN_QUOTE_CHARS = 6;
/** A lone name or call (`handleRequest()`, `req.body`) mentions something; it doesn't quote the line. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const MAX_REPORTED = 8;
const MAX_SHOWN_CHARS = 240;
/** Referenced files are read for checking only up to this size. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

// file:line[-end], an optional closing backtick (for `file:line` written as code), then on the
// same line a `backticked` or "double-quoted" snippet.
const CITATION =
  /(?<file>[^\s`'"()<>|,;*]+?\.[A-Za-z0-9_+-]{1,10}):(?<line>\d+)(?:\s*[-–]\s*(?<end>\d+))?`?[^`"\n]*?(?:`(?<bq>[^`\n]+)`|"(?<dq>[^"\n]+)")/g;

export function extractCitations(answer: string): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(CITATION)) {
    const groups = match.groups ?? {};
    const quote = (groups.bq ?? groups.dq ?? "").trim();
    if (quote.length < MIN_QUOTE_CHARS || IDENTIFIER.test(quote) || !groups.file || !groups.line) continue;
    const line = Number(groups.line);
    const lineEnd = groups.end ? Math.max(line, Number(groups.end)) : line;
    const key = `${groups.file}:${line}:${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ file: groups.file, line, lineEnd, quote });
  }
  return citations;
}

export function checkCitation(citation: Citation, source: SourceText): CheckedCitation {
  const total = source.lines.length;
  if (citation.line < 1 || citation.line > total) return { ...citation, status: "out_of_range", totalLines: total };
  const quote = normalizeQuote(citation.quote, citation);
  const cited = source.lines.slice(citation.line - 1, Math.min(total, citation.lineEnd)).join(" ");
  if (containsQuote(normalize(cited), quote)) return { ...citation, status: "ok" };

  const found = source.lines.findIndex((line) => containsQuote(normalize(line), quote));
  if (found !== -1) return { ...citation, status: "wrong_line", actualLine: found + 1, actualText: source.lines[found] };
  return { ...citation, status: "misquoted", actualLine: citation.line, actualText: source.lines[citation.line - 1] };
}

export interface CitationReport {
  checked: CheckedCitation[];
  /** Lines to append to the answer; null when there was nothing to check. */
  text: string | null;
  problems: number;
}

/**
 * Checks every citation that names one of the sources. Citations of other files can't be
 * checked and are left alone. `expectCitations` adds a note when an answer about attached
 * files cites nothing at all — a sign of a shallow, unverifiable answer.
 */
export function verifyCitations(answer: string, sources: readonly SourceText[], expectCitations = false): CitationReport {
  const checked: CheckedCitation[] = [];
  for (const citation of extractCitations(answer)) {
    const source = resolveSource(citation.file, sources);
    if (source) checked.push(checkCitation(citation, source));
  }
  const problems = checked.filter((c) => c.status !== "ok");
  if (checked.length === 0) {
    return {
      checked,
      problems: 0,
      text: expectCitations && sources.length > 0 ? "[no quotes the bridge could check against the files: treat the claims above as unverified]" : null,
    };
  }

  const count = (status: CitationStatus) => checked.filter((c) => c.status === status).length;
  const parts = [`${count("ok")} exact`];
  if (count("wrong_line")) parts.push(`${count("wrong_line")} at a different line`);
  if (count("misquoted")) parts.push(`${count("misquoted")} misquoted`);
  if (count("out_of_range")) parts.push(`${count("out_of_range")} past the end of the file`);
  const lines = [`[quotes checked by the bridge against the files: ${parts.join(" · ")}]`];
  for (const problem of problems.slice(0, MAX_REPORTED)) lines.push(describeProblem(problem));
  if (problems.length > MAX_REPORTED) lines.push(`… and ${problems.length - MAX_REPORTED} more.`);
  return { checked, problems: problems.length, text: lines.join("\n") };
}

/** Text of referenced files the answer might cite (folders are expanded only for cited files). */
export async function loadSources(
  inline: ReadonlyArray<{ path: string; raw?: string[] }>,
  referenced: ReadonlyArray<{ path: string; isDirectory: boolean }>,
  answer: string,
): Promise<SourceText[]> {
  const sources: SourceText[] = inline.filter((f) => f.raw).map((f) => ({ path: f.path, lines: f.raw! }));
  const cited = extractCitations(answer).map((c) => c.file);
  for (const ref of referenced) {
    if (!ref.isDirectory) {
      const lines = await readLines(ref.path);
      if (lines) sources.push({ path: ref.path, lines });
      continue;
    }
    for (const file of new Set(cited)) {
      const candidate = path.resolve(ref.path, file.replace(/\\/g, "/"));
      if (!candidate.startsWith(path.resolve(ref.path)) || sources.some((s) => samePath(s.path, candidate))) continue;
      const lines = await readLines(candidate);
      if (lines) sources.push({ path: candidate, lines });
    }
  }
  return sources;
}

function describeProblem(c: CheckedCitation): string {
  const where = `${c.file}:${c.line}`;
  switch (c.status) {
    case "wrong_line":
      return `⚠ ${where}: that text is actually at line ${c.actualLine}.`;
    case "misquoted":
      return `⚠ ${where}: Gemini quoted \`${shorten(c.quote)}\` but the file says \`${shorten(c.actualText ?? "")}\`.`;
    case "out_of_range":
      return `⚠ ${where}: the file has only ${c.totalLines} lines.`;
    default:
      return `${where}: ok`;
  }
}

function resolveSource(file: string, sources: readonly SourceText[]): SourceText | null {
  const target = file.replace(/\\/g, "/").toLowerCase();
  const exact = sources.find((s) => {
    const p = s.path.replace(/\\/g, "/").toLowerCase();
    return p === target || p.endsWith(`/${target}`);
  });
  if (exact) return exact;
  const base = target.split("/").pop();
  const byName = sources.filter((s) => s.path.replace(/\\/g, "/").toLowerCase().split("/").pop() === base);
  return byName.length === 1 ? byName[0]! : null;
}

function normalize(text: string): string {
  return text.replace(/\\@/g, "@").replace(/\s+/g, " ").trim();
}

/** Undoes what Gemini adds around a quote: our "N: " numbering, escapes, leading/trailing ellipses. */
function normalizeQuote(quote: string, citation: Citation): string {
  let q = normalize(quote);
  const numbered = /^(\d+):\s/.exec(q);
  if (numbered && Number(numbered[1]) >= citation.line - 1 && Number(numbered[1]) <= citation.lineEnd + 1) {
    q = q.slice(numbered[0].length);
  }
  return q.replace(/^(\.\.\.|…)\s*/, "").replace(/\s*(\.\.\.|…)$/, "").trim();
}

/** Every piece of a quote shortened with "..." must appear, in order. */
function containsQuote(haystack: string, quote: string): boolean {
  const pieces = quote.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  let from = 0;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at === -1) return false;
    from = at + piece.length;
  }
  return pieces.length > 0;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SHOWN_CHARS ? `${oneLine.slice(0, MAX_SHOWN_CHARS - 1)}…` : oneLine;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function readLines(file: string): Promise<string[] | null> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
    const buffer = await fsp.readFile(file);
    if (buffer.includes(0)) return null;
    const text = buffer.toString("utf8");
    return splitLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}
