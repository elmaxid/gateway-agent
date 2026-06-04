# Bug Fix Plan — Post-Review Findings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bugs and UX issues found by the multi-agent project review (2026-06-04).

**Architecture:** Surgical fixes across 5 files. No refactors. Each task is independent.

**Tech Stack:** Node.js ESM, no build step. Run tests with `node --test tests/*.test.mjs`.

---

## Files touched

| File | Change |
|------|--------|
| `plugins/gateway/scripts/lib/api-client.mjs` | Fix AbortSignal leak + TextDecoder flush |
| `plugins/gateway/scripts/lib/debate.mjs` | Surface errors instead of swallowing them |
| `plugins/gateway/scripts/lib/config.mjs` | Warn on corrupt config + runtime kind check |
| `plugins/gateway/hooks/hooks.json` | Align Stop hook timeout with actual cap |
| `plugins/gateway/commands/setup.md` | Fix `--auth-token` → `--api-key` |
| `plugins/gateway/commands/review.md` | Add `--include-diff`, `--scope` to argument-hint |
| `plugins/gateway/commands/adversarial-review.md` | Add `--include-diff` to argument-hint |
| `plugins/gateway/agents/gateway-rescue.md` | Add prompt shaping (generic senior-engineer preamble) |

---

## Task 1: Fix TextDecoder not flushed at stream end (`api-client.mjs`)

**File:** `plugins/gateway/scripts/lib/api-client.mjs`

**Problem:** `decoder.decode(value, { stream: true })` never flushed → last UTF-8 multibyte frame silently truncated.

- [ ] Read `api-client.mjs` fully.

- [ ] After the `while (true)` loop ends (`if (done) break;`), add a flush before processing remaining buffer:

```javascript
// After: while (true) { ... if (done) break; ... }
// The decoder may hold partial UTF-8 bytes — flush them now
buffer += decoder.decode(); // no args = flush
```

The flush goes right after the `while` loop closes, before the `if (buffer.trim())` block.

- [ ] Run tests:
```bash
cd /opt/agent-plugin-cc && node --test tests/api-client.test.mjs
```
Expected: all pass.

- [ ] Commit:
```bash
git add plugins/gateway/scripts/lib/api-client.mjs
git commit -m "fix: flush TextDecoder after SSE stream ends to prevent UTF-8 truncation"
```

---

## Task 2: Fix AbortSignal listener leak (`api-client.mjs`)

**File:** `plugins/gateway/scripts/lib/api-client.mjs`

**Problem (lines ~87-96):** `onAbort` listener attached to `externalSignal` with `{ once: true }` but never removed if stream ends normally before the signal fires.

- [ ] Read the `chatCompletionStream` function.

- [ ] In the `finally` block (where `reader.releaseLock()` is called), add listener removal:

```javascript
} finally {
  if (idleTimer) clearTimeout(idleTimer);
  reader.releaseLock();
  // Remove external signal listener to prevent stale abort on future streams
  if (externalSignal && !externalSignal.aborted) {
    externalSignal.removeEventListener("abort", onAbort);
  }
}
```

Note: `onAbort` must be hoisted out of the `if` block so it's in scope. Refactor the signal wiring:

```javascript
// Replace the existing externalSignal block with:
let onAbort = null;
if (externalSignal) {
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    onAbort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener("abort", onAbort, { once: true });
  }
}
```

Then in `finally`:
```javascript
} finally {
  if (idleTimer) clearTimeout(idleTimer);
  reader.releaseLock();
  if (onAbort && externalSignal) {
    externalSignal.removeEventListener("abort", onAbort);
  }
}
```

- [ ] Run tests:
```bash
cd /opt/agent-plugin-cc && node --test tests/api-client.test.mjs
```

- [ ] Commit:
```bash
git add plugins/gateway/scripts/lib/api-client.mjs
git commit -m "fix: remove AbortSignal listener in chatCompletionStream finally block to prevent listener leak"
```

---

## Task 3: Surface debate errors instead of swallowing them (`debate.mjs`)

**File:** `plugins/gateway/scripts/lib/debate.mjs`

**Problem (line ~53):** `safeCompletion` catches network errors and injects `[Error: …]` strings as model output. The synthesis round then summarizes the error string as real content.

- [ ] Read `debate.mjs` fully.

- [ ] Change `safeCompletion` to propagate errors to the `onProgress` callback AND mark the position as failed so synthesis skips it:

```javascript
async function safeCompletion(profile, messages, opts, label, onProgress) {
  try {
    const result = await chatCompletion(profile, messages, opts);
    return result.choices[0].message.content ?? "";
  } catch (err) {
    const errMsg = `[Error from ${label}: ${err.message}]`;
    if (onProgress) onProgress({ type: "error", label, message: err.message });
    console.error(`[debate] ${errMsg}`);
    return null; // null = failed, skip in synthesis
  }
}
```

- [ ] Find where `safeCompletion` results are used (positions array, critiques array). Filter out `null` values before building synthesis prompt:

```javascript
const validPositions = positions.filter(p => p.content !== null);
if (validPositions.length === 0) throw new Error("All debate participants failed to respond");
```

Apply same null-filter to critiques.

