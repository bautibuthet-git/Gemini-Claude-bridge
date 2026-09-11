import fs from "node:fs/promises";
import path from "node:path";
import type { Attempt } from "./gemini/runner.js";
import type { Mode } from "./state/schema.js";

export interface HistoryEntry {
  at: string;
  mode: Mode;
  ok: boolean;
  /** "cache" when the answer came from the response cache. */
  engine: "cli" | "acp" | "cache" | "none";
  model: string | null;
  durationMs: number;
  errorType?: string;
  attempts: Array<Pick<Attempt, "model" | "outcome" | "ms">>;
  inlineFiles: number;
  referencedFiles: number;
  charsSaved: number;
  background: boolean;
}

/** One JSON line per call, trimmed to the most recent entries so it never grows unbounded. */
export class History {
  private appends = 0;

  constructor(
    readonly file: string,
    private readonly keep = 500,
  ) {}

  async append(entry: HistoryEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    if (++this.appends % 50 === 0) await this.trim();
  }

  async recent(since: Date): Promise<HistoryEntry[]> {
    const text = await fs.readFile(this.file, "utf8").catch(() => "");
    const entries: HistoryEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (Date.parse(entry.at) >= since.getTime()) entries.push(entry);
      } catch {
        // skip a torn line
      }
    }
    return entries;
  }

  async trim(): Promise<void> {
    const text = await fs.readFile(this.file, "utf8").catch(() => "");
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length <= this.keep) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${lines.slice(-this.keep).join("\n")}\n`, "utf8");
    await fs.rename(tmp, this.file);
  }
}

export interface ModelStats {
  ok: number;
  failed: number;
  avgMs: number;
}

export interface HistorySummary {
  calls: number;
  ok: number;
  cached: number;
  failed: number;
  avgMs: number;
  byModel: Record<string, ModelStats>;
}

export function summarizeHistory(entries: readonly HistoryEntry[]): HistorySummary {
  const byModel: Record<string, { ok: number; failed: number; totalMs: number }> = {};
  let okTotalMs = 0;
  let okCount = 0;
  for (const entry of entries) {
    for (const attempt of entry.attempts) {
      const stats = (byModel[attempt.model] ??= { ok: 0, failed: 0, totalMs: 0 });
      if (attempt.outcome === "ok") {
        stats.ok++;
        stats.totalMs += attempt.ms;
      } else {
        stats.failed++;
      }
    }
    if (entry.ok && entry.engine !== "cache") {
      okTotalMs += entry.durationMs;
      okCount++;
    }
  }
  return {
    calls: entries.length,
    ok: entries.filter((e) => e.ok).length,
    cached: entries.filter((e) => e.engine === "cache").length,
    failed: entries.filter((e) => !e.ok).length,
    avgMs: okCount > 0 ? Math.round(okTotalMs / okCount) : 0,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([model, s]) => [model, { ok: s.ok, failed: s.failed, avgMs: s.ok > 0 ? Math.round(s.totalMs / s.ok) : 0 }]),
    ),
  };
}
