import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StateStore } from "../state/store.js";
import { isErrnoException } from "../util/errors.js";
import { findOnPath, getEnv, withAugmentedPath } from "../util/paths.js";
import { geminiCommand, geminiEnv, runProcess, type KillFn, type SpawnFn } from "./invoke.js";

/** How long install/sign-in checks are reused before being re-run. */
export const DETECT_TTL_MS = 10 * 60_000;

export interface InstallCheck {
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface AuthCheck {
  /** null = can't tell offline; the next real Gemini call settles it. */
  ok: boolean | null;
  method: string | null;
  detail: string;
}

export interface RipgrepStatus {
  available: boolean;
  path: string | null;
  detail: string;
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  authOk: boolean | null;
  authDetail: string | null;
  /** e.g. "oauth-personal", "gemini-api-key"; null when not installed or not yet configured. */
  authMethod: string | null;
  checkedAt: string | null;
  fromCache: boolean;
  ripgrep?: RipgrepStatus;
}

export interface DetectDeps {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  kill?: KillFn;
}

export async function detectInstall(deps: DetectDeps = {}): Promise<InstallCheck> {
  // Same PATH the bridge launches Gemini with, so a CLI installed after Claude Code started counts.
  const env = geminiEnv(deps.env ?? process.env);
  const command = deps.command ?? geminiCommand(env);
  const resolved = findOnPath(command, env);
  if (!resolved) return { installed: false, path: null, version: null };

  try {
    const r = await runProcess(command, ["--version"], { timeoutMs: 30_000, env, spawn: deps.spawn, kill: deps.kill });
    const version = r.code === 0 ? (/\d+\.\d+\.\d+[\w.+-]*/.exec(r.stdout)?.[0] ?? null) : null;
    return { installed: true, path: resolved, version };
  } catch (err) {
    return isErrnoException(err, "ENOENT")
      ? { installed: false, path: null, version: null }
      : { installed: true, path: resolved, version: null };
  }
}

/**
 * Mirrors the Gemini CLI's own lookup: its bundled binary first, else `rg` on PATH — but only
 * from a folder it trusts (Windows or Program Files; /usr/bin and the like elsewhere). Without
 * it, Gemini's searches fall back to a slower built-in grep.
 */
export function detectRipgrep(
  cliPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  /** Also look in the standard install folders, as the bridge does when it launches Gemini. */
  augment = true,
): RipgrepStatus {
  const binary = `rg-${platform}-${process.arch}${platform === "win32" ? ".exe" : ""}`;
  if (cliPath) {
    const bundle = path.join(path.dirname(cliPath), "node_modules", "@google", "gemini-cli", "bundle");
    for (const candidate of [path.join(bundle, binary), path.join(bundle, "vendor", "ripgrep", binary)]) {
      if (fs.existsSync(candidate)) return { available: true, path: candidate, detail: "bundled with the Gemini CLI" };
    }
  }
  const found = findOnPath("rg", augment ? withAugmentedPath(env, platform) : env, platform);
  if (!found) return { available: false, path: null, detail: "not installed, so Gemini's searches use a slower built-in grep" };
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {
    // keep the PATH entry
  }
  return isTrustedSystemPath(real, env, platform)
    ? { available: true, path: real, detail: "installed" }
    : { available: false, path: real, detail: "installed outside Program Files, where the Gemini CLI refuses to run it" };
}

function isTrustedSystemPath(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const normalize = (p: string) => path.win32.resolve(p).replace(/\\/g, "/").toLowerCase();
    const target = normalize(file);
    return [
      getEnv(env, "SystemRoot", platform) ?? "C:\\Windows",
      getEnv(env, "ProgramFiles", platform) ?? "C:\\Program Files",
      getEnv(env, "ProgramFiles(x86)", platform) ?? "C:\\Program Files (x86)",
    ]
      .map(normalize)
      .some((prefix) => target === prefix || target.startsWith(`${prefix}/`));
  }
  return ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/Cellar", "/usr/local/Cellar", "/usr/sbin", "/sbin"].some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

/** The Gemini CLI's config folder. The CLI treats GEMINI_CLI_HOME as a replacement home folder. */
export function geminiConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getEnv(env, "GEMINI_CLI_HOME")?.trim() || os.homedir(), ".gemini");
}

