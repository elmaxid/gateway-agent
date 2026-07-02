---
description: Run a multi-model debate between gateway LLM endpoints (positions, cross-critique, synthesis)
argument-hint: "[--models <profile1,profile2>] [--rounds <N>] [--synthesizer <profile>] [--mode <relaxed|strict>] [--timeout <ms>] [--max-concurrency <N>] [--base <ref>] [--scope <auto|branch|working-tree>] [--include-diff] [--json] \"question or topic\""
allowed-tools: Bash(node:*)
---

Run a structured multi-model debate through gateway-configured LLM endpoints.

Raw slash-command arguments:
`$ARGUMENTS`

Argument handling:
- `--models` specifies a comma-separated list of gateway profiles to participate in the debate. If omitted, the script uses the first 2 configured profiles (defaultProfile + next available).
- `--rounds` sets the number of debate rounds (default determined by the script).
- `--synthesizer` selects which profile produces the final synthesis.
- `--timeout` sets the per-request timeout in milliseconds (default: 60000). Raise this for slow local models or large backends under load.
- `--max-concurrency` limits how many simultaneous requests hit the same backend `baseUrl` (default: 1 — safe for single-slot local servers; raise it if your backend supports true parallel generation, e.g. vLLM with `--max-num-seqs`).
- `--mode relaxed|strict` sets the quorum required to proceed after the preflight health check (default: `relaxed`). `relaxed` needs a majority of `--models` reachable; `strict` needs all of them reachable.
- `--base <ref>`, `--scope <auto|branch|working-tree>`, and `--include-diff` pull a git diff into the debate question as extra context, same semantics as `/gateway:review`. Omit all three to debate without diff context.
- `--json` requests JSON-formatted output.
- Any remaining text after the flags is the debate question or topic.

Usage examples:
```
/gateway:debate "should we use sqlite or postgres for this project?"
/gateway:debate --models gateway-deepseek,ollama-minimax "review this sorting algorithm"
/gateway:debate --rounds 2 --synthesizer gateway-deepseek "compare REST vs GraphQL"
/gateway:debate --json "best approach for caching in this architecture"
/gateway:debate --models glm,minimax --timeout 180000 --max-concurrency 1 "review this caching strategy"
```

Execution:

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" debate "$ARGUMENTS"
```

Output rules:
- Present the command output to the user verbatim.
- Do not paraphrase, summarize, or add commentary before or after it.
- The output will be a structured markdown debate with positions, critiques, and synthesis.
