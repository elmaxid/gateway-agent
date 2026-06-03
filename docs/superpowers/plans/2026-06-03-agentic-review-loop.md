# Agentic Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tool-use loop to `/gateway:review` so the gateway model reads repo context incrementally (like codex) instead of receiving a pre-injected diff.

**Architecture:** New `lib/agentic-review.mjs` owns all loop logic: tool schemas, dispatcher, `runToolLoop`, `runAgenticReview`. `api-client.mjs` gets a 2-line change to forward `tools`/`tool_choice`. `gateway-companion.mjs::executeReviewRun` switches from `runDirectReview` to `runAgenticReview`; `--no-tools` flag preserves the old path.

**Tech Stack:** Node.js 18+ ESM, `node:child_process.spawn` (no shell), `node:fs/promises`, `node:path`, OpenAI-compatible chat completions API.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `plugins/gateway/scripts/lib/api-client.mjs` | Modify (2 lines) | Add `tools`/`tool_choice` passthrough to `chatCompletion` body |
| `plugins/gateway/scripts/lib/agentic-review.mjs` | **Create** (~260 lines) | Tool schemas, dispatcher, loop driver, public entrypoint |
| `plugins/gateway/scripts/gateway-companion.mjs` | Modify (~20 lines) | Wire `executeReviewRun` to agentic path; add `--no-tools` flag |

---

## Task 1: api-client.mjs — tools/tool_choice passthrough

**Files:**
- Modify: `plugins/gateway/scripts/lib/api-client.mjs:38-47`

- [ ] **Step 1: Read the file to confirm current state**

```bash
sed -n '36,50p' plugins/gateway/scripts/lib/api-client.mjs
```

Expected output shows `chatCompletion` body object ending with `stream: false` and no `tools` field.

- [ ] **Step 2: Add the two lines**

In `api-client.mjs`, inside the `body` object in `chatCompletion` (after `response_format` line, before `stream: false`):

```javascript
    ...(opts.response_format !== undefined && { response_format: opts.response_format }),
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.tool_choice !== undefined && { tool_choice: opts.tool_choice }),
    stream: false,
```

- [ ] **Step 3: Smoke test — verify tools reach the endpoint**

```bash
node --input-type=module <<'EOF'
import { chatCompletion } from './plugins/gateway/scripts/lib/api-client.mjs';
import { loadConfig } from './plugins/gateway/scripts/lib/config.mjs';
const cfg = loadConfig();
const profile = cfg.profiles['ollama-minimax'];
const TOOL = { type: "function", function: { name: "ping", description: "test", parameters: { type: "object", properties: {} } } };
const res = await chatCompletion(profile, [{ role: "user", content: "Call ping." }], { tools: [TOOL], tool_choice: "auto" });
console.log("finish_reason:", res.choices[0].finish_reason);
console.log("tool_calls:", JSON.stringify(res.choices[0].message.tool_calls ?? null));
EOF
```

Expected: `finish_reason: tool_calls`, `tool_calls` array with `name: "ping"`.

- [ ] **Step 4: Commit**

```bash
git add plugins/gateway/scripts/lib/api-client.mjs
git commit -m "feat: add tools/tool_choice passthrough to chatCompletion"
```

---

## Task 2: agentic-review.mjs — scaffold + tool schemas

**Files:**
- Create: `plugins/gateway/scripts/lib/agentic-review.mjs`

- [ ] **Step 1: Create the file with imports and GIT_TOOLS**

