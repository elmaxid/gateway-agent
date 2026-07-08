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
