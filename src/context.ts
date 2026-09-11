import fs from "node:fs/promises";
import path from "node:path";
import { ResponseCache } from "./cache.js";
import { AcpEngine, type AcpRunRequest } from "./gemini/acp.js";
import { SpendLedger } from "./gemini/budget.js";
import { refreshCliStatus, type CliStatus } from "./gemini/detect.js";
import { invokeGemini, type GeminiRequest, type GeminiResponse } from "./gemini/invoke.js";
import { History } from "./history.js";
import { JobManager } from "./jobs.js";
import { StateStore } from "./state/store.js";
import { projectDirForGemini, scratchWorkspaceDir, stateDir, workspaceRoot } from "./util/paths.js";

/** The warm-process engine as the handlers see it; tests substitute a fake, or null for none. */
export interface WarmEngine {
  isHealthy(): boolean;
  hasSession(sessionId: string): boolean;
  describe(): string;
  run(req: AcpRunRequest): Promise<GeminiResponse>;
  close(): void | Promise<void>;
}

/** Everything the tool handlers touch, injectable so tests never spawn Gemini or write to ~/. */
export interface BridgeContext {
  store: StateStore;
  /** One-off Gemini process per call. */
  invoke(req: GeminiRequest): Promise<GeminiResponse>;
  /** Warm Gemini process reused across calls, when available. */
  acp: WarmEngine | null;
  cache: ResponseCache;
  history: History;
  jobs: JobManager;
  /** Input tokens of calls in flight in this process, for the per-minute budget. */
  spend: SpendLedger;
  refreshCli(force: boolean): Promise<CliStatus>;
  /** The project Claude is working in (base for relative paths, readable by Gemini). */
  projectDir(): string;
  /** The empty folder Gemini runs from; created on demand. */
  scratchDir(): Promise<string>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export function createContext(store: StateStore = new StateStore()): BridgeContext {
  const scratchDir = async () => {
    const dir = scratchWorkspaceDir();
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };
  const home = stateDir();
  return {
    store,
    invoke: (req) => invokeGemini(req),
    acp: new AcpEngine({ cwd: scratchDir, projectDir: () => projectDirForGemini(workspaceRoot()) }),
    cache: new ResponseCache(path.join(home, "cache")),
    history: new History(path.join(home, "history.jsonl")),
    jobs: new JobManager(),
    spend: new SpendLedger(),
    refreshCli: (force) => refreshCliStatus(store, { force }),
    projectDir: () => workspaceRoot(),
    scratchDir,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