```javascript
/**
 * Agentic review loop — multi-turn tool-use driver for /gateway:review.
 * Model reads repo context incrementally via read-only git/fs tools.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { chatCompletion } from "./api-client.mjs";

const MAX_OUTPUT_BYTES = 32 * 1024;
const TOOL_TIMEOUT_MS = 10_000;
const VALID_REF = /^[A-Za-z0-9._\-/~^:]+$/;
const VALID_PATH_COMPONENT = /^[A-Za-z0-9._\-/]+$/;

export const GIT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a source file from the repository. Returns line-numbered content. Use start_line/end_line for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          start_line: { type: "number", description: "First line to read (1-based, inclusive, optional)" },
          end_line: { type: "number", description: "Last line to read (1-based, inclusive, optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff for the review target. Use paths[] to filter to specific files when the diff is large.",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string", description: "Base ref to diff against (e.g. 'main', 'HEAD~1')" },
          staged: { type: "boolean", description: "Show staged (cached) changes only" },
          paths: { type: "array", items: { type: "string" }, description: "Limit diff to these file paths" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_changed_files",
      description: "List files changed in the review target with their change type (M/A/D/R).",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string", description: "Base ref to compare against" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commit history as one-line summaries.",
      parameters: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of commits to show (default 10, max 50)" },
          branch: { type: "string", description: "Branch to show log for (default: current branch)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "Show the full diff and metadata of a specific commit.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Commit ref or hash to inspect" },
        },
        required: ["ref"],
      },
    },
  },
];
```

- [ ] **Step 2: Verify schemas parse cleanly**

```bash
node --input-type=module <<'EOF'
import { GIT_TOOLS } from './plugins/gateway/scripts/lib/agentic-review.mjs';
console.log(`${GIT_TOOLS.length} tools defined:`, GIT_TOOLS.map(t => t.function.name).join(', '));
EOF
```

Expected: `5 tools defined: read_file, git_diff, list_changed_files, git_log, git_show`

---

## Task 3: agentic-review.mjs — runCommand helper + dispatchTool

**Files:**
- Modify: `plugins/gateway/scripts/lib/agentic-review.mjs` (append)

- [ ] **Step 1: Append runCommand helper**

```javascript
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    const chunks = [];
    let totalBytes = 0;
    let done = false;

    const timer = setTimeout(() => {
      done = true;
      proc.kill();
      reject(new Error("timeout"));
    }, TOOL_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      if (totalBytes < MAX_OUTPUT_BYTES) {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    proc.on("close", () => {
      if (done) return;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const out = totalBytes >= MAX_OUTPUT_BYTES ? raw + "\n[truncated]" : raw;
      resolve(out);
    });

    proc.on("error", (err) => {
      if (done) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

- [ ] **Step 2: Append dispatchTool**

```javascript
async function dispatchTool(name, args, cwd, repoRoot) {
  try {
    switch (name) {
      case "read_file": {
        const { path: filePath, start_line, end_line } = args;
        const resolved = path.resolve(repoRoot, filePath);
        if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
          return "Error: path outside repository";
        }
        const buf = await fs.readFile(resolved).catch((e) => { throw e; });
        for (let i = 0; i < Math.min(buf.length, 512); i++) {
          if (buf[i] === 0) return "Error: binary file, cannot review";
        }
        const lines = buf.toString("utf8").split("\n");
        const start = start_line ? Math.max(1, start_line) : 1;
        const end = end_line ? Math.min(lines.length, end_line) : lines.length;
        const numbered = lines.slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join("\n");
        return numbered.length > MAX_OUTPUT_BYTES
          ? numbered.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
          : numbered;
      }

      case "git_diff": {
        const { base, staged, paths: filePaths } = args;
        if (base !== undefined && !VALID_REF.test(base)) return "Error: invalid ref";
        const gitArgs = ["diff"];
        if (staged) gitArgs.push("--cached");
        if (base) gitArgs.push(`${base}..HEAD`);
        if (filePaths?.length) {
          for (const p of filePaths) {
            if (!VALID_PATH_COMPONENT.test(p)) return "Error: invalid path in paths[]";
          }
          gitArgs.push("--", ...filePaths);
        }
        return runCommand("git", gitArgs, cwd);
      }

      case "list_changed_files": {
        const { base } = args;
        if (base !== undefined && !VALID_REF.test(base)) return "Error: invalid ref";
        const gitArgs = ["diff", "--name-status"];
        if (base) gitArgs.push(`${base}..HEAD`);
        return runCommand("git", gitArgs, cwd);
      }

      case "git_log": {
        const { n = 10, branch } = args;
        if (branch !== undefined && !VALID_REF.test(branch)) return "Error: invalid ref";
        const count = Math.min(50, Math.max(1, n || 10));
        const gitArgs = ["log", "--oneline", `-${count}`];
        if (branch) gitArgs.push(branch);
        return runCommand("git", gitArgs, cwd);
      }

      case "git_show": {
        const { ref } = args;
        if (!VALID_REF.test(ref)) return "Error: invalid ref";
        return runCommand("git", ["show", ref], cwd);
      }

      default:
        return `Error: unknown tool '${name}'`;
    }
  } catch (err) {
    return err.message === "timeout" ? "Error: timeout" : `Error: ${err.message}`;
  }
}
```

- [ ] **Step 3: Test dispatch isolation**

```bash
node --input-type=module <<'EOF'
// Inline test — no framework needed
const { GIT_TOOLS } = await import('./plugins/gateway/scripts/lib/agentic-review.mjs');

