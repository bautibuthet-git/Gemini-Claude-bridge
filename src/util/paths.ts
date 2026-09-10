import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Overrides where the bridge keeps its state (used by tests; handy for separate profiles). */
export const STATE_DIR_ENV = "GEMINI_CLAUDE_BRIDGE_HOME";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = getEnv(env, STATE_DIR_ENV)?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".gemini-claude-bridge");
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "state.json");
}

/** Empty folder owned by the bridge that Gemini runs from (see buildGeminiArgs for why). */
export function scratchWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "workspace");
}

/** The project Claude is working in; base for relative `paths`. */
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return getEnv(env, "CLAUDE_PROJECT_DIR")?.trim() || process.cwd();
}

/**
 * Case-insensitive env lookup on Windows. `process.env` itself is case-insensitive there,
 * but copies of it (and test fixtures) are plain objects.
 */
export function getEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Minimal `which`: resolves a command on PATH without spawning it (honours PATHEXT on
 * Windows). Used for fast "is it installed?" checks, e.g. from the SessionStart hook.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (p.isAbsolute(command)) return isFile(command) ? command : null;

  const dirs = (getEnv(env, "PATH", platform) ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const exts =
    platform === "win32" && !p.extname(command)
      ? (getEnv(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface ResolvedPath {
  input: string;
  absolute: string;
  isDirectory: boolean;
}

/** Makes each requested path absolute (relative to `baseDir`, `~` expanded), de-duplicates and existence-checks it. */
export async function resolveInputPaths(
  inputs: readonly string[],
  baseDir: string,
): Promise<{ resolved: ResolvedPath[]; missing: string[] }> {
  const resolved: ResolvedPath[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const absolute = path.resolve(baseDir, expandHome(input.trim()));
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const stat = await fsp.stat(absolute);
      resolved.push({ input, absolute, isDirectory: stat.isDirectory() });
    } catch {
      missing.push(input.trim() === absolute ? absolute : `${input} (resolved to ${absolute})`);
    }
  }
  return { resolved, missing };
}

/**
 * Folders Gemini must be allowed to read: each target's folder plus the project folder,
 * without entries already covered by a parent in the list.
 */
export function includeDirectoriesFor(targets: readonly ResolvedPath[], projectDir?: string): string[] {
  const candidates = targets.map((t) => (t.isDirectory ? t.absolute : path.dirname(t.absolute)));
  if (projectDir && isReasonableProjectDir(projectDir)) candidates.push(path.resolve(projectDir));

  const result: string[] = [];
  for (const dir of [...new Set(candidates)].sort((a, b) => a.length - b.length)) {
    if (!result.some((parent) => isInside(dir, parent))) result.push(dir);
  }
  return result;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);
const MAX_FILES_TO_MEASURE = 5_000;

/** Approximate size (bytes ≈ chars) of what Gemini reads instead of Claude. Folder walks are bounded. */
export async function estimateChars(targets: readonly ResolvedPath[]): Promise<number> {
  const budget = { files: MAX_FILES_TO_MEASURE };
  let total = 0;
  for (const target of targets) {
    total += target.isDirectory ? await directorySize(target.absolute, budget) : await fileSize(target.absolute);
  }
  return total;
}

async function directorySize(dir: string, budget: { files: number }): Promise<number> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (budget.files <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) total += await directorySize(full, budget);
    } else if (entry.isFile()) {
      budget.files--;
      total += await fileSize(full);
    }
  }
  return total;
}

async function fileSize(file: string): Promise<number> {
  return fsp.stat(file).then(
    (s) => s.size,
    () => 0,
  );
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Excludes folders too broad to hand to Gemini wholesale (filesystem roots, the home folder). */
function isReasonableProjectDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return false;
  if (path.relative(os.homedir(), resolved) === "") return false;
  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
