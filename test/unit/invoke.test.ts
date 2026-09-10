import { describe, expect, it } from "vitest";
import {
  buildGeminiArgs,
  invokeGemini,
  parseGeminiJson,
  runProcess,
  summarizeOutput,
  type GeminiRequest,
} from "../../src/gemini/invoke.js";
import { BridgeError, type BridgeErrorType } from "../../src/util/errors.js";
import { fakeKill, fakeSpawn } from "../helpers.js";

const REQ: GeminiRequest = { prompt: "line one\nline two with \"quotes\" & %PATH%", timeoutMs: 5_000, cwd: "C:\\scratch" };
const doc = (value: unknown) => JSON.stringify(value, null, 2);

async function expectBridgeError(promise: Promise<unknown>, type: BridgeErrorType): Promise<BridgeError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BridgeError);
  expect((err as BridgeError).type).toBe(type);
  return err as BridgeError;
}

describe("buildGeminiArgs", () => {
  it("runs headless JSON, read-only by default, and never passes the prompt as an argument", () => {
    const args = buildGeminiArgs({});
    expect(args).toEqual(["--output-format", "json", "--skip-trust", "--approval-mode=default"]);
    expect(args).not.toContain("-p");
  });

  it("binds option values with = so they can't be parsed as separate flags", () => {
    expect(buildGeminiArgs({ model: "gemini-x", yolo: true, includeDirectories: ["C:\\a b", "D:\\c"] })).toEqual([
      "--output-format",
      "json",
      "--skip-trust",
      "--approval-mode=yolo",
      "--model=gemini-x",
      "--include-directories=C:\\a b",
      "--include-directories=D:\\c",
    ]);
  });
});

