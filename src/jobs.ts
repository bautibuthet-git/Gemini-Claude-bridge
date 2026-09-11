import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface Job {
  id: string;
  label: string;
  status: "running" | "done";
  startedAt: number;
  finishedAt: number | null;
  result: CallToolResult | null;
  /** Settles when the job finishes; never rejects. */
  done: Promise<void>;
}

/**
 * Background Gemini calls, so Claude can keep working instead of waiting on a slow answer.
 * Jobs live in this server process, i.e. for one Claude Code session.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly keepMs = 60 * 60_000,
    private readonly maxJobs = 50,
  ) {}

  start(label: string, run: () => Promise<CallToolResult>, onError: (err: unknown) => CallToolResult): Job {
    this.prune();
    const job: Job = {
      id: crypto.randomBytes(4).toString("hex"),
      label,
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      result: null,
      done: Promise.resolve(),
    };
    job.done = run()
      .catch(onError)
      .then((result) => {
        job.result = result;
        job.status = "done";
        job.finishedAt = this.now();
      });
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  running(): number {
    return [...this.jobs.values()].filter((job) => job.status === "running").length;
  }

  /** Resolves when the job finishes or after `ms`, whichever comes first. */
  async wait(job: Job, ms: number): Promise<Job> {
    if (job.status === "done" || ms <= 0) return job;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return job;
  }

  private prune(): void {
    const cutoff = this.now() - this.keepMs;
    for (const [id, job] of this.jobs) {
      if (job.status === "done" && (job.finishedAt ?? 0) < cutoff) this.jobs.delete(id);
    }
    const finished = this.list().filter((job) => job.status === "done");
    for (const job of finished.slice(Math.max(0, this.maxJobs - 1))) this.jobs.delete(job.id);
  }
}
