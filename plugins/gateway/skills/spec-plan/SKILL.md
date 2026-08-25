---
name: spec-plan
description: Use when starting research, writing a spec, or drafting an implementation plan before any code changes — the step before implement-plan.
---

# Spec & Plan

Ships with the gateway plugin — works in any project where it's installed, not tied to a specific codebase. Companion to **implement-plan**: this skill covers research → spec → plan; implement-plan takes over once a plan file exists.

## Overview

Default engine is the bundled `research-planner` agent (opus, fixed, read-only — see `plugins/gateway/agents/research-planner.md`). This skill doesn't replace it, it adds what research-planner's own definition doesn't cover: forcing intake, decomposition, source priority, and an optional multi-model review pass for contested calls.

## When to use

- Starting research, a spec, or a plan for a non-trivial change, before touching code
- NOT for implementation — hand off to **implement-plan** once the plan file exists
- NOT for a one-line lookup a single Grep/graph query already answers — just answer it

## Phase 1 — Intake (forcing, don't skip)

Get concrete answers before researching anything — infer from an already-specific request instead of re-asking if it's already unambiguous:

**Facts are looked up, decisions are asked.** Anything you can determine yourself — what the code already does, which profiles/tools this installation has configured, what the git history says, what convention the repo follows — is a fact: go read it, never spend a question on it. Only genuine decisions reach the user: scope, priority, which tradeoff to take, what counts as done. A question whose answer was already on disk costs a round trip and signals you didn't look.

1. **The question, specific.** Vague in = vague out. If the ask is broad ("mejorá el sistema de X"), push back once: name the angle (architecture? bug root cause? feature scope? tradeoff between options?).
2. **Deliverable depth** — one of: research findings only / spec / spec+plan / spec+plan+multi-model review. Default spec+plan unless the ask is clearly narrower.
3. **Model/agent** — default the bundled `research-planner` agent. If the prompt names a different model/agent explicitly, use that instead — no separate override mechanism needed, the prompt IS the override.

## Phase 2 — Decompose

Break the question into 3-5 sub-questions before researching (what/why/how/tradeoffs/what's-next fits most cases here). Show the breakdown before digging — catches a wrong angle before burning research effort on it.

## Phase 3 — Source priority (deterministic, stop at first tier that answers it)

1. This repo's own code/history — if a codebase-graph MCP tool is available (e.g. `code-review-graph`), use it first; otherwise Grep/Glob. `git log`/`blame` for "why" questions either way.
2. External library/API/framework behavior — if `context7` (or an equivalent docs-lookup MCP) is available, use `resolve-library-id` + `query-docs` there. Never assume a signature from training data.
3. General web (WebSearch/WebFetch) — last resort, only once 1 and 2 don't answer it or aren't available.

None of tier 1/2's tools are guaranteed present in every installation — check what's actually available before assuming a specific MCP tool exists, and fall back a tier rather than erroring.

## Phase 4 — Research + synthesize

Delegate to the agent chosen in Phase 1.3. `research-planner` is read-only by its own definition (Read/Grep/Glob/WebSearch/WebFetch/Write, no Edit) and only ever produces prose artifacts — spec/plan files, never source/config/scripts.

## Phase 5 — Multi-model review (only if Phase 1.2 selected "spec+plan+multi-model review")

Same reviewer+arbiter shape as implement-plan's Phases 3-4, applied to the drafted spec/plan instead of a diff: discover configured gateway profiles (`gateway-companion.mjs setup list --json`), fan out the draft to 2+ of them for critique, one dedicated opus arbiter verifies every suggestion against the real repo before anything gets folded in — raw unfiltered findings go to the arbiter, same as implement-plan. Skip this phase for every other deliverable tier — it's not free, don't run it by default.

Concrete command, per profile: `gateway-companion.mjs task --profile <name> --no-write --prompt-file <file>`, where `<file>` embeds the draft plus critique instructions — **not** `review`: the draft typically lives under a gitignored path (this repo's own `docs/superpowers/`), and `review`'s target resolution (`git ls-files --others --exclude-standard`) never sees gitignored files, on any route.

## Phase 6 — Close out (audit + handoff)

Before calling it done:
- **No file:line references, no pasted code in the spec.** Describe *what* changes and *why* in prose that stays true after the code changes shape — a `lib/foo.mjs:214` citation or a copied snippet is wrong the first time someone moves that function. Name the component, behavior or deliverable, not the location. Only exception: a prototype produced something prose genuinely can't encode (an exact wire format, a measured number) — include that, nothing else.
- State what was NOT found or stayed uncertain — never pad over a gap.
- Note which source tier (Phase 3) each key claim came from, so a reader can tell what's grounded in this repo vs. external docs vs. the open web.
- Name the exact output file and hand off explicitly: "next: implement-plan on `<file>`".

## Common mistakes

- Skipping Phase 1 intake on a vague ask — wastes research effort on the wrong angle.
- Running Phase 5 by default — expensive, only for the deliverable tier that explicitly asked for it.
- Reaching for WebSearch before checking this repo's own code/graph — most "how does X work here" questions are answered by code that already exists.
- Assuming a specific MCP tool (codebase graph, docs lookup) or gateway profile name is present — always check what's actually available/configured in this installation, never hardcode a name from one workstation's setup.
- Padding an unanswered sub-question instead of saying "not found" — same discipline implement-plan's arbiter phase already enforces for findings.
