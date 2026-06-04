# Security & Quality Fixes — 5 Validated Findings

**Date:** 2026-06-04  
**Source:** Dual-agent analysis (minimax-m3 + deepseek-v4-pro) + codex:rescue validation  
**Status:** PLANNED — awaiting implementation

---

## Context

5 real bugs confirmed by 3 independent agents. No false positives. Ordered by severity:
- Task 1 (High): auth key bypass via subprocessEnv
- Task 2 (Medium): agentic-review schema mismatch breaks field parsing
- Task 3 (Medium): state files world-readable + theoretical race
- Task 4 (Low): pickEnv/sanitizeError/terminateProcessTree duplicated
- Task 5 (Informational): dead code removal

---

## Task 1 — Fix subprocessEnv auth key bypass

**Severity:** High — profile.subprocessEnv can silently overwrite ANTHROPIC_API_KEY / OPENAI_API_KEY

### Root cause

In both subprocess builders, `Object.assign(env, profile.subprocessEnv)` runs **after** auth key assignments:

```
// claude-subprocess.mjs:34-39
env.ANTHROPIC_BASE_URL = profile.baseUrl;
env.ANTHROPIC_API_KEY = profile.apiKey || "";     // ← assigned first
env.ANTHROPIC_AUTH_TOKEN = profile.authToken || "";
if (profile.subprocessEnv) {
  Object.assign(env, profile.subprocessEnv);       // ← overwrites above
}
```

Same pattern in codex-harness.mjs:37-41.

### Fix

Move `Object.assign` **before** auth assignments so profile env is the base, not the override:

```js
// claude-subprocess.mjs — buildSubprocessEnv
export function buildSubprocessEnv(profile) {
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, profile.subprocessEnv);   // base layer
  }
  env.ANTHROPIC_BASE_URL = profile.baseUrl;      // always wins
  env.ANTHROPIC_API_KEY = profile.apiKey || "";
  env.ANTHROPIC_AUTH_TOKEN = profile.authToken || "";
  return env;
}
```

```js
// codex-harness.mjs — buildCodexEnv
export function buildCodexEnv(profile) {
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, profile.subprocessEnv);   // base layer
  }
  env.OPENAI_BASE_URL = profile.baseUrl;         // always wins
  env.OPENAI_API_KEY = profile.apiKey || profile.authToken || "";
  return env;
}
```

### Files
- `plugins/gateway/scripts/lib/claude-subprocess.mjs` — lines 32–41
- `plugins/gateway/scripts/lib/codex-harness.mjs` — lines 35–43

### Success criteria
- `npm test` passes (30/30)
- Manual check: config with `subprocessEnv: { ANTHROPIC_API_KEY: "evil" }` does NOT override auth key in env

---

## Task 2 — Align agentic-review output schema

**Severity:** Medium — severity labels and field names differ from direct review; render.mjs silently produces empty/wrong output

### Root cause

System prompt at `agentic-review.mjs:299-308` uses different taxonomy than direct review:

| Field | agentic-review (wrong) | direct review (correct) |
|-------|----------------------|------------------------|
| severity | `critical\|major\|minor\|nit` | `critical\|warning\|suggestion` |
| line ref | `"line": <number or null>` | `"line_start"`, `"line_end"` |
| explanation | `"detail": "..."` | `"body": "..."`, `"recommendation": "..."` |

`render.mjs` reads `finding.body`, `finding.recommendation`, `finding.line_start` — agentic findings have none of these → rendered as empty.

Also: `schemas/review-output.schema.json` is a dead third schema (no code imports it).

### Fix

Update the output schema block in the system prompt (lines 295-308 of agentic-review.mjs):

```js
// Replace the findings array item schema with:
{
  "file": "<relative file path>",
  "line_start": <line number or null>,
  "line_end": <line number or null>,
  "severity": "critical" | "warning" | "suggestion",
  "title": "<short finding title>",
  "body": "<detailed explanation>",
  "recommendation": "<specific fix recommendation>"
}
```

Delete `schemas/review-output.schema.json` (no imports, never used).

### Files
- `plugins/gateway/scripts/lib/agentic-review.mjs` — lines 295–308 (system prompt schema block)
- `plugins/gateway/schemas/review-output.schema.json` — DELETE

### Success criteria
- `npm test` passes
- Output of agentic review parsed by render.mjs shows non-empty body/recommendation fields
- No file imports `review-output.schema.json` (grep confirms)

---

## Task 3 — Fix state file permissions and document race

**Severity:** Medium (permissions: real; race: theoretical for single-user CLI)

### Root cause — permissions

Three `writeFileSync` calls omit `mode`, so umask decides (typically 0644 = world-readable). State files contain job IDs, status, output paths — should be 0600.

```
state.mjs:129   writeFileSync(tmpFile, ..., "utf8")    // ← no mode
state.mjs:185   writeFileSync(jobFile, ..., "utf8")    // ← no mode
tracked-jobs.mjs:62  writeFileSync(logFile, "", "utf8") // ← no mode
```

### Root cause — race

`updateState` at state.mjs:134 is a read-modify-write: two concurrent node processes (e.g., background job + CLI command) can both read state, both modify, last write wins — first write's changes lost.

