---
description: Run a task then automatically cross-review the changes with a different model
argument-hint: "--review <review-profile> [--profile <task-profile>] [--model <model>] [--harness claude|codex|zero|kimi|cline] [--as persona] [--write|--no-write] [--prompt-file <path>] [what to do]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Chain a gateway task with an automatic cross-model review of the resulting changes.
Two Bash calls: one for the task, one for the review. No subagent delegation.

Raw slash-command arguments:
`$ARGUMENTS`

## Required flag

`--review <profile>` — the gateway profile that will review the implementation. **Required.**
If missing, ask the user: "Which profile should review the implementation?"

## Argument splitting

Split `$ARGUMENTS` into two groups:

- **Review args**: extract and remove `--review <profile>` from the arguments.
- **Task args**: everything else passes through to the task command unchanged.

Do not add flags the user did not specify. Do not add `--background`.

## Self-review check

If `--review <profile>` is the same as `--profile <profile>` (or the same as the default profile when `--profile` is omitted), warn before running:
"Warning: same profile for task and review — cross-model review provides better independent verification."
Then proceed anyway.

## Step 1 — Run the task

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task <task-args>
```

- If `--no-write` is present, warn: "Note: --no-write is set — review may find no implementation changes to review."
- Report the task stdout **verbatim** to the user.
- If exit code is non-zero, report: "Task failed (exit <code>). Review skipped." and stop.

## Step 2 — Cross-model review (only if Step 1 exits 0)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" review --profile <review-profile> --include-diff --scope working-tree
```

- Report the review stdout **verbatim** after the task output, separated by a line:
  `--- Cross-model review (by <review-profile>) ---`

## Operating rules

- Two Bash calls maximum. No other tools except AskUserQuestion when a required flag is missing.
- Return both outputs verbatim. Do not paraphrase, summarize, or add commentary.
- Do not fix issues found in the review.
- Do not inspect files, monitor progress, or do follow-up work.
- If the user did not provide a task prompt and no `--prompt-file` was given, ask what the model should do.
