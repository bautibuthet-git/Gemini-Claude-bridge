---
name: setup
description: Check and fix everything the Gemini bridge needs (Node.js, Gemini CLI, sign-in or API key, ripgrep), step by step. Run it right after installing the plugin, or whenever the bridge doesn't work.
disable-model-invocation: true
---

Walk the user through setting up the Gemini bridge. Reply in the user's language, keep each step short, and don't move on until the current step works.

1. Call `gemini_bridge_status` with `forceRefresh: true`.
   - If that tool is missing or fails to connect, the bridge's server couldn't start. The usual cause is that Node.js is missing, or that Claude Code was started before Node was installed.
   - Check with `node --version`; it needs version 20 or newer.
   - Install Node with `winget install OpenJS.NodeJS.LTS` (Windows), `brew install node` (macOS) or from https://nodejs.org.
   - Then the user must fully quit Claude Code (on Windows, from the system tray) and reopen it, and run `/gemini-claude-bridge:setup` again.
2. Read the status' `Setup:` section and fix each item it lists, in order, using the exact commands it shows:
   - **Gemini CLI missing:** `npm install -g @google/gemini-cli`, then restart Claude Code.
   - **Not signed in:** the user creates a free API key at https://aistudio.google.com/apikey, puts `GEMINI_API_KEY=<key>` in `~/.gemini/.env` (Windows: `C:\Users\<you>\.gemini\.env`), runs `gemini` once, and chooses "Gemini API key".
     - Never ask the user to paste the key into the chat, and never read or print the `.env` file.
   - **Signed in with "Sign in with Google" (the status item that starts "Signed in with \"Sign in with Google\"..."):** this is a setup problem even though calls may currently work. Gemini CLI's own terms don't allow a third-party tool (this bridge included) to use that sign-in, and it can get the account suspended — this applies even to a Google AI Pro/Ultra subscription (e.g. a student promo), which is exactly what makes that sign-in tempting for more quota. Tell the user plainly why, then walk them through the API key step above. Do not suggest working around this.
   - **ripgrep missing:** optional; it makes Gemini's searches faster. Use the command shown for their system. On Windows it must be installed machine-wide from an administrator terminal, because the Gemini CLI ignores a per-user install.
3. Run a tiny test: `gemini_ask` with the prompt `Reply with exactly: OK`. If it fails, follow the next step included in the error and try again.
4. Finish with two or three lines covering:
   - that the bridge works;
   - how to turn it off and on by just asking ("turn the Gemini bridge off", "apagá el bridge");
   - that `gemini_bridge_status` shows its state at any time.
