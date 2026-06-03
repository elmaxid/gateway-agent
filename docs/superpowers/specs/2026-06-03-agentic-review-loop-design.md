# Agentic Review Loop — Design Spec

**Date:** 2026-06-03  
**Status:** Approved  
**Scope:** gateway plugin (`/opt/agent-plugin-cc`)

---

## Problem

`/gateway:review` injects context upfront as a static prompt (one-shot HTTP POST, no tools). For large diffs or complex changes the model has no way to read additional files for context — it can only reason over what was pre-injected. `/codex:review` avoids this by giving the model tool access to the repo; it reads what it needs incrementally inside a read-only sandbox.

Goal: make `/gateway:review` behave like codex — model self-collects repo context via tools, no context-limit pressure from pre-injected diffs.

---

## Architecture

```
gateway-companion.mjs :: executeReviewRun
  └─ runAgenticReview(profile, cwd, target, opts)   ← agentic-review.mjs
       └─ runToolLoop(profile, messages, GIT_TOOLS)  ← agentic-review.mjs
            ├─ POST /v1/chat/completions (with tools[])
            ├─ finish_reason == "tool_calls" → dispatch → append results → repeat
            └─ finish_reason == "stop" → return content
```

`api-client.mjs` stays pure HTTP transport — only adds `tools`/`tool_choice` passthrough to the body.

---

## New File: `lib/agentic-review.mjs`

Responsibilities:
1. Define tool JSON schemas (`GIT_TOOLS`)
2. Implement `dispatch(toolName, args, cwd)` — executes tool, returns string result
3. Implement `runToolLoop(profile, messages, tools, opts)` — multi-turn driver
4. Implement `runAgenticReview(profile, cwd, target, opts)` — public entrypoint

### Tool Set

All tools are read-only. All execute with `cwd = repo root`. Timeout: 10s per call.

| Tool | Parameters | Executes |
|------|-----------|---------|
| `read_file` | `path: string` | `fs.readFile(resolved, "utf8")` — path must resolve within repoRoot |
| `git_diff` | `base?: string, staged?: boolean` | `git diff [--cached] [base..HEAD]` |
| `list_changed_files` | `base?: string` | `git diff --name-status [base..HEAD]` |
| `git_log` | `n?: number (default 10)` | `git log --oneline -N` |
| `git_show` | `ref: string` | `git show --stat ref` |

### `runToolLoop(profile, messages, tools, opts)`

```
maxIterations = opts.maxIterations ?? 10
iteration = 0
loop:
  response = await chatCompletion(profile, messages, { tools, tool_choice: "auto" })
  choice = response.choices[0]
  messages.push(choice.message)             // always append assistant message

  if choice.finish_reason == "stop":
    return choice.message.content

  if choice.finish_reason == "tool_calls":
    for each tool_call in choice.message.tool_calls:
      result = await dispatch(tool_call.function.name, JSON.parse(tool_call.function.arguments), cwd)
      messages.push({ role: "tool", tool_call_id: tool_call.id, content: result })

  else:
    throw Error("Unexpected finish_reason: " + choice.finish_reason)

  iteration++
  if iteration >= maxIterations:
    throw Error("Tool loop exceeded maxIterations=" + maxIterations)
```

Tool dispatch errors are caught per-call. On error: `content = "Error: <sanitized message>"`, loop continues — model decides next step.

### `runAgenticReview(profile, cwd, target, opts)`

1. Resolve `repoRoot` via `git rev-parse --show-toplevel`
2. Build system prompt: instructs model to review the target using tools, produce structured findings
3. Build initial user message: describes the review target (`target.label`, scope, base ref)
4. Call `runToolLoop(profile, messages, GIT_TOOLS, { cwd: repoRoot, ...opts })`
5. Return raw content string (caller parses findings)

System prompt instructs the model to:
- Start by calling `list_changed_files` to understand scope
- Use `git_diff` and `read_file` to gather evidence
- Produce a structured JSON review with `verdict` and `findings[]`

### Security: `read_file` path validation

```javascript
const resolved = path.resolve(repoRoot, userPath);
if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
  return "Error: path outside repository";
}
```

---

## Modified Files

### `lib/api-client.mjs`

`chatCompletion()` body — add 2 lines:

```javascript
...(opts.tools !== undefined && { tools: opts.tools }),
...(opts.tool_choice !== undefined && { tool_choice: opts.tool_choice }),
```

No other changes.

### `scripts/gateway-companion.mjs`

`executeReviewRun` (`:335`) — replace `runDirectReview` call with:

```javascript
import { runAgenticReview } from "./lib/agentic-review.mjs";

// inside executeReviewRun:
const content = await runAgenticReview(profile, cwd, target, {
  model: opts.model,
  maxIterations: 10,
});
```

Fallback: if `--no-tools` flag passed or profile kind is `openai-chat`, use existing `runDirectReview`.

---

## Safety & Edge Cases

| Case | Handling |
|------|---------|
| Loop exceeds 10 iterations | Throw with iteration count; surface to user |
| Tool execution timeout (>10s) | Catch, return `"Error: timeout"`, loop continues |
| `read_file` path traversal | Validate against repoRoot before reading |
| Tool returns large output | Cap at 32KB, append `"[truncated]"` |
| Model stops with no findings | Return content as-is; companion parses best-effort |
| Profile doesn't support tools | `--no-tools` flag → `runDirectReview` fallback |

---

## What This Does NOT Change

- `runDirectReview` stays as-is (fallback path)
- `adversarial-review` path unchanged (still two-pass inject)
- `debate`, `task`, `setup` subcommands unchanged
- `git.mjs` unchanged — tools in `agentic-review.mjs` call `git` directly via `child_process`, not via `git.mjs` helpers (simpler dispatch, avoids coupling)

---

## File Summary

| File | Change |
|------|--------|
| `lib/agentic-review.mjs` | **New** (~160 lines): tool schemas, dispatcher, loop driver, entrypoint |
| `lib/api-client.mjs` | +2 lines: `tools`/`tool_choice` passthrough in `chatCompletion` body |
| `scripts/gateway-companion.mjs` | ~10 lines changed: `executeReviewRun` calls `runAgenticReview` |

---

## Success Criteria

1. `node gateway-companion.mjs review` against a branch with changes → model calls tools, produces findings without diff pre-injected
2. Tool calls visible in `--json` output (tool_calls in message history)
3. Works against all 3 configured profiles (minimax, deepseek-pro, deepseek-flash)
4. `--no-tools` flag → falls back to `runDirectReview`, no regression
5. Path traversal attempt → rejected, review continues
