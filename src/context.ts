import fs from "node:fs/promises";
import { refreshCliStatus, type CliStatus } from "./gemini/detect.js";
import { invokeGemini, type GeminiRequest, type GeminiResponse } from "./gemini/invoke.js";
import { StateStore } from "./state/store.js";
import { scratchWorkspaceDir, workspaceRoot } from "./util/paths.js";

/** Everything the tool handlers touch, injectable so tests never spawn Gemini or write to ~/. */
export interface BridgeContext {
  store: StateStore;
  invoke(req: GeminiRequest): Promise<GeminiResponse>;
  refreshCli(force: boolean): Promise<CliStatus>;
  /** The project Claude is working in (base for relative paths, readable by Gemini). */
  projectDir(): string;
  /** The empty folder Gemini runs from; created on demand. */
  scratchDir(): Promise<string>;
  now(): Date;
}

export function createContext(store: StateStore = new StateStore()): BridgeContext {
  return {
    store,
    invoke: (req) => invokeGemini(req),
    refreshCli: (force) => refreshCliStatus(store, { force }),
    projectDir: () => workspaceRoot(),
    scratchDir: async () => {
      const dir = scratchWorkspaceDir();
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    now: () => new Date(),
  };
}
