# Agentic Review Loop — Design Spec

**Date:** 2026-06-03  
**Status:** Approved (rev 2 — post model review)  
**Scope:** gateway plugin (`/opt/agent-plugin-cc`)

---

## Problem

`/gateway:review` injects context upfront as a static prompt (one-shot HTTP POST, no tools). For large diffs or complex changes the model has no way to read additional files for context — it can only reason over what was pre-injected. `/codex:review` avoids this by giving the model tool access to the repo; it reads what it needs incrementally inside a read-only sandbox.

Goal: make `/gateway:review` behave like codex — model self-collects repo context via tools, no context-limit pressure from pre-injected diffs.

---

## Architecture

```
gateway-companion.mjs :: executeReviewRun
  └─ runAgenticReview(profile, cwd, target, opts)     ← agentic-review.mjs
       └─ runToolLoop(profile, messages, GIT_TOOLS, opts)
            ├─ POST /v1/chat/completions (with tools[])
            ├─ finish_reason == "tool_calls" → dispatch → append results → repeat
            ├─ finish_reason == "stop" | "length" → return content
            └─ maxIterations reached → force final answer (no throw)
  returns { content, messages }
```

`api-client.mjs` stays pure HTTP transport — only adds `tools`/`tool_choice` passthrough to the body.

---

## `target` Object Structure

```javascript
{
  label: string,      // human-readable label ("branch foo vs main", "working-tree")
  mode: "branch" | "working-tree",
  baseRef: string,    // e.g. "main", "HEAD~3"
  targetRef?: string, // e.g. "feature/x" (omit for working-tree)
}
```

Initial user message tells the model: `"Review ${target.label}. For all diff/log tools use base=${target.baseRef}."` This ensures the model uses the correct base on every tool call without guessing.

---

## New File: `lib/agentic-review.mjs`

Responsibilities:
1. Define tool JSON schemas (`GIT_TOOLS`)
2. Implement `dispatch(toolName, args, cwd, repoRoot)` — executes tool safely, returns string
3. Implement `runToolLoop(profile, messages, tools, opts)` — multi-turn driver
4. Implement `runAgenticReview(profile, cwd, target, opts)` — public entrypoint

### Tool Set

All tools are read-only. All execute via `child_process.spawn` with **array args, no shell**. Timeout: 10s per call. Output capped at 32KB + `"[truncated]"`.

| Tool | Parameters | Executes |
|------|-----------|---------|
| `read_file` | `path: string, start_line?: number, end_line?: number` | `fs.readFile` — path validated within repoRoot; binary files rejected; output line-numbered |
| `git_diff` | `base?: string, staged?: boolean, paths?: string[]` | `git diff [--cached] [base..HEAD] [-- paths]` |
| `list_changed_files` | `base?: string` | `git diff --name-status [base..HEAD]` |
| `git_log` | `n?: number (default 10), branch?: string` | `git log --oneline -N [branch]` |
| `git_show` | `ref: string` | `git show ref` (full patch, no `--stat`) |

### Command Injection Mitigation

All git args come from model JSON. Rules in `dispatch`:
- Use `spawn(cmd, [arg1, arg2, ...], { shell: false })` — never string concatenation
- `base`, `ref`, `branch`: validate against `/^[A-Za-z0-9._\-/~^:]+$/` — reject on mismatch, return `"Error: invalid ref"`
- `paths`: each entry validated against `/^[A-Za-z0-9._\-/]+$/`
- `read_file` path: resolved against `repoRoot`, must stay within it (see below)

### `read_file` Path Validation & Binary Detection

```javascript
const resolved = path.resolve(repoRoot, userPath);
if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
  return "Error: path outside repository";
}
const buf = await fs.readFile(resolved);
if (buf.includes(0)) return "Error: binary file, cannot review";
const text = buf.toString("utf8");
const lines = text.split("\n");
const slice = (start_line && end_line)
  ? lines.slice(start_line - 1, end_line)
  : lines;
return slice.map((l, i) => `${(start_line ?? 1) + i}: ${l}`).join("\n")
  .slice(0, 32 * 1024);
```

### `runToolLoop(profile, messages, tools, opts)`