// We can't import dispatchTool directly (not exported) — test via runAgenticReview later.
// Verify the module loads without error.
console.log("Module loaded OK. Tools:", GIT_TOOLS.length);
EOF
```

Expected: `Module loaded OK. Tools: 5`

---

## Task 4: agentic-review.mjs — runToolLoop + forceFinish

**Files:**
- Modify: `plugins/gateway/scripts/lib/agentic-review.mjs` (append)

- [ ] **Step 1: Append forceFinish + runToolLoop**

```javascript
// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

async function forceFinish(profile, messages, opts) {
  const forced = [...messages, {
    role: "user",
    content: "You must now produce your final review as valid JSON only. No tool calls.",
  }];
  const response = await chatCompletion(profile, forced, { model: opts.model });
  return { content: response.choices[0].message.content ?? "", messages: forced };
}

export async function runToolLoop(profile, messages, tools, opts = {}) {
  const maxIterations = opts.maxIterations ?? 10;
  const maxTime = opts.maxTime ?? 120_000;
  const deadline = Date.now() + maxTime;
  let msgs = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() > deadline) return forceFinish(profile, msgs, opts);

    const response = await chatCompletion(profile, msgs, {
      model: opts.model,
      tools,
      tool_choice: "auto",
    });
    const choice = response.choices[0];
    msgs = [...msgs, choice.message];

    const reason = choice.finish_reason;

    if (reason === "stop" || reason === "length" || reason === "content_filter" || !reason) {
      return { content: choice.message.content ?? "", messages: msgs };
    }

    if (reason === "tool_calls") {
      for (const tc of choice.message.tool_calls ?? []) {
        let args;
        try { args = JSON.parse(tc.function.arguments); }
        catch { args = null; }
        const result = args === null
          ? "Error: malformed JSON arguments"
          : await dispatchTool(tc.function.name, args, opts.cwd, opts.repoRoot);
        msgs = [...msgs, { role: "tool", tool_call_id: tc.id, content: String(result) }];
      }
    } else {
      // unknown finish_reason — treat as stop
      return { content: choice.message.content ?? "", messages: msgs };
    }
  }

  return forceFinish(profile, msgs, opts);
}
```

- [ ] **Step 2: Test loop with a live tool call against the repo**

```bash
node --input-type=module <<'EOF'
import { runToolLoop, GIT_TOOLS } from './plugins/gateway/scripts/lib/agentic-review.mjs';
import { loadConfig } from './plugins/gateway/scripts/lib/config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cfg = loadConfig();
const profile = cfg.profiles['ollama-minimax'];
const cwd = process.cwd();
const repoRoot = cwd; // for this test, assume running from repo root

const messages = [
  { role: "system", content: "You are a code reviewer. Use list_changed_files to list changed files, then say DONE." },
  { role: "user", content: "List changed files vs HEAD~1, then say DONE and stop." },
];

const { content, messages: history } = await runToolLoop(profile, messages, GIT_TOOLS, {
  cwd,
  repoRoot,
  maxIterations: 5,
});

console.log("Final content:", content.slice(0, 300));
console.log("Total messages:", history.length);
const toolCalls = history.filter(m => m.role === "tool");
console.log("Tool calls made:", toolCalls.length);
EOF
```

Expected: at least 1 tool call message, final content contains model response, no crash.

---

## Task 5: agentic-review.mjs — runAgenticReview entrypoint + system prompt

**Files:**
- Modify: `plugins/gateway/scripts/lib/agentic-review.mjs` (append)

- [ ] **Step 1: Append SYSTEM_PROMPT constant and runAgenticReview**

```javascript
// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code reviewer with read-only access to a git repository.
Use the provided tools to gather evidence, then produce a structured JSON review.

