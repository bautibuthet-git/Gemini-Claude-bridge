---
name: gemini-ask
description: Delegate a task to Google Gemini through the Gemini bridge, e.g. /gemini-claude-bridge:gemini-ask summarize C:\logs\build.log
argument-hint: <task> [file or folder paths]
disable-model-invocation: true
---

Delegate this task to Gemini with the `gemini_ask` tool from the gemini-claude-bridge MCP server:

$ARGUMENTS

How to call it:

- `prompt`: the task, written so it stands on its own. Gemini sees only the prompt and the files, not this conversation, so include any context it needs.
- `paths`: every file or folder the task refers to, as absolute paths (max 20). Do **not** read those files yourself first. Gemini reads them directly, and that is what saves context.
- `mode`: `review` for code review, `analyze` to explain code or architecture, `refactor` for refactoring suggestions, `plan` for implementation plans, `test` for test design, otherwise `ask`.
- Leave `model`, `timeoutMs` and `yolo` unset unless the user asked for them.

Then relay Gemini's answer concisely. Gemini is read-only: if its answer calls for code changes, you make the edits. If the tool returns an error (bridge disabled, Gemini not installed or not logged in, timeout), tell the user in one line and follow the hint included in the error.