```
maxIterations = opts.maxIterations ?? 10
maxTime = opts.maxTime ?? 120_000  // overall wall-clock limit
deadline = Date.now() + maxTime
iteration = 0

loop:
  if Date.now() > deadline → force final answer (see below)

  response = await chatCompletion(profile, messages, { tools, tool_choice: "auto" })
  choice = response.choices[0]
  messages.push(choice.message)

  if finish_reason == "stop" | "length" | "content_filter":
    return { content: choice.message.content ?? "", messages }

  if finish_reason == "tool_calls":
    for each tool_call in choice.message.tool_calls:
      let args
      try { args = JSON.parse(tool_call.function.arguments) }
      catch { args = null }

      const result = args === null
        ? "Error: malformed JSON arguments"
        : await dispatchWithTimeout(tool_call.function.name, args, cwd, repoRoot)
      messages.push({ role: "tool", tool_call_id: tool_call.id, content: result })

  else:
    // unknown finish_reason — treat as stop
    return { content: choice.message.content ?? "", messages }

  iteration++
  if iteration >= maxIterations:
    → force final answer

force final answer:
  messages.push({ role: "user", content: "You must now produce your final review JSON." })
  const final = await chatCompletion(profile, messages, { tool_choice: "none" })
  return { content: final.choices[0].message.content ?? "", messages }
```

Unknown tool name in dispatch → `return "Error: unknown tool '${name}'"` — loop continues.

### `runAgenticReview(profile, cwd, target, opts)`

1. Resolve `repoRoot` via `git rev-parse --show-toplevel`
2. Build system prompt (see below)
3. Build initial user message with `target` info and explicit `base` instruction
4. Call `runToolLoop(profile, messages, GIT_TOOLS, { cwd: repoRoot, ...opts })`
5. Return `{ content, messages }`

### System Prompt

```
You are a code reviewer with read-only access to a git repository.
Use the provided tools to gather evidence, then produce a structured JSON review.

Workflow:
1. Call list_changed_files to understand scope.
2. For each significant change, call git_diff (filtered by path) or read_file for context.
3. Call git_log or git_show to understand intent when commit history is relevant.
4. When you have sufficient evidence, respond with only valid JSON:

{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "<one paragraph>",
  "findings": [
    {
      "file": "<path>",
      "line": <number or null>,
      "severity": "critical" | "major" | "minor" | "nit",
      "title": "<short title>",
      "detail": "<explanation>"
    }
  ]
}

Rules:
- Never request more than 32KB of file content at once; use start_line/end_line.
- For large diffs, use paths[] to filter to relevant files.
- Always use base=<provided base ref> for git_diff and list_changed_files.
- Your final response must be valid JSON only — no markdown fences, no prose.
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

`executeReviewRun` (`:335`) — replace `runDirectReview` call:

```javascript
import { runAgenticReview } from "./lib/agentic-review.mjs";

// inside executeReviewRun:
const { content, messages } = await runAgenticReview(profile, cwd, target, {
  model: opts.model,
  maxIterations: 10,
  maxTime: 120_000,
});
// pass messages to render if --json requested
```

Fallback: `--no-tools` flag or profile kind `openai-chat` → existing `runDirectReview` (diff still collected via `collectReviewContext` on that path).

---

## Safety & Edge Cases

| Case | Handling |
|------|---------|
| Loop hits `maxIterations` | Force final answer call with `tool_choice:"none"` — no throw |
| Overall `maxTime` exceeded | Force final answer immediately |
| `finish_reason == "length"` | Treat as stop, return partial content |
| Unknown `finish_reason` | Treat as stop, return content |
| `JSON.parse` fails on args | Return `"Error: malformed JSON arguments"` as tool result, continue |
| Unknown tool name | Return `"Error: unknown tool 'name'"`, continue |
| Tool execution timeout >10s | Return `"Error: timeout"`, continue |
| Tool output >32KB | Truncate + `"[truncated]"` |
| `read_file` path traversal | Validate, return `"Error: path outside repository"` |
| Binary file | Detect NUL bytes, return `"Error: binary file"` |
| Invalid ref/branch arg | Regex validate, return `"Error: invalid ref"` |
| Profile doesn't support tools | `--no-tools` → `runDirectReview` fallback |

---

## What This Does NOT Change

- `runDirectReview` stays as-is (fallback path)
- `adversarial-review` path unchanged
- `debate`, `task`, `setup` subcommands unchanged
- `git.mjs` unchanged

---

## File Summary

| File | Change |
|------|--------|
| `lib/agentic-review.mjs` | **New** (~250 lines): tool schemas, dispatcher, loop driver, entrypoint |
| `lib/api-client.mjs` | +2 lines: `tools`/`tool_choice` passthrough |
| `scripts/gateway-companion.mjs` | ~12 lines changed: `executeReviewRun` calls `runAgenticReview` |

---

## Success Criteria

1. `node gateway-companion.mjs review` against a branch → model calls tools, produces JSON findings without pre-injected diff
2. `--json` flag → output includes `messages` array with tool_calls history
3. Works against all 3 profiles (minimax, deepseek-pro, deepseek-flash)
4. `--no-tools` flag → fallback to `runDirectReview`, no regression
5. Path traversal attempt in `read_file` → rejected, review continues
6. Invalid ref in `git_diff` → rejected, review continues
7. Review completes within 120s wall-clock
