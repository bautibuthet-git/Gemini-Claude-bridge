import { describe, expect, it } from "vitest";
import { buildPrompt, escapeAtSigns, GUARDRAIL, MODE_PREFIXES, toAtReference } from "../../src/gemini/promptBuilder.js";
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
    expect(buildPrompt({ prompt: "  What is 2+2?  ", mode: "ask", paths: [], platform: "win32" })).toBe(
      `What is 2+2?\n\n${GUARDRAIL}`,
    );
  });

  it("puts mode framing first, then the task, the file references and the guardrail", () => {
    const prompt = buildPrompt({
      prompt: "Review this",
      mode: "review",
      paths: ["C:\\a b\\x.ts", "C:\\y.ts"],
      platform: "win32",
    });
    const sections = prompt.split("\n\n");
    expect(sections[0]).toBe(MODE_PREFIXES.review);
    expect(sections[1]).toBe("Review this");
    expect(sections[2]).toContain('@"C:\\a b\\x.ts"');
    expect(sections[2]).toContain('@"C:\\y.ts"');
    expect(sections.at(-1)).toBe(GUARDRAIL);
  });

  it("ends every mode with the read-only guardrail", () => {
    for (const mode of MODES) {
      expect(buildPrompt({ prompt: "x", mode, paths: [] }).endsWith(GUARDRAIL)).toBe(true);
    }
  });

  it.each([
    ["win32", ["C:\\Users\\Me\\My Project\\src\\big file.ts", "D:\\logs\\build,1.log", "C:\\plain\\a.txt"]],
    ["linux", ["/home/me/my project/src/big file.ts", "/var/log/build,1 (old).log", "/plain/a.txt"]],
  ] as const)("on %s the Gemini CLI extracts exactly our paths and nothing from the task text", (platform, paths) => {
    const prompt = buildPrompt({ prompt: "Compare these. Ping me@example.com, see @Component.", mode: "analyze", paths, platform });
    expect(geminiExtractedPaths(prompt, platform)).toEqual(paths);
  });
});
