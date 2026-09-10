import type { ChildProcess, SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";
import treeKill from "tree-kill";
import { BridgeError, errorMessage, isErrnoException } from "../util/errors.js";
import { getEnv } from "../util/paths.js";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number, signal: string, callback?: (error?: Error) => void) => void;

/** Points the bridge at a specific Gemini executable (tests, unusual installs). */
export const GEMINI_BIN_ENV = "GEMINI_CLAUDE_BRIDGE_GEMINI_BIN";

export function geminiCommand(env: NodeJS.ProcessEnv = process.env): string {
  return getEnv(env, GEMINI_BIN_ENV)?.trim() || "gemini";
}

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** After a kill, stop waiting for 'close' if a grandchild keeps the pipes open. */
const KILL_GRACE_MS = 5_000;

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  spawn?: SpawnFn;
  kill?: KillFn;
  killGraceMs?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * Spawns a process with cross-spawn (correct .cmd resolution on Windows, no shell: true),
 * writes `input` to stdin, captures output, and enforces a hard timeout by killing the whole
 * process tree — Windows has no POSIX process groups, and gemini.cmd → node → relaunched node
 * would otherwise survive a plain kill.
 */
export function runProcess(command: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const spawn = opts.spawn ?? (crossSpawn as unknown as SpawnFn);
  const kill = opts.kill ?? (treeKill as KillFn);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdout = new Capture();
    const stderr = new Capture();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killRequested = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      cleanup();
      resolve({ code, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted, durationMs: Date.now() - started });
    };
    const terminate = () => {
      if (killRequested) return;
      killRequested = true;
      graceTimer = setTimeout(() => finish(null, "SIGKILL"), opts.killGraceMs ?? KILL_GRACE_MS);
      if (child.pid !== undefined) kill(child.pid, "SIGKILL", () => undefined);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => finish(code, signal));

    // EPIPE here just means the child exited before reading all of stdin; 'close' reports the outcome.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.input ?? "", "utf8");
  });
}

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    if (this.size >= MAX_CAPTURE_BYTES) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export interface GeminiRequest {
  prompt: string;
  model?: string;
  yolo?: boolean;
  timeoutMs: number;
  /** Folder Gemini runs from. The bridge uses its own empty scratch folder. */
  cwd: string;
  includeDirectories?: readonly string[];
  signal?: AbortSignal;
}

export interface GeminiResponse {
  text: string;
  model: string | null;
  durationMs: number;
  exitCode: number;
  warnings: string[];
}

export interface InvokeDeps {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  kill?: KillFn;
}

/**
 * CLI arguments for one headless Gemini run. The prompt itself goes over stdin, not `-p`:
 * on Windows `gemini` is a .cmd shim run through cmd.exe, which cuts arguments at the first
 * newline and caps the command line at ~8 KB. Piped stdin alone puts the CLI in headless mode.
 */
export function buildGeminiArgs(req: Pick<GeminiRequest, "model" | "yolo" | "includeDirectories">): string[] {
  const args = [
    "--output-format",
    "json",
    // Safe because Gemini runs from the bridge's own empty scratch folder, so no project's
    // .gemini/settings.json (MCP servers, hooks) is ever loaded. Headless runs in an untrusted
    // folder otherwise exit with code 55.
    "--skip-trust",
    // Explicit, so a user-level default like auto_edit can't let Gemini edit files. In headless
    // mode "default" denies every tool that would need approval.
    `--approval-mode=${req.yolo ? "yolo" : "default"}`,
  ];
  // `--flag=value` keeps a value that starts with "-" from being parsed as another flag.
  if (req.model) args.push(`--model=${req.model}`);
  for (const dir of req.includeDirectories ?? []) args.push(`--include-directories=${dir}`);
  return args;
}

export async function invokeGemini(req: GeminiRequest, deps: InvokeDeps = {}): Promise<GeminiResponse> {
  const command = deps.command ?? geminiCommand(deps.env);
  let result: RunResult;
  try {
    result = await runProcess(command, buildGeminiArgs(req), {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      env: deps.env,
      signal: req.signal,
      spawn: deps.spawn,
      kill: deps.kill,
    });
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      throw new BridgeError("not_installed", `The Gemini CLI ("${command}") was not found on PATH.`);
    }
    throw new BridgeError("gemini_error", `Could not start the Gemini CLI: ${errorMessage(err)}`);
  }
  return interpretResult(result, req.timeoutMs);
}

