import { describe, expect, it } from "vitest";
import {
  buildGeminiArgs,
  classifyFailure,
  invokeGemini,
  parseGeminiJson,
  runProcess,
  summarizeOutput,
  watchForModelFailure,
  type GeminiRequest,
} from "../../src/gemini/invoke.js";
import { BridgeError, type BridgeErrorType } from "../../src/util/errors.js";
import { fakeKill, fakeSpawn } from "../helpers.js";

const REQ: GeminiRequest = { prompt: "line one\nline two with \"quotes\" & %PATH%", timeoutMs: 5_000, cwd: "C:\\scratch" };
const doc = (value: unknown) => JSON.stringify(value, null, 2);
const NO_QUOTA_STDERR = [
  "Error when talking to Gemini API Full report available at: C:\\Temp\\report.json TerminalQuotaError: You exceeded your current quota, please check your plan and billing details.",
  "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro",
  "Please retry in 31.779058943s.",
].join("\n");

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
    expect(
      buildGeminiArgs({ model: "gemini-x", yolo: true, resumeSessionId: "abc-123", includeDirectories: ["C:\\a b", "D:\\c"] }),
    ).toEqual([
      "--output-format",
      "json",
      "--skip-trust",
      "--approval-mode=yolo",
      "--model=gemini-x",
      "--resume=abc-123",
      "--include-directories=C:\\a b",
      "--include-directories=D:\\c",
    ]);
  });
});

describe("invokeGemini", () => {
  it("sends the prompt on stdin, skips the CLI's self-relaunch, and returns the answer, model and session", async () => {
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

    expect(res).toMatchObject({ text: "Hi there", model: "main-pro", exitCode: 0, warnings: [], sessionId: "s1" });
    expect(children[0]?.stdinText).toBe(REQ.prompt);
    expect(calls[0]?.command).toBe("gemini");
    expect(calls[0]?.options).toMatchObject({ cwd: REQ.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(calls[0]?.options.env?.GEMINI_CLI_NO_RELAUNCH).toBe("true");
  });

  it("keeps a complete answer even when the CLI crashes while shutting down", async () => {
    // Seen live on Windows: the full JSON answer on stdout, then a libuv assertion and exit 127.
    const { spawn } = fakeSpawn((child) =>
      child.exit(127, doc({ session_id: "s2", response: "OK" }), "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94"),
    );
    expect(await invokeGemini(REQ, { spawn })).toMatchObject({ text: "OK", exitCode: 127, sessionId: "s2" });
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
    [1, "Error: 429 RESOURCE_EXHAUSTED: quota exceeded for this catalog index", "quota", /quota/],
    [1, "something unexpected happened", "gemini_error", /exit 1.*something unexpected/],
    [9009, "'gemini' is not recognized as an internal or external command", "not_installed", /not recognized/],
  ])("maps exit %i to %s", async (code, stderr, type, message) => {
    const { spawn } = fakeSpawn((child) => child.exit(code, "", stderr));
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), type);
    expect(err.message).toMatch(message);
    expect(err.details).toMatchObject({ exitCode: code });
  });

  it("reads the quota kind from the full output, not just the headline", async () => {
    const { spawn } = fakeSpawn((child) =>
      child.exit(1, "", `${NO_QUOTA_STDERR}\n${doc({ error: { type: "Error", message: "You exceeded your current quota", code: 429 } })}`),
    );
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), "quota");
    expect(err.details).toMatchObject({ failure: "quota", quota: { kind: "no_quota", retryAfterMs: 31_780 } });
  });

  it("says so when the CLI waits out a per-minute limit on the last model, instead of going silent", async () => {
    const notices: string[] = [];
    const { spawn } = fakeSpawn((child) => {
      // Verbatim shape of the CLI's stderr when a second big question hit the free tier's limit.
      child.stderr.write(
        "Attempt 1 failed: You exceeded your current quota\n* Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.1-flash-lite\nPlease retry in 54.863515632s.\nSuggested retry after 54s.. Retrying after 64395ms...\n",
      );
      setTimeout(() => child.exit(0, doc({ response: "late but fine" })), 20);
    });
    const res = await invokeGemini({ ...REQ, onNotice: (m) => notices.push(m) }, { spawn });
    expect(res.text).toBe("late but fine");
    expect(notices).toEqual(["Gemini hit its per-minute quota; the Gemini CLI waits ~64s and retries by itself…"]);
  });

  it("stops a doomed model early when failFast is set", async () => {
    const { spawn, children } = fakeSpawn((child) => child.stderr.write(NO_QUOTA_STDERR)); // then hangs
    const { kill, kills } = fakeKill(() => children[0]?.emit("close", null, "SIGKILL"));
    const started = Date.now();
    const err = await expectBridgeError(invokeGemini({ ...REQ, failFast: true }, { spawn, kill }), "quota");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(kills).toHaveLength(1);
    expect(err.details.quota).toMatchObject({ kind: "no_quota" });
  });

  it("maps Google's ineligible-tier refusal to a sign-in problem with a usable next step", async () => {
    // Verbatim shape of what Gemini CLI 0.59 printed on stderr for this account (stdout was empty).
    const stderr = [
      "Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.",
      "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google",
      "    at throwIneligibleOrProjectIdError (file:///C:/Users/Me/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/chunk.js:310176:11)",
      "Ripgrep is not available. Falling back to GrepTool.",
      "An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.",
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
    const err = await expectBridgeError(invokeGemini(REQ, { spawn }), "gemini_error");
    expect(err.details.failure).toBe("transient");
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

  it("kills Gemini when the MCP request is cancelled", async () => {
    const controller = new AbortController();
    const { spawn, children } = fakeSpawn(() => setTimeout(() => controller.abort(), 10));
    const { kill, kills } = fakeKill(() => children[0]?.emit("close", null, "SIGKILL"));
    const err = await expectBridgeError(invokeGemini({ ...REQ, signal: controller.signal }, { spawn, kill }), "gemini_error");
    expect(err.message).toMatch(/cancelled/);
    expect(kills).toHaveLength(1);
  });
});

describe("runProcess", () => {
  it("stops after a grace period if the killed process never closes", async () => {
    const { spawn } = fakeSpawn(() => undefined);
    const { kill } = fakeKill();
    const result = await runProcess("gemini", [], { timeoutMs: 20, killGraceMs: 20, spawn, kill });
    expect(result).toMatchObject({ timedOut: true, code: null });
  });

  it("lets a watcher stop the process, after reading a little more output", async () => {
    const { spawn, children } = fakeSpawn((child) => {
      child.stderr.write("TerminalQuotaError: boom\n");
      setTimeout(() => child.stderr.write("* limit: 0\n"), 5);
    });
    const { kill } = fakeKill(() => children[0]?.emit("close", null, "SIGKILL"));
    const result = await runProcess("gemini", [], { timeoutMs: 5_000, watch: watchForModelFailure, watchGraceMs: 50, spawn, kill });
    expect(result.stoppedBy).toBe("TerminalQuotaError");
    expect(result.stderr).toContain("limit: 0");
  });
});

describe("classifyFailure", () => {
  it("flags models the account can't use and temporary errors for the runner", () => {
    expect(classifyFailure(1, "ModelNotFoundError: models/x is not found for API version v1beta").details.failure).toBe("unavailable");
    expect(classifyFailure(1, "503 Service UNAVAILABLE").details.failure).toBe("transient");
    expect(classifyFailure(1, "boom").details.failure).toBeUndefined();
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
