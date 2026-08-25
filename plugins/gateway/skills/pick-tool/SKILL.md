---
name: pick-tool
description: Use when unsure which gateway command, skill, agent, or persona fits the task at hand — including "what does this plugin give me", "which of these two do I use", and "is there something here for X".
---

# Pick Tool

Routing map for everything this plugin exposes to a user. Read the tables, name one entry point, give the exact invocation. Nothing here runs a model or edits anything.

## When to use

- Someone (often new to this plugin) asks what to use for a task, or what the plugin can do at all
- Two entry points look interchangeable and the wrong one wastes a run (`review` vs `adversarial-review`, `task` vs `dispatch`, `spec-plan` vs `implement-plan`)
- NOT when the right entry point is already obvious or was named explicitly — just run it

## How to answer

1. Match the request against the **Reach for it when** column, category by category.
2. Name **one** primary entry point and give the exact invocation (`/gateway:review`, `Skill(gateway:spec-plan)`, `Agent(gateway:gateway-coder)`). Name a second only as an explicit escalation ("start here; if X, escalate to Y").
3. If two rows compete, resolve with **Close calls** below instead of listing both.
4. If nothing fits, use **If none of these fit** — do not force a bad match.
5. Anything routed to a gateway model needs a configured profile. If unsure one exists, check with `/gateway:setup list` first (or `setup list --json`) — never assume a profile name.

## Commands — review (read-only, never edits)

| Entry point | What it does | Reach for it when |
|---|---|---|
| `/gateway:review` | Single agentic review pass through a gateway model | Default review of a diff/branch before commit |
| `/gateway:adversarial-review` | Two passes: find issues, then filter its own false positives | Findings quality matters more than speed; pre-commit gate on a risky change |
| `/gateway:staged-review` | Phase 1 spec compliance, Phase 2 adversarial quality | There is a stated spec/intent and "does it do what we said" is a separate question from "is the code good" |

All three take `--profile`, `--base`, `--scope auto\|branch\|working-tree`, `--json`, `--timeout`. None of them fix anything — they report. `--include-diff` is different across the three: `adversarial-review` and `staged-review` always honor it; on plain `review` it only does anything paired with `--no-tools` (review's default route is agentic — the model reads the diff itself via tools — so `--include-diff` alone errors instead of silently doing nothing).

**Reviewing a document that isn't code** (a spec, a plan, notes — anything under a gitignored path like this repo's own `docs/superpowers/`): none of the three `review` variants can see it. Target resolution runs `git ls-files --others --exclude-standard`, and `--exclude-standard` filters out anything gitignored on every route, `--no-tools` included — there's no flag that overrides it. Use `/gateway:task` instead: point it at the file and ask for a critique; `task` reads files directly, not through git.

## Commands — delegation (does work, can write)

| Entry point | What it does | Reach for it when |
|---|---|---|
| `/gateway:task` | Delegates one task to a gateway model (`--harness claude\|codex\|zero\|kimi\|cline`, `--as <persona>`, `--write\|--no-write`, `--background\|--wait`) | One bounded task you want off your own context |
| `/gateway:task-review` | Runs a task, then cross-reviews the resulting changes with a **different** profile (`--review <profile>` required) | The task is worth doing but you don't trust one model's output unreviewed |
| `/gateway:work` | Keyword auto-routing to the right persona agent, then delegates | You know what you need done but not which persona/agent fits — simplest entry point |
| `/gateway:dispatch` | Splits a plan (or explicit `--task` list) across several models in parallel, optional worktrees and `--cross-review` | Several independent tasks at once; one model would be the bottleneck. Supports `--dry-run` |

## Commands — multi-model orchestration

| Entry point | What it does | Reach for it when |
|---|---|---|
| `/gateway:debate` | Structured debate between profiles: positions, cross-critique, synthesis (`--models`, `--rounds`, `--synthesizer`, `--mode relaxed\|strict`) | A contested decision with no obvious answer — architecture, X vs Y, a tradeoff call |
| `/gateway:transfer` | Window transfer: sends the last `--turns` of this session to a gateway model thread | You want a different model to continue *this* conversation. Recent turns only — older context does not travel |

## Skills — planning and execution

| Entry point | What it does | Reach for it when |
|---|---|---|
| `Skill(gateway:spec-plan)` | Research → spec → plan: forcing intake, decomposition, deterministic source priority, optional multi-model review of the draft | Before any code exists — the question, the spec, or the plan is what's missing |
| `Skill(gateway:implement-plan)` | Executes a written plan: split & route per task, implement, multi-model review fan-out, opus arbiter verifies findings, then fix | A plan file already exists and needs executing across backend/frontend |
| `Skill(gateway:pick-tool)` | This map | You are here |

`spec-plan` and `implement-plan` are a sequence, not alternatives: `spec-plan` ends by naming the plan file and handing off (`next: implement-plan on <file>`); `implement-plan` starts from that file. Never use `implement-plan` to write the plan, never use `spec-plan` to change code.

## Agents (delegate via the `Agent` tool)