Workflow:
1. Call list_changed_files to understand the scope of the review target.
2. For each significant file, call git_diff (filtered by path) or read_file for deeper context.
3. Call git_log or git_show to understand intent when commit history is relevant.
4. When you have sufficient evidence, stop calling tools and respond with valid JSON only.

Output schema (respond with ONLY this JSON — no markdown fences, no prose):
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "<one paragraph summary of the changes and your overall assessment>",
  "findings": [
    {
      "file": "<relative file path>",
      "line": <line number or null>,
      "severity": "critical" | "major" | "minor" | "nit",
      "title": "<short finding title>",
      "detail": "<detailed explanation and recommendation>"
    }
  ]
}

Rules:
- Always use start_line/end_line when reading large files — never request the whole file if you only need a section.
- Use paths[] in git_diff to filter to the file(s) you care about.
- Always use the base ref provided in the initial message for git_diff and list_changed_files.
- Your final message must be valid JSON only — the caller will JSON.parse it directly.`;

/**
 * Run an agentic review for the given target.
 * Returns { content: string, messages: array }.
 * content is the model's final message (expected to be valid JSON).
 */
export async function runAgenticReview(profile, cwd, target, opts = {}) {
  const repoRoot = (await runCommand("git", ["rev-parse", "--show-toplevel"], cwd)).trim();

  const baseInstruction = target.baseRef
    ? `For all git_diff and list_changed_files calls use base="${target.baseRef}".`
    : "Compare against the working tree (no base ref provided).";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Review target: ${target.label}`,
        `Mode: ${target.mode}`,
        target.baseRef ? `Base ref: ${target.baseRef}` : null,
        target.targetRef ? `Target ref: ${target.targetRef}` : null,
        "",
        baseInstruction,
        "Start by calling list_changed_files to understand the scope.",
      ].filter(Boolean).join("\n"),
    },
  ];

  return runToolLoop(profile, messages, GIT_TOOLS, {
    ...opts,
    cwd,
    repoRoot,
  });
}
```

- [ ] **Step 2: Full module smoke test**

```bash
node --input-type=module <<'EOF'
import { runAgenticReview, GIT_TOOLS, runToolLoop } from './plugins/gateway/scripts/lib/agentic-review.mjs';
console.log("Exports OK:", { runAgenticReview: typeof runAgenticReview, runToolLoop: typeof runToolLoop, GIT_TOOLS: GIT_TOOLS.length });
EOF
```

Expected: `Exports OK: { runAgenticReview: 'function', runToolLoop: 'function', GIT_TOOLS: 5 }`

- [ ] **Step 3: Commit**

```bash
git add plugins/gateway/scripts/lib/agentic-review.mjs
git commit -m "feat: add agentic-review.mjs — tool schemas, dispatcher, loop, entrypoint"
```

---

## Task 6: gateway-companion.mjs — wire up executeReviewRun

**Files:**
- Modify: `plugins/gateway/scripts/gateway-companion.mjs:10` (import line)
- Modify: `plugins/gateway/scripts/gateway-companion.mjs:335-380` (`executeReviewRun`)
- Modify: `plugins/gateway/scripts/gateway-companion.mjs:383-418` (`handleReview` — add `--no-tools` flag)

- [ ] **Step 1: Add import for runAgenticReview**

At line 10, the current import is:
```javascript
import { chatCompletion, runDirectReview, testConnectivity, listModels } from "./lib/api-client.mjs";
```

Add a new import line after it:
```javascript
import { runAgenticReview } from "./lib/agentic-review.mjs";
```

- [ ] **Step 2: Replace executeReviewRun body**

Current `executeReviewRun` (lines 335–381). Replace the entire function body with:

```javascript
async function executeReviewRun(request) {
  ensureGitRepository(request.cwd);

  const config = loadConfig();
  const profile = request.profile ?? resolveReviewProfile(config);
  const model = request.model || profile.defaultModel;
  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });

  // Fallback to pre-injected diff if --no-tools requested
  if (request.noTools) {
    const context = collectReviewContext(request.cwd, target, {
      includeDiff: request.includeDiff
    });
    const userPrompt = `Review target: ${target.label}\n\n${context.content}`;
    request.onProgress?.({ message: `Sending review to ${profile.name} (${model})...`, phase: "reviewing" });
    const result = await runDirectReview(profile, REVIEW_SYSTEM_PROMPT, userPrompt, {
      model,
      response_format: { type: "json_object" }
    });
    const rendered = renderReviewOutput(result, {
      reviewLabel: "Review",
      targetLabel: target.label,
      profileName: profile.name,
      model: result.model
    });
    return {
      exitStatus: 0,
      payload: { review: "Review", target, profile: profile.name, model: result.model, usage: result.usage, result: result.content },
      rendered,
      summary: (result.parsed && result.content?.summary) || firstMeaningfulLine(String(result.content), "Review completed."),
      jobTitle: "Gateway Review",
      jobClass: "review",
      targetLabel: target.label
    };
  }

  // Agentic path — model self-collects via tools
  request.onProgress?.({ message: `Starting agentic review via ${profile.name} (${model})...`, phase: "reviewing" });

  const { content, messages: msgHistory } = await runAgenticReview(profile, request.cwd, target, {
    model,
    maxIterations: 10,
    maxTime: 120_000,
  });

  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = null; }

  const rendered = renderReviewOutput(
    { content: parsed ?? content, model, usage: null, parsed },
    { reviewLabel: "Review", targetLabel: target.label, profileName: profile.name, model }
  );

  return {
    exitStatus: 0,
    payload: {
      review: "Review",
      target,
      profile: profile.name,
      model,
      usage: null,
      result: parsed ?? content,
      messages: msgHistory,
    },
    rendered,
    summary: parsed?.summary ?? firstMeaningfulLine(content, "Review completed."),
    jobTitle: "Gateway Review",
    jobClass: "review",
    targetLabel: target.label
  };
}
```

- [ ] **Step 3: Add --no-tools to handleReview option parsing**

At line 386–387, current:
```javascript
    booleanOptions: ["json", "background", "include-diff"],
