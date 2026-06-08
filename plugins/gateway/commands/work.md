---
description: Auto-route a task to the best gateway persona (coder, debugger, reviewer, researcher) based on task keywords
argument-hint: "[--profile <name>] [--model <model>] [--harness <claude|codex>] \"your task description\""
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Auto-route the user's task to a specialized gateway persona agent based on keyword detection.

Raw slash-command arguments:
`$ARGUMENTS`

If the user did not supply a task description, ask what they need done.

Keyword routing:

Scan the task text (case-insensitive) for the first matching keyword group below. Check groups in this exact order — first match wins.

1. **debug** — keywords: `bug`, `error`, `fail`, `crash`, `broken`, `fix`, `debug`, `traceback`, `stacktrace`, `exception`
   Agent: `gateway:gateway-debugger`

2. **review** — keywords: `review`, `audit`, `check quality`, `inspect`, `PR`, `diff`, `code review`
   Agent: `gateway:gateway-reviewer`

3. **security** — keywords: `security`, `vulnerability`, `CVE`, `CVSS`, `exploit`, `injection`, `owasp`
   Agent: `gateway:gateway-rescue` — prepend `--as security` to the forwarded task text

4. **research** — keywords: `research`, `find all`, `list`, `inventory`, `map`, `explain`, `describe`, `explore`, `analyze`, `architecture`
   Agent: `gateway:gateway-researcher`

5. **coder** — keywords: `implement`, `build`, `create`, `add`, `refactor`, `write`, `update`, `modify`, `change`, `migrate`
   Agent: `gateway:gateway-coder`

6. **fallback** — no keyword matched
   Agent: `gateway:gateway-rescue`

This routing must be deterministic keyword matching, not LLM judgment. Do not reclassify based on your own interpretation of the task.

Flag handling:

- `--profile`, `--model`, `--harness`, `--write`, `--no-write` are runtime-selection flags. Preserve them in the forwarded task prompt for the selected agent.
- `--background` and `--wait` are execution-mode flags for the `Agent` tool call (background vs foreground). Do not forward them to the agent's task text.
- If neither `--background` nor `--wait` is present, default to foreground.
- Do not add `--profile`, `--model`, or `--harness` if the user did not specify them.

Execution:

Invoke the selected agent via the `Agent` tool (`subagent_type` set to the agent name from the table above), forwarding the task text and preserved flags as the prompt.

Operating rules:

- Return the persona agent's output verbatim to the user.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not add routing explanation or announce which persona was selected.
- Do not ask the subagent to do follow-up work beyond the forwarded task.
