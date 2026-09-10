import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage, isErrnoException } from "../util/errors.js";
import { stateFilePath } from "../util/paths.js";
import { defaultState, stateSchema, type BridgeState } from "./schema.js";

/**
 * JSON state file with serialized in-process access and atomic writes (temp file + rename).
 * Missing file → defaults. Corrupt file → backed up, reset, and reported once via takeWarning().
 *
 * Several Claude Code sessions may each run their own server process against the same file.
 * Atomic renames keep the file intact across processes; a rare lost usage-counter increment
 * is acceptable at this scale, so there is no cross-process lock.
 */
export class StateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private warning: string | null = null;

  constructor(readonly file: string = stateFilePath()) {}

  read(): Promise<BridgeState> {
    return this.serialize(() => this.load());
  }

  /** Read-modify-write under the lock. The mutator edits the state in place. */
  update(mutate: (state: BridgeState) => void): Promise<BridgeState> {
    return this.serialize(async () => {
      const state = await this.load();
      mutate(state);
      const next = stateSchema.parse(state);
      await this.write(next);
      return next;
    });
  }

  /** Returns the pending corruption warning (if any) and clears it, so it surfaces exactly once. */
  takeWarning(): string | null {
    const warning = this.warning;
    this.warning = null;
    return warning;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<BridgeState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if (isErrnoException(err, "ENOENT")) return defaultState();
      throw err;
    }

    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}.bak`;
      const backedUp = await fs.rename(this.file, backup).then(
        () => true,
        () => false,
      );
      const fresh = defaultState();
      await this.write(fresh);
      this.warning =
        `The bridge state file ${this.file} was unreadable (${firstLine(errorMessage(err))}) and was reset to defaults` +
        (backedUp ? `; the old file was kept as ${backup}.` : ".");
      return fresh;
    }
  }

  private async write(state: BridgeState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, this.file);
  }
}

/** On Windows, rename-over can fail transiently while another process (or antivirus) has the file open. */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const transient = isErrnoException(err) && ["EPERM", "EACCES", "EBUSY"].includes(err.code ?? "");
      if (!transient || i >= attempts - 1) {
        await fs.rm(from, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** i));
    }
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}
