---
name: gateway-cli-runtime
description: Internal helper contract for calling the gateway-companion runtime from Claude Code
user-invocable: false
---

# Gateway Runtime

Use this skill only inside the `gateway:gateway-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task "<raw arguments>"`

Available subcommands (reference only -- rescue subagent uses `task` exclusively):
- `setup` -- configure gateway profiles and endpoints
- `review` -- run a code review via direct HTTP to an alternative LLM
- `adversarial-review` -- run an adversarial review via direct HTTP
- `task` -- delegate a coding task via Claude subprocess to an alternative LLM
- `task-worker` -- internal worker process (do not call directly)
- `status` -- check job status
- `result` -- fetch job result
- `cancel` -- cancel a running job

Task invocation:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task [options] "prompt text"`
- Options:
  - `--profile NAME` -- use a named gateway profile (must be configured via /gateway:setup)
  - `--model MODEL` -- override the model for this task (e.g. deepseek-r1, minimax-01)
  - `--background` -- run the task in the background, return immediately with a job id
  - `--wait` -- run in foreground, block until completion (default)
  - `--write` -- allow the task to make file edits (default)
  - `--no-write` -- read-only mode, no file edits
  - `--json` -- output structured JSON instead of rendered text

Status check:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" status [--job-id ID]`

Environment:
- `CLAUDE_PLUGIN_ROOT` is set automatically by Claude Code at plugin load time.
- `GATEWAY_COMPANION_SESSION_ID` is set by the session lifecycle hook.
- Profiles must be configured first via `/gateway:setup`.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled HTTP calls, direct CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gateway:gateway-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repository, solve the task yourself, or add independent analysis outside the forwarded prompt text.

Safety rules:
- Default to write-capable gateway work unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the gateway cannot be invoked, return nothing.
