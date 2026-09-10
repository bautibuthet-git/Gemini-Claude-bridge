import { describe, expect, it } from "vitest";
import {
  ATTACHED_LINE_LIMIT,
  buildPrompt,
  escapeAtSigns,
  fileReferenceLine,
  GUARDRAIL,
  MODE_PREFIXES,
  toAtReference,
  TRUNCATION_NOTICE,
} from "../../src/gemini/promptBuilder.js";
import { MODES } from "../../src/state/schema.js";

// Copied verbatim from Gemini CLI 0.59 (atCommandProcessor / paths utils) to pin the contract our
// @references must satisfy: the CLI must extract exactly the paths we meant.
const AT_COMMAND_PATH_REGEX_SOURCE = '(?:(?:"(?:[^"]*)")|(?:\\\\.|[^ \\t\\n\\r,;!?()\\[\\]{}.]|\\.(?!$|[ \\t\\n\\r])))+';
function geminiExtractedPaths(query: string, platform: "win32" | "linux"): string[] {
  const regex = new RegExp(`(?<!\\\\)@${AT_COMMAND_PATH_REGEX_SOURCE}`, "g");
  return [...query.matchAll(regex)].map((m) => {
    const raw = m[0].slice(1);
    if (platform === "win32") return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return raw.replace(/\\(.)/g, "$1");
  });
}

describe("toAtReference", () => {
  it("quotes Windows paths so spaces and backslashes survive", () => {
    expect(toAtReference("C:\\Users\\Me\\My Project\\a.ts", "win32")).toBe('@"C:\\Users\\Me\\My Project\\a.ts"');
  });

  it("backslash-escapes special characters on POSIX", () => {
    expect(toAtReference("/home/me/my project/a (1),b.ts", "linux")).toBe("@/home/me/my\\ project/a\\ \\(1\\)\\,b.ts");
  });
});

describe("fileReferenceLine", () => {
  it("says how much of a long file is missing", () => {
    expect(fileReferenceLine({ path: "C:\\a.log", lines: 4000 }, "win32")).toBe(
      `@"C:\\a.log" (4000 lines, only the first ${ATTACHED_LINE_LIMIT} attached)`,
    );
  });

  it("just states the size of a fully attached file, and stays bare when the count is unknown", () => {
    expect(fileReferenceLine({ path: "C:\\a.ts", lines: 120 }, "win32")).toBe('@"C:\\a.ts" (120 lines)');
    expect(fileReferenceLine({ path: "C:\\dir", lines: null }, "win32")).toBe('@"C:\\dir"');
    expect(fileReferenceLine({ path: "C:\\dir" }, "win32")).toBe('@"C:\\dir"');
  });
});

describe("escapeAtSigns", () => {
  it("escapes bare @ so the CLI doesn't treat it as a file reference", () => {
    expect(escapeAtSigns("mail me@x.com about @Component and @scope/pkg")).toBe(
      "mail me\\@x.com about \\@Component and \\@scope/pkg",
    );
  });

  it("leaves an already-escaped @ alone", () => {
    expect(escapeAtSigns("\\@keep")).toBe("\\@keep");
  });
});

describe("buildPrompt", () => {
  it("ask mode is just the trimmed task plus the guardrail", () => {
    expect(buildPrompt({ prompt: "  What is 2+2?  ", mode: "ask", files: [], platform: "win32" })).toBe(
      `What is 2+2?\n\n${GUARDRAIL}`,
    );
  });

  it("puts mode framing first, then the task, the file references and the guardrail", () => {
    const prompt = buildPrompt({
      prompt: "Review this",
      mode: "review",
      files: [{ path: "C:\\a b\\x.ts", lines: 4000 }, { path: "C:\\y.ts" }],
      platform: "win32",
    });
    const sections = prompt.split("\n\n");
    expect(sections[0]).toBe(MODE_PREFIXES.review);
    expect(sections[1]).toBe("Review this");
    expect(sections[2]).toContain('@"C:\\a b\\x.ts" (4000 lines, only the first 2000 attached)');
    expect(sections[2]).toContain('@"C:\\y.ts"');
    // Gemini silently attaches only the first 2000 lines of a file; it must be told.
    expect(sections[2]).toContain(TRUNCATION_NOTICE);
    expect(sections.at(-1)).toBe(GUARDRAIL);
  });

  it("ends every mode with the read-only guardrail", () => {
    for (const mode of MODES) {
      expect(buildPrompt({ prompt: "x", mode, files: [] }).endsWith(GUARDRAIL)).toBe(true);
    }
  });

  it.each([
    ["win32", ["C:\\Users\\Me\\My Project\\src\\big file.ts", "D:\\logs\\build,1.log", "C:\\plain\\a.txt"]],
    ["linux", ["/home/me/my project/src/big file.ts", "/var/log/build,1 (old).log", "/plain/a.txt"]],
  ] as const)("on %s the Gemini CLI extracts exactly our paths and nothing from the task text", (platform, paths) => {
    const prompt = buildPrompt({
      prompt: "Compare these. Ping me@example.com, see @Component.",
      mode: "analyze",
      files: paths.map((path, i) => ({ path, lines: i === 0 ? 4000 : null })),
      platform,
    });
    expect(geminiExtractedPaths(prompt, platform)).toEqual(paths);
  });
});
