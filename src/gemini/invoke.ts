import type { ChildProcess, SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";
import treeKill from "tree-kill";
import { BridgeError, errorMessage, isErrnoException } from "../util/errors.js";
import { getEnv, withAugmentedPath } from "../util/paths.js";
import { isModelUnavailable, isTransient, parseQuota } from "./models.js";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type KillFn = (pid: number, signal: string, callback?: (error?: Error) => void) => void;

/** Points the bridge at a specific Gemini executable (tests, unusual installs). */
export const GEMINI_BIN_ENV = "GEMINI_CLAUDE_BRIDGE_GEMINI_BIN";

export function geminiCommand(env: NodeJS.ProcessEnv = process.env): string {
  return getEnv(env, GEMINI_BIN_ENV)?.trim() || "gemini";
}

/**
 * Environment for every Gemini process: standard install folders appended to PATH (Claude Code
 * may predate them), and no self-relaunch — otherwise the CLI starts Node twice per call.
 * Measured: 6.9s → 5.4s warm, 19.6s → 11.7s cold.
 */
export function geminiEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...withAugmentedPath(base), GEMINI_CLI_NO_RELAUNCH: "true" };
}

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** After a kill, stop waiting for 'close' if a grandchild keeps the pipes open. */
const KILL_GRACE_MS = 5_000;
/** Once the watcher spots a fatal error, keep reading briefly: its details ("limit: 0") follow. */
const WATCH_GRACE_MS = 600;

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  spawn?: SpawnFn;
  kill?: KillFn;
  killGraceMs?: number;
  /** Sees the recent stderr; returning a reason stops the process early. */
  watch?: (recentStderr: string) => string | null;
  watchGraceMs?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Why the watcher stopped the process, if it did. */
  stoppedBy: string | null;
  durationMs: number;
}

/**
 * Spawns a process with cross-spawn (correct .cmd resolution on Windows, no shell: true),
 * writes `input` to stdin, captures output, and enforces a hard timeout by killing the whole
 * process tree — Windows has no POSIX process groups, and gemini.cmd → node would otherwise
 * survive a plain kill.
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
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killRequested = false;
    let stoppedBy: string | null = null;
    let recentStderr = "";
    let graceTimer: NodeJS.Timeout | undefined;
    let watchTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!opts.watch || stoppedBy !== null || killRequested) return;
      recentStderr = (recentStderr + chunk.toString("utf8")).slice(-4096);
      const reason = opts.watch(recentStderr);
      if (reason) {
        stoppedBy = reason;
        watchTimer = setTimeout(terminate, opts.watchGraceMs ?? WATCH_GRACE_MS);
      }
    });

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (watchTimer) clearTimeout(watchTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      cleanup();
      resolve({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        stoppedBy,
        durationMs: Date.now() - started,
      });
    };
    function terminate() {
      if (killRequested || settled) return;
      killRequested = true;
      graceTimer = setTimeout(() => finish(null, "SIGKILL"), opts.killGraceMs ?? KILL_GRACE_MS);
      if (child.pid !== undefined) kill(child.pid, "SIGKILL", () => undefined);
    }
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
  /** Continue this Gemini session (a follow-up) instead of starting a new one. */
  resumeSessionId?: string;
  /** Stop as soon as stderr shows a quota or unknown-model error, so another model can be tried. */
  failFast?: boolean;
  /** Told when the CLI starts waiting out a rate limit, so the wait isn't silent. */
  onNotice?: (message: string) => void;
}

