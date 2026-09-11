import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import treeKill from "tree-kill";
import { BridgeError, errorMessage } from "../util/errors.js";
import { VERSION } from "../version.js";
import {
  classifyFailure,
  describeWait,
  geminiCommand,
  geminiEnv,
  RETRY_WAIT_PATTERN,
  summarizeOutput,
  watchForModelFailure,
  type GeminiResponse,
  type KillFn,
  type SpawnFn,
} from "./invoke.js";

/**
 * A warm `gemini --acp` process reused across calls, instead of starting the CLI for every one.
 * ACP (Agent Client Protocol) is newline-delimited JSON-RPC 2.0 over stdio; Gemini CLI 0.59
 * speaks protocol version 1. Each call gets its own session (or reuses one for a follow-up),
 * and anything the agent asks permission for is refused, which keeps Gemini read-only.
 */
const ACP_PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 60_000;
/** After asking the agent to cancel, how long to wait before killing the whole process. */
const CANCEL_GRACE_MS = 3_000;
const IDLE_MS = 10 * 60_000;
/** After a crash or a failed start, calls use one-off processes for a while. */
const UNHEALTHY_MS = 5 * 60_000;
const MAX_SESSIONS = 20;
/** Once stderr shows a fatal model error, keep reading briefly: its details ("limit: 0") follow. */
const WATCH_GRACE_MS = 600;

type Json = Record<string, unknown>;

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private readonly chunks = new Map<string, string[]>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();
  closed: Error | null = null;
  stderrTail = "";

  constructor(
    readonly child: ChildProcess,
    private readonly onClosed: (connection: AcpConnection) => void,
  ) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => this.onData(data));
    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString("utf8");
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
      for (const listener of this.stderrListeners) listener(chunk);
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => this.close(err));
    child.on("close", () => this.close(new Error(`the Gemini ACP process exited. ${lastLine(this.stderrTail)}`.trim())));
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  /** Stderr written from now on (it is shared by every session of the process). */
  watchStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  collect(sessionId: string): void {
    this.chunks.set(sessionId, []);
  }

  takeText(sessionId: string): string {
    const text = (this.chunks.get(sessionId) ?? []).join("");
    this.chunks.delete(sessionId);
    return text;
  }

  /** Kills the whole process tree; `done` runs once the kill has been carried out. */
  kill(kill: KillFn, done: () => void = () => undefined): void {
    if (this.child.pid !== undefined && !this.closed) kill(this.child.pid, "SIGKILL", () => done());
    else done();
    this.close(new Error("the Gemini ACP process was stopped."));
  }

  private send(message: Json): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onData(data: string): void {
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return; // stdout is protocol-only, but never let a stray line break the connection
    }
    const params = (message.params ?? {}) as Json;
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) this.answer(message.id, message.method, params);
      else this.onNotification(message.method, params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = message.error as { message?: string; code?: number; data?: unknown };
      const data = typeof error.data === "string" ? ` ${error.data}` : "";
      pending.reject(new RpcError(`${error.message ?? "ACP error"}${data}`, error.code));
    } else {
      pending.resolve((message.result ?? {}) as Json);
    }
  }

  private onNotification(method: string, params: Json): void {
    if (method !== "session/update") return;
    const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: unknown } } | undefined;
    if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
      this.chunks.get(String(params.sessionId))?.push(update.content.text);
    }
  }

  /** The bridge is read-only: whatever needs approval (edits, shell) is refused. */
  private answer(id: unknown, method: string, params: Json): void {
    if (method === "session/request_permission") {
      const options = (params.options ?? []) as Array<{ optionId?: string; kind?: string }>;
      const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
      const outcome = reject?.optionId ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
      this.send({ jsonrpc: "2.0", id, result: { outcome } });
      return;
    }
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `gemini-claude-bridge does not provide ${method}` } });
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onClosed(this);
  }
}

export interface AcpRunRequest {
  prompt: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Continue this session (a follow-up) if the process still has it. */
  sessionId?: string;
  /** Abandon the prompt as soon as stderr shows a quota or unknown-model error. */
  failFast?: boolean;
  /** Told when the CLI starts waiting out a rate limit. */
  onNotice?: (message: string) => void;
}

