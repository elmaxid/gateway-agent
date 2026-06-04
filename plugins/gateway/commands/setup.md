---
description: Configure gateway endpoint profiles (add, remove, list, test, set-default, set-model)
argument-hint: "<add|remove|list|test|set-default|set-review-profile|set-task-profile|set-model> [--profile <name>] [--url <url>] [--model <model>] [--kind <claude-gateway|openai-chat>] [--api-key <key>]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup $ARGUMENTS
```

Output rules:
- Present the command output to the user verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- If the output includes guidance on next steps or configuration instructions, preserve them exactly.
