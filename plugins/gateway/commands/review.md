---
description: Run a code review using an alternative LLM endpoint (Ollama, DeepSeek, MiniMax, etc.)
argument-hint: "[--profile <name>] [--model <model>] [--base <ref>] [--json] [--include-diff] [--no-tools] [--scope <auto|branch|working-tree>] [--timeout <ms>]"
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
- `--base <ref>` diffs the working tree against that ref (branch mode). There is no `--head` flag — the review always compares against the current working tree/HEAD, never an arbitrary head ref.
- `--scope <auto|branch|working-tree>` controls target selection when `--base` is absent: `auto` (default) picks working-tree changes if dirty, else falls back to a branch diff against the detected default branch; `working-tree` forces a working-tree diff; `branch` forces a branch diff against the detected default branch.
- `--json` requests JSON-formatted output.
- `--no-tools` skips the agentic tool-use loop and does a single direct HTTP review instead (see the `--timeout` note below for how this changes request-count behavior).
- `--timeout` sets the per-request timeout in milliseconds (default: 60000). In `--no-tools` mode, the review makes 1 HTTP request (bounded by the timeout). In default agentic mode, the review may make up to `maxIterations` requests; the tool loop's internal deadline scales with `--timeout` as `max(120000, timeout × 2)` (120s when `--timeout` is left at its default), so worst-case total wait ≈ that deadline + up to 4×the configured timeout (the in-flight call when the deadline passes, the loop's own terminal-turn retry-on-malformed-output, and forceFinish's call plus its own retry-on-malformed-output). Raise this for slow local models or large backends under load. If the model returns output that isn't shaped like a valid review (non-JSON, or JSON missing verdict/summary/findings) twice in a row (observed intermittently with some backends, e.g. minimax-m3, unrelated to `--timeout`), the review now fails explicitly (non-zero exit, output says "FAILED") instead of silently rendering the garbage as if it were a real review.
- This command does not take a free-text focus description — unlike `/gateway:adversarial-review` and `/gateway:staged-review`, `review` ignores any positional text after the flags.
- If no diff context is provided (no `--base`, and `--scope` left at its `auto` default), the review targets working-tree changes if the tree is dirty, else falls back to a branch diff.

Execution:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
