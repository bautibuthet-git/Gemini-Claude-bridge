import { describe, expect, it, vi } from "vitest";
import { AcpEngine, silenceLimitMs, type AcpDeps } from "../../src/gemini/acp.js";
import { BridgeError } from "../../src/util/errors.js";
import { fakeKill, fakeSpawn, type FakeChild } from "../helpers.js";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };

interface AgentOptions {
  /** Never answer session/prompt (until cancelled). */
  hang?: boolean;
  /** Ignore the handshake. */
  silent?: boolean;
  /** Ask the client for permission during the prompt. */
  askPermission?: boolean;
  setModelError?: string;
  /** Written to stderr when a prompt arrives (the agent then answers, unless hang is set). */
  promptStderr?: string;
  /** Tool calls reported before the answer. */
  toolCalls?: Array<{ kind: string; title: string }>;
  /** Stream thoughts for this long (ms) before answering. */
  thinkFor?: number;
}

/** A scripted `gemini --acp`: answers the protocol over the fake child's stdio. */
function fakeAgent(options: AgentOptions = {}) {
  const received: Message[] = [];
  const permissionAnswers: unknown[] = [];
  let sessions = 0;
  let current: FakeChild | undefined;
  const attach = (child: FakeChild) => {
    current = child;
    // The engine writes its handshake right after spawning, before this script is attached, so
    // start from what the child has already received.
    let buffer = child.stdinText;
    const send = (message: object) => child.stdout.write(`${JSON.stringify(message)}\n`);
    const drain = () => {
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Message;
        received.push(message);
        handle(message, send);
      }
    };
    drain();
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      drain();
    });
  };
  const handle = (m: Message, send: (message: object) => void) => {
    if (m.method === undefined && m.id === 99) {
      permissionAnswers.push(m.result);
      return;
    }
    switch (m.method) {
      case "initialize":
        if (!options.silent) send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
        return;
      case "session/new":
        send({ jsonrpc: "2.0", id: m.id, result: { sessionId: `sess-${++sessions}` } });
        return;
      case "session/set_model":
        send(
          options.setModelError
            ? { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: options.setModelError } }
            : { jsonrpc: "2.0", id: m.id, result: {} },
        );
        return;
      case "session/prompt": {
        if (options.promptStderr) current?.stderr.write(options.promptStderr);
        if (options.hang) return;
        const sessionId = m.params?.sessionId;
        const thought = () =>
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "(thinking)" } } } });
        const answer = () => {
          if (options.askPermission) {
            send({
              jsonrpc: "2.0",
              id: 99,
              method: "session/request_permission",
              params: { sessionId, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }], toolCall: {} },
            });
          }
          for (const tool of options.toolCalls ?? []) {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: tool.title, status: "in_progress", ...tool } } });
          }
          for (const text of ["Hello ", "world"]) {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
          }
          thought();
          send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", _meta: { quota: { model_usage: [{ model: "gemini-3.1-flash-lite" }] } } } });
        };
        if (!options.thinkFor) return answer();
        const until = Date.now() + options.thinkFor;
        const tick = setInterval(() => {
          thought();
          if (Date.now() < until) return;
          clearInterval(tick);
          answer();
        }, 40);
        return;
      }
      case "session/cancel":
        return;
      default:
        if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  };
  return { attach, received, permissionAnswers };
}

function engineWith(agent: ReturnType<typeof fakeAgent>, overrides: Partial<AcpDeps> = {}) {
  const { spawn, calls, children } = fakeSpawn((child) => agent.attach(child));
  const { kill, kills } = fakeKill((pid) => children.find((c) => c.pid === pid)?.emit("close", null, "SIGKILL"));
  const engine = new AcpEngine({ cwd: async () => "C:\\scratch", projectDir: () => "C:\\project", spawn, kill, command: "gemini", ...overrides });
  return { engine, calls, children, kills };
}