/**
 * Cheap, offline sign-in check that mirrors the CLI's own headless auth validation. Google
 * sign-in tokens may live in the OS keychain instead of a file, so "unknown" is a legitimate
 * answer here.
 */
export function detectAuth(env: NodeJS.ProcessEnv = process.env): AuthCheck {
  const dir = geminiConfigDir(env);
  const method = selectedAuthType(readJsonc(path.join(dir, "settings.json"))) ?? authTypeFromEnv(env);

  if (!method) {
    return {
      ok: false,
      method: null,
      detail:
        'No Gemini sign-in configured yet. Create a free API key at https://aistudio.google.com/apikey, put GEMINI_API_KEY=<key> in ~/.gemini/.env, then choose "Gemini API key" via /auth inside `gemini` (Gemini CLI\'s terms do not allow third-party tools like this bridge to use "Sign in with Google").',
    };
  }
  if (method === "oauth-personal") {
    // Gemini CLI's own terms name third-party tools using this sign-in as a violation that can
    // get the account suspended (see docs/resources/tos-privacy.md and the FAQ, which names
    // Claude Code specifically). "ok: true" here is about whether calls will work, not whether
    // they're allowed; setupItems() turns this into a setup item regardless of ok.
    return fs.existsSync(path.join(dir, "oauth_creds.json"))
      ? {
          ok: true,
          method,
          detail:
            "Signed in with Google (cached credentials found) — but Gemini CLI's terms don't allow third-party tools like this bridge to use this sign-in. Switch to a Gemini API key (see Setup).",
        }
      : {
          ok: null,
          method,
          detail:
            "Google sign-in is selected, but Gemini CLI's terms don't allow third-party tools like this bridge to use it. Switch to a Gemini API key (see Setup).",
        };
  }
  if (method === "gemini-api-key") {
    if (getEnv(env, "GEMINI_API_KEY")) return { ok: true, method, detail: "Using the GEMINI_API_KEY environment variable." };
    // The CLI also reads ~/.gemini/.env and ~/.env. Only the key's presence is checked, never its value.
    const envFile = [path.join(dir, ".env"), path.join(path.dirname(dir), ".env")].find((file) => hasDotEnvKey(file, "GEMINI_API_KEY"));
    return envFile
      ? { ok: true, method, detail: `Using the API key in ${envFile}.` }
      : {
          ok: null,
          method,
          detail:
            "API-key sign-in is selected, but no GEMINI_API_KEY was found in the environment or ~/.gemini/.env. If calls fail, put GEMINI_API_KEY=<key> in ~/.gemini/.env (keys: https://aistudio.google.com/apikey).",
        };
  }
  return { ok: null, method, detail: `Auth method "${method}" is configured. The next Gemini call will confirm it works.` };
}

export interface RefreshOptions {
  force?: boolean;
  ttlMs?: number;
  now?: () => Date;
  detectInstall?: () => Promise<InstallCheck>;
  detectAuth?: () => AuthCheck;
  findPath?: () => string | null;
  detectRipgrep?: (cliPath: string | null) => RipgrepStatus;
}

