import fs from "node:fs/promises";
import path from "node:path";
import { countLines, stateDir } from "../util/paths.js";

// PreToolUse hook for Claude's Read tool. It runs before every Read in every project, so it
// stays tiny (no zod, no MCP SDK): read the bridge settings, stat the file, count its lines.

export interface ReadHookInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_input?: { file_path?: unknown; path?: unknown; offset?: unknown; limit?: unknown };
}

export interface HookSettings {
  enabled: boolean;
  suggest: boolean;
  minLines: number;
  /** Only nudge toward Gemini once a real call has proven it works. */
  geminiUsable: boolean;
}

/** Below this size a file can't plausibly reach minLines; skips the line count. */
const MIN_BYTES_TO_CHECK = 16 * 1024;
const SUGGESTION_TTL_MS = 24 * 60 * 60_000;

/** Tolerant read of the bridge state: any problem means "don't suggest". */
export async function loadHookSettings(dir: string = stateDir()): Promise<HookSettings> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
      enabled?: unknown;
      preferences?: { suggestDelegation?: { enabled?: unknown; minLines?: unknown } };
      geminiCli?: { lastAuthOk?: unknown; lastDetectedVersion?: unknown; lastInstalledCheckAt?: unknown };
    };
    const suggest = state.preferences?.suggestDelegation;
    const cli = state.geminiCli;
    return {
      enabled: state.enabled !== false,
      suggest: suggest?.enabled !== false,
      minLines: typeof suggest?.minLines === "number" ? suggest.minLines : 800,
      geminiUsable: cli?.lastAuthOk === true && !(cli.lastInstalledCheckAt && cli.lastDetectedVersion === null),
    };
  } catch {
    return { enabled: false, suggest: false, minLines: 800, geminiUsable: false };
  }
}

/** Remembers which files were already suggested in each session, so every nudge happens once. */
export class SuggestionLog {
  constructor(readonly file: string = path.join(stateDir(), "read-suggestions.json")) {}

  async firstTime(sessionId: string, filePath: string, now: Date): Promise<boolean> {
    let log: Record<string, { at: string; paths: string[] }> = {};
    try {
      log = JSON.parse(await fs.readFile(this.file, "utf8")) as typeof log;
    } catch {
      // first use, or a torn write: start over
    }
    for (const [id, entry] of Object.entries(log)) {
      if (now.getTime() - Date.parse(entry.at) > SUGGESTION_TTL_MS) delete log[id];
    }
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    const entry = (log[sessionId] ??= { at: now.toISOString(), paths: [] });
    if (entry.paths.includes(key)) return false;
    entry.paths.push(key);
    entry.at = now.toISOString();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(log), "utf8");
    await fs.rename(tmp, this.file);
    return true;
  }
}

/**
 * Returns the reason to show Claude when it is about to read a big file whole, or null to let
 * the Read through. The nudge is a deny, because a suggestion after the Read would come too
 * late — the tokens would already be spent — but repeating the same Read goes through.
 */
export async function decideRead(
  input: ReadHookInput,
  settings: HookSettings,
  log: SuggestionLog,
  now: Date,
): Promise<string | null> {
  if (!settings.enabled || !settings.suggest || !settings.geminiUsable) return null;
  const toolInput = input.tool_input ?? {};
  // A targeted read of a range is exactly what we'd want Claude to do anyway.
  if (toolInput.offset !== undefined || toolInput.limit !== undefined) return null;
  const raw = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.path === "string" ? toolInput.path : null;
  if (!raw) return null;

  const file = path.resolve(typeof input.cwd === "string" ? input.cwd : process.cwd(), raw);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < MIN_BYTES_TO_CHECK) return null;
  const lines = await countLines(file); // null for binaries and very large files
  if (lines === null || lines < settings.minLines) return null;

  const sessionId = typeof input.session_id === "string" ? input.session_id : "unknown-session";
  if (!(await log.firstTime(sessionId, file, now))) return null;

  const tokens = Math.round(stat.size / 4);
  return (
    `gemini-claude-bridge: ${path.basename(file)} has ${lines.toLocaleString("en-US")} lines (~${tokens.toLocaleString("en-US")} tokens). ` +
    `To keep it out of your context, delegate it with gemini_ask (paths: [${JSON.stringify(file)}]) — for example to summarize it, find errors, or answer a specific question about it. ` +
    "If you really need the raw text, run this same Read again (it will be allowed) or read just a range with offset/limit. (Shown once per file per session.)"
  );
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}
