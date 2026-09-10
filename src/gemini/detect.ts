import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StateStore } from "../state/store.js";
import { isErrnoException } from "../util/errors.js";
import { findOnPath, getEnv } from "../util/paths.js";
import { geminiCommand, runProcess, type KillFn, type SpawnFn } from "./invoke.js";

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

export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  authOk: boolean | null;
  authDetail: string | null;
  checkedAt: string | null;
  fromCache: boolean;
}

export interface DetectDeps {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  kill?: KillFn;
}

export async function detectInstall(deps: DetectDeps = {}): Promise<InstallCheck> {
  const env = deps.env ?? process.env;
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
      detail: 'No Gemini sign-in configured yet. Run `gemini` once in a terminal and choose "Sign in with Google" (or set GEMINI_API_KEY).',
    };
  }
  if (method === "oauth-personal") {
    return fs.existsSync(path.join(dir, "oauth_creds.json"))
      ? { ok: true, method, detail: "Signed in with Google (cached credentials found)." }
      : {
          ok: null,
          method,
          detail: "Google sign-in is selected; its credentials may be in the OS keychain. The next Gemini call will confirm.",
        };
  }
  if (method === "gemini-api-key") {
    return getEnv(env, "GEMINI_API_KEY")
      ? { ok: true, method, detail: "Using the GEMINI_API_KEY environment variable." }
      : { ok: null, method, detail: "API-key sign-in is selected; the key may come from a .env file. The next Gemini call will confirm." };
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
}

/** Install + sign-in status, re-checked when the cached result is older than the TTL or `force` is set. */
export async function refreshCliStatus(store: StateStore, opts: RefreshOptions = {}): Promise<CliStatus> {
  const now = opts.now?.() ?? new Date();
  const cached = (await store.read()).geminiCli;
  const lastCheck = cached.lastInstalledCheckAt ? Date.parse(cached.lastInstalledCheckAt) : Number.NaN;

  if (!opts.force && Number.isFinite(lastCheck) && now.getTime() - lastCheck < (opts.ttlMs ?? DETECT_TTL_MS)) {
    const installed = cached.lastDetectedVersion !== null;
    return {
      installed,
      path: installed ? (opts.findPath ?? (() => findOnPath(geminiCommand())))() : null,
      version: cached.lastDetectedVersion,
      authOk: installed ? cached.lastAuthOk : null,
      authDetail: installed ? cached.lastAuthDetail : null,
      checkedAt: cached.lastInstalledCheckAt,
      fromCache: true,
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
    checkedAt: stamp,
    fromCache: false,
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