describe("invokeGemini", () => {
  it("sends the prompt on stdin (multi-line, special chars intact) and returns the answer and main model", async () => {
    const { spawn, calls, children } = fakeSpawn((child) =>
      child.exit(
        0,
        doc({
          session_id: "s1",
          response: "Hi there",
          stats: { models: { "router-lite": { tokens: { candidates: 3 } }, "main-pro": { tokens: { candidates: 120 } } } },
        }),
      ),
    );
    const res = await invokeGemini(REQ, { spawn, command: "gemini" });

    expect(res).toMatchObject({ text: "Hi there", model: "main-pro", exitCode: 0, warnings: [] });
    expect(children[0]?.stdinText).toBe(REQ.prompt);
    expect(calls[0]?.command).toBe("gemini");
    expect(calls[0]?.options).toMatchObject({ cwd: REQ.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  });

  it("tolerates log lines printed before the JSON document", async () => {
    const { spawn } = fakeSpawn((child) => child.exit(0, `Loaded cached credentials.\n${doc({ response: "ok" })}`));
    expect((await invokeGemini(REQ, { spawn })).text).toBe("ok");
  });

  it.each<[number, string, BridgeErrorType, RegExp]>([
    // Exactly what Gemini CLI 0.59 printed on stderr when run unauthenticated on this machine.
    [
      41,
      doc({
        session_id: "x",
        error: {
          type: "Error",
          message:
            "Please set an Auth method in your C:\\Users\\Me\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
          code: 41,
        },
      }),
      "not_authenticated",
      /Auth method/,
    ],
    [1, doc({ error: { type: "Error", message: "Failed to login. Message: invalid_grant" } }), "not_authenticated", /invalid_grant/],
    [42, doc({ error: { type: "FatalInputError", message: "No input provided via stdin.", code: 42 } }), "gemini_error", /rejected the input/],
    [53, doc({ error: { type: "FatalTurnLimitedError", message: "Reached max session turns", code: 53 } }), "gemini_error", /turn limit/],
    [1, "Error: 429 RESOURCE_EXHAUSTED: quota exceeded for this catalog index", "gemini_error", /quota/],
    [1, "something unexpected happened", "gemini_error", /exit 1.*something unexpected/],
    [9009, "'gemini' is not recognized as an internal or external command", "not_installed", /not recognized/],
  ])("maps exit %i to %s", async (code, stderr, type, message) => {
    const { spawn } = fakeSpawn((child) => child.exit(code, "", stderr));
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), type);
    expect(err.message).toMatch(message);
    expect(err.details).toMatchObject({ exitCode: code });
  });

  it("maps Google's ineligible-tier refusal to a sign-in problem with a usable next step", async () => {
    // Verbatim shape of what Gemini CLI 0.59 printed on stderr for this account (stdout was empty).
    const stderr = [
      "Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.",
      "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google",
      "    at throwIneligibleOrProjectIdError (file:///C:/Users/Me/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk.js:310176:11)",
      "    at _doSetupUser (file:///C:/Users/Me/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk.js:310165:5)",
      "Ripgrep is not available. Falling back to GrepTool.",
      "An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.",
      "    at throwIneligibleOrProjectIdError (file:///C:/Users/Me/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk.js:310176:11)",
    ].join("\n");
    const { spawn } = fakeSpawn((child) => child.exit(1, "", stderr));
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), "not_authenticated");

    expect(err.message).toMatch(/no longer supported for Gemini Code Assist/);
    expect(err.message).not.toMatch(/ {4}at /);
    expect(err.message).not.toMatch(/True color/);
    expect(err.details.nextStep).toMatch(/aistudio\.google\.com/);
  });

  it("reports an error document even when the exit code is 0", async () => {
    const { spawn } = fakeSpawn((child) => child.exit(0, doc({ error: { type: "Error", message: "model overloaded" } })));
    await expectBridgeError(invokeGemini(REQ, { spawn }), "gemini_error");
  });

  it("rejects an empty answer", async () => {
    const { spawn } = fakeSpawn((child) => child.exit(0, doc({ response: "   " })));
    await expectBridgeError(invokeGemini(REQ, { spawn }), "gemini_error");
  });

  it("maps ENOENT to not_installed", async () => {
    const { spawn } = fakeSpawn((child) =>
      child.emit("error", Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" })),
    );
    await expectBridgeError(invokeGemini(REQ, { spawn }), "not_installed");
  });

  it("maps a synchronous spawn failure to gemini_error", async () => {
    const spawn = () => {
      throw new Error("EINVAL");
    };
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), "gemini_error");
    expect(err.message).toMatch(/Could not start/);
  });

  it("kills the whole process tree on timeout instead of hanging", async () => {
    const { spawn, children } = fakeSpawn(() => {
      /* never exits: e.g. waiting on a browser login */
    });
    const { kill, kills } = fakeKill(() => children[0]?.emit("close", null, "SIGKILL"));
    const err = await expectBridgeError(invokeGemini({ ...REQ, timeoutMs: 30 }, { spawn, kill }), "timeout");
    expect(kills).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
    expect(err.message).toMatch(/process tree was stopped/);
  });

  it("stops waiting after a grace period if the killed process never closes", async () => {
    const { spawn } = fakeSpawn(() => undefined);
    const { kill } = fakeKill();
    const result = await runProcess("gemini", [], { timeoutMs: 20, killGraceMs: 20, spawn, kill });
    expect(result).toMatchObject({ timedOut: true, code: null });
  });

  it("kills Gemini when the MCP request is cancelled", async () => {
    const controller = new AbortController();
    const { spawn, children } = fakeSpawn(() => setTimeout(() => controller.abort(), 10));
    const { kill, kills } = fakeKill(() => children[0]?.emit("close", null, "SIGKILL"));
    const err = await expectBridgeError(invokeGemini({ ...REQ, signal: controller.signal }, { spawn, kill }), "gemini_error");
    expect(err.message).toMatch(/cancelled/);
    expect(kills).toHaveLength(1);
  });
});

describe("parseGeminiJson", () => {
  it("parses a plain document, ignores surrounding log lines, and rejects garbage", () => {
    expect(parseGeminiJson(doc({ response: "a" }))).toEqual({ response: "a" });
    expect(parseGeminiJson(`warn: x\n${doc({ response: "b" })}`)).toEqual({ response: "b" });
    expect(parseGeminiJson(`${doc({ response: "c" })}\nRipgrep is not available.`)).toEqual({ response: "c" });
    expect(parseGeminiJson(`start\n${doc({ response: "d" })}\nend`)).toEqual({ response: "d" });
    expect(parseGeminiJson("not json at all")).toBeNull();
    expect(parseGeminiJson("")).toBeNull();
    expect(parseGeminiJson("[1,2]")).toBeNull();
  });
});

describe("summarizeOutput", () => {
  it("keeps the last meaningful line and drops stack frames and terminal chatter", () => {
    const text = "Warning: True color (24-bit) support not detected.\nError authenticating: boom\n    at foo (x.js:1:1)";
    expect(summarizeOutput(text)).toBe("Error authenticating: boom");
  });

  it("falls back to the last lines when nothing looks like an error", () => {
    expect(summarizeOutput("one\ntwo\nthree\nfour")).toBe("two\nthree\nfour");
    expect(summarizeOutput("   \n  ")).toBe("");
  });

  it("truncates very long messages", () => {
    expect(summarizeOutput(`Error: ${"x".repeat(900)}`, 100)).toHaveLength(101);
  });
});
