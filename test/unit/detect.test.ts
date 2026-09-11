import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectAuth,
  detectInstall,
  detectRipgrep,
  refreshCliStatus,
  stripJsonComments,
  type AuthCheck,
  type InstallCheck,
  type RipgrepStatus,
} from "../../src/gemini/detect.js";
import { StateStore } from "../../src/state/store.js";
import { fakeGeminiOnPath, fakeSpawn, tempDir } from "../helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("gcb-detect-");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function geminiHome(settings?: string, withCreds = false): Promise<NodeJS.ProcessEnv> {
  const config = path.join(dir, ".gemini");
  await fs.mkdir(config, { recursive: true });
  if (settings !== undefined) await fs.writeFile(path.join(config, "settings.json"), settings);
  if (withCreds) await fs.writeFile(path.join(config, "oauth_creds.json"), "{}");
  return { GEMINI_CLI_HOME: dir };
}

describe("detectAuth", () => {
  it("is a definite no when nothing is configured", async () => {
    expect(detectAuth(await geminiHome())).toMatchObject({ ok: false, method: null });
  });

  it("accepts commented settings and finds cached Google credentials", async () => {
    const settings = `{
      // written by the CLI
      "security": { "auth": { "selectedType": "oauth-personal" } }, /* trailing */
      "docs": "https://example.com/not-a-comment"
    }`;
    expect(detectAuth(await geminiHome(settings, true))).toMatchObject({ ok: true, method: "oauth-personal" });
  });

  it("is inconclusive for Google sign-in without a credentials file (keychain storage)", async () => {
    const env = await geminiHome(JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    expect(detectAuth(env)).toMatchObject({ ok: null, method: "oauth-personal" });
  });

  it("reads the legacy flat setting and an API key from the environment", async () => {
    const env = await geminiHome(JSON.stringify({ selectedAuthType: "gemini-api-key" }));
    expect(detectAuth({ ...env, GEMINI_API_KEY: "k" })).toMatchObject({ ok: true, method: "gemini-api-key" });
  });

  it("falls back to environment-only configuration", async () => {
    expect(detectAuth({ ...(await geminiHome()), GEMINI_API_KEY: "k" })).toMatchObject({ ok: true, method: "gemini-api-key" });
  });
});

describe("stripJsonComments", () => {
  it("removes comments but keeps // inside strings", () => {
    const out = stripJsonComments('{"u":"http://x" // c\n, /* b */ "v": "a\\"//b"}');
    expect(JSON.parse(out)).toEqual({ u: "http://x", v: 'a"//b' });
  });
});

describe("detectInstall", () => {
  it("reports the version when gemini is on PATH", async () => {
    const env = await fakeGeminiOnPath(dir);
    const { spawn, calls } = fakeSpawn((child) => child.exit(0, "0.59.0\n"));
    expect(await detectInstall({ env, spawn })).toMatchObject({ installed: true, version: "0.59.0" });
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  it("doesn't spawn anything when gemini isn't on PATH", async () => {
    const { spawn, calls } = fakeSpawn(() => undefined);
    // ProgramFiles points at the temp dir so no real install folder gets appended to PATH.
    expect(await detectInstall({ env: { PATH: dir, ProgramFiles: dir }, spawn })).toEqual({ installed: false, path: null, version: null });
    expect(calls).toHaveLength(0);
  });

  it("treats ENOENT at spawn time as not installed", async () => {
    const env = await fakeGeminiOnPath(dir);
    const { spawn } = fakeSpawn((child) => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
    expect((await detectInstall({ env, spawn })).installed).toBe(false);
  });
});

describe("detectRipgrep", () => {
  const binary = `rg-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;

  it("accepts the ripgrep bundled with the Gemini CLI", async () => {
    const vendor = path.join(dir, "npm", "node_modules", "@google", "gemini-cli", "bundle", "vendor", "ripgrep");
    await fs.mkdir(vendor, { recursive: true });
    await fs.writeFile(path.join(vendor, binary), "");
    expect(detectRipgrep(path.join(dir, "npm", "gemini.cmd"), { PATH: "", ProgramFiles: dir })).toMatchObject({
      available: true,
      detail: "bundled with the Gemini CLI",
    });
  });

  it("rejects an rg outside the folders the Gemini CLI trusts, like it does", async () => {
    await fs.writeFile(path.join(dir, "rg"), "");
    await fs.writeFile(path.join(dir, "rg.exe"), "");
    // ProgramFiles points somewhere else, so the temp folder is neither augmented nor trusted.
    expect(detectRipgrep(null, { PATH: dir, PATHEXT: ".EXE", ProgramFiles: path.join(dir, "pf") })).toMatchObject({
      available: false,
      detail: expect.stringMatching(/outside Program Files/),
    });
  });

  it("reports a missing rg", () => {
    expect(detectRipgrep(null, { PATH: dir, ProgramFiles: dir })).toMatchObject({ available: false, path: null });
  });
});

describe("refreshCliStatus", () => {
  let store: StateStore;
  let now: Date;
  let install: ReturnType<typeof vi.fn<() => Promise<InstallCheck>>>;
  let auth: ReturnType<typeof vi.fn<() => AuthCheck>>;
  const RG: RipgrepStatus = { available: true, path: "C:\\Program Files\\rg.exe", detail: "installed" };
  const run = (force = false) =>
    refreshCliStatus(store, {
      force,
      now: () => now,
      detectInstall: install,
      detectAuth: auth,
      findPath: () => "C:\\bin\\gemini.cmd",
      detectRipgrep: () => RG,
    });

  beforeEach(() => {
    store = new StateStore(path.join(dir, "state.json"));
    now = new Date("2026-09-10T12:00:00.000Z");
    install = vi.fn(async () => ({ installed: true, path: "C:\\bin\\gemini.cmd", version: "0.59.0" }));
    auth = vi.fn(() => ({ ok: true, method: "oauth-personal", detail: "Signed in with Google." }));
  });

  it("checks once, then serves the cached result within the TTL", async () => {
    expect(await run()).toMatchObject({ installed: true, version: "0.59.0", authOk: true, fromCache: false, ripgrep: RG });
    now = new Date(now.getTime() + 60_000);
    expect(await run()).toMatchObject({ installed: true, version: "0.59.0", authOk: true, fromCache: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("re-checks when forced or once the TTL has passed", async () => {
    await run();
    await run(true);
    now = new Date(now.getTime() + 11 * 60_000);
    await run();
    expect(install).toHaveBeenCalledTimes(3);
  });

  it("doesn't let an inconclusive offline check erase a proven sign-in", async () => {
    await store.update((s) => {
      s.geminiCli.lastAuthOk = true;
      s.geminiCli.lastAuthDetail = "The last Gemini call succeeded.";
    });
    auth.mockReturnValue({ ok: null, method: "oauth-personal", detail: "keychain?" });
    expect(await run(true)).toMatchObject({ authOk: true, authDetail: "The last Gemini call succeeded." });
  });

  it("reports a missing CLI without checking sign-in", async () => {
    install.mockResolvedValue({ installed: false, path: null, version: null });
    expect(await run(true)).toMatchObject({ installed: false, version: null, authOk: null });
    expect(auth).not.toHaveBeenCalled();
  });
});