- [ ] Run tests (if any exist for debate):
```bash
cd /opt/agent-plugin-cc && node --test tests/*.test.mjs 2>&1 | tail -20
```

- [ ] Commit:
```bash
git add plugins/gateway/scripts/lib/debate.mjs
git commit -m "fix: surface debate participant errors via onProgress and skip failed positions in synthesis"
```

---

## Task 4: Warn on corrupt config, fix openai-chat runtime rejection (`config.mjs`)

**File:** `plugins/gateway/scripts/lib/config.mjs`

Two sub-fixes:

**4a — Corrupt config.json:** Currently silent fallback to empty config.

- [ ] Read `config.mjs`.

- [ ] In `loadConfig`, distinguish ENOENT (normal, no config yet) from parse errors:

```javascript
export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    // Corrupt file — warn loudly instead of silently returning empty config
    console.error(`[gateway] Warning: config file is corrupt or unreadable (${CONFIG_PATH}): ${err.message}`);
    console.error(`[gateway] Delete it and run setup again: rm "${CONFIG_PATH}"`);
    return { ...DEFAULT_CONFIG };
  }
}
```

**4b — openai-chat kind rejected silently at task time:** `resolveTaskProfile` throws if profile kind is not `claude-gateway`. Add check at `setup add` time instead.

- [ ] In `validateProfile` (or wherever setup stores new profiles), add a warning if kind is `openai-chat` and user is adding a task-profile:

Actually the simpler fix: update the `resolveTaskProfile` error message to explain the constraint:

```javascript
// Current: throw new Error(`Profile ${name} is not a claude-gateway profile`)
// Replace with:
throw new Error(
  `Profile "${name}" has kind "${profile.kind}" — task subcommand requires kind "claude-gateway". ` +
  `Use a different profile or re-add this profile with --kind claude-gateway.`
);
```

- [ ] Commit:
```bash
git add plugins/gateway/scripts/lib/config.mjs
git commit -m "fix: warn on corrupt config.json, improve resolveTaskProfile error message for wrong kind"
```

---

## Task 5: Fix hooks.json Stop timeout (`hooks.json`)

**File:** `plugins/gateway/hooks/hooks.json`

**Problem:** Stop hook timeout = 900, but `stop-review-gate-hook.mjs` caps at 120s (`MAX_WAIT_MS = 2 * 60 * 1000`).

- [ ] Read `hooks.json` and `scripts/stop-review-gate-hook.mjs` to confirm `MAX_WAIT_MS`.

- [ ] Change Stop hook timeout from `900` to `125` (120s cap + 5s buffer for Node startup):

```json
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
  "timeout": 125
}
```

- [ ] Commit:
```bash
git add plugins/gateway/hooks/hooks.json
git commit -m "fix: align Stop hook timeout (125s) with actual MAX_WAIT_MS cap in stop-review-gate-hook"
```

---

## Task 6: Fix CLI command definitions (3 files)

**Files:** `commands/setup.md`, `commands/review.md`, `commands/adversarial-review.md`

**6a — setup.md:** `argument-hint` says `--auth-token` but correct flag is `--api-key`.

- [ ] Read `commands/setup.md`.
- [ ] Replace `--auth-token <token>` with `--api-key <key>` in the argument-hint.

**6b — review.md:** Missing `--include-diff` and `--scope` from argument-hint.

- [ ] Read `commands/review.md`.
- [ ] Add to argument-hint: `--include-diff --scope <auto|branch|working-tree>`

**6c — adversarial-review.md:** Missing `--include-diff` from argument-hint.

- [ ] Read `commands/adversarial-review.md`.
- [ ] Add to argument-hint: `--include-diff`

- [ ] Commit all 3:
```bash
git add plugins/gateway/commands/setup.md plugins/gateway/commands/review.md plugins/gateway/commands/adversarial-review.md
git commit -m "fix: correct --auth-token typo in setup.md, add missing flags to review/adversarial-review argument-hints"
```

---

## Task 7: Add prompt shaping to gateway-rescue agent

**File:** `plugins/gateway/agents/gateway-rescue.md`

**Problem:** Only agent without prompt shaping — the generic fallback is also the one most likely to produce mediocre output without framing.

- [ ] Read `agents/gateway-rescue.md` and `agents/gateway-coder.md` to understand shaping pattern.

- [ ] Read `skills/gateway-prompt-shaper/SKILL.md` to understand how prompt shaping works.

- [ ] Add a generic senior-engineer preamble to `gateway-rescue`. It should:
  - Frame the model as a pragmatic senior software engineer
  - Ask it to assess the task type first (implementation? debug? review? research?) before acting
  - Keep it short — rescue is a catch-all, not a specialist

- [ ] Commit:
```bash
git add plugins/gateway/agents/gateway-rescue.md
git commit -m "feat: add prompt shaping to gateway-rescue agent (generic senior-engineer framing)"
```

---

## Verification

After all tasks:

```bash
cd /opt/agent-plugin-cc && node --test tests/*.test.mjs
```

Expected: all 30 tests pass. Then run a live review sanity check:

```bash
CLAUDE_PLUGIN_DATA=~/.gateway-plugin node plugins/gateway/scripts/gateway-companion.mjs review --profile ollama-minimax
```

Expected: agentic loop runs, JSON verdict returned, no errors.