interface GeminiJson {
  response?: unknown;
  stats?: { models?: Record<string, { tokens?: { candidates?: number; total?: number } }> };
  error?: { type?: string; message?: string; code?: number | string };
  warnings?: unknown;
}

/** Exit codes from the Gemini CLI's FatalError classes. */
const EXIT_AUTH = 41;
const EXIT_INPUT = 42;
const EXIT_TURN_LIMIT = 53;
const EXIT_UNTRUSTED = 55;
/** "Command not found" when the shell ran but the command didn't resolve (cmd.exe / POSIX sh). */
const EXIT_NOT_FOUND = new Set([9009, 127]);

const AUTH_PATTERN =
  /(authenticat|auth method|not logged in|\blog ?in\b|\bsign ?in\b|credential|oauth|api key|unauthenticated|invalid_grant|\b401\b)/i;
const QUOTA_PATTERN = /(quota|rate.?limit|resource_exhausted|\b429\b|too many requests)/i;

export function interpretResult(r: RunResult, timeoutMs: number): GeminiResponse {
  if (r.timedOut) {
    throw new BridgeError(
      "timeout",
      `Gemini did not finish within ${Math.round(timeoutMs / 1000)}s; its whole process tree was stopped.`,
      { timeoutMs, durationMs: r.durationMs },
    );
  }
  if (r.aborted) {
    throw new BridgeError("gemini_error", "The request was cancelled and the Gemini process was stopped.", {
      durationMs: r.durationMs,
    });
  }

  const exitCode = r.code ?? -1;
  const json = parseGeminiJson(r.stdout) ?? parseGeminiJson(r.stderr);

  if (exitCode === 0 && !json?.error) {
    const text = (typeof json?.response === "string" ? json.response : json ? "" : r.stdout).trim();
    if (!text) throw new BridgeError("gemini_error", "Gemini returned an empty response.", { exitCode });
    const warnings = Array.isArray(json?.warnings) ? json.warnings.filter((w): w is string => typeof w === "string") : [];
    return { text, model: primaryModel(json?.stats), durationMs: r.durationMs, exitCode, warnings };
  }

  const message = json?.error?.message?.trim() || tail(r.stderr) || tail(r.stdout) || "no error output";
  throw classifyFailure(exitCode, message, json?.error?.type);
}

export function classifyFailure(exitCode: number, message: string, geminiErrorType?: string): BridgeError {
  const details = { exitCode, ...(geminiErrorType ? { geminiErrorType } : {}) };
  if (EXIT_NOT_FOUND.has(exitCode)) {
    return new BridgeError("not_installed", `The Gemini CLI could not be started: ${message}`, details);
  }
  if (exitCode === EXIT_AUTH || AUTH_PATTERN.test(message)) {
    return new BridgeError("not_authenticated", `The Gemini CLI is not signed in: ${message}`, details);
  }
  if (QUOTA_PATTERN.test(message)) {
    return new BridgeError("gemini_error", `Gemini quota or rate limit reached: ${message}`, details);
  }
  const label =
    exitCode === EXIT_INPUT
      ? "rejected the input"
      : exitCode === EXIT_TURN_LIMIT
        ? "hit its turn limit"
        : exitCode === EXIT_UNTRUSTED
          ? "refused to run in an untrusted folder"
          : "failed";
  return new BridgeError("gemini_error", `The Gemini CLI ${label} (exit ${exitCode}): ${message}`, details);
}

/**
 * Parses the CLI's `--output-format json` document. Tolerates log lines printed before it: the
 * document is pretty-printed, so its top-level "{" is the only one at the start of a line.
 */
export function parseGeminiJson(text: string): GeminiJson | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = tryParseObject(trimmed);
  if (parsed) return parsed;

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]?.startsWith("{")) continue;
    const candidate = tryParseObject(lines.slice(i).join("\n"));
    if (candidate) return candidate;
  }
  return null;
}

function tryParseObject(text: string): GeminiJson | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as GeminiJson) : null;
  } catch {
    return null;
  }
}

/** The model that produced the most output (routing may also call a small model). */
function primaryModel(stats: GeminiJson["stats"]): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [name, info] of Object.entries(stats?.models ?? {})) {
    const tokens = info?.tokens?.candidates ?? info?.tokens?.total ?? 0;
    if (tokens > bestTokens) {
      best = name;
      bestTokens = tokens;
    }
  }
  return best;
}

function tail(text: string, maxLines = 6): string {
  return text.trim().split(/\r?\n/).slice(-maxLines).join("\n").trim();
}
