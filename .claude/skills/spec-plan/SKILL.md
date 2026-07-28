---
name: spec-plan
description: Use when starting research, writing a spec, or drafting an implementation plan before any code changes — the step before implement-plan.
---

# Spec & Plan

Project-scoped skill (agent-plugin-cc only — does not ship with the gateway plugin, same as `.claude/agents/research-planner.md`). Companion to **implement-plan**: this skill covers research → spec → plan; implement-plan takes over once a plan file exists.

## Overview

Default engine is `research-planner` (opus, fixed, read-only — see `.claude/agents/research-planner.md`). This skill doesn't replace it, it adds what research-planner's own definition doesn't cover: forcing intake, decomposition, source priority, and an optional multi-model review pass for contested calls.

## When to use

- Starting research, a spec, or a plan for a non-trivial change, before touching code
- NOT for implementation — hand off to **implement-plan** once the plan file exists
- NOT for a one-line lookup a single Grep/graph query already answers — just answer it

## Phase 1 — Intake (forcing, don't skip)

Get concrete answers before researching anything — infer from an already-specific request instead of re-asking if it's already unambiguous:

1. **The question, specific.** Vague in = vague out. If the ask is broad ("mejorá el sistema de X"), push back once: name the angle (architecture? bug root cause? feature scope? tradeoff between options?).
2. **Deliverable depth** — one of: research findings only / spec / spec+plan / spec+plan+multi-model review. Default spec+plan unless the ask is clearly narrower.
3. **Model/agent** — default `research-planner`. If the prompt names a different model/agent explicitly, use that instead — no separate override mechanism needed, the prompt IS the override.

## Phase 2 — Decompose

Break the question into 3-5 sub-questions before researching (what/why/how/tradeoffs/what's-next fits most cases here). Show the breakdown before digging — catches a wrong angle before burning research effort on it.

## Phase 3 — Source priority (deterministic, stop at first tier that answers it)

1. This repo's own code/history — `code-review-graph` MCP tools first (per project CLAUDE.md: `query_graph`/`semantic_search_nodes` before Grep), Grep/Glob as fallback, `git log`/`blame` for "why".
2. External library/API/framework behavior — `context7` (`resolve-library-id` + `query-docs`). Never assume a signature from training data.
3. General web (WebSearch/WebFetch) — last resort, only once 1 and 2 don't answer it.

## Phase 4 — Research + synthesize

Delegate to the agent chosen in Phase 1.3. `research-planner` is read-only by its own definition (Read/Grep/Glob/WebSearch/WebFetch/Write, no Edit) and only ever produces prose artifacts — spec/plan files, never source/config/scripts.

## Phase 5 — Multi-model review (only if Phase 1.2 selected "spec+plan+multi-model review")

Same reviewer+arbiter shape as implement-plan's Phases 3-4, applied to the drafted spec/plan instead of a diff: fan out the draft to 2+ gateway models for critique (pool depends on what's configured/available), one dedicated opus arbiter verifies every suggestion against the real repo before anything gets folded in — raw unfiltered findings go to the arbiter, same as implement-plan. Skip this phase for every other deliverable tier — it's not free, don't run it by default.

## Phase 6 — Close out (audit + handoff)

Before calling it done:
- State what was NOT found or stayed uncertain — never pad over a gap.
- Note which source tier (Phase 3) each key claim came from, so a reader can tell what's grounded in this repo vs. external docs vs. the open web.
- Name the exact output file and hand off explicitly: "next: implement-plan on `<file>`".

## Common mistakes

- Skipping Phase 1 intake on a vague ask — wastes research effort on the wrong angle.
- Running Phase 5 by default — expensive, only for the deliverable tier that explicitly asked for it.
- Reaching for WebSearch before checking this repo's own code/graph — most "how does X work here" questions are answered by code that already exists.
- Padding an unanswered sub-question instead of saying "not found" — same discipline implement-plan's arbiter phase already enforces for findings.
