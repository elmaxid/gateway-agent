---
description: Run a code review using an alternative LLM endpoint (Ollama, DeepSeek, MiniMax, etc.)
argument-hint: "[--profile <name>] [--model <model>] [--base <ref>] [--head <ref>] [--json] [--include-diff] [--scope <auto|branch|working-tree>] [--timeout <ms>] [description of what to review]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a gateway-routed code review through an alternative LLM endpoint.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the gateway output verbatim to the user.

Argument handling:
- Preserve the user's arguments exactly.
- `--profile` selects a configured gateway profile. Do not add one if the user did not specify it.
- `--model` overrides the model for this review. Do not add one if the user did not specify it.
- `--base` and `--head` specify the git ref range for the review.
- `--json` requests JSON-formatted output.
- `--timeout` sets the per-request timeout in milliseconds (default: 60000). In `--no-tools` mode, the review makes 1 HTTP request (bounded by the timeout). In default agentic mode, the review may make up to `maxIterations` requests (each bounded by the timeout — the total time is not capped). Raise this for slow local models or large backends under load.
- Any remaining text after the flags is a description of what to focus the review on.
- If no diff context is provided (no `--base`/`--head`), the review targets staged and unstaged changes.

Execution:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
