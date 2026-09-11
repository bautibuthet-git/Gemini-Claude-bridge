import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface CachedAnswer {
  text: string;
  model: string | null;
  createdAt: string;
  durationMs: number;
  conversationId: string | null;
}

/**
 * Answers to identical questions about unchanged files. The key covers the whole prompt (which
 * holds the inlined file contents) plus size and mtime of any file left as a reference, so an
 * edit to any input is a miss. Typical hit: Claude asking again after compacting its context.
 */
export class ResponseCache {
  private writes = 0;

  constructor(
    readonly dir: string,
    private readonly maxEntries = 300,
  ) {}

  static key(parts: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  async get(key: string, ttlMs: number, now: Date): Promise<CachedAnswer | null> {
    try {
      const entry = JSON.parse(await fs.readFile(this.file(key), "utf8")) as CachedAnswer;
      if (typeof entry.text !== "string" || Date.parse(entry.createdAt) + ttlMs < now.getTime()) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CachedAnswer): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(key)}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
    await fs.rename(tmp, this.file(key)).catch(async (err: unknown) => {
      await fs.rm(tmp, { force: true });
      throw err;
    });
    if (++this.writes % 20 === 0) await this.prune();
  }

  /** Keeps the newest entries only. */
  async prune(): Promise<void> {
    const names = (await fs.readdir(this.dir).catch(() => [])).filter((name) => name.endsWith(".json"));
    if (names.length <= this.maxEntries) return;
    const entries = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(this.dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of entries.slice(0, entries.length - this.maxEntries)) {
      await fs.rm(path.join(this.dir, name), { force: true });
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}
