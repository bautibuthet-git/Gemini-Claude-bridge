export type BridgeErrorType =
  | "disabled"
  | "not_installed"
  | "not_authenticated"
  | "timeout"
  | "gemini_error"
  | "invalid_paths";

/** What Claude should do next for each failure — returned alongside the error text. */
export const ERROR_HINTS: Record<BridgeErrorType, string> = {
  disabled:
    "The user turned the Gemini bridge off. Do the task yourself. Only call gemini_bridge_toggle(enabled: true) if the user asks to turn it back on.",
  not_installed:
    "The Gemini CLI is not installed or not on PATH. Tell the user to run `npm install -g @google/gemini-cli`, then restart Claude Code. Meanwhile, do the task yourself.",
  not_authenticated:
    "The Gemini CLI is not logged in. Tell the user to run `gemini` once in a terminal and sign in with Google. Meanwhile, do the task yourself.",
  timeout:
    "Gemini did not answer in time. Retry with a narrower prompt, fewer paths or a larger timeoutMs, or do the task yourself.",
  gemini_error:
    "The Gemini CLI reported an error (see message). Retry once if it looks transient (e.g. a rate limit), otherwise do the task yourself.",
  invalid_paths: "Fix the listed paths (prefer absolute paths that exist) and call gemini_ask again.",
};

export class BridgeError extends Error {
  override name = "BridgeError";

  constructor(
    readonly type: BridgeErrorType,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isErrnoException(err: unknown, code?: string): err is NodeJS.ErrnoException {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return code === undefined || (err as NodeJS.ErrnoException).code === code;
}
