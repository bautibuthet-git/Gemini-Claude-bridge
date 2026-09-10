# Gemini ↔ Claude Bridge

A Claude Code plugin that lets Claude hand context-heavy subtasks to **Google Gemini** through your local, already signed-in [`gemini` CLI](https://github.com/google-gemini/gemini-cli): reading big files and logs, analyzing many files at once, second-opinion code reviews, boilerplate, plans.

Gemini reads the files itself, so their contents never enter Claude's context. That is where the token savings come from. The bridge never sees or stores an API key; it uses whatever the `gemini` CLI is signed in with.

Inspired by [andytargino/gemini-bridge](https://github.com/andytargino/gemini-bridge), with these improvements:

- **On/off by conversation.** Say "turn the Gemini bridge off" (or "apagá el bridge") and Claude flips it. No config files to edit.
- **Status and usage.** One tool reports whether the bridge is on, whether Gemini is installed and signed in, and how much context it has saved.
- **Two-command install.** It's a plugin, it works on native Windows, and there's no `cp`/`chmod`/bash setup.
- **Tested.** Unit tests plus a stdio smoke test against the built server.

## What you get

| Piece | What it does |
|---|---|
| `gemini_ask` tool | Delegates a task (prompt + optional files/folders + a mode) to Gemini and returns its text answer. |
| `gemini_bridge_status` tool | On/off, Gemini CLI install and sign-in, usage stats, preferences. |
| `gemini_bridge_toggle` tool | Turns delegation on or off. It persists across sessions and projects. |
| `/gemini-claude-bridge:gemini-ask` | Explicit command: `/gemini-claude-bridge:gemini-ask summarize C:\logs\build.log` |
| Session banner | A one-line status (e.g. `Gemini bridge: ON · Gemini CLI 0.59.0 · 12 delegated calls so far`) when a session starts. |

The three tools are always registered. When the bridge is off, `gemini_ask` refuses immediately without starting Gemini, and Claude does the work itself.

## Requirements

1. **Claude Code** (CLI, desktop app or IDE extension).
2. **Node.js 20+.** Claude Code starts the bridge with `node`. On Windows: `winget install OpenJS.NodeJS.LTS`.
3. **Gemini CLI, signed in:**
   ```bash
   npm install -g @google/gemini-cli
   gemini
   ```
   In `gemini`, choose **Sign in with Google**, finish in the browser, then type `/quit`.
4. **Access to this private repo**: the owner adds you as a collaborator on GitHub. You also need git credentials for GitHub. The easiest way is the GitHub CLI: run `gh auth login` and answer **Yes** to "Authenticate Git with your GitHub credentials".

## Install

```bash
claude plugin marketplace add https://github.com/bautibuthet-git/gemini-claude-bridge.git
claude plugin install gemini-claude-bridge@gemini-claude-bridge
```

Then fully restart Claude Code and ask Claude: **"check the gemini bridge status"**.

- The HTTPS URL is used on purpose. The `owner/repo` shorthand defaults to SSH, which only works if you have SSH keys set up with GitHub.
- On Windows, restart Claude Code after installing Node or the Gemini CLI; it picks up `PATH` only at launch. In the desktop app, quit it from the tray.
- The plugin installs at user scope, so it works in every project.

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
| "Use Gemini to summarize C:\logs\build.log" | `gemini_ask` with the file in `paths`; Claude never reads the log itself |
| "Have Gemini review src/auth/ for bugs" | `gemini_ask`, mode `review` |
| "Ask Gemini for a test plan for src/parser.ts" | `gemini_ask`, mode `test` |
| "Is the Gemini bridge on?" | `gemini_bridge_status` |
| "Turn the Gemini bridge off" / "apagá el bridge" | `gemini_bridge_toggle(false)` |
| "Turn it back on" / "prendé el bridge" | `gemini_bridge_toggle(true)` |

Claude may also delegate on its own when a task clearly fits, such as a huge file or a broad analysis. In v1 nothing is intercepted automatically: Claude decides per task, and turning the bridge off stops all delegation.

### `gemini_ask` parameters

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | required | Must stand alone: Gemini sees only the prompt and the files, not the conversation. |
| `paths` | none | Up to 20 files or folders. Absolute paths are preferred; relative ones resolve against the project folder. Folders are read recursively. |
| `mode` | `ask` | `ask` general · `analyze` explain code/architecture · `review` critical review with file/line citations · `refactor` behavior-preserving proposals · `plan` ordered implementation plan · `test` test cases plus code |
| `model` | Gemini CLI default | Model override. |
| `timeoutMs` | `120000` | 5 s to 30 min. When it expires, the whole Gemini process tree is killed. |
| `yolo` | `false` | Auto-approves Gemini's own tool calls (e.g. web fetches). Only on request. |

## How it works

1. Claude calls `gemini_ask`. If the bridge is off, the call returns `disabled` right away and no process starts.
2. The bridge makes the paths absolute and checks that they exist.
3. It builds the prompt: mode framing + the task + `@"<path>"` references (Gemini CLI's own file syntax) + a read-only guardrail. Any other `@` in the task text is escaped, so files get attached **only** through `paths`.
4. It runs `gemini --output-format json --skip-trust --approval-mode=default`. Two details:
   - **The prompt goes over stdin, not `-p`.** On Windows `gemini` is a `.cmd` shim run through cmd.exe, which cuts arguments at the first newline and at about 8 KB.
   - **Gemini runs from a bridge-owned empty folder** (`~/.gemini-claude-bridge/workspace`). The referenced folders and the project folder are added with `--include-directories`.
5. Gemini's CLI reads the files and answers. The bridge returns the text plus metadata: mode, model, duration, and an estimate of the tokens kept out of Claude's context.
6. A hard timeout (default 120 s) kills the whole process tree with `tree-kill`, so a hung or signed-out Gemini can never hang Claude.

| `errorType` | Meaning / what to do |
|---|---|
| `disabled` | The bridge is off. Claude does the task itself. |
| `not_installed` | `gemini` isn't on Claude Code's PATH. Install it, then restart Claude Code. |
| `not_authenticated` | Run `gemini` once and sign in. |
| `timeout` | Narrow the task, pass fewer paths, or raise `timeoutMs`. |
| `gemini_error` | Anything else the CLI reported (quota or rate limits, bad input, …), with its message. |
| `invalid_paths` | A path doesn't exist. Claude fixes it and retries. |

## Privacy and safety

- **What leaves your machine:** the prompt, the files in `paths`, and anything Gemini chooses to read inside the folders it's given (the referenced folders and the project folder). All of it goes to Google under your Gemini account's terms. Don't delegate secrets.
- **Read-only by default.** In headless mode the `default` approval mode denies every Gemini tool that needs approval (file edits, shell), and the prompt tells Gemini not to try. Claude is the only one that edits your files.
- **`--skip-trust` only applies to the bridge's own empty scratch folder.** So the bridge never loads a project's `.gemini/settings.json`, which could define MCP servers or hooks.

## Configuration

State lives in `~/.gemini-claude-bridge/state.json` (Windows: `C:\Users\<you>\.gemini-claude-bridge\state.json`):

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "preferences": { "model": null, "approvalMode": "default", "timeoutMs": 120000 },
  "geminiCli": { "lastDetectedVersion": "0.59.0", "lastAuthOk": true, "...": "..." },
  "usage": { "totalCalls": 12, "totalErrors": 1, "callsByMode": { "review": 5, "ask": 7 }, "estimatedCharsSaved": 812345 }
}
```

- You can edit `preferences` by hand: `model` (a model name, or `null` for the CLI default), `timeoutMs` (5000 to 1800000), `approvalMode` (`default` or `yolo`). Changes apply on the next call.
- A missing file means defaults. A corrupt file is backed up next to itself, reset, and reported once.
- Environment overrides:
  - `GEMINI_CLAUDE_BRIDGE_HOME`: where state is kept.
  - `GEMINI_CLAUDE_BRIDGE_GEMINI_BIN`: a specific `gemini` executable.

## Troubleshooting

- **Status says the Gemini CLI isn't found, but `gemini` works in your terminal.** Claude Code was started before Node or Gemini was installed. Restart it completely.
- **`not_authenticated`.** Run `gemini` in a terminal and sign in with Google.
- **Rate limit or quota errors.** These come from your Gemini account's limits. Wait, or let Claude do the task itself.
- **Very large answers.** Claude Code caps MCP tool results at about 25k tokens (`MAX_MCP_OUTPUT_TOKENS`). The bridge asks Gemini to be concise; for huge jobs, split the task.
- **Updating.** Run `claude plugin marketplace update gemini-claude-bridge`, then restart Claude Code.

## Development

```bash
git clone https://github.com/bautibuthet-git/gemini-claude-bridge.git
cd gemini-claude-bridge
npm install
npm run check
```

`npm run check` runs the typecheck, the unit tests, the build, and a stdio smoke test against a fake `gemini`.

Inner loop:

- `claude --plugin-dir .` loads the plugin in place for one session. It's the fastest way to iterate.
- `claude plugin marketplace add ./` followed by `claude plugin install gemini-claude-bridge@gemini-claude-bridge` exercises the real install path.

House rules:

- **Commit `src/` and the rebuilt `dist/index.js` together** (`npm run build`). `dist/` is committed on purpose: installing a plugin is a git clone with no build step, so the server ships pre-built and dependency-free.
- **`package-lock.json` is not committed.** When a plugin ships a lockfile, Claude Code runs `npm ci` in every user's plugin cache, which here would only download dev tooling. Versions are pinned exactly in `package.json` instead.
- **No `version` in `plugin.json` or `marketplace.json`.** That way installs track the latest commit. If you add a version, bump it on every release, or users keep their cached copy.

```text
.claude-plugin/     plugin.json + marketplace.json (self-referencing marketplace, source "./")
mcp-servers.json    starts node ${CLAUDE_PLUGIN_ROOT}/dist/index.js; referenced from plugin.json.
                    Deliberately not named .mcp.json: that name is also project-scoped MCP
                    config, so opening this repo in Claude Code would prompt to approve a
                    server whose ${CLAUDE_PLUGIN_ROOT} is undefined.
hooks/hooks.json    SessionStart banner (node dist/index.js --check, never blocks)
skills/gemini-ask/  /gemini-claude-bridge:gemini-ask
src/                TypeScript source (server, tools, gemini/, state/, util/)
dist/index.js       esbuild bundle, committed
scripts/            build, smoke test, postinstall check
test/unit/          vitest
```

## Not in v1

- Automatic delegation (intercepting large reads or greps without being asked).
- Providers other than Gemini.

## License

MIT
