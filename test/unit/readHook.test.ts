import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideRead, denyOutput, loadHookSettings, SuggestionLog, type HookSettings } from "../../src/hooks/readHook.js";
import { tempDir } from "../helpers.js";

const ON: HookSettings = { enabled: true, suggest: true, minLines: 800, geminiUsable: true };
const NOW = new Date("2026-09-10T12:00:00.000Z");

let dir: string;
let big: string;
let log: SuggestionLog;

beforeEach(async () => {
  dir = await tempDir("gcb-hook-");
  big = path.join(dir, "server.log");
  await fs.writeFile(big, Array.from({ length: 1000 }, (_, i) => `2026-09-10 INFO request ${i} handled in ${i} ms`).join("\n"));
  log = new SuggestionLog(path.join(dir, "suggestions.json"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("decideRead", () => {
  it("suggests delegating a big file read whole, once per file per session", async () => {
    const input = { session_id: "s1", tool_input: { file_path: big } };
    const reason = await decideRead(input, ON, log, NOW);

    expect(reason).toMatch(/server\.log has 1,000 lines/);
    expect(reason).toMatch(/gemini_ask \(paths: \[/);
    expect(reason).toMatch(/run this same Read again/);
    expect(await decideRead(input, ON, log, NOW)).toBeNull();
    expect(await decideRead({ ...input, session_id: "s2" }, ON, log, NOW)).not.toBeNull();
  });

  it("resolves a relative path against the session's folder", async () => {
    expect(await decideRead({ session_id: "s", cwd: dir, tool_input: { file_path: "server.log" } }, ON, log, NOW)).not.toBeNull();
  });

  it("lets targeted, small, binary and missing reads through", async () => {
    const small = path.join(dir, "small.txt");
    const binary = path.join(dir, "blob.bin");
    await fs.writeFile(small, "tiny");
    await fs.writeFile(binary, Buffer.alloc(40_000, 0));

    for (const toolInput of [{ file_path: big, offset: 1 }, { file_path: big, limit: 50 }, { file_path: small }, { file_path: binary }, { file_path: path.join(dir, "nope") }, {}]) {
      expect(await decideRead({ session_id: "s", tool_input: toolInput }, ON, log, NOW)).toBeNull();
    }
  });

  it("stays quiet when the bridge is off, suggestions are off, Gemini hasn't worked yet, or the file is under the threshold", async () => {
    const input = { session_id: "s", tool_input: { file_path: big } };
    for (const settings of [{ ...ON, enabled: false }, { ...ON, suggest: false }, { ...ON, geminiUsable: false }, { ...ON, minLines: 5_000 }]) {
      expect(await decideRead(input, settings, log, NOW)).toBeNull();
    }
  });
});

describe("loadHookSettings", () => {
  it("reads the bridge state tolerantly and needs a proven sign-in before suggesting anything", async () => {
    expect(await loadHookSettings(dir)).toMatchObject({ enabled: false, geminiUsable: false });

    await fs.writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({ enabled: true, preferences: { suggestDelegation: { enabled: true, minLines: 300 } }, geminiCli: { lastAuthOk: true, lastDetectedVersion: "0.59.0" } }),
    );
    expect(await loadHookSettings(dir)).toEqual({ enabled: true, suggest: true, minLines: 300, geminiUsable: true });

    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ geminiCli: { lastAuthOk: null } }));
    expect((await loadHookSettings(dir)).geminiUsable).toBe(false);
  });
});

describe("denyOutput", () => {
  it("is a PreToolUse deny whose reason Claude sees", () => {
    expect(JSON.parse(denyOutput("why"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "why" },
    });
  });
});