export interface AcpDeps {
  /** Folder the agent runs from and creates sessions in: the bridge's scratch folder. */
  cwd: () => Promise<string>;
  /** Readable by Gemini's own tools, fixed for the process lifetime. */
  projectDir?: () => string | null;
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  kill?: KillFn;
  now?: () => number;
}

export class AcpEngine {
  private connection: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private unhealthyUntil = 0;
  private lastError: string | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  /** sessionId → last use, for sessions alive in the current process. */
  private readonly sessions = new Map<string, number>();
  private readonly spawnFn: SpawnFn;
  private readonly killFn: KillFn;
  private readonly now: () => number;

  constructor(private readonly deps: AcpDeps) {
    this.spawnFn = deps.spawn ?? (crossSpawn as unknown as SpawnFn);
    this.killFn = deps.kill ?? (treeKill as KillFn);
    this.now = deps.now ?? Date.now;
  }

  isHealthy(): boolean {
    return this.now() >= this.unhealthyUntil;
  }

  hasSession(sessionId: string): boolean {
    return this.connection !== null && this.sessions.has(sessionId);
  }

  describe(): string {
    if (!this.isHealthy()) return `off until ${new Date(this.unhealthyUntil).toISOString()} after an error (${this.lastError})`;
    return this.connection ? `warm, ${this.sessions.size} open conversation(s)` : "starts on first use";
  }

