---
name: gemini-ask
description: Delegate a task to Google Gemini through the Gemini bridge, e.g. /gemini-claude-bridge:gemini-ask summarize C:\logs\build.log
argument-hint: <task> [file or folder paths]
disable-model-invocation: true
---

Delegate this task to Gemini with the `gemini_ask` tool from the gemini-claude-bridge MCP server:

$ARGUMENTS

Delegate the reading, not the thinking: ask Gemini for the facts, locations and exact quotes you need, then draw the conclusions yourself. For example, ask for "every place user input reaches a SQL query, with the line" rather than "is this code secure?".

How to call it:

- `prompt`: the task, written so it stands on its own. Gemini sees only the prompt and the files, not this conversation, so include any context it needs.
- `paths`: every file or folder the task refers to, as absolute paths (max 20). Do **not** read those files yourself first. The bridge hands them to Gemini complete, with line numbers, and that is what saves context.
- `goal`: what the answer is for, e.g. "decide whether the nightly export needs a retry". Gemini keeps what matters for that and says when the material can't support it.
- `mode`: `summarize` for logs and documents, `review` for code review, `analyze` to explain code or data, `refactor` for refactoring suggestions, `plan` for implementation plans, `test` for test design, otherwise `ask`.
- `format`: exactly what you need back ("5 bullets", "only issues as file:line — problem — fix", "max 200 words").
- `thorough: true` for reviews and decisions that matter: Gemini re-checks its answer against the files. It takes about twice the time and quota (its time budget doubles too), so add `background: true` for big reviews.
- For a long job, add `background: true` and collect the answer later with `gemini_result`.
- Leave `model`, `timeoutMs`, `fresh` and `yolo` unset unless the user asked for them.

Then relay the answer concisely, and read what the bridge appends to it:

- Quote checks and ⚠ lines mean Gemini misquoted the file; trust the file's text shown there.
- "first pass" means the lightest model answered a judgment task. Verify its key findings in the code, by reading just the cited lines, before acting on them.
- Gemini's confidence tells you how much weight its answer can bear.

Gemini is read-only: if its answer calls for code changes, you make the edits. The answer ends with a `followUp` id; use it to ask Gemini more about the same material without resending the files. If the tool returns an error (bridge disabled, Gemini not installed or not logged in, out of quota, timeout), tell the user in one line and follow the hint included in the error.