| Entry point | What it does | Reach for it when |
|---|---|---|
| `gateway:gateway-coder` | Implementation/refactor through the gateway, codex harness, write mode | The task is clearly "write or modify code" |
| `gateway:gateway-debugger` | Debugging, error and test-failure diagnosis, codex harness (keeps test results across turns) | Something is broken and root cause is unknown |
| `gateway:gateway-reviewer` | Code review / architecture analysis, read-only | You want a reviewer subagent rather than a one-shot `/gateway:review` run |
| `gateway:gateway-researcher` | Codebase exploration, inventory, technical analysis, read-only | "Where is X / how does Y work / list all Z" |
| `gateway:gateway-dispatcher` | Thin forwarder used by `/gateway:dispatch` — no prompt shaping | Rarely direct; prefer the command |
| `gateway:gateway-rescue` | Generic gateway fallback; `--as security` covers CVE/OWASP framing | The task doesn't fit a specialized agent above |
| `gateway:research-planner` | Research/spec/plan agent, opus fixed, read-only, prose artifacts only | You want the planner directly without `spec-plan`'s intake and phases |

## Personas (`--as <persona>` on `task` / `task-review` / `work`)

`coder`, `debugger`, `researcher`, `reviewer`, `security` — system-prompt shaping, defined in `personas/*.md`. They select *how* a delegated model thinks, not *which* command runs. `/gateway:work` picks one for you by keyword.

## Session and job management (type these yourself — model-invocation is disabled)

| Entry point | What it does | Reach for it when |
|---|---|---|
| `/gateway:status` | Status of background jobs (`[job-id]`, `--all`, `--json`) | A `--background` task is in flight |
| `/gateway:result` | Result of a completed job | `status` says the job finished |
| `/gateway:cancel` | Cancels a running job | A job is stuck or no longer wanted |
| `/gateway:setup` | Profile config: `add`, `remove`, `list`, `test`, `set-default`, `set-review-profile`, `set-task-profile`, `set-model`, `doctor`, `models`, `zero-init` | Anything gateway-routed fails, or you're setting up / switching a model |

First stop for "it isn't working": `/gateway:setup test --profile <name>` and `/gateway:setup doctor`.

Interactive model picker (browse every model an endpoint offers, pick several by number, name a profile for each, choose a default) is `setup wizard` — needs live stdin, so it only works run directly in a terminal, e.g. `!node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup wizard`, never via the `/gateway:setup` slash command.

## Not user-invocable

`gateway-cli-runtime` and `gateway-prompt-shaper` are internal skills (`user-invocable: false`) loaded by the gateway agents — never route a user to them. The separate **gateway-codex** plugin (`gateway-workflows` skill) serves the Codex CLI, not Claude Code; mention it only when the question is about using the gateway from Codex.

## Close calls

- **`review` vs `adversarial-review` vs `staged-review`** — one pass / two passes with false-positive filtering / spec compliance first then quality. More phases means more cost and time, not automatically better findings.
- **`task` vs `work`** — `work` is `task` plus persona auto-selection. Unsure which persona? `work`. Already know? `task --as <persona>`, one less indirection.
- **`task` vs `dispatch`** — one task versus many in parallel. A single task through `dispatch` is overhead for nothing.
- **`task-review` vs `dispatch --cross-review`** — same idea (implement, then review with another model) at one-task versus many-task scale.
- **`/gateway:review` vs `Agent(gateway:gateway-reviewer)`** — same job, different shape: a command run whose output you read, versus a subagent that keeps the review out of your context.
- **`implement-plan` vs `dispatch`** — `implement-plan` is the full discipline (route, implement, multi-model review, arbiter, fix). `dispatch` is the parallel execution mechanism `implement-plan` can use. Plan with real review needs → the skill; raw parallel throughput → the command.
- **`spec-plan` vs `Agent(gateway:research-planner)`** — the skill adds intake, decomposition, source priority and an optional review phase around the agent. Small, already-specific question → the agent alone.
- **`debate` vs `adversarial-review`** — debate argues a *decision*; adversarial-review critiques *code that already exists*.

## If none of these fit

Say so instead of forcing a row. Then, in order:

1. Native Claude Code tools (Read/Grep/Glob/Edit, `Agent`) — most one-line lookups and single-file edits are cheaper without any gateway hop.
2. `/gateway:work "<what you need>"` — one-shot fallback that routes by keyword when the category itself is unclear.
3. `Agent(gateway:gateway-rescue)` — generic gateway delegation for a task that matches no specialized agent.

Not everything belongs in this plugin. Nothing here does git operations, releases, or CI.

## Keeping this map honest

This map is only worth reading if it matches disk. **Adding a command, agent, or skill means adding exactly one row to the matching table here** — same commit, not later. Removing one means deleting its row.

Verify before trusting it, especially after a `git pull`:

```bash
ls "$CLAUDE_PLUGIN_ROOT"/commands "$CLAUDE_PLUGIN_ROOT"/agents "$CLAUDE_PLUGIN_ROOT"/skills "$CLAUDE_PLUGIN_ROOT"/personas
```

(In the source repo: `plugins/gateway/{commands,agents,skills,personas}/`.) Anything listed there and missing here — or listed here and gone from disk — makes this map wrong. The files win; fix the table, then answer.

## Common mistakes

- Listing five plausible options instead of picking one — the point of this skill is a decision.
- Routing to a gateway command without checking that a profile is configured (`setup list`), then blaming the model for `fetch failed`.
- Recommending an internal skill (`gateway-cli-runtime`, `gateway-prompt-shaper`) or the Codex-only `gateway-workflows` to a Claude Code user.
- Answering from this file after someone added a command and skipped the row — re-list the directories when the answer is "there's nothing for that".