```

Change to:
```javascript
    booleanOptions: ["json", "background", "include-diff", "no-tools"],
```

- [ ] **Step 4: Pass noTools through the request**

At line 408–416, current `executeReviewRun` call:
```javascript
      executeReviewRun({
        cwd,
        profile,
        model: options.model,
        base: options.base,
        scope: options.scope,
        includeDiff: options["include-diff"] || undefined,
        onProgress: progress
      }),
```

Change to:
```javascript
      executeReviewRun({
        cwd,
        profile,
        model: options.model,
        base: options.base,
        scope: options.scope,
        includeDiff: options["include-diff"] || undefined,
        noTools: options["no-tools"] || undefined,
        onProgress: progress
      }),
```

- [ ] **Step 5: Verify the file parses without error**

```bash
node --input-type=module --eval "import('./plugins/gateway/scripts/gateway-companion.mjs')" 2>&1 | head -5
```

Expected: no output (module loaded) or only the companion's normal startup. No SyntaxError.

- [ ] **Step 6: Commit**

```bash
git add plugins/gateway/scripts/gateway-companion.mjs
git commit -m "feat: wire executeReviewRun to runAgenticReview, add --no-tools fallback"
```

---

## Task 7: Integration Tests

**Files:** none modified — verification only

- [ ] **Test 1: Agentic review runs and produces findings**

Make sure there are uncommitted changes in the repo, then run:

```bash
node plugins/gateway/scripts/gateway-companion.mjs review --profile ollama-minimax
```

Expected:
- Progress message "Starting agentic review via..."
- Review output with verdict and findings
- No crash

- [ ] **Test 2: --json shows tool call history**

```bash
node plugins/gateway/scripts/gateway-companion.mjs review --profile ollama-minimax --json 2>/dev/null | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('messages:', j.payload?.messages?.length, 'tool calls:', j.payload?.messages?.filter(m=>m.role==='tool').length)"
```

Expected: `messages: N` and `tool calls: M` where M >= 1.

- [ ] **Test 3: --no-tools falls back to old path**

```bash
node plugins/gateway/scripts/gateway-companion.mjs review --profile ollama-minimax --include-diff --no-tools
```

Expected: works as before (diff pre-injected, no tool calls in output).

- [ ] **Test 4: Security — path traversal rejected**

```bash
node --input-type=module <<'EOF'
import { runToolLoop, GIT_TOOLS } from './plugins/gateway/scripts/lib/agentic-review.mjs';
import { loadConfig } from './plugins/gateway/scripts/lib/config.mjs';
const cfg = loadConfig();
const profile = cfg.profiles['ollama-minimax'];
const cwd = process.cwd();
// Simulate a model trying path traversal
const messages = [
  { role: "system", content: "You are a file reader. When asked, call read_file with the exact path given." },
  { role: "user", content: 'Call read_file with path="../../../etc/passwd"' },
];
const { content, messages: history } = await runToolLoop(profile, messages, GIT_TOOLS, {
  cwd,
  repoRoot: cwd,
  maxIterations: 3,
});
const toolResults = history.filter(m => m.role === "tool");
console.log("Tool results:", toolResults.map(m => m.content));
EOF
```

Expected: tool result contains `"Error: path outside repository"` — traversal blocked.

- [ ] **Test 5: Invalid ref rejected**

```bash
node --input-type=module <<'EOF'
import { runToolLoop, GIT_TOOLS } from './plugins/gateway/scripts/lib/agentic-review.mjs';
import { loadConfig } from './plugins/gateway/scripts/lib/config.mjs';
const cfg = loadConfig();
const profile = cfg.profiles['ollama-minimax'];
const cwd = process.cwd();
const messages = [
  { role: "system", content: "Call git_diff with base='main; rm -rf /'." },
  { role: "user", content: "Do it." },
];
const { messages: history } = await runToolLoop(profile, messages, GIT_TOOLS, {
  cwd, repoRoot: cwd, maxIterations: 3,
});
const toolResults = history.filter(m => m.role === "tool");
console.log("Tool results:", toolResults.map(m => m.content));
EOF
```

Expected: tool result contains `"Error: invalid ref"` — injection blocked.

- [ ] **Test 6: All three profiles**

```bash
for profile in ollama-minimax gateway-deepseek gateway-flash; do
  echo "--- $profile ---"
  node plugins/gateway/scripts/gateway-companion.mjs review --profile $profile 2>&1 | tail -5
