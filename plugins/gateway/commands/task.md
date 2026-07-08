---
description: Delegate investigation, fix, or task to an alternative LLM via Claude subprocess
argument-hint: "[--background|--wait] [--profile <name>] [--model <model>] [--harness claude|codex|zero] [--as persona] [--write|--no-write] [--prompt-file <path>] [what the model should do]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gateway:gateway-rescue` subagent via the `Agent` tool (`subagent_type: "gateway:gateway-rescue"`), forwarding the raw user request as the prompt.
`gateway:gateway-rescue` is a subagent, not a skill — do not call `Skill(gateway:gateway-rescue)` (no such skill) or `Skill(gateway:task)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be the gateway output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `gateway:gateway-rescue` subagent in the background.
- If the request includes `--wait`, run the `gateway:gateway-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--profile`, `--model`, `--write`, `--no-write`, `--harness`, `--as`, and `--prompt-file` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--harness claude|codex|zero` selects the execution harness (default: `claude`). `--as` selects a persona (`debugger`, `reviewer`, `security`, `researcher`, `coder`). `--prompt-file <path>` reads the task prompt from a file instead of the natural-language text.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task ...` and return that command's stdout as-is.
- Return the gateway companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/gateway:status`, fetch `/gateway:result`, call `/gateway:cancel`, summarize output, or do follow-up work of its own.
- Leave `--profile` unset unless the user explicitly asks for a specific profile.
- Leave `--model` unset unless the user explicitly asks for one.
- `--write` allows the gateway model to write files. `--no-write` disables file writes. Leave unset unless the user explicitly specifies.
- Leave `--harness`, `--as`, and `--prompt-file` unset unless the user explicitly asks for them.
- If the user did not supply a request, ask what the gateway model should investigate or do.
