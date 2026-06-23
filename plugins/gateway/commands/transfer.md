---
description: Transfer the current Claude Code session into a gateway model thread (window transfer)
argument-hint: "[--profile <name>] [--turns <N>] [continuation prompt]"
allowed-tools: Bash(node:*)
---

Transfer the current Claude Code session context to a gateway model.

Reads the transcript at $GATEWAY_TRANSCRIPT_PATH, extracts the last N conversation turns,
and sends them to the configured gateway endpoint as context for a new response.

This is a window transfer, not a session clone. The gateway model sees recent turns only.
For sessions where critical context is older than --turns turns, increase the window or re-frame the question.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" transfer "$ARGUMENTS"
```

Output rules:
- Present the command output to the user verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
