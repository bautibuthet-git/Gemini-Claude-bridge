import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponseCache } from "../../src/cache.js";
import { History, summarizeHistory, type HistoryEntry } from "../../src/history.js";
import { JobManager } from "../../src/jobs.js";
import { tempDir } from "../helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await tempDir("gcb-misc-");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const answer = (createdAt: string) => ({ text: "cached", model: "m", createdAt, durationMs: 5, conversationId: null });

describe("ResponseCache", () => {
  it("returns a stored answer within its TTL and nothing after", async () => {
    const cache = new ResponseCache(dir);
    await cache.set("k", answer("2026-09-10T12:00:00.000Z"));
    expect(await cache.get("k", 60_000, new Date("2026-09-10T12:00:30.000Z"))).toMatchObject({ text: "cached" });
    expect(await cache.get("k", 60_000, new Date("2026-09-10T12:02:00.000Z"))).toBeNull();
    expect(await cache.get("missing", 60_000, new Date())).toBeNull();
  });

  it("derives different keys from different inputs", () => {
    expect(ResponseCache.key({ prompt: "a" })).toBe(ResponseCache.key({ prompt: "a" }));
    expect(ResponseCache.key({ prompt: "a" })).not.toBe(ResponseCache.key({ prompt: "b" }));
  });

  it("keeps only the newest entries", async () => {
    const cache = new ResponseCache(dir, 3);
    for (let i = 0; i < 5; i++) await cache.set(`k${i}`, answer("2026-09-10T12:00:00.000Z"));
    await cache.prune();
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(3);
  });
});

const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at: "2026-09-10T12:00:00.000Z",
  mode: "ask",
  ok: true,
  engine: "cli",
  model: "m",
  durationMs: 1000,
  attempts: [{ model: "m", outcome: "ok", ms: 1000 }],
  inlineFiles: 0,
  referencedFiles: 0,
  charsSaved: 0,
  background: false,
  ...overrides,
});

describe("History", () => {
  it("appends entries and reads back the recent ones", async () => {
    const history = new History(path.join(dir, "h.jsonl"));
    await history.append(entry({ at: "2026-09-01T00:00:00.000Z" }));
    await history.append(entry());
    expect(await history.recent(new Date("2026-09-05T00:00:00.000Z"))).toHaveLength(1);
  });

  it("trims to the newest entries", async () => {
    const history = new History(path.join(dir, "h.jsonl"), 3);
    for (let i = 0; i < 5; i++) await history.append(entry({ durationMs: i }));
    await history.trim();
    expect((await history.recent(new Date(0))).map((e) => e.durationMs)).toEqual([2, 3, 4]);
  });

  it("summarizes success, cache hits and per-model speed", () => {
    const summary = summarizeHistory([
      entry(),
      entry({ engine: "cache", attempts: [] }),
      entry({ ok: false, attempts: [{ model: "pro", outcome: "quota", ms: 200 }] }),
      entry({ durationMs: 3000, attempts: [{ model: "pro", outcome: "quota", ms: 100 }, { model: "m", outcome: "ok", ms: 3000 }] }),
    ]);
    expect(summary).toMatchObject({ calls: 4, ok: 3, cached: 1, failed: 1, avgMs: 2000 });
    expect(summary.byModel).toEqual({ m: { ok: 2, failed: 0, avgMs: 2000 }, pro: { ok: 0, failed: 2, avgMs: 0 } });
  });
});

describe("JobManager", () => {
  const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
  const onError = () => result("crashed");

  it("runs a job in the background and hands back its result", async () => {
    const jobs = new JobManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = jobs.start("label", async () => {
      await gate;
      return result("done");
    }, onError);

    expect(job.status).toBe("running");
    expect((await jobs.wait(job, 10)).status).toBe("running");
    expect(jobs.running()).toBe(1);
    release();
    await jobs.wait(job, 1_000);
    expect(job.status).toBe("done");
    expect(job.result?.content[0]).toMatchObject({ text: "done" });
  });

  it("turns a crash into an error result instead of losing the job", async () => {
    const jobs = new JobManager();
    const job = jobs.start("boom", async () => {
      throw new Error("x");
    }, onError);
    await jobs.wait(job, 1_000);
    expect(job.result?.content[0]).toMatchObject({ text: "crashed" });
  });

  it("lists newest first and forgets old finished jobs", async () => {
    let now = 0;
    const jobs = new JobManager(() => now, 1_000);
    const first = jobs.start("first", async () => result("1"), onError);
    await jobs.wait(first, 100);
    now = 10;
    const second = jobs.start("second", async () => result("2"), onError);
    expect(jobs.list().map((j) => j.label)).toEqual(["second", "first"]);
    await jobs.wait(second, 100);
    now = 5_000;
    jobs.start("third", async () => result("3"), onError);
    expect(jobs.get(first.id)).toBeUndefined();
  });
});
