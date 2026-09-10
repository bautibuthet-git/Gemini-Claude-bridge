import { detectAuth } from "./gemini/detect.js";
import { geminiCommand } from "./gemini/invoke.js";
import { StateStore } from "./state/store.js";
import { findOnPath } from "./util/paths.js";

/**
 * `node dist/index.js --check`, run by the SessionStart hook. Offline and fast (never spawns
 * Gemini) and always exits 0, so it can't block or slow down a session.
 */
export async function runCheck(write: (text: string) => void = (text) => process.stdout.write(text)): Promise<void> {
  try {
    write(`${JSON.stringify({ systemMessage: await bannerText() })}\n`);
  } catch {
    // Never block session start.
  }
}

export async function bannerText(store: StateStore = new StateStore(), env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const state = await store.read();
  if (!state.enabled) return "Gemini bridge: OFF. Ask Claude to turn it on when you want delegation to Gemini.";
  if (!findOnPath(geminiCommand(env), env)) {
    return "Gemini bridge: ON, but the Gemini CLI isn't installed. Run: npm install -g @google/gemini-cli";
  }
  // A definite offline answer (e.g. never signed in) wins; otherwise trust the last real call.
  const authOk = detectAuth(env).ok ?? state.geminiCli.lastAuthOk;
  if (authOk === false) return "Gemini bridge: ON, but Gemini isn't signed in. Run `gemini` once in a terminal to sign in.";

  const version = state.geminiCli.lastDetectedVersion;
  const calls = state.usage.totalCalls;
  return (
    "Gemini bridge: ON" +
    (version && version !== "unknown" ? ` · Gemini CLI ${version}` : "") +
    ` · ${calls} delegated call${calls === 1 ? "" : "s"} so far`
  );
}