  async run(req: AcpRunRequest): Promise<GeminiResponse> {
    const startedAt = this.now();
    const deadline = startedAt + req.timeoutMs;
    this.clearIdle();

    let connection: AcpConnection;
    try {
      connection = await this.connect(Math.min(START_TIMEOUT_MS, req.timeoutMs));
    } catch (err) {
      this.markUnhealthy(err);
      throw new BridgeError("gemini_error", `The warm Gemini process could not start: ${errorMessage(err)}`, {
        failure: "engine",
      });
    }

    try {
      const sessionId =
        req.sessionId && this.sessions.has(req.sessionId) ? req.sessionId : await this.newSession(connection);
      this.sessions.set(sessionId, this.now());
      if (req.model !== "auto") await connection.request("session/set_model", { sessionId, modelId: req.model });

      connection.collect(sessionId);
      const result = await this.prompt(connection, sessionId, req.prompt, deadline, req);
      const text = connection.takeText(sessionId).trim();
      const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn";
      if (stopReason === "refusal") throw new BridgeError("gemini_error", "Gemini refused to answer this request.");
      if (!text) throw new BridgeError("gemini_error", `Gemini returned an empty response (stop reason: ${stopReason}).`);
      return {
        text,
        model: modelUsed(result) ?? req.model,
        durationMs: this.now() - startedAt,
        exitCode: 0,
        warnings: stopReason === "end_turn" ? [] : [`The answer may be incomplete (stop reason: ${stopReason}).`],
        sessionId,
      };
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err instanceof RpcError) throw classifyFailure(-1, err.message, undefined, connection.stderrTail);
      // The process died mid-call.
      this.markUnhealthy(err);
      throw new BridgeError("gemini_error", `The warm Gemini process failed: ${errorMessage(err)}`, { failure: "engine" });
    } finally {
      this.evictOldSessions();
      this.scheduleIdle();
    }
  }

  /**
   * Stops the process (idle, shutdown); the next call starts a new one. Resolves once the kill
   * has run (at most 2s), so a shutting-down server doesn't exit before it and orphan Gemini.
   */
  close(): Promise<void> {
    this.clearIdle();
    const connection = this.connection;
    this.connection = null;
    this.sessions.clear();
    if (!connection) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      connection.kill(this.killFn, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async connect(timeoutMs: number): Promise<AcpConnection> {
    if (this.connection && !this.connection.closed) return this.connection;
    if (!this.isHealthy()) throw new Error(this.lastError ?? "it failed recently");
    this.starting ??= this.start(timeoutMs).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(timeoutMs: number): Promise<AcpConnection> {
    const cwd = await this.deps.cwd();
    const args = ["--acp", "--skip-trust", "--approval-mode=default"];
    const project = this.deps.projectDir?.();
    if (project) args.push(`--include-directories=${project}`);
    const child = this.spawnFn(this.deps.command ?? geminiCommand(this.deps.env), args, {
      cwd,
      env: geminiEnv(this.deps.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const connection = new AcpConnection(child, (closed) => {
      if (this.connection === closed) {
        this.connection = null;
        this.sessions.clear();
      }
    });
    const initialize = connection.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "gemini-claude-bridge", version: VERSION },
    });
    try {
      await withTimeout(initialize, timeoutMs, "it did not answer the ACP handshake in time");
    } catch (err) {
      connection.kill(this.killFn);
      throw err;
    }
    this.connection = connection;
    return connection;
  }

  private async newSession(connection: AcpConnection): Promise<string> {
    const result = await connection.request("session/new", { cwd: await this.deps.cwd(), mcpServers: [] });
    if (typeof result.sessionId !== "string") throw new Error("session/new returned no sessionId");
    return result.sessionId;
  }

  private prompt(connection: AcpConnection, sessionId: string, prompt: string, deadline: number, req: AcpRunRequest): Promise<Json> {
    return new Promise<Json>((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      let settled = false;
      let done = false;
      let recentStderr = "";
      let failing = false;
      let noticed = false;

      const finish = (error: Error | null, value?: Json) => {
        if (done) return;
        done = true;
        for (const timer of timers) clearTimeout(timer);
        unwatch();
        req.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value!);
      };
      const stop = (error: BridgeError) => {
        if (done) return;
        connection.notify("session/cancel", { sessionId });
        this.sessions.delete(sessionId);
        // A well-behaved agent ends the turn; one that doesn't loses its process.
        setTimeout(() => {
          if (!settled && this.connection === connection) void this.close();
        }, CANCEL_GRACE_MS).unref();
        finish(error);
      };

      // Same rules as a one-off process: abandon a failing model if another can take over,
      // otherwise say that the CLI is waiting out a rate limit.
      const unwatch = connection.watchStderr((chunk) => {
        recentStderr = (recentStderr + chunk).slice(-4096);
        if (req.failFast && !failing && watchForModelFailure(recentStderr)) {
          failing = true;
          timers.push(
            setTimeout(
              () => stop(classifyFailure(-1, summarizeOutput(recentStderr) || "quota error", undefined, recentStderr)),
              WATCH_GRACE_MS,
            ),
          );
        } else if (!req.failFast && !noticed && RETRY_WAIT_PATTERN.test(recentStderr)) {
          noticed = true;
          req.onNotice?.(describeWait(recentStderr));
        }
      });
      const onAbort = () => stop(new BridgeError("gemini_error", "The request was cancelled and Gemini was told to stop."));
      timers.push(
        setTimeout(
          () =>
            stop(
              new BridgeError(
                "timeout",
                `Gemini did not finish within the ${Math.round(req.timeoutMs / 1000)}s budget; the request was cancelled.`,
              ),
            ),
          Math.max(0, deadline - this.now()),
        ),
      );
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener("abort", onAbort, { once: true });
      if (done) return;

      // Sent only now, with the stderr watcher already in place, so nothing the prompt
      // triggers (a quota error printed right away) can slip past it.
      connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }).then(
        (value) => {
          settled = true;
          finish(null, value);
        },
        (err: unknown) => {
          settled = true;
          finish(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private markUnhealthy(err: unknown): void {
    this.unhealthyUntil = this.now() + UNHEALTHY_MS;
    this.lastError = errorMessage(err);
    void this.close();
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.sessions.size - MAX_SESSIONS);
    for (const [sessionId] of oldest) {
      this.sessions.delete(sessionId);
      this.connection?.request("session/close", { sessionId }).catch(() => undefined);
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function modelUsed(result: Json): string | null {
  const usage = (result._meta as { quota?: { model_usage?: Array<{ model?: unknown }> } } | undefined)?.quota?.model_usage;
  const model = usage?.[usage.length - 1]?.model;
  return typeof model === "string" ? model : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^at\s/.test(line))
      .pop() ?? ""
  );
}
