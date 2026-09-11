# Gemini ↔ Claude Bridge

A Claude Code plugin that lets Claude hand context-heavy subtasks to **Google Gemini** through your local, already signed-in [`gemini` CLI](https://github.com/google-gemini/gemini-cli): reading big files and logs, analyzing many files at once, second-opinion code reviews, boilerplate, plans.

The bridge sends the files to Gemini itself, so their contents never enter Claude's context. That is where the token savings come from: one delegated summary of a 4,000-line log kept ~68k tokens out of Claude's context. The bridge never sees or stores an API key; it uses whatever the `gemini` CLI is signed in with.

Inspired by [andytargino/gemini-bridge](https://github.com/andytargino/gemini-bridge). Compared with it, this bridge:

- **Turns on and off by conversation.** Say "turn the Gemini bridge off" (or "apagá el bridge") and Claude flips it.
- **Reads big files correctly.** The Gemini CLI silently attaches only the first 2,000 lines of a file. The bridge sends files complete, with line numbers, so the error on line 2,817 isn't missed (measured: 95 s and half the file → 9 s and all of it).
- **Never gets stuck on quota.** Each model is tried in turn. One that's out of quota is abandoned within seconds, benched until its quota returns, and skipped on later calls.
- **Is fast.** It keeps one Gemini process warm between calls, skips the CLI's self-relaunch, and caches repeat questions.
- **Doesn't block Claude.** Long jobs can run in the background while Claude keeps working.
- **Nudges Claude.** Before Claude reads a big file whole, the bridge suggests delegating it.
- **Installs with two commands.** It's a plugin, it works on native Windows, and there's no `cp`/`chmod`/bash setup.
- **Is tested.** 155 unit tests plus a stdio smoke test that runs the built bundles end to end.

## What you get

| Piece | What it does |
|---|---|
| `gemini_ask` tool | Delegates a task (prompt + files/folders + mode + answer format) to Gemini and returns its text answer. |
| `gemini_result` tool | Collects the answer of a background `gemini_ask`, or lists the session's jobs. |
| `gemini_bridge_status` tool | On/off, CLI and sign-in, ripgrep, models cooling down, speed over the last 7 days, usage, preferences. |
| `gemini_bridge_toggle` tool | Turns delegation on or off. It persists across sessions and projects. |
| `/gemini-claude-bridge:gemini-ask` | Explicit command: `/gemini-claude-bridge:gemini-ask summarize C:\logs\build.log` |
| Session banner | `Gemini bridge: ON · Gemini CLI 0.59.0 · 12 delegated calls so far` when a session starts. |
| Read hook | When Claude is about to read a file of 800+ lines whole, it suggests `gemini_ask` instead. It only fires once per file per session: repeating the Read goes through. |

The tools are always registered. When the bridge is off, `gemini_ask` refuses immediately without starting Gemini, and Claude does the work itself.

## Requirements

1. **Claude Code** (CLI, desktop app or IDE extension).
2. **Node.js 20+.** Claude Code starts the bridge with `node`. On Windows: `winget install OpenJS.NodeJS.LTS`.
3. **Gemini CLI, signed in with *your own* account:**
   ```bash
   npm install -g @google/gemini-cli
   gemini
   ```
   In `gemini`, choose **Sign in with Google**, finish in the browser, then type `/quit`.

   If that fails with `IneligibleTierError` ("no longer supported for Gemini Code Assist for individuals"), use a free API key instead:
   - Create one at https://aistudio.google.com/apikey.
   - Put `GEMINI_API_KEY=<your key>` in `~/.gemini/.env` (Windows: `C:\Users\<you>\.gemini\.env`).
   - Pick **Gemini API key** via `/auth` inside `gemini`.

   The bridge itself never handles the key.
4. **Access to this private repo**: the owner adds you as a collaborator, and git needs credentials for GitHub:
   ```bash
   gh auth login
   gh auth setup-git
   ```
5. **Optional, recommended: ripgrep, installed machine-wide.** Gemini's searches get faster. The Gemini CLI only runs an `rg` located under Program Files or Windows, so a per-user install doesn't count. Run this from an **administrator** terminal:
   ```bash
   winget install --id BurntSushi.ripgrep.MSVC --scope machine
   ```

## Install

```bash
claude plugin marketplace add https://github.com/bautibuthet-git/Gemini-Claude-bridge.git
claude plugin install gemini-claude-bridge@gemini-claude-bridge
```

Then fully restart Claude Code and ask Claude: **"check the gemini bridge status"**.

- The HTTPS URL is used on purpose. The `owner/repo` shorthand defaults to SSH, which only works if you have SSH keys set up with GitHub.
- Installs track the latest commit (`claude plugin list` shows a commit SHA as the version).
- The plugin installs at user scope, so it works in every project.
- Each person uses their own Gemini account. Sharing the plugin never shares anyone's quota or key.

**Optional: no permission prompt on every call.** Add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_gemini-claude-bridge_gemini-claude-bridge__*"]
  }
}
```

## Use it

Just talk to Claude:

| You say | What happens |
|---|---|
| "Use Gemini to summarize C:\logs\build.log" | `gemini_ask`, mode `summarize`; Claude never reads the log itself |
| "Have Gemini review src/auth/ for bugs" | `gemini_ask`, mode `review` (strongest model with quota) |
| "Ask Gemini what else fails in that log" | a follow-up: Gemini still has the file, nothing is re-sent |
| "Have Gemini draft tests for these 5 files in the background" | `background: true`; Claude keeps working and collects it with `gemini_result` |
| "Is the Gemini bridge on?" | `gemini_bridge_status` |
| "Turn the Gemini bridge off" / "apagá el bridge" | `gemini_bridge_toggle(false)` |

Claude also delegates on its own when a task clearly fits, and the read hook reminds it when it's about to read a big file whole. Turning the bridge off stops all of it.

### `gemini_ask` parameters

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | required | Must stand alone: Gemini sees only the prompt and the files, not the conversation. |
| `paths` | none | Up to 20 files or folders. Files are sent complete with line numbers; folders are read recursively by the CLI. |
| `mode` | `ask` | `ask` · `summarize` (key facts, errors with line numbers) · `analyze` · `review` · `refactor` · `plan` · `test`. |
| `format` | none | What Claude needs back: "5 bullets", "only issues as file:line — problem — fix", "max 200 words". Shorter answers mean fewer tokens in Claude's context. |
| `followUp` | none | The id printed at the end of an earlier answer; continues that conversation. |
| `background` | `false` | Returns a job id at once; the answer is collected with `gemini_result`. |
| `fresh` | `false` | Ask Gemini again even if an identical question about unchanged files was answered recently. |
| `model` | the chain | Try this model first; the chain still backs it up. |
| `timeoutMs` | `180000` | Budget for the whole call, fallbacks included (5 s to 30 min). When it runs out, Gemini is stopped. |
| `yolo` | `false` | Auto-approves Gemini's own tool calls (e.g. web fetches). Only on request. |

## How it works

1. **The on/off check comes first.** If the bridge is off, the call returns `disabled` and no process starts.
2. **Files go into the prompt, complete.** Paths are made absolute and checked, and text files are sent inline with line numbers (up to 6 MB per call). Folders, binaries (images, PDFs) and oversized files are left as `@"<path>"` references for the CLI, with a warning that it only attaches their first 2,000 lines. Every other `@` is escaped, so the CLI never goes looking for files that were never asked for.
3. **The prompt is framed by mode.** It gets the mode's framing, the answer format and a read-only guardrail. Gemini may read and search freely, must not edit or run anything, and must cite line numbers.
4. **Models are tried in a chain.**
   - Fast tasks (`ask`, `summarize`, `analyze`) start with `gemini-3.1-flash-lite`.
   - Strong ones (`review`, `refactor`, `plan`, `test`) start with `pro`.
   - On a quota error the process is abandoned within ~2 s. The model is benched until its quota returns (next Pacific midnight for daily quotas, 24 h for "limit: 0", the stated delay for per-minute limits) and the next model is tried. A temporary error gets one retry.
5. **A warm process serves most calls.** Gemini runs as a persistent `gemini --acp` process: one warm process, one session per call, a follow-up reuses its session, and anything Gemini asks permission for is refused. Calls that need `@` references, or `yolo`, run as one-off `gemini` processes instead:
   - They use `--output-format json --skip-trust --approval-mode=default`.
   - The prompt goes over stdin, since cmd.exe cuts arguments at the first newline.
   - They run from a bridge-owned empty folder with the needed folders added via `--include-directories`.
6. **Guard rails bound every call.** A hard budget kills the whole process tree when it runs out. Progress notifications keep Claude Code informed while Gemini works. A complete answer is kept even if the CLI crashes while shutting down, which happens on Windows once ripgrep is installed.
7. **The answer comes back as text.** It ends with a footer: mode, model, time, warm or one-off, tokens kept out of Claude's context, any models it fell back past, and the `followUp` id. Identical questions about unchanged files are answered from a 24 h cache.

| `errorType` | Meaning / what to do |
|---|---|
| `disabled` | The bridge is off. Claude does the task itself. |
| `not_installed` | `gemini` isn't on PATH. Install it (the bridge also looks in the standard install folders). |
| `not_authenticated` | Run `gemini` once and sign in, or switch it to an API key (see Requirements). |
| `quota` | Every model in the chain is out of quota; the message says when each recovers. |
| `timeout` | Narrow the task, use `background: true`, or raise `timeoutMs`. |
| `gemini_error` | Anything else the CLI reported, with its message. |
| `invalid_paths` | A path doesn't exist. Claude fixes it and retries. |
| `unknown_job` | `gemini_result` got an id this session doesn't know. |

## Speed and the free tier

Measured on Windows with a free API key:

| | Time |
|---|---|
| Summarize a 4,000-line log, file inline, warm process | **9 s** (was 95 s with `@path` references) |
| Trivial question, one-off process (skipping the CLI's relaunch) | ~5–8 s |
| Review with two models out of quota before the one that answers | 21 s; each dead model cost ~1–2 s |

On a free key:

- `pro` has no quota at all, and `flash` allows about 20 requests a day. The chains handle this on their own; `gemini_bridge_status` shows which models are benched and until when.
- There is also a **per-minute token limit**: 250,000 input tokens per minute for flash-lite on the free tier. A 4,000-line log is a large share of that, so asking about it twice within a minute hits the limit; the Gemini CLI then waits and retries by itself (measured: the second call waited 64 s). A follow-up re-sends the conversation, file included, so it counts too.
  - When the wait happens, the progress message says so ("waits ~64s and retries").
  - If another model has quota, the bridge switches to it instead of waiting.
  - The cache avoids re-asking identical questions. Otherwise, space out big questions or use a paid key.

## Privacy and safety

- **What leaves your machine:** the prompt, the files you pass, and anything Gemini reads inside the folders it's given (the referenced folders and the project folder). All of it goes to Google under your Gemini account's terms. Don't delegate secrets.
- **Read-only by default.** One-off calls use headless `default` approval mode, which denies every tool that needs approval. The warm process answers every permission request with a refusal. The prompt also forbids edits and commands. Claude is the only one that edits your files.
- **`--skip-trust` only applies to the bridge's own empty scratch folder.** So no project's `.gemini/settings.json` (MCP servers, hooks) is ever loaded.

## Configuration

Everything lives in `~/.gemini-claude-bridge/` (Windows: `C:\Users\<you>\.gemini-claude-bridge\`):

| File | Contents |
|---|---|
| `state.json` | on/off, preferences, benched models, usage counters |
| `history.jsonl` | the last 500 calls (model, duration, outcome), for the 7-day stats |
| `cache/` | cached answers |
| `read-suggestions.json` | which big files the read hook already mentioned, per session |
| `workspace/` | the empty folder Gemini runs from |

Preferences in `state.json` (edit by hand; changes apply on the next call):

```json
{
  "preferences": {
    "model": null,
    "models": {
      "fast": ["gemini-3.1-flash-lite", "flash", "auto"],
      "strong": ["pro", "flash", "gemini-3.1-flash-lite"]
    },
    "engine": "auto",
    "timeoutMs": 180000,
    "cacheTtlMinutes": 1440,
    "suggestDelegation": { "enabled": true, "minLines": 800 },
    "approvalMode": "default"
  }
}
```

- `model` is tried first for every mode, before the chains. `"auto"`, `"pro"` and `"flash"` are Gemini CLI aliases that follow its current models.
- `engine` controls the warm process: `"auto"` uses it when a call allows, `"acp"` prefers it, `"cli"` uses one-off processes only.
- `cacheTtlMinutes: 0` turns the cache off.
- `suggestDelegation.enabled: false` turns off the read hook's suggestions.

A missing or partial file means defaults. A corrupt file is backed up next to itself, reset, and reported once.

Environment overrides:

- `GEMINI_CLAUDE_BRIDGE_HOME`: where all of the above is kept.
- `GEMINI_CLAUDE_BRIDGE_GEMINI_BIN`: a specific `gemini` executable.

## Troubleshooting

- **The bridge's tools never appear in the desktop app.** The app captures `PATH` when it launches; if Node was installed afterwards it can't start the server. Quit the app from the system tray (check Task Manager for leftover `claude` processes, or just reboot) and open a **new** conversation. You can confirm the cause in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-plugin-gemini-claude-bridge-gemini-claude-bridge\*.jsonl` (`'node' is not recognized`). A failed connection is also cached for about 15 minutes; `claude plugin marketplace update gemini-claude-bridge` clears it.
- **`not_authenticated`.** Run `gemini` in a terminal and sign in. With `IneligibleTierError`, signing in again won't help; switch to an API key.
- **`quota`, or answers only from flash-lite.** Your models are benched; `gemini_bridge_status` shows until when. That's the free tier working as designed.
- **Status says `ripgrep: no (installed outside Program Files…)`.** Reinstall it machine-wide from an administrator terminal (see Requirements).
- **Very large answers.** Claude Code caps tool results at about 25k tokens (`MAX_MCP_OUTPUT_TOKENS`). Ask for a tighter `format`, or split the task.
- **`claude plugin marketplace add` fails with "could not read Username".** Run `gh auth setup-git`.
- **Updating.** Run `claude plugin marketplace update gemini-claude-bridge`, then restart Claude Code.

