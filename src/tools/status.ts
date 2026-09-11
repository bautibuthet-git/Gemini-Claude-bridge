import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BridgeContext } from "../context.js";
import type { CliStatus } from "../gemini/detect.js";
import { recentSpends } from "../gemini/runner.js";
import { summarizeHistory, type HistorySummary } from "../history.js";
import { CHARS_PER_TOKEN, type BridgeState } from "../state/schema.js";
import { textResult, withWarning } from "./result.js";

export const STATUS_DESCRIPTION =
  "Report whether the Gemini bridge is on, whether the gemini CLI is installed and signed in, what is missing from the setup (with the commands to fix it), which models are cooling down after running out of quota, per-minute token limits, recent speed and usage, and current preferences. Use it when the user asks whether the bridge or Gemini is on, set up or working. Works even while the bridge is off.";

export const statusInputSchema = {
  forceRefresh: z
    .boolean()
    .optional()
    .describe("Re-check the Gemini CLI install and sign-in now instead of reusing the last check (cached up to 10 minutes)."),
};

const WEEK_MS = 7 * 24 * 60 * 60_000;

export async function handleStatus(ctx: BridgeContext, args: { forceRefresh?: boolean }): Promise<CallToolResult> {
  const cli = await ctx.refreshCli(args.forceRefresh ?? false);
  const state = await ctx.store.read();
  const now = ctx.now();
  const week = summarizeHistory(await ctx.history.recent(new Date(now.getTime() - WEEK_MS)));
  const lastMinute: Record<string, number> = {};
  for (const spend of await recentSpends(ctx)) lastMinute[spend.model] = (lastMinute[spend.model] ?? 0) + spend.tokens;
  const input: StatusInput = {
    state,
    cli,
    week,
    now,
    stateFile: ctx.store.file,
    engine: ctx.acp ? ctx.acp.describe() : "not available",
    runningJobs: ctx.jobs.running(),
    lastMinute,
    platform: process.platform,
    nodeVersion: process.versions.node,
  };
  const summary = formatStatus(input);
  const usage = { ...state.usage, estimatedTokensSaved: Math.round(state.usage.estimatedCharsSaved / CHARS_PER_TOKEN) };
  return withWarning(
    textResult(summary, {
      summary,
      enabled: state.enabled,
      setup: setupItems(input),
      geminiCli: cli,
      cooldowns: activeCooldowns(state, now),
      modelLimits: state.modelLimits,
      last7Days: week,
      usage,
      preferences: state.preferences,
      stateFile: ctx.store.file,
    }),
    ctx.store.takeWarning(),
  );
}

export interface StatusInput {
  state: BridgeState;
  cli: CliStatus;
  week: HistorySummary;
  now: Date;
  stateFile: string;
  engine: string;
  runningJobs: number;
  /** Input tokens sent per model in the last minute. */
  lastMinute?: Record<string, number>;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
}

export function formatStatus(input: StatusInput): string {
  const { state, cli, week, now, stateFile, engine, runningJobs } = input;
  const lines = [`Gemini bridge: ${state.enabled ? "ON" : "OFF"}`];
  const p = state.preferences;

  const setup = setupItems(input);
  lines.push(setup.length === 0 ? "Setup: all set" : `Setup: ${setup.length} thing(s) to fix:\n${setup.map((item) => `  - ${item}`).join("\n")}`);

  if (cli.installed) {
    const version = cli.version && cli.version !== "unknown" ? ` v${cli.version}` : " (version unknown)";
    const ripgrep = cli.ripgrep ? ` · ripgrep: ${cli.ripgrep.available ? "yes" : `no (${cli.ripgrep.detail})`}` : "";
    lines.push(`Gemini CLI: installed${version}${cli.path ? ` at ${cli.path}` : ""}${ripgrep}`);
    const auth = cli.authOk === true ? "OK" : cli.authOk === false ? "NOT signed in" : "unknown";
    lines.push(`Sign-in: ${auth}${cli.authDetail ? ` (${cli.authDetail})` : ""}`);
  } else {
    lines.push("Gemini CLI: NOT FOUND on PATH.");
  }

  lines.push(`Engine: ${p.engine} (warm process: ${engine})`);
  lines.push(
    `Models: fast tasks ${p.models.fast.join(" → ")}; strong tasks ${p.models.strong.join(" → ")}` +
      (p.model ? `; always first: ${p.model}` : ""),
  );
  const cooling = activeCooldowns(state, now);
  lines.push(
    cooling.length > 0
      ? `Cooling down: ${cooling.map((c) => `${c.model} (${c.reason}; until ${shortTime(c.until)})`).join("; ")}`
      : "Cooling down: none",
  );
  const limits = Object.entries(state.modelLimits);
  if (limits.length > 0) {
    lines.push(
      `Per-minute input-token limits (learned from Google's quota errors): ${limits
        .map(([model, l]) => `${model} ${compact(l.inputTokensPerMinute)}/min, ~${compact(input.lastMinute?.[model] ?? 0)} used in the last minute`)
        .join("; ")}`,
    );
  }

  if (week.calls > 0) {
    const models = Object.entries(week.byModel)
      .map(([model, s]) => `${model} ${s.ok} ok${s.failed ? `/${s.failed} failed` : ""}${s.ok ? ` avg ${(s.avgMs / 1000).toFixed(1)}s` : ""}`)
      .join("; ");
    lines.push(
      `Last 7 days: ${plural(week.calls, "call")} (${week.ok} ok, ${week.cached} cached, ${week.failed} failed)` +
        (week.avgMs ? `, avg ${(week.avgMs / 1000).toFixed(1)}s` : "") +
        (models ? `; ${models}` : ""),
    );
  }

  const u = state.usage;
  const byMode = Object.entries(u.callsByMode)
    .filter(([, n]) => n > 0)
    .map(([mode, n]) => `${mode} ${n}`)
    .join(", ");
  lines.push(
    `Usage: ${plural(u.totalCalls, "call")}, ${plural(u.totalErrors, "error")}${byMode ? ` (${byMode})` : ""}; ` +
      `${plural(u.cacheHits, "cache hit")}; ~${compact(u.estimatedCharsSaved)} chars (~${compact(u.estimatedCharsSaved / CHARS_PER_TOKEN)} tokens) of file content kept out of Claude's context` +
      (u.lastUsedAt ? `; last used ${u.lastUsedAt}` : ""),
  );
  if (runningJobs > 0) lines.push(`Background jobs running: ${runningJobs}`);

  const suggest = p.suggestDelegation;
  lines.push(
    `Preferences: timeout ${p.timeoutMs / 1000}s, cache ${p.cacheTtlMinutes ? `${p.cacheTtlMinutes} min` : "off"}, ` +
      `suggest delegating files ≥ ${suggest.minLines} lines: ${suggest.enabled ? "on" : "off"}, approval mode ${p.approvalMode}`,
  );
  lines.push(`State file: ${stateFile}${cli.checkedAt ? ` (CLI last checked ${cli.checkedAt})` : ""}`);
  return lines.join("\n");
}

