---
name: gateway-cli-runtime
description: Internal helper contract for calling the gateway-companion runtime from Claude Code
user-invocable: false
---

# Gateway Runtime

Use this skill inside the gateway forwarder subagents (`gateway:gateway-rescue`,
`gateway:gateway-coder`, `gateway:gateway-debugger`, `gateway:gateway-reviewer`,
`gateway:gateway-researcher`). They forward to `task`; `gateway:gateway-dispatcher`
forwards to `dispatch`.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" <subcommand> [options] [prompt]`

Available subcommands (forwarder agents use `task` — or `dispatch` for the dispatcher — exclusively):
- `setup` — configure gateway profiles: `add|remove|list|test|set-default|set-review-profile|set-task-profile|set-model|doctor|models|zero-init`
- `review` — one-pass code review via direct HTTP to an alternative LLM
- `adversarial-review` — two-pass review (find issues, then filter false positives)
- `staged-review` — two-phase review (spec extraction + adversarial pass)
- `debate` — multi-model debate with a synthesizer
- `task` — delegate a one-shot task to an alternative LLM via a harness subprocess
- `task-worker` — internal worker process (do not call directly)
- `dispatch` — run N tasks in parallel across profiles/models, worktree-isolated, optional cross-review
- `transfer` — transfer recent conversation window to a gateway model
- `status` / `result` / `cancel` — background job management

Task invocation:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task [options] "prompt text"`
- Options:
  - `--profile NAME` — use a named gateway profile (must be configured via /gateway:setup)
  - `--model MODEL` (`-m`) — override the model for this task (e.g. `glm-5.2`, `minimax-m3`, `deepseek-v4-pro`)
  - `--harness claude|codex|zero` — select execution harness (default: claude)
    - `claude` — stateless subprocess via `claude -p --bare` (fast, zero overhead; one-shot Q&A, research, review)
    - `codex` — stateful subprocess via `codex exec --json` (thread persistence, reasoning traces, real sandbox; implementation, debugging). If codex is not installed, falls back to claude automatically.
    - `zero` — one-shot agentic run via `zero exec` (fixed tool whitelist, no MCP/browser/swarm; JSONL event stream kept in the task log). **Fail-loud: NO fallback** — if the zero CLI is missing or its provider does not match the profile URL, the command errors with remediation (`npm i -g @gitlawb/zero`, `setup zero-init`) instead of silently switching harness.
  - `--as PERSONA` — server-side persona preamble applied by the companion itself: `coder|debugger|researcher|reviewer|security`, or `auto` (keyword matching). Do NOT combine with an agent-side preamble from `gateway-prompt-shaper` — pick one shaping mechanism per call.
  - `--background` — run in the background, return immediately with a job id (default is foreground: block until completion; there is no `--wait` flag)
  - `--write` — allow file edits (default) / `--no-write` — read-only mode
  - `--prompt-file FILE` — read the prompt from a file (use for long prompts, embedded diffs, multi-line text)
  - `--cwd DIR` — working directory for the delegated task
  - `--json` — structured JSON output instead of rendered text
  - Note: `task` has NO `--timeout` flag (timeouts exist on `review`/`debate`/`dispatch`). Unknown flags are not honored.

Zero harness prompt convention:
- Zero's rendered stdout is the model's **final message only**. Agentic models often close with a short meta remark and leave the real content mid-stream. For analysis/review delegations via `--harness zero`, end the prompt with: "Your final message must contain the complete output." The full event stream is always preserved in the task log (`rawJsonl`).

Dispatch invocation (dispatcher agent only):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" dispatch [--plan FILE | --task PROMPT:PROFILE ...] [--harness claude|codex|zero] [--max-concurrency N] [--timeout MS] [--write|--no-write] [--cross-review PROFILE] [--fail-fast] [--dry-run] [--json]`
- With `--harness zero`, every task profile must point at the URL of zero's single global provider; misaligned profiles are rejected pre-dispatch (exit 2), before dry-run and before any HTTP probe.
- With `--harness codex`, dispatch does NOT fall back to claude if codex is missing — it preflight-fails (exit 2), unlike `task --harness codex`, which does fall back to claude for `claude-gateway` profiles. Fail-loud in dispatch applies to both codex and zero, not just zero.

Status check:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" status [job-id] [--all] [--json]`

Environment:
- `CLAUDE_PLUGIN_ROOT` is set automatically by Claude Code at plugin load time.
- `GATEWAY_COMPANION_SESSION_ID` is set by the session lifecycle hook.
- Profiles must be configured first via `/gateway:setup` (fresh machine: `setup add`, then `setup test`; for zero additionally `setup zero-init` once per machine — see `setup doctor` for a full health check of all three harnesses).

Execution rules:
- Forwarder subagents are forwarders, not orchestrators: invoke the subcommand once and return its stdout unchanged.
- Prefer the helper over hand-rolled HTTP calls, direct CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from a forwarder subagent.
- Honor an explicit harness request from the user (`--harness zero`, "use zero", "con codex") — pass it through instead of the agent's default.
- Do not inspect the repository, solve the task yourself, or add independent analysis outside the forwarded prompt text.

Safety rules:
- Default to write-capable gateway work unless the user explicitly asks for read-only behavior; reviews/research default to `--no-write`.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the forwarded command exactly as-is.
- If the command fails, report its exit status and the stderr excerpt the runtime already redacted and truncated. Never convert a gateway failure into an empty response.