export interface GeminiResponse {
  text: string;
  model: string | null;
  durationMs: number;
  exitCode: number;
  warnings: string[];
  /** Gemini's session id: pass it back as a follow-up to continue the conversation. */
  sessionId: string | null;
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
export function buildGeminiArgs(
  req: Pick<GeminiRequest, "model" | "yolo" | "includeDirectories" | "resumeSessionId">,
): string[] {
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
  if (req.resumeSessionId) args.push(`--resume=${req.resumeSessionId}`);
  for (const dir of req.includeDirectories ?? []) args.push(`--include-directories=${dir}`);
  return args;
}

/** Errors worth abandoning a model for immediately instead of waiting out the CLI's own retries. */
const FAIL_FAST_PATTERN =
  /(TerminalQuotaError|RetryableQuotaError|RESOURCE_EXHAUSTED|exceeded your current quota|exhausted your daily quota|ModelNotFoundError|is not found for API version)/i;

export function watchForModelFailure(recentStderr: string): string | null {
  return FAIL_FAST_PATTERN.exec(recentStderr)?.[0] ?? null;
}

/**
 * The CLI announces when it waits out a per-minute limit ("Please retry in 54.8s … Retrying
 * after 64395ms"). Measured on a free key: a second big question within a minute waited 64s.
 */
export const RETRY_WAIT_PATTERN = /(Retrying after \d+\s*ms|retry in\s+[\d.]+\s*s)/i;

export function describeWait(recentStderr: string): string {
  const retryMs = /Retrying after (\d+)\s*ms/i.exec(recentStderr);
  const retryS = /retry in\s+([\d.]+)\s*s/i.exec(recentStderr);
  const seconds = retryMs ? Math.round(Number(retryMs[1]) / 1000) : retryS ? Math.round(Number(retryS[1])) : null;
  return `Gemini hit its per-minute quota; the Gemini CLI waits${seconds ? ` ~${seconds}s` : ""} and retries by itself…`;
}

export async function invokeGemini(req: GeminiRequest, deps: InvokeDeps = {}): Promise<GeminiResponse> {
  const command = deps.command ?? geminiCommand(deps.env);
  let noticed = false;
  // Cut a failing model short when another one can take over; otherwise just say it's waiting.
  const watch = (recentStderr: string): string | null => {
    const failure = watchForModelFailure(recentStderr);
    if (failure && req.failFast) return failure;
    if (!noticed && RETRY_WAIT_PATTERN.test(recentStderr)) {
      noticed = true;
      req.onNotice?.(describeWait(recentStderr));
    }
    return null;
  };
  let result: RunResult;
  try {
    result = await runProcess(command, buildGeminiArgs(req), {
      cwd: req.cwd,
      input: req.prompt,
      timeoutMs: req.timeoutMs,
      env: geminiEnv(deps.env ?? process.env),
      signal: req.signal,
      spawn: deps.spawn,
      kill: deps.kill,
      watch,
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
  session_id?: unknown;
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
/** Google refusing the account's plan, e.g. IneligibleTierError telling users to move to Antigravity. */
const INELIGIBLE_PATTERN =
  /(ineligibletier|unsupported_client|no longer supported for gemini code assist|antigravity)/i;

/** Terminal chatter the CLI prints around real errors. */
const NOISE_PATTERNS = [
  /^\s+at\s/, // stack frames
  /^Warning: True color/i,
  /^Ripgrep is not available/i,
  /^Loaded cached credentials/i,
];

export function interpretResult(r: RunResult, timeoutMs: number): GeminiResponse {
  const json = parseGeminiJson(r.stdout) ?? parseGeminiJson(r.stderr);
  const exitCode = r.code ?? -1;
  const warnings = Array.isArray(json?.warnings) ? json.warnings.filter((w): w is string => typeof w === "string") : [];
  const sessionId = typeof json?.session_id === "string" ? json.session_id : null;

  // A complete answer wins over the exit code. On Windows the CLI can crash while shutting down
  // after printing it (a libuv assertion in src\win\async.c, exit 127) — which would otherwise
  // read as "not installed" and throw a good answer away.
  if (typeof json?.response === "string" && json.response.trim() && !json.error) {
    return { text: json.response.trim(), model: primaryModel(json.stats), durationMs: r.durationMs, exitCode, warnings, sessionId };
  }

  // Stopped on purpose by the watcher: classify from everything read so far.
  if (r.stoppedBy) {
    const message = json?.error?.message?.trim() || summarizeOutput(r.stderr) || r.stoppedBy;
    throw classifyFailure(r.code ?? -1, message, json?.error?.type, r.stderr);
  }
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

  if (exitCode === 0 && !json?.error) {
    // No JSON document at all: take plain stdout, if there is any.
    const text = (json ? "" : r.stdout).trim();
    if (!text) throw new BridgeError("gemini_error", "Gemini returned an empty response.", { exitCode });
    return { text, model: null, durationMs: r.durationMs, exitCode, warnings, sessionId };
  }

  const message =
    json?.error?.message?.trim() || summarizeOutput(r.stderr) || summarizeOutput(r.stdout) || "no error output";
  throw classifyFailure(exitCode, message, json?.error?.type, r.stderr);
}

/**
 * Maps a failure to an error type plus `details.failure` ("quota" | "unavailable" | "transient"),
 * which tells the runner whether to cool the model down, try the next one, or retry.
 * `raw` is the full CLI output: quota details ("limit: 0", "daily") often sit outside the headline.
 */
export function classifyFailure(exitCode: number, message: string, geminiErrorType?: string, raw = ""): BridgeError {
  const details = { exitCode, ...(geminiErrorType ? { geminiErrorType } : {}) };
  const haystack = `${message}\n${raw}`;
  if (EXIT_NOT_FOUND.has(exitCode)) {
    return new BridgeError("not_installed", `The Gemini CLI could not be started: ${message}`, details);
  }
  // Google refusing the account's tier looks like a crash, but the fix is an auth change.
  if (INELIGIBLE_PATTERN.test(haystack)) {
    return new BridgeError("not_authenticated", `Google rejected this Gemini CLI for that account: ${message}`, {
      ...details,
      nextStep:
        "Google refused this Gemini CLI for the signed-in account's tier. Tell the user to switch the Gemini CLI to another auth method: create an API key at https://aistudio.google.com/apikey, put GEMINI_API_KEY=<key> in ~/.gemini/.env, and select \"Gemini API key\" via /auth inside `gemini`. Meanwhile, do the task yourself.",
    });
  }
  const quota = parseQuota(haystack);
  if (quota) {
    return new BridgeError("quota", `Gemini quota or rate limit reached: ${message}`, { ...details, failure: "quota", quota });
  }
  if (isModelUnavailable(haystack)) {
    return new BridgeError("gemini_error", `This Gemini model is not available: ${message}`, {
      ...details,
      failure: "unavailable",
    });
  }
  if (exitCode === EXIT_AUTH || AUTH_PATTERN.test(message)) {
    return new BridgeError("not_authenticated", `The Gemini CLI is not signed in: ${message}`, details);
  }
  if (isTransient(haystack)) {
    return new BridgeError("gemini_error", `Gemini had a temporary problem: ${message}`, { ...details, failure: "transient" });
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

  // The document starts with "{" at the start of a line and ends with a lone "}". Both can be
  // surrounded by log lines, so look for a slice that actually parses.
  const lines = trimmed.split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start]?.startsWith("{")) continue;
    for (let end = lines.length - 1; end > start; end--) {
      if (lines[end]?.trim() !== "}") continue;
      const candidate = tryParseObject(lines.slice(start, end + 1).join("\n"));
      if (candidate) return candidate;
    }
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

/**
 * Condenses raw CLI output into one meaningful error line. A fatal Gemini error prints no JSON
 * at all — just prose, an object dump and two stack traces — so the useful sentence has to be
 * picked out of the noise.
 */
export function summarizeOutput(text: string, maxChars = 500): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !NOISE_PATTERNS.some((pattern) => pattern.test(line)));
  if (lines.length === 0) return "";

  const meaningful = lines.filter((line) => /(error|failed|cannot|unable|denied|quota|limit|not recognized)/i.test(line));
  const chosen = meaningful.length > 0 ? [meaningful[meaningful.length - 1]!] : lines.slice(-3);
  const summary = chosen.join("\n").trim();
  return summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary;
}
