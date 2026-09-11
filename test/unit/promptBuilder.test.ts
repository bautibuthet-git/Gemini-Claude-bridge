import { describe, expect, it } from "vitest";
import { numberLines } from "../../src/gemini/attachments.js";
import {
  ATTACHED_LINE_LIMIT,
  buildPrompt,
  escapeAtSigns,
  fileReferenceLine,
  FOLLOW_UP_HEADER,
  GUARDRAIL,
  INLINE_INTRO,
  MODE_PREFIXES,
  toAtReference,
  TRUNCATION_NOTICE,
} from "../../src/gemini/promptBuilder.js";
import { MODES } from "../../src/state/schema.js";

// Copied verbatim from Gemini CLI 0.59 (atCommandProcessor / paths utils) to pin the contract our
// prompts must satisfy: the CLI must attach exactly the paths we meant, and nothing else.
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
  it("says how much of a long referenced file is missing", () => {
    expect(fileReferenceLine({ path: "C:\\a.log", lines: 4000 }, "win32")).toBe(
      `@"C:\\a.log" (4000 lines, only the first ${ATTACHED_LINE_LIMIT} attached)`,
    );
  });

  it("just states the size of a fully attached file, and stays bare when the count is unknown", () => {
    expect(fileReferenceLine({ path: "C:\\a.ts", lines: 120 }, "win32")).toBe('@"C:\\a.ts" (120 lines)');
    expect(fileReferenceLine({ path: "C:\\dir", lines: null }, "win32")).toBe('@"C:\\dir"');
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
  it("opens with a header, so the input can never start with a Gemini CLI command", () => {
    const prompt = buildPrompt({ prompt: "  /help me  ", mode: "ask" });
    expect(prompt).toBe(`Task:\n\n/help me\n\n${GUARDRAIL}`);
    for (const mode of MODES) expect(buildPrompt({ prompt: "$x", mode }).startsWith(MODE_PREFIXES[mode])).toBe(true);
  });

  it("adds the requested answer format", () => {
    expect(buildPrompt({ prompt: "x", mode: "ask", format: "5 bullets" })).toContain("\n\nAnswer format: 5 bullets\n\n");
  });

  it("inlines files between markers, complete and numbered, with at-signs escaped", () => {
    const file = { path: "C:\\logs\\build.log", ...numberLines("ok\nERROR boom @ db\n") };
    const prompt = buildPrompt({ prompt: "Summarize", mode: "summarize", inline: [file], platform: "win32" });
    expect(prompt).toContain(INLINE_INTRO);
    expect(prompt).toContain(
      "===== FILE 1 of 1: C:\\logs\\build.log (2 lines) =====\n1: ok\n2: ERROR boom \\@ db\n===== END OF FILE 1 =====",
    );
    expect(prompt).not.toContain(TRUNCATION_NOTICE);
  });

  it("lists referenced files and folders with the truncation notice", () => {
    const prompt = buildPrompt({
      prompt: "x",
      mode: "review",
      referenced: [
        { path: "C:\\a b\\x.ts", lines: 4000, isDirectory: false },
        { path: "C:\\dir", lines: null, isDirectory: true },
      ],
      platform: "win32",
    });
    expect(prompt).toContain('@"C:\\a b\\x.ts" (4000 lines, only the first 2000 attached)');
    expect(prompt).toContain('@"C:\\dir"');
    expect(prompt).toContain(TRUNCATION_NOTICE);
    expect(prompt.split("\n\n").at(-1)).toBe(GUARDRAIL);
  });

  it("frames a follow-up as one", () => {
    expect(buildPrompt({ prompt: "and?", mode: "review", followUp: true }).startsWith(FOLLOW_UP_HEADER)).toBe(true);
  });

  it("ends every mode with the read-only guardrail", () => {
    for (const mode of MODES) expect(buildPrompt({ prompt: "x", mode }).endsWith(GUARDRAIL)).toBe(true);
  });

  it.each([
    ["win32", ["C:\\Users\\Me\\My Project\\src\\big file.ts", "D:\\logs\\build,1.log"]],
    ["linux", ["/home/me/my project/src/big file.ts", "/var/log/build,1 (old).log"]],
  ] as const)(
    "on %s the CLI attaches exactly the referenced paths — nothing from the task or the inlined code",
    (platform, paths) => {
      const code = numberLines("@Component({})\nconst mail = 'me@example.com';\nimport x from '@scope/pkg';\n");
      const prompt = buildPrompt({
        prompt: "Compare these. Ping me@example.com, see @Component.",
        mode: "analyze",
        inline: [{ path: platform === "win32" ? "C:\\src\\app.ts" : "/src/app.ts", ...code }],
        referenced: paths.map((path, i) => ({ path, lines: i === 0 ? 4000 : null, isDirectory: false })),
        platform,
      });
      expect(geminiExtractedPaths(prompt, platform)).toEqual(paths);
    },
  );
});