## Development

```bash
git clone https://github.com/bautibuthet-git/Gemini-Claude-bridge.git
cd Gemini-Claude-bridge
npm install
npm run check
```

`npm run check` runs the typecheck, 155 unit tests, the build, and the smoke test. The smoke test drives the built bundles against a fake `gemini` that speaks both the one-shot JSON mode and ACP.

Inner loop:

- `claude --plugin-dir .` loads the plugin in place for one session.
- `claude plugin marketplace add ./` followed by `claude plugin install gemini-claude-bridge@gemini-claude-bridge` exercises the real install path.

House rules:

- **Commit `src/` and the rebuilt `dist/` together** (`npm run build`). `dist/` is committed on purpose: installing a plugin is a git clone with no build step. It holds two bundles:
  - `dist/index.js`: the MCP server plus the session banner.
  - `dist/read-hook.js`: the 5 KB Read hook, kept tiny because it runs before every Read.
- **`package-lock.json` is not committed.** When a plugin ships a lockfile, Claude Code runs `npm ci` in every user's plugin cache. Versions are pinned exactly in `package.json` instead.
- **No `version` in `plugin.json` or `marketplace.json`.** That way installs track the latest commit.

```text
.claude-plugin/     plugin.json + marketplace.json (self-referencing marketplace, source "./")
mcp-servers.json    starts node ${CLAUDE_PLUGIN_ROOT}/dist/index.js (not named .mcp.json, which is
                    also project-scoped MCP config and would prompt when this repo is opened)
hooks/hooks.json    SessionStart banner + PreToolUse(Read) suggestion; neither ever blocks for good
skills/gemini-ask/  /gemini-claude-bridge:gemini-ask
src/                server, tools/, gemini/ (attachments, prompts, models, runner, one-off + ACP
                    engines, detection), state/, cache, history, jobs, hooks/, util/
dist/               the two bundles, committed
scripts/            build, smoke test, postinstall check
test/unit/          vitest
```

## Not included

- Providers other than Gemini.
- Forcing delegation: the read hook only suggests, and Claude still decides.

## License

MIT
