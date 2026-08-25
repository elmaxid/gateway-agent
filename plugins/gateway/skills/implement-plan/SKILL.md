---
name: implement-plan
description: Use when implementing an existing plan or task list that spans backend and frontend work, before touching code — routes each task to the right model and persona, then verifies review findings before any fix is applied.
---

# Implement Plan

Ships with the gateway plugin — works in any project where it's installed. Companion to **spec-plan** (covers the research/spec/plan phase that precedes this one).

## Overview

Given an already-written plan (spec/plan writing is `spec-plan`'s job), execute it end to end: split into tasks, route each to model+persona, implement, fan out review across multiple models, arbiter-verify findings against real code, apply only confirmed fixes.

## When to use

- User says "implementá el plan X" / "ejecutá este plan"
- A plan file already exists (from `spec-plan`, `superpowers:writing-plans`, or similar)
- NOT for writing the plan itself, and not for a single one-off task — this is for multi-task plans needing routing

## Phase 1 — Split & route

Read the plan. Split into tasks at the same granularity the plan already uses (one task = one deliverable/file-set). Full-stack tasks that touch both layers: split into a backend sub-task and a frontend sub-task.

Classify each task backend or frontend by content — judgment call, no regex/heuristic script. State the classification in one line before dispatching.

| Domain | Simple/default | Complex/architectural | Execution |
|---|---|---|---|
| Backend | sonnet | opus | `Agent` tool, native Claude. Persona: if `octo:personas:*` (backend-architect default, database-architect for schema/migration, cloud-architect for infra/deploy) is available in your agent list, use it; otherwise proceed with plain judgment, no persona override — never treat octo as a hard dependency |
| Frontend | this installation's configured task profile | same, or an explicit profile named in the prompt | `gateway-companion.mjs task --profile <configured task profile> --harness codex --as coder`. Discover the configured profile via `gateway-companion.mjs setup list` (falls back to whatever `setup` reports as the default/task profile) — never hardcode a profile name, every installation configures its own. For design-system/visual-heavy tasks use the `frontend-developer`/`ui-ux-designer` persona preamble (`gateway-prompt-shaper` skill) instead of `--as coder`, same best-effort rule as backend if it's an octo persona instead |

"Complex/architectural" = new subsystem, cross-cutting change, non-obvious tradeoff. "Simple" = bounded, mechanical, ~single-file. Backend gets a real model-tier split (sonnet vs opus, both always available on Claude); frontend does not assume a tiered pair of gateway profiles exists — if the prompt explicitly names a stronger/alternate profile for a complex frontend task, honor that instead of the default.

Independent tasks → dispatch together (multiple `Agent` calls in one message for backend; multiple gateway `task` Bash calls, or `gateway:dispatch`, for frontend). Dependent tasks → sequential, respecting the plan's stated order.

## Phase 2 — Implement

Run the Phase 1 dispatch. Each task returns its diff. Collect all diffs before moving on — do not review task-by-task.

## Phase 3 — Multi-model review (fan-out, tolerate failures)

**Orchestration constraint**: the Phase 3 native reviewer and the Phase 4 arbiter are two separate `Agent` calls — running them requires a context that can call `Agent` (main thread, or a non-fork subagent). A `fork` subagent cannot call `Agent` (hard harness rule) and will silently collapse both into itself under one inherited model instead of erroring. Never delegate the full Phase 3-4 run to a single fork.

Discover what's actually configured before fanning out — run `gateway-companion.mjs setup list --json` (or `setup list`) and use whatever profiles it reports. Do not assume any specific profile name or count exists; every installation configures its own set. Run in parallel, no pre-flight `setup test`:
- One `gateway-companion.mjs review --profile <name> --scope working-tree` call per configured profile (exclude the profile used for Phase 2's frontend implementation, if any, so a model doesn't review its own output)
- one native Claude reviewer: `Agent` call, model sonnet, persona `code-reviewer` if `octo:personas:code-reviewer` is available (otherwise plain judgment), on the same working-tree diff

If a call errors or times out: skip it, note which profile was skipped, continue with whatever responded. Never let one dead profile block the phase.

If the diff spans several unrelated areas (e.g. backend task 2's diff and frontend task 3's diff, from Phase 2), review each related file-group separately through the pool instead of one mixed dump — keeps each model's findings scoped and file:line-accurate. Single-area diffs: review as one working-tree scope, no need to split.

## Phase 4 — Arbiter

Spawn exactly one dedicated `Agent` (model: **opus**, fixed — distinct from the sonnet used in Phase 3's native reviewer). Give it: the full diff + every review's **raw, unfiltered** findings from Phase 3. Do not pre-filter or summarize findings yourself before handing them off — that defeats the phase.

Arbiter's job, two checks per finding, in order:
1. **Location check** — does the cited file:line exist and match what the finding describes? If not, that's an invalid-location finding, not a content judgment yet — re-locate the real line before judging the claim, if findable.
2. **Claim check** — read the actual code at the (corrected) location and verify the claim against it (not against the finding's own description).

Output one of four: confirmed / refuted / invalid-location / **confirmed-imprecise-citation** (the underlying bug is real and verified, but the cited file:line is incomplete or isn't the actual defect site — e.g. the finding cites where an error object is built, but the real defect is where that error gets silently dropped later; state the real site if found). Give a one-line reason for every non-plain-confirmed item. This is the only phase allowed to discard a finding — confirmed-imprecise-citation is NOT discarded, it proceeds to Phase 5 same as confirmed.

## Phase 5 — Fix

Apply fixes for confirmed and confirmed-imprecise-citation findings (fix at the real site for the latter, not the cited one), one surgical fix per finding (no drive-by cleanup). Re-run whatever tests cover the touched code. Report: findings fixed, findings refuted and invalid-location (with the arbiter's reason each — don't silently drop them), any Phase 3 profile that was skipped.

## Common mistakes

- Applying Phase 3 findings directly, skipping Phase 4 → false positives get "fixed," i.e. working code gets changed for no real bug.
- Filtering findings before they reach the arbiter → arbiter can't verify what it never saw.
- Treating "complex/architectural" as a fixed per-project label instead of a per-task call — re-judge every task.
- Reusing the same model as both a Phase 3 reviewer and the Phase 4 arbiter.
- Delegating the full Phase 3-4 run to a single `fork` subagent — forks can't call `Agent`, so the native reviewer and arbiter silently collapse into one model instead of two, with no error to signal it.
- Assuming a specific gateway profile name (or octo persona) exists because it does on your own machine — always discover via `setup list` / check your available agent list, never hardcode.