/** What's missing from the setup, each with the exact command for this OS. Read by /gemini-claude-bridge:setup. */
export function setupItems({ cli, platform = process.platform, nodeVersion = process.versions.node }: StatusInput): string[] {
  const items: string[] = [];
  if (Number(nodeVersion.split(".")[0]) < 20) {
    items.push(`Node.js ${nodeVersion} is too old for the Gemini CLI: install Node 20 or newer (${nodeInstall(platform)}), then restart Claude Code.`);
  }
  if (!cli.installed) {
    items.push("The Gemini CLI is missing: run `npm install -g @google/gemini-cli`, then restart Claude Code.");
  } else if (cli.authMethod === "oauth-personal") {
    // Flagged regardless of authOk: this is about what Gemini CLI's terms allow a third-party
    // tool to do, not about whether the calls currently succeed (they often do).
    items.push(
      "Signed in with \"Sign in with Google\", but Gemini CLI's terms don't allow third-party tools like this bridge to use that sign-in (Google can suspend the account for it). Switch to a free API key: create one at https://aistudio.google.com/apikey, put `GEMINI_API_KEY=<key>` in `~/.gemini/.env`, then choose \"Gemini API key\" via `/auth` inside `gemini`.",
    );
  } else if (cli.authOk === false) {
    items.push(`Gemini isn't signed in: ${cli.authDetail ?? "create a free API key at https://aistudio.google.com/apikey and set it up per the README."}`);
  }
  if (cli.installed && cli.ripgrep && !cli.ripgrep.available) {
    items.push(`Optional, for faster searches: install ripgrep ${ripgrepInstall(platform)}.`);
  }
  return items;
}

function nodeInstall(platform: NodeJS.Platform): string {
  if (platform === "win32") return "`winget install OpenJS.NodeJS.LTS`";
  if (platform === "darwin") return "`brew install node`";
  return "your package manager or https://nodejs.org";
}

function ripgrepInstall(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "machine-wide, from an administrator terminal: `winget install --id BurntSushi.ripgrep.MSVC --scope machine` (the Gemini CLI ignores a per-user install)";
  }
  if (platform === "darwin") return "with `brew install ripgrep`";
  return "with `sudo apt install ripgrep` (or your distribution's package manager)";
}

function activeCooldowns(state: BridgeState, now: Date): Array<{ model: string; until: string; reason: string }> {
  return Object.entries(state.modelCooldowns)
    .filter(([, c]) => Date.parse(c.until) > now.getTime())
    .map(([model, c]) => ({ model, ...c }));
}

function shortTime(iso: string): string {
  return iso.replace(/:\d{2}\.\d{3}Z$/, "Z").replace("T", " ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function registerStatusTool(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "gemini_bridge_status",
    {
      title: "Gemini bridge status",
      description: STATUS_DESCRIPTION,
      inputSchema: statusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => handleStatus(ctx, args),
  );
}
