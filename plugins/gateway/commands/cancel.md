---
description: Cancel a running gateway background task
argument-hint: "[--job-id <id>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" cancel $ARGUMENTS`
