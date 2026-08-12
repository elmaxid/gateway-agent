---
description: Configure gateway endpoint profiles (add, remove, list, test, set-default, set-model, doctor, models)
argument-hint: "<add|remove|list|test|set-default|set-review-profile|set-task-profile|set-model|doctor|models|zero-init> [--profile <name>] [--url <url>] [--model <model>] [--kind <claude-gateway|openai-chat>] [--api-key <key>] [--auth-token <token>] [--max-context <n>] [--max-output <n>] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup "$ARGUMENTS"
```

Output rules:
- Present the command output to the user verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- If the output includes guidance on next steps or configuration instructions, preserve them exactly.

Note: `setup wizard` (interactive model picker — browse all models on an
endpoint, choose which ones to add by number, name each profile, pick a
default) is not reachable through this slash command — it forwards to a
non-interactive Bash call with no stdin attached, and `wizard` would hang
waiting for input. Run it directly in a real terminal, or via `!node
"${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup wizard` from the
Claude Code prompt.