describe("AcpEngine", () => {
  it("starts one warm process, reuses it, and assembles the streamed answer", async () => {
    const agent = fakeAgent();
    const { engine, calls } = engineWith(agent);

    const first = await engine.run({ prompt: "hi", model: "gemini-3.1-flash-lite", timeoutMs: 5_000 });
    const second = await engine.run({ prompt: "again", model: "auto", timeoutMs: 5_000 });

    expect(first).toMatchObject({ text: "Hello world", model: "gemini-3.1-flash-lite", sessionId: "sess-1", exitCode: 0 });
    expect(second.sessionId).toBe("sess-2");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["--acp", "--skip-trust", "--approval-mode=default", "--include-directories=C:\\project"]);
    expect(calls[0]!.options.env?.GEMINI_CLI_NO_RELAUNCH).toBe("true");
    const methods = agent.received.map((m) => m.method);
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    // "auto" leaves the model choice to Gemini: no set_model for the second call.
    expect(methods.filter((m) => m === "session/set_model")).toHaveLength(1);
    expect(engine.describe()).toMatch(/warm/);
    engine.close();
  });

  it("continues a conversation in the same session", async () => {
    const agent = fakeAgent();
    const { engine } = engineWith(agent);
    const first = await engine.run({ prompt: "hi", model: "auto", timeoutMs: 5_000 });
    expect(engine.hasSession(first.sessionId!)).toBe(true);
    await engine.run({ prompt: "more", model: "auto", timeoutMs: 5_000, sessionId: first.sessionId! });
    expect(agent.received.filter((m) => m.method === "session/new")).toHaveLength(1);
    engine.close();
  });

  it("refuses whatever the agent asks permission for, keeping Gemini read-only", async () => {
    const agent = fakeAgent({ askPermission: true });
    const { engine } = engineWith(agent);
    await engine.run({ prompt: "hi", model: "auto", timeoutMs: 5_000 });
    expect(agent.permissionAnswers).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
    engine.close();
  });

  it("classifies agent errors like the CLI's, e.g. a model the account can't use", async () => {
    const { engine } = engineWith(fakeAgent({ setModelError: "ModelNotFoundError: models/x is not found for API version v1beta" }));
    const error = (await engine.run({ prompt: "hi", model: "x", timeoutMs: 5_000 }).catch((e: unknown) => e)) as BridgeError;
    expect(error).toBeInstanceOf(BridgeError);
    expect(error.details.failure).toBe("unavailable");
    expect(engine.isHealthy()).toBe(true);
    engine.close();
  });

  it("abandons a model at once when stderr shows it has no quota and another model can take over", async () => {
    const agent = fakeAgent({
      hang: true,
      promptStderr: "TerminalQuotaError: You exceeded your current quota\n* Quota exceeded for metric: x, limit: 0, model: gemini-3.1-pro\n",
    });
    const { engine } = engineWith(agent);
    const started = Date.now();
    const error = (await engine.run({ prompt: "x", model: "pro", timeoutMs: 30_000, failFast: true }).catch((e: unknown) => e)) as BridgeError;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.type).toBe("quota");
    expect(error.details.quota).toMatchObject({ kind: "no_quota" });
    expect(agent.received.some((m) => m.method === "session/cancel")).toBe(true);
    engine.close();
  });

  it("says so when the CLI waits out a per-minute limit on the last model", async () => {
    const notices: string[] = [];
    const agent = fakeAgent({ promptStderr: "Please retry in 54.8s.\nSuggested retry after 54s.. Retrying after 64395ms...\n" });
    const { engine } = engineWith(agent);
    const result = await engine.run({ prompt: "x", model: "auto", timeoutMs: 5_000, onNotice: (m) => notices.push(m) });
    expect(result.text).toBe("Hello world");
    expect(notices).toEqual(["Gemini hit its per-minute quota; the Gemini CLI waits ~64s and retries by itself…"]);
    engine.close();
  });

  it("reports the files Gemini reads and searches as progress, but not its bookkeeping", async () => {
    const notices: string[] = [];
    const agent = fakeAgent({
      toolCalls: [
        { kind: "think", title: 'Update tactical intent: "review the module"' },
        { kind: "read", title: "src\\app.ts" },
        { kind: "search", title: "src" },
      ],
    });
    const { engine } = engineWith(agent);
    const result = await engine.run({ prompt: "x", model: "auto", timeoutMs: 5_000, onNotice: (m) => notices.push(m) });
    expect(result.text).toBe("Hello world");
    expect(notices).toEqual(["Gemini is reading src\\app.ts…", "Gemini is searching src…"]);
    engine.close();
  });

  it("gives up on a prompt with no sign of life, so the call can ask again with a one-off process", async () => {
    const agent = fakeAgent({ hang: true });
    const { engine } = engineWith(agent, { silenceMs: () => 50 });
    const error = (await engine.run({ prompt: "x", model: "flash", timeoutMs: 5_000 }).catch((e: unknown) => e)) as BridgeError;
    expect(error.details.failure).toBe("engine");
    expect(error.message).toMatch(/^flash gave no sign of life for 0s in the warm Gemini process/);
    expect(agent.received.some((m) => m.method === "session/cancel")).toBe(true);
    // Only this prompt was stuck: the engine stays available to other calls.
    expect(engine.isHealthy()).toBe(true);
    engine.close();
  });

  it("keeps waiting while Gemini shows signs of life, however long it thinks", async () => {
    const { engine } = engineWith(fakeAgent({ thinkFor: 300 }), { silenceMs: () => 150 });
    const result = await engine.run({ prompt: "x", model: "flash", timeoutMs: 5_000 });
    expect(result.text).toBe("Hello world");
    engine.close();
  });

  it("allows bigger prompts a longer silence before the first sign of life", () => {
    expect(silenceLimitMs(2_500)).toBe(40_500);
    expect(silenceLimitMs(250_000)).toBe(90_000);
    expect(silenceLimitMs(5_000_000)).toBe(120_000);
  });

  it("cancels a prompt that runs out of time", async () => {
    const agent = fakeAgent({ hang: true });
    const { engine } = engineWith(agent);
    const error = (await engine.run({ prompt: "slow", model: "auto", timeoutMs: 100 }).catch((e: unknown) => e)) as BridgeError;
    expect(error.type).toBe("timeout");
    expect(agent.received.some((m) => m.method === "session/cancel")).toBe(true);
    engine.close();
  });

  it("goes unhealthy when the process dies, so calls fall back to one-off processes", async () => {
    const agent = fakeAgent({ hang: true });
    const { engine, children } = engineWith(agent);
    const pending = engine.run({ prompt: "x", model: "auto", timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(agent.received.some((m) => m.method === "session/prompt")).toBe(true));
    children[0]!.emit("close", 1, null);
    const error = (await pending) as BridgeError;
    expect(error.details.failure).toBe("engine");
    expect(engine.isHealthy()).toBe(false);
    expect(engine.describe()).toMatch(/off until/);
  });

  it("gives up on a handshake that never comes", async () => {
    const { engine, kills } = engineWith(fakeAgent({ silent: true }));
    const error = (await engine.run({ prompt: "x", model: "auto", timeoutMs: 100 }).catch((e: unknown) => e)) as BridgeError;
    expect(error.details.failure).toBe("engine");
    expect(error.message).toMatch(/could not start/);
    expect(kills).toHaveLength(1);
  });
});