/** Install + sign-in status, re-checked when the cached result is older than the TTL or `force` is set. */
export async function refreshCliStatus(store: StateStore, opts: RefreshOptions = {}): Promise<CliStatus> {
  const now = opts.now?.() ?? new Date();
  const cached = (await store.read()).geminiCli;
  const lastCheck = cached.lastInstalledCheckAt ? Date.parse(cached.lastInstalledCheckAt) : Number.NaN;

  const ripgrepFor = opts.detectRipgrep ?? ((cliPath: string | null) => detectRipgrep(cliPath));

  if (!opts.force && Number.isFinite(lastCheck) && now.getTime() - lastCheck < (opts.ttlMs ?? DETECT_TTL_MS)) {
    const installed = cached.lastDetectedVersion !== null;
    const cliPath = installed ? (opts.findPath ?? (() => findOnPath(geminiCommand(), geminiEnv())))() : null;
    // Cheap, local and always fresh (unlike the version check above): whether the configured
    // sign-in method is one Gemini CLI's terms allow this bridge to use never goes stale.
    const authMethod = installed ? (opts.detectAuth ?? (() => detectAuth()))().method : null;
    return {
      installed,
      path: cliPath,
      version: cached.lastDetectedVersion,
      authOk: installed ? cached.lastAuthOk : null,
      authDetail: installed ? cached.lastAuthDetail : null,
      authMethod,
      checkedAt: cached.lastInstalledCheckAt,
      fromCache: true,
      ...(installed ? { ripgrep: ripgrepFor(cliPath) } : {}),
    };
  }

  const install = await (opts.detectInstall ?? (() => detectInstall()))();
  const auth = install.installed ? (opts.detectAuth ?? (() => detectAuth()))() : null;
  const stamp = now.toISOString();
  const next = await store.update((s) => {
    s.geminiCli.lastDetectedVersion = install.installed ? (install.version ?? "unknown") : null;
    s.geminiCli.lastInstalledCheckAt = stamp;
    if (auth) {
      s.geminiCli.lastAuthCheckAt = stamp;
      // An inconclusive offline check must not erase what a real Gemini call already proved.
      if (auth.ok !== null || s.geminiCli.lastAuthOk === null) {
        s.geminiCli.lastAuthOk = auth.ok;
        s.geminiCli.lastAuthDetail = auth.detail;
      }
    }
  });

  return {
    installed: install.installed,
    path: install.path,
    version: next.geminiCli.lastDetectedVersion,
    authOk: install.installed ? next.geminiCli.lastAuthOk : null,
    authDetail: install.installed ? next.geminiCli.lastAuthDetail : null,
    authMethod: install.installed ? (auth?.method ?? null) : null,
    checkedAt: stamp,
    fromCache: false,
    ...(install.installed ? { ripgrep: ripgrepFor(install.path) } : {}),
  };
}

function selectedAuthType(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const s = settings as { security?: { auth?: { selectedType?: unknown } }; selectedAuthType?: unknown };
  const value = s.security?.auth?.selectedType ?? s.selectedAuthType;
  return typeof value === "string" && value ? value : null;
}

/** Same precedence as the CLI's getAuthTypeFromEnv(). */
function authTypeFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (getEnv(env, "GOOGLE_GENAI_USE_GCA") === "true") return "oauth-personal";
  if (getEnv(env, "GOOGLE_GENAI_USE_VERTEXAI") === "true") return "vertex-ai";
  if (getEnv(env, "GOOGLE_GEMINI_BASE_URL")) return "gateway";
  if (getEnv(env, "GEMINI_API_KEY")) return "gemini-api-key";
  if (getEnv(env, "CLOUD_SHELL") === "true" || getEnv(env, "GEMINI_CLI_USE_COMPUTE_ADC") === "true") {
    return "compute-default-credentials";
  }
  return null;
}

/** Whether a .env file sets `key` to something that isn't empty or an obvious placeholder. */
function hasDotEnvKey(file: string, key: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
  const value = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  return value.length > 0 && !/^(PEGA_TU_KEY_ACA|your[-_ ]?(api[-_ ]?)?key.*|<.*>|x+)$/i.test(value);
}

function readJsonc(file: string): unknown {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(stripJsonComments(withoutBom));
  } catch {
    return null;
  }
}

/** Removes // and /* *\/ comments outside strings (the Gemini CLI accepts commented settings). */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}
