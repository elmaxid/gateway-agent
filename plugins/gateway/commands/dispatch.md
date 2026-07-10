---
description: Distribute tasks across multiple gateway LLM models in parallel with optional cross-review
argument-hint: "[--plan <file>|--task <prompt:profile>...] [--assign <ranges>] [--harness claude|codex|zero] [--cross-review <profile>] [--dry-run] [--json] [natural language description]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Dispatch implementation tasks across multiple gateway models in parallel.

The user's request may be:
1. **Structured CLI flags** (--plan, --task, --assign, etc.) — forward as-is
2. **Natural language** — parse intent and generate the CLI call

For natural language, extract:
- Plan file path (if mentioned)
- Task count per model (e.g., "3 to minimax, 3 to glm")
- Cross-review model (if mentioned)
- Any other flags

Then generate and execute:
```
node "$CLAUDE_PLUGIN_ROOT/scripts/gateway-companion.mjs" dispatch [flags]
```

## Examples

Natural language → CLI translation:

"implement plan tasks/plan.md with 3 tasks on minimax-m3, 3 on glm-5.2, cross-review with deepseek"
→ `dispatch --plan tasks/plan.md --assign "1-3:minimax,4-6:glm" --model-override minimax:minimax-m3 --model-override glm:glm-5.2 --cross-review deepseek-pro`

"run 4 tasks on minimax: add retry, fix auth, write tests, update docs"
→ `dispatch --task "add retry:minimax" --task "fix auth:minimax" --task "write tests:minimax" --task "update docs:minimax"`

Direct CLI passthrough:
$ARGUMENTS

## Rules

- Use exactly one `Bash` call to invoke `node "$CLAUDE_PLUGIN_ROOT/scripts/gateway-companion.mjs" dispatch ...`
- Return stdout verbatim — do not paraphrase or summarize
- For natural language requests, map model names to configured profiles. Use `setup list` to discover profile names if needed.
- If the user specifies task counts per model (e.g., "3 to minimax"), auto-distribute task IDs with --assign
- Add --dry-run first if the mapping is ambiguous, then confirm with user before running
- Do not inspect files, monitor progress, or do follow-up work
- When translating natural language into task text, state the action, why it matters, and explicit done-criteria (expected behavior, tests/checks to satisfy, constraints to preserve) — a bare imperative under-specifies delegated models more than it would Sonnet/Opus.
- Treat a task as failed when its dispatch status is `"failed"` (error/timeout) or its cross-review returns a critical finding. After two failures of the same task on the same profile+model, the next dispatch of that task must use a different profile or `--harness` — that means a new `/gateway:dispatch` invocation for that task, not a retry within this call. Operator policy only: `dispatch.mjs` does not track attempts or retry automatically.
- When a review profile distinct from every executor profile used in this dispatch is available, include `--cross-review <profile>` for it; skip it and say so if no distinct profile is configured. `--cross-review` is a single opt-in findings pass — it does not change the dispatch exit code. Check the `critical: N` line in the dispatch summary; if `N` > 0 for a task, apply that task's patch first (`git apply .gateway-dispatch/<job>/patches/task-NNN.patch`), then run `/gateway:adversarial-review` on the resulting working-tree diff before treating the task as resolved, and reset the apply afterward. Use `/gateway:staged-review` instead only if the diff's intent (not just its quality) is in doubt.
- `--plan <file>` content runs with full write+exec power inside an isolated worktree — treat plan files from untrusted provenance (issue trackers, prior model output, external contributors) as executable input, not inert text.