done
```

Expected: all three complete without HTTP errors.

---

## Self-Review Checklist

### Spec Coverage

| Spec Requirement | Covered by Task |
|-----------------|----------------|
| `api-client.mjs` tools passthrough | Task 1 |
| GIT_TOOLS schemas | Task 2 |
| `dispatchTool` — spawn array args, no shell | Task 3 |
| `read_file` path traversal, binary detection, line numbering | Task 3 |
| Ref validation (VALID_REF regex) | Task 3 |
| Output cap 32KB | Task 3 |
| Tool timeout 10s | Task 3 |
| `runToolLoop` multi-turn driver | Task 4 |
| `finish_reason == "length"` → stop | Task 4 |
| `JSON.parse` args guarded | Task 4 |
| Max iterations → `forceFinish` (no throw) | Task 4 |
| Overall `maxTime` 120s | Task 4 |
| Unknown tool name → error string | Task 3 (`default` case) |
| `SYSTEM_PROMPT` with exact output schema | Task 5 |
| `target.baseRef` injected into user message | Task 5 |
| Return `{ content, messages }` | Task 4+5 |
| `gateway-companion.mjs` wired up | Task 6 |
| `--no-tools` fallback to `runDirectReview` | Task 6 |
| Integration tests vs all 3 profiles | Task 7 |
| Path traversal test | Task 7 Test 4 |
| Invalid ref test | Task 7 Test 5 |

### Type Consistency

- `runAgenticReview` → `runToolLoop` → `{ content: string, messages: array }` — consistent through Tasks 4, 5, 6.
- `dispatchTool` always returns `string` (catches all errors, returns error string) — safe for `String(result)` in Task 4.
- `chatCompletion` in Task 1 receives `tools` and `tool_choice` as `opts` fields — same `opts` shape used in Task 4.
- `target.baseRef` used in Task 5 matches shape returned by `resolveReviewTarget` (confirmed from existing code at line 341).