`saveState` already uses tmp+rename (atomic single-write), so partial-write corruption is not possible. Only the application-level TOCTOU matters.

### Fix

**Permissions (must fix):** Add `{ mode: 0o600 }` to all three `writeFileSync` calls.

```js
// state.mjs:129
fs.writeFileSync(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

// state.mjs:185
fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

// tracked-jobs.mjs:62
fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
```

**Race (document, no fix needed now):** The race requires two gateway CLI processes running simultaneously on the same cwd. In practice this is rare for a single-user CLI tool. Add a short comment in `updateState` documenting the known limitation. A proper fix (mkdir-based lock or proper-lockfile) is scope for a future task.

### Files
- `plugins/gateway/scripts/lib/state.mjs` — lines 129, 185
- `plugins/gateway/scripts/lib/tracked-jobs.mjs` — line 62

### Success criteria
- `npm test` passes
- `stat` on a newly-written state file shows permissions `0600`

---

## Task 4 — Extract shared subprocess utilities

**Severity:** Low — duplication risk: a fix in one file doesn't propagate to the other

### Root cause

`pickEnv` and `terminateProcessTree` are copy-pasted identically between `claude-subprocess.mjs` and `codex-harness.mjs`. `process.mjs` already exports a richer `terminateProcessTree` (with SIGKILL fallback after timeout). `sanitizeError` is duplicated between `api-client.mjs` and `debate.mjs`.

### Fix

Create `lib/subprocess-utils.mjs` with `pickEnv` and re-export `terminateProcessTree` from `process.mjs`:

```js
// lib/subprocess-utils.mjs
export { terminateProcessTree } from "./process.mjs";

const ENV_WHITELIST = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "NODE_PATH", "TMPDIR", "TMP", "TEMP"
];

export function pickEnv(source) {
  const picked = {};
  for (const key of ENV_WHITELIST) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith("XDG_")) picked[key] = source[key];
  }
  return picked;
}
```

Move `sanitizeError` from `debate.mjs` into `api-client.mjs` (already there), import it in debate.mjs. Or extract to a third location — decide based on which callers exist.

Update `claude-subprocess.mjs` and `codex-harness.mjs` to import from `subprocess-utils.mjs`.

### Files
- `plugins/gateway/scripts/lib/subprocess-utils.mjs` — CREATE
- `plugins/gateway/scripts/lib/claude-subprocess.mjs` — remove local pickEnv + terminateProcessTree, import from utils
- `plugins/gateway/scripts/lib/codex-harness.mjs` — same
- `plugins/gateway/scripts/lib/debate.mjs` — import sanitizeError from api-client (or shared util)

### Success criteria
- `npm test` passes
- `grep -n "function pickEnv\|function terminateProcessTree" lib/claude-subprocess.mjs lib/codex-harness.mjs` returns nothing
- Single definition of each utility

---

## Task 5 — Delete dead code

**Severity:** Informational — dead code bloats, confuses, misleads

### Dead code inventory

| File | What | Evidence |
|------|------|---------|
| `lib/prompts.mjs` | exports `loadPromptTemplate`, `interpolateTemplate` | `grep -rn "from.*prompts"` → 0 matches |
| `lib/fs.mjs` | exports `ensureAbsolutePath`, `createTempDir`, `readJsonFile`, `writeJsonFile`, `safeReadFile` | `grep` shows only `isProbablyText` (git.mjs) and `readStdinIfPiped` (gateway-companion.mjs) used |
| `schemas/review-output.schema.json` | JSON schema file | already deleted in Task 2 |

### Fix

1. Delete `lib/prompts.mjs` entirely.
2. In `lib/fs.mjs`, remove the 5 unused exports — keep `isProbablyText` and `readStdinIfPiped`.
   - Remove: `ensureAbsolutePath`, `createTempDir`, `readJsonFile`, `writeJsonFile`, `safeReadFile`
   - Remove: `import os from "node:os"` if only used by `createTempDir`

### Files
- `plugins/gateway/scripts/lib/prompts.mjs` — DELETE
- `plugins/gateway/scripts/lib/fs.mjs` — remove 5 functions + unused import

### Success criteria
- `npm test` passes
- `node --input-type=module <<'EOF'
  import {} from "/opt/agent-plugin-cc/plugins/gateway/scripts/lib/fs.mjs"
  EOF` succeeds (no import errors)
- `ls lib/prompts.mjs` → not found

---

## Implementation order

```
Task 1 (High security)   → test → commit
Task 2 (Medium, schema)  → test → commit
Task 3 (Medium, perms)   → test → commit
Task 4 (Low, cleanup)    → test → commit
Task 5 (Info, dead code) → test → commit
```

Each task is independent. Safe to stop after any commit.

## Personas for subagent-driven-development

| Task | Implementer model | Why |
|------|------------------|-----|
| 1 | haiku | Surgical 2-line reorder, no logic change |
| 2 | sonnet | Needs to read system prompt context + understand schema semantics |
| 3 | haiku | Mechanical: add `{ mode: 0o600 }` + comment |
| 4 | sonnet | Multi-file refactor, import wiring |
| 5 | haiku | Mechanical: delete functions, remove import |
