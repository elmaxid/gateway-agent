---
description: Run a 2-phase staged review — Phase 1 checks spec compliance, Phase 2 runs adversarial code quality review
argument-hint: "[--profile <name>] [--model <model>] [--base <ref>] [--scope <auto|branch|working-tree>] [--json] [--include-diff] [description]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a two-phase staged code review through a gateway-routed LLM endpoint.

Phase 1: Spec compliance — checks if the code matches the stated intent.
Phase 2: Adversarial code quality — finds issues, then filters false positives.

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
- `--base` and `--scope` specify the git ref range for the review.
- Any remaining text after flags is a description of what to review.

Execution:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" staged-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
