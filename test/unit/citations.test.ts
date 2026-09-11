import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCitation, extractCitations, loadSources, verifyCitations, type SourceText } from "../../src/gemini/citations.js";
import { tempDir } from "../helpers.js";

const ERROR_LINE = "2026-09-10T10:57:00Z ERROR db.pool: connection refused to 10.0.0.12:5432 after 3 retries (job=nightly-export)";
const LOG: SourceText = { path: "C:\\logs\\build.log", lines: ["INFO start", ERROR_LINE, "INFO end"] };
const cite = (quote: string, line = 2, lineEnd = line) => ({ file: "build.log", line, lineEnd, quote });

describe("extractCitations", () => {
  it("finds file:line quotes in backticks or double quotes, with ranges, and skips bare names and fragments", () => {
    const answer = [
      "- build.log:2 `2026-09-10T10:57:00Z ERROR db.pool: connection refused`",
      '- src/app.ts:10-12 "const total = price * qty;"',
      "- `build.log:3` shows `INFO end`",
      "- mentioned without a quote: build.log:1",
      "- src/app.ts:14 — `handleRequest()` is never awaited",
      "- tiny.ts:4 `x`",
    ].join("\n");
    expect(extractCitations(answer)).toEqual([
      { file: "build.log", line: 2, lineEnd: 2, quote: "2026-09-10T10:57:00Z ERROR db.pool: connection refused" },
      { file: "src/app.ts", line: 10, lineEnd: 12, quote: "const total = price * qty;" },
      { file: "build.log", line: 3, lineEnd: 3, quote: "INFO end" },
    ]);
  });
});

describe("checkCitation", () => {
  it("accepts exact quotes, even with Gemini's copied numbering, escapes and ellipses", () => {
    for (const quote of [
      "2026-09-10T10:57:00Z ERROR db.pool",
      "2: 2026-09-10T10:57:00Z ERROR",
      "... connection refused to 10.0.0.12:5432 ...",
      "ERROR db.pool: ... after 3 retries",
    ]) {
      expect(checkCitation(cite(quote), LOG).status).toBe("ok");
    }
  });

  it("catches the 10:58-for-10:57 misquote and returns what the file really says", () => {
    expect(checkCitation(cite("2026-09-10T10:58:00Z ERROR db.pool: connection refused"), LOG)).toMatchObject({
      status: "misquoted",
      actualLine: 2,
      actualText: ERROR_LINE,
    });
  });

  it("finds a correct quote cited at the wrong line", () => {
    expect(checkCitation(cite("INFO end", 1), LOG)).toMatchObject({ status: "wrong_line", actualLine: 3 });
  });

  it("flags a line past the end of the file", () => {
    expect(checkCitation(cite("anything at all", 99), LOG)).toMatchObject({ status: "out_of_range", totalLines: 3 });
  });
});

describe("verifyCitations", () => {
  it("summarizes the checks and shows the real text of each problem, ignoring files it doesn't have", () => {
    const answer = [
      "build.log:2 `2026-09-10T10:58:00Z ERROR db.pool: connection refused`",
      "build.log:1 `INFO start`",
      "other.ts:5 `not one of ours`",
    ].join("\n");
    const report = verifyCitations(answer, [LOG]);
    expect(report.problems).toBe(1);
    expect(report.text).toContain("[quotes checked by the bridge against the files: 1 exact · 1 misquoted]");
    expect(report.text).toContain("the file says `2026-09-10T10:57:00Z ERROR db.pool");
  });

  it("flags an answer about attached files that quotes nothing it could check", () => {
    expect(verifyCitations("All good, no errors.", [LOG], true).text).toMatch(/no quotes the bridge could check/);
    expect(verifyCitations("All good.", [LOG]).text).toBeNull();
    expect(verifyCitations("All good.", [], true).text).toBeNull();
  });
});

describe("loadSources", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir("gcb-cite-");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uses inline files, reads referenced files, and cited files inside referenced folders", async () => {
    await fs.writeFile(path.join(dir, "notes.txt"), "alpha\nbeta\n");
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");

    const sources = await loadSources(
      [{ path: path.join(dir, "inline.log"), raw: ["one", "two"] }],
      [
        { path: path.join(dir, "notes.txt"), isDirectory: false },
        { path: dir, isDirectory: true },
      ],
      "src/app.ts:2 `const b = 2;`",
    );
    expect(sources.map((s) => path.basename(s.path))).toEqual(["inline.log", "notes.txt", "app.ts"]);
    expect(verifyCitations("src/app.ts:2 `const b = 2;`", sources).problems).toBe(0);
  });
});
