import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeContext } from "../../src/context.js";
import type { CliStatus } from "../../src/gemini/detect.js";
import type { GeminiRequest, GeminiResponse } from "../../src/gemini/invoke.js";
import { toAtReference } from "../../src/gemini/promptBuilder.js";
import { createServer } from "../../src/server.js";
import { StateStore } from "../../src/state/store.js";
import { handleAsk } from "../../src/tools/ask.js";
import { handleStatus } from "../../src/tools/status.js";
import { handleToggle } from "../../src/tools/toggle.js";
import { BridgeError } from "../../src/util/errors.js";
import { tempDir } from "../helpers.js";

const CLI: CliStatus = {
  installed: true,
  path: "C:\\bin\\gemini.cmd",
  version: "0.59.0",
  authOk: true,
  authDetail: "The last Gemini call succeeded.",
  checkedAt: "2026-09-10T12:00:00.000Z",
  fromCache: false,
};

let root: string;
let project: string;
let bigFile: string;
let ctx: BridgeContext;
let invoke: ReturnType<typeof vi.fn<(req: GeminiRequest) => Promise<GeminiResponse>>>;
let refreshCli: ReturnType<typeof vi.fn<(force: boolean) => Promise<CliStatus>>>;

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

beforeEach(async () => {
  root = await tempDir("gcb-tools-");
  project = path.join(root, "project");
  bigFile = path.join(project, "src", "big file.ts");
  await fs.mkdir(path.dirname(bigFile), { recursive: true });
  await fs.writeFile(bigFile, "x".repeat(40_000));

  invoke = vi.fn(async () => ({ text: "Gemini says hi", model: "main-pro", durationMs: 1234, exitCode: 0, warnings: [] }));
  refreshCli = vi.fn(async () => CLI);
  ctx = {
    store: new StateStore(path.join(root, "state", "state.json")),
    invoke,
    refreshCli,
    projectDir: () => project,
    scratchDir: async () => {
      const dir = path.join(root, "scratch");
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("gemini_ask", () => {
  it("attaches files as @references, runs from the scratch folder and records usage", async () => {
    const result = await handleAsk(ctx, { prompt: "Summarize", paths: [bigFile], mode: "analyze" });

    expect(result.isError).toBeFalsy();
    const req = invoke.mock.calls[0]![0];
    expect(req.prompt).toContain(toAtReference(bigFile));
    expect(req.cwd).toBe(path.join(root, "scratch"));
    // The file's folder is inside the project, so the project folder alone covers both.
    expect(req.includeDirectories).toEqual([project]);
    expect(req.timeoutMs).toBe(180_000);
    expect(req.yolo).toBe(false);

    const saved = 40_000 - "Gemini says hi".length;
    expect(textOf(result)).toBe(
      `Gemini says hi\n\n[gemini-claude-bridge · analyze · main-pro · 1.2s · ~${Math.round(saved / 4)} tokens of file content kept out of Claude's context]`,
    );
    // Claude Code shows the model structuredContent INSTEAD of the text, so a successful answer
    // must not carry one, or Gemini's answer would never reach Claude.
    expect(result.structuredContent).toBeUndefined();

    const state = await ctx.store.read();
    expect(state.usage).toMatchObject({ totalCalls: 1, totalErrors: 0, callsByMode: { analyze: 1 }, estimatedCharsSaved: saved });
    expect(state.geminiCli.lastAuthOk).toBe(true);
  });

  it("resolves relative paths against the project folder", async () => {
    await handleAsk(ctx, { prompt: "x", paths: [path.join("src", "big file.ts")] });
    expect(invoke.mock.calls[0]![0].prompt).toContain(toAtReference(bigFile));
  });

  it("refuses immediately when the bridge is off: no subprocess, nothing counted", async () => {
    await handleToggle(ctx, { enabled: false });
    const result = await handleAsk(ctx, { prompt: "x", paths: ["does/not/matter"] });

    expect(result.isError).toBe(true);
    // Both representations carry the next step, whichever one the client shows the model.
    expect(result.structuredContent).toMatchObject({
      ok: false,
      errorType: "disabled",
      nextStep: expect.stringContaining("Do the task yourself"),
    });
    expect(textOf(result)).toMatch(/Do the task yourself/);
    expect(invoke).not.toHaveBeenCalled();
    expect((await ctx.store.read()).usage.totalCalls).toBe(0);
  });

  it("reports missing paths without calling Gemini", async () => {
    const result = await handleAsk(ctx, { prompt: "x", paths: [bigFile, "nope.txt"] });
    expect(result.structuredContent).toMatchObject({ errorType: "invalid_paths" });
    expect(textOf(result)).toMatch(/nope\.txt/);
    expect(invoke).not.toHaveBeenCalled();
    expect((await ctx.store.read()).usage.totalErrors).toBe(1);
  });

  it("returns Gemini failures as typed errors and remembers sign-in problems", async () => {
    invoke.mockRejectedValue(new BridgeError("not_authenticated", "The Gemini CLI is not signed in: expired", { exitCode: 41 }));
    const result = await handleAsk(ctx, { prompt: "x" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorType: "not_authenticated", exitCode: 41 });
    expect(textOf(result)).toMatch(/run `gemini` once/);
    const state = await ctx.store.read();
    expect(state.geminiCli.lastAuthOk).toBe(false);
    expect(state.usage.totalErrors).toBe(1);
  });

  it("uses preferences as defaults and lets arguments override them", async () => {
    await ctx.store.update((s) => {
      s.preferences.model = "pref-model";
      s.preferences.timeoutMs = 60_000;
      s.preferences.approvalMode = "yolo";
    });
    await handleAsk(ctx, { prompt: "x" });
    expect(invoke.mock.calls[0]![0]).toMatchObject({ model: "pref-model", timeoutMs: 60_000, yolo: true });

    await handleAsk(ctx, { prompt: "x", model: "arg-model", timeoutMs: 9_000, yolo: false });
    expect(invoke.mock.calls[1]![0]).toMatchObject({ model: "arg-model", timeoutMs: 9_000, yolo: false });
  });

  it("passes the cancellation signal through to the Gemini process", async () => {
    const controller = new AbortController();
    await handleAsk(ctx, { prompt: "x" }, controller.signal);
    expect(invoke.mock.calls[0]![0].signal).toBe(controller.signal);
  });
});

describe("gemini_bridge_toggle", () => {
  it("persists the flag and says when nothing changed", async () => {
    expect(textOf(await handleToggle(ctx, { enabled: false }))).toMatch(/now OFF/);
    expect(textOf(await handleToggle(ctx, { enabled: false }))).toMatch(/already OFF/);
    expect((await ctx.store.read()).enabled).toBe(false);
    expect(textOf(await handleToggle(ctx, { enabled: true }))).toMatch(/now ON/);
  });
});

describe("gemini_bridge_status", () => {
  it("summarizes on/off, CLI, sign-in and usage, and forwards forceRefresh", async () => {
    await handleAsk(ctx, { prompt: "x", paths: [bigFile], mode: "review" });
    const result = await handleStatus(ctx, { forceRefresh: true });
    const text = textOf(result);

    expect(refreshCli).toHaveBeenCalledWith(true);
    expect(text).toMatch(/Gemini bridge: ON/);
    expect(text).toMatch(/Gemini CLI: installed v0\.59\.0/);
    expect(text).toMatch(/Sign-in: OK/);
    expect(text).toMatch(/1 call, 0 errors \(review 1\)/);
    expect(result.structuredContent).toMatchObject({
      enabled: true,
      usage: { totalCalls: 1 },
      summary: expect.stringContaining("Gemini bridge: ON"),
    });
  });

  it("works while the bridge is off", async () => {
    await handleToggle(ctx, { enabled: false });
    expect(textOf(await handleStatus(ctx, {}))).toMatch(/Gemini bridge: OFF/);
  });
});

describe("MCP server", () => {
  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(ctx).connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("always lists exactly the three tools with the expected schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gemini_ask", "gemini_bridge_status", "gemini_bridge_toggle"]);

    const ask = tools.find((t) => t.name === "gemini_ask")!;
    expect(ask.inputSchema.required).toEqual(["prompt"]);
    const props = ask.inputSchema.properties as Record<string, { maxItems?: number; enum?: string[] }>;
    expect(Object.keys(props).sort()).toEqual(["mode", "model", "paths", "prompt", "timeoutMs", "yolo"]);
    expect(props.paths?.maxItems).toBe(20);
    expect(props.mode?.enum).toEqual(["ask", "analyze", "review", "refactor", "plan", "test"]);
    expect(client.getInstructions()).toMatch(/gemini_bridge_toggle/);
    await client.close();
  });

  it("short-circuits a disabled bridge end to end without spawning Gemini", async () => {
    const client = await connect();
    await client.callTool({ name: "gemini_bridge_toggle", arguments: { enabled: false } });
    const result = (await client.callTool({ name: "gemini_ask", arguments: { prompt: "hello" } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorType: "disabled" });
    expect(invoke).not.toHaveBeenCalled();

    // Tool list stays the same while disabled.
    expect((await client.listTools()).tools).toHaveLength(3);
    await client.close();
  });

  it("rejects invalid arguments before doing anything", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "gemini_ask",
      arguments: { prompt: "x", model: "--yolo" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await client.close();
  });
});
