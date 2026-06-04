---
description: Run a two-pass adversarial code review — first pass finds issues, second pass filters false positives
argument-hint: "[--profile <name>] [--model <model>] [--base <ref>] [--head <ref>] [--include-diff]"
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
- `--base` and `--head` specify the git ref range for the review.
- Any remaining text after the flags is a description of what to focus the review on.

Execution:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
