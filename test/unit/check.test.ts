import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerText, runCheck } from "../../src/check.js";
import { StateStore } from "../../src/state/store.js";
import { STATE_DIR_ENV } from "../../src/util/paths.js";
import { fakeGeminiOnPath, tempDir } from "../helpers.js";

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await tempDir("gcb-check-");
  store = new StateStore(path.join(dir, "state.json"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function signedInEnv(): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(dir, "bin");
  const config = path.join(dir, "home", ".gemini");
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  await fs.writeFile(path.join(config, "oauth_creds.json"), "{}");
  return { ...(await fakeGeminiOnPath(bin)), GEMINI_CLI_HOME: path.join(dir, "home") };
}

describe("SessionStart banner", () => {
  it("says OFF when the bridge is disabled", async () => {
    await store.update((s) => {
      s.enabled = false;
    });
    expect(await bannerText(store, await signedInEnv())).toMatch(/^Gemini bridge: OFF/);
  });

  it("flags a missing Gemini CLI", async () => {
    expect(await bannerText(store, { PATH: dir })).toMatch(/isn't installed/);
  });

  it("flags a missing sign-in", async () => {
    const env = { ...(await signedInEnv()), GEMINI_CLI_HOME: path.join(dir, "nobody") };
    expect(await bannerText(store, env)).toMatch(/isn't signed in/);
  });

  it("shows ON with the CLI version and call count", async () => {
    await store.update((s) => {
      s.geminiCli.lastDetectedVersion = "0.59.0";
      s.usage.totalCalls = 3;
    });
    expect(await bannerText(store, await signedInEnv())).toBe("Gemini bridge: ON · Gemini CLI 0.59.0 · 3 delegated calls so far");
  });

  it("prints one JSON line with a systemMessage", async () => {
    const previous = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = dir;
    try {
      let out = "";
      await runCheck((text) => {
        out += text;
      });
      expect(out.endsWith("\n")).toBe(true);
      expect(JSON.parse(out)).toEqual({ systemMessage: expect.stringMatching(/^Gemini bridge: /) });
    } finally {
      if (previous === undefined) delete process.env[STATE_DIR_ENV];
      else process.env[STATE_DIR_ENV] = previous;
    }
  });
});
