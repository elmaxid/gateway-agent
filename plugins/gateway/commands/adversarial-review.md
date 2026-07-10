---
description: Run a two-pass adversarial code review — first pass finds issues, second pass filters false positives
argument-hint: "[--profile <name>] [--model <model>] [--base <ref>] [--scope <auto|branch|working-tree>] [--json] [--include-diff] [--timeout <ms>] [focus]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a two-pass adversarial code review through a gateway-routed LLM endpoint.
The first pass finds issues and the second pass adversarially filters false positives.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the gateway output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Argument handling:
- Preserve the user's arguments exactly.
- `--profile` selects a configured gateway profile. Do not add one if the user did not specify it.
- `--model` overrides the model for this review. Do not add one if the user did not specify it.
- `--base <ref>` diffs the working tree against that ref (branch mode). There is no `--head` flag — the review always compares against the current working tree/HEAD, never an arbitrary head ref.
- `--scope <auto|branch|working-tree>` controls target selection when `--base` is absent, same as `/gateway:review`.
- `--json` requests JSON-formatted output. This command always uses a single direct HTTP call per pass — there is no agentic tool-use loop to opt out of (unlike `/gateway:review`, which supports `--no-tools`).
- `--timeout` sets the per-request timeout in milliseconds (default: 60000). This command makes two sequential HTTP requests (pass 1 finds issues, pass 2 filters false positives), so worst-case total wait ≈ 2×the configured timeout. Raise this for slow local models or large backends under load.
- Any remaining text after the flags is a description of what to focus the review on (the `[focus]` positional).

Execution:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
