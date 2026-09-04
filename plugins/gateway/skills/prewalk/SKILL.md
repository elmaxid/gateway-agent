---
name: prewalk
description: Use when one bounded implementation task should be opened by a strong model and finished by a cheaper one on the SAME resumed codex thread — the opener explores, writes a checklist, lands the first edit and stops, then the closer inherits the whole trajectory instead of re-reading everything. NOT for architectural refactors, migrations, iterative debugging, entangled diagnose-and-fix bugs, or tasks small enough for a single turn; not a plan-writing or multi-task router (see spec-plan / implement-plan).
---

# Prewalk

Ships with the gateway plugin — works in any project where it's installed. Two turns, one thread, two models.

## What it is, and what it is not

**It is** a procedure for transferring a *trajectory*, not a plan document. Turn 1 runs a strong model that reads the real files, states a minimal plan, writes it as a checklist, applies the first item and stops. Turn 2 resumes **that same codex session** with a cheaper model, which inherits the entire history — reads, tool results, reasoning — and simply keeps working. From its perspective it never started; it continued.

**It is not** "strong model writes a plan, cheap model executes it". That pattern hands over a ~2K-token postcard summarizing 100K+ tokens of exploration, so the cheap model re-explores at its own cost and its own risk of drifting. Prewalk exists precisely to avoid that.

**It is not** a CLI feature. Nothing here adds flags or changes runtime behavior: it orchestrates two invocations that are already legal, with a verification gate between them.

**Known fidelity gap, stated up front.** The original technique prunes the turn-1 planning instruction out of context before handing the thread over. We cannot: a codex thread is a rollout on disk that the CLI replays as-is, and nothing in the plugin or the harness can edit messages already written to it. So turn 1's "make one change and stop" **stays in turn 2's context as a prior user order** — and a cheap model may imitate it, make one change and declare itself done. The only defense available is an explicit two-phase **time contract**: turn 1 declares its stop rule expires when the turn ends, turn 2 declares it has expired. Both prompts below carry that contract, and every clause of it is load-bearing. Do not paraphrase, shorten or "improve" them.

## When to use it

A bounded implementation task whose plan will not change shape mid-flight, where the closing model alone either does not get there or gets there wandering.

## When NOT to use it

- **Small tasks.** Two turns, a checklist file and a gate cost more than they return. If the work fits in three weak items, just run the task.
- **Bugs where diagnosis and implementation are entangled.** There is no swap point: the "first edit" is a hypothesis, not a decision.
- **Architectural refactors and migrations.** The plan changes while it executes; inheriting a frozen turn-1 plan is worse than replanning.
- **Iterative debugging.** Same reason.
- **When turn 1's first edit was wrong.** The cheap model inherits the mistake *with authority* — with all the evidence that someone more capable already decided it. This is the technique's worst failure mode and it has no in-flow mitigation. The only defense is that the gate forces a human to look at that edit before spending turn 2.

If any of the above fits, say so and run the task normally, in one turn. Refusing to run prewalk is a correct outcome, not a failure.

## Hard constraints inherited from the CLI

These are properties of the runtime, not choices this skill makes. Violating any of them makes turn 2 fail:

- **codex harness only.** It is the only harness with verified resume that is not bound to the original working directory.
- **Same profile in both phases, always.** Resume inherits the source job's profile and *rejects* a different one — a deliberate guard, since switching profile silently switches endpoint and credentials. Design consequence: **the closing model must be served by the same endpoint as the opening model's profile.**
- **The model is the only thing that changes.** Resume does not block a different model. That single degree of freedom is the whole technique.
- **A resume is always write-capable.** The CLI refuses to resume read-only because it cannot guarantee it. Prewalk is a writing flow, so this matches.
- **Only completed jobs can be resumed.** A failed turn 1 is not resumable, period.
- **A background job runs exactly one execution.** Two phases are two jobs, never one job with two phases.
- **Every resume creates a new job** that captures its own continuation reference, so the phase 1 → phase 2 chain stays traceable job by job.
- **A failed phase 2 does not destroy phase 1.** The phase 1 job stays completed with its reference intact and can be resumed again. Careful: if phase 2 applied changes before failing, the retry starts on an already-modified tree.

Also: **do not pass a persona** (`--as`) in either phase. The prompts below are self-sufficient, and a persona preamble is composed the same way on a resumed turn as on a fresh one — passing one would duplicate it into the thread for no benefit.

## Profile and model selection, at runtime

Never hardcode a profile or a model name. Every installation configures its own.

1. **Resolve the profile.** Use the one the user names explicitly; otherwise the one this installation has configured for tasks. Read it — never assume a name:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup list --json
   ```
   (the payload reports the configured profiles plus the default/review/task profile assignments).
2. **List the models that endpoint actually serves.** This is a live query by the CLI:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" setup models --profile <resolved profile> --json
   ```
3. **The user names the opening model and the closing model from that list.** If the closing model is not in it, fail *before* spending phase 1.
4. **If the model query fails**, say so and offer two explicit paths: retry, or proceed with hand-named models accepting the risk that phase 2 fails on resume. Never guess.

**Why the user picks and this skill does not rank:** the endpoint catalog exposes no cost, size or tier metadata. There is no honest way to derive "the cheap one" from a list of identifiers, and any heuristic over model names would be a hidden rule that breaks on the next installation.

## Phase 1 — the opening turn

### Before running it, two preparations

1. **Choose the checklist path and verify it does not exist.** Put it at the work-tree root with a unique per-run suffix generated by you (not the job id — that does not exist yet), so two concurrent runs cannot collide, e.g. `.prewalk-todo-<unique suffix>.md`. If the chosen path exists, do not overwrite it — choose another.
2. **Capture a baseline** of the working tree (which files are modified/untracked). Without it, "the tree has changes" proves nothing — the tree almost always has prior changes.

**Deliberately not done here: adding the checklist pattern to `.gitignore`.** It looks like cheap insurance against the file leaking into a commit, but it buys almost nothing — the gate excludes the checklist by name anyway, and close-out inspects the filesystem rather than `git status`. What it does buy is a tracked-file edit that every abandonment path would have to remember to undo, and the paths that abort early are exactly the ones that would forget. Leaving the checklist visible to `git status` is the safer failure mode: a stray file you can see beats a `.gitignore` line you cannot.

### Invocation

Write the prompt below to a file (substituting `<TASK>` and `<TODO_PATH>`) and run it in the foreground with structured output, which returns the job id you will need for the resume:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task \
  --profile <resolved profile> --model <opening model> --harness codex \
  --prompt-file <phase-1 prompt file> --json
```

`--model` is not optional here. Without it the run silently falls back to the profile's configured default, so the opening model the user picked above is never actually used — and if that default happens to be the cheap model, the whole technique becomes a no-op that still looks like it worked.

The `--json` payload carries `jobId` — use it directly for phase 2. **Alternative:** run phase 1 with `--background`, which also returns the job id (structured and human) at enqueue time and then requires polling `status <job-id>` until it completes. Either path gives a real id; never identify the phase 1 job by guessing "the most recent one" in the registry.

### Phase 1 prompt (verbatim — substitute only `<TASK>` and `<TODO_PATH>`)

```
You are starting a task that will be finished across two turns. This turn is the
opening: explore, plan, and land the first change. A later turn — same session,
same context — will finish it.

TASK
<TASK>

TURN 1 CONTRACT — read all of it before acting

1. Read first. Open the actual files, tests and configuration this task touches.
   Do not work from search snippets, filenames or assumptions. If the requirement
   is ambiguous, or rests on a premise you have not verified, resolve that by
   reading before you build anything on it.

2. State a minimal plan, in your reply, in exactly these four parts:
   - Outcome — the exact behavior requested, in one or two sentences.
   - Non-goals — what this task will not do.
   - Files — the smallest set of files you expect to change.
   - Proof — the specific command or check that will prove the change works.

3. Decide whether this task justifies a two-turn split at all. If it genuinely
   needs fewer than 3 checklist items, this approach is not justified for it: say
   so, change nothing, and stop. Never pad a list to reach three.

   Otherwise write that plan as a checklist to the file <TODO_PATH>. Create it —
   never overwrite an existing file at that path. If something is already there,
   stop and report it instead of touching it. Rules for that file:
   - Between 3 and 12 items. Not more. If the work genuinely needs more than 12,
     the scope is too big: stop, say so, and propose a smaller task instead of
     writing a longer list.
   - One item = one concrete, independently checkable change. No item may be a
     batch ("update all callers", "fix the tests").
   - Every item states its own done-condition.
   - The last item is always the Proof from step 2: running it and reporting the
     result.
   - Format every item as "- [ ] <item>". Mark an item "- [x]" only when it is
     actually finished.

4. Make exactly ONE change to the repository: the first item on the checklist.
   Apply it for real, with your editing tools — not as a diff in your reply. Then
   mark that item "- [x]" in <TODO_PATH>.

5. STOP THERE. Do not start the second item. Do not run the Proof yet. End your
   turn with the line:

   PREWALK_READY

   followed by one short paragraph naming the file(s) you just changed and the
   next unchecked item.

SCOPE RULES (these apply to both turns)
- Minimum sufficient change. Reuse what already exists — helpers, patterns, test
  setup — before adding anything new.
- Fix causes, not symptoms. Do not stack patches on top of a wrong premise.
- Add an abstraction, dependency, config layer or new test file only if this task
  has a second real caller for it, or you were explicitly asked for one.
- Preserve behavior outside the requested change. Do not fix unrelated problems
  you notice along the way; list at most two at the end under "Out of scope".
- Read-only investigation is always allowed. Ask before: expanding scope to
  unrelated files, adding a dependency or new test infrastructure, changing a
  public interface, schema or wire format, deleting user data or discarding
  uncommitted work, or keeping two implementations of the same behavior alive.

TIME-LIMITED INSTRUCTION — read this carefully
Rule 5 — make one change, then stop — applies to THIS TURN ONLY. It is a handoff
point, not a description of how this task should be worked. It expires when this
turn ends. In any later turn of this session, the correct behavior is to keep
working through the checklist to the end. Do not treat "one change, then stop" as
a pattern to imitate.
```

## Handoff gate

Runs **between** the two phases, in whatever context orchestrates them. It is fail-loud: if it does not pass, phase 2 is not spent.

**Four signals, all mandatory:**

1. **The phase 1 job completed.** Read it from the plugin's job registry — `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" status <job-id> [--json]`. A failed or cancelled job is not resumable — the CLI rejects it anyway, but the gate says so earlier and with a better message.
2. **The job has a continuation reference.** Without it there is no thread to resume. Same field the CLI requires.
3. **At least one real change landed in the tree**, compared against the baseline, **explicitly excluding the checklist file**. The checklist is itself a write: without that exclusion, a turn that planned and edited nothing would pass the gate.
4. **The checklist file exists and is valid**: between 3 and 12 items, checklist format, at least one item marked done (the first edit), at least one item unmarked (work remains), and a final verification item.

**Count the marked items while you are there.** More than one means the opening turn ran past its cut point — it was told to make exactly one change. One item marked is the contract being honored; several means it was not, and the handoff is worth less because the strong model already spent the turns the swap was supposed to save. That is not automatically fatal: if real work still remains, the handoff can proceed. But it is a deviation, so **say it out loud** rather than letting it pass silently, and if most of the checklist is already done, take the "the turn ran long" outcome below instead — there is no longer enough left to justify a second turn.

**Fifth signal, weak, informative:** the `PREWALK_READY` marker in phase 1's output. Its absence with the four material signals present usually means the turn ran past the cut point. It is not equivalent to the other four, but **report it anyway** — it changes the recommendation.

**When the gate fails — four named outcomes, with a budget of exactly one retry:**

- **The task did not justify prewalk** (phase 1 reported it needs fewer than 3 items and changed nothing): not a failure, the correct answer to a small task. No handoff, no retry, nothing penalized — run the task normally, in one turn. Distinguish this from "no traction" by the deliberate absence of a checklist **plus** the model's explicit report; if it is ambiguous, treat it as the next case.
- **No real change landed** (with or without a checklist): phase 1 got no traction. Allow **one** phase 1 retry, and only with the task statement **reworded by the human** — resending the same text reproduces the same failure. Never retry alone, never in a loop. If the second attempt also lands nothing, abandon prewalk for that task: the task is not well enough defined, and swapping models will not fix that.
- **The job failed, or has no continuation reference**: prewalk is impossible for that run. No resume retry exists. Fall back to running the whole task with the strong model in a fresh turn — the path that existed before this skill.
- **The turn ran long** (several changes, or no unchecked items left, or the marker is missing and the task looks finished): **do not hand off.** The trajectory is healthy, but the work that justified the swap is gone. Close it out with the strong model: run the verification and finish.

In every case, report which signal failed and with what evidence. Never a bare "proceeding anyway".

## Phase 2 — the closing turn

Same thread, cheaper model. Omit `--profile` (it is inherited and a different one is rejected), omit `--harness` (inherited from the source job), omit `--no-write` (a resume is always write-capable):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" task \
  --resume <phase 1 job id> --model <closing model> \
  --prompt-file <phase-2 prompt file> --json
```

Keep `--json` here too, and capture `jobId` from the payload: the resume creates its own job, and close-out has to read *that* record to confirm which model ran. Without it the human output is the model's text verbatim, the phase 2 id appears nowhere, and the only way left to find it is guessing the newest record — which is exactly what this skill forbids.

### Phase 2 prompt (verbatim — substitute only `<TODO_PATH>`)

```
Same task, same session. You are continuing from where you stopped.

This is a new user instruction, for turn 2. It SUPERSEDES the opening turn's
"make exactly ONE change, then stop" rule and its PREWALK_READY handoff marker:
you must not follow either of them now. Both applied only to the reply that ended
turn 1. In this turn the only stop point is finishing the work — or one of the
approval cases enumerated at the end of this instruction. Nothing else.

Do this:

1. Re-read <TODO_PATH>. It is the plan you wrote: the current plan, not immutable
   truth. Keep its scope and its order. Amend an item only when the code or the
   Proof disproves an assumption it rests on — and when you do, record why, in the
   file. Never delete an item, never uncheck a finished one, and never add items
   beyond what the task requires.
2. Work the unchecked items in order. Apply real changes with your editing tools.
   After an item is genuinely finished, mark it "- [x]" in <TODO_PATH>.
3. Do not re-explore what you already read this session — you have it. Read again
   only what you have not read yet, or what your own changes made stale.
4. Run the Proof item last, and report its actual output, verbatim, pass or fail.
   A failing Proof is a result to report, not something to work around: if it
   fails, fix the cause and run it again.
5. When every item is checked and the Proof passes — after any retries it needed —
   delete <TODO_PATH> and say so.

You are not done while any item is unchecked. Do not declare the task complete, do
not summarize it as finished, and do not stop to ask whether to continue while
unchecked items remain. The only questions that justify stopping are the ones the
scope rules enumerate: expanding scope to unrelated files, adding a dependency or
new test infrastructure, changing a public interface, schema or wire format,
deleting user data or discarding uncommitted work, or keeping two implementations
of the same behavior alive. A routine "should I keep going?" is not one of them.
If you genuinely cannot finish an item, say exactly which item, why, and what you
tried — never drop it silently.

The scope rules from the opening instruction still apply: minimum sufficient
change, no unrelated fixes, no new abstractions or dependencies this task does not
require, and ask before expanding scope.

Finish with: the files you changed, the Proof command and its actual result, and
anything you could not do.
```

## Close-out

Before anything gets committed:

- **Check the checklist file, by looking at the filesystem.** What you expect depends on how the run ended, and the two cases are different:
  - **Everything checked and the Proof passed** — the file must be gone. Phase 2 deletes it, and its presence means phase 2 stopped short of its own closing step.
  - **Work remains** (an item could not be finished, or an approval boundary stopped the run) — the file must **stay**, with the unfinished items still unchecked and the blocker recorded. It is the only record of what is left; deleting it there would destroy the handoff to whoever picks the work up. Do not treat a surviving checklist as a failure of close-out in this case.
- **Confirm phase 2 ran the model that was asked for**, by reading it from the job registry — `node "${CLAUDE_PLUGIN_ROOT}/scripts/gateway-companion.mjs" status <phase 2 job id> [--json]`; the record carries the model that actually ran, in both the human and the structured output. "Some other model than phase 1" is not enough: if the model flag is forgotten, the resume still runs, on the profile's default. The rule here is that the requested model is the model that ran.
- **Report what phase 2 could not finish**, item by item, if anything is left. An unchecked item is a result, not an omission.
- **Say whether the closing model imitated the cut** — declared itself done with items still unchecked. That is the one observation worth recording every single time: it is the fidelity gap at the top of this file, and it is the signal that decides whether this procedure is worth keeping.

## Common mistakes

- Running prewalk on a refactor, a migration, or a bug whose diagnosis is still open — the plan changes under the closing model, and there was never a real swap point.
- Handing off without looking at turn 1's first edit. A wrong first edit is inherited with authority; the gate is the only place anyone catches it.
- Paraphrasing, trimming or "cleaning up" either prompt. The time contract (turn 1's `TIME-LIMITED INSTRUCTION`, turn 2's supersession paragraph) is the only mitigation for the fidelity gap; delete a clause and the technique degrades silently, still producing plausible output.
- Passing `--profile` on the resume, or a different one — rejected by design, because a profile switch is an endpoint and credential switch.
- Identifying the phase 1 job by picking the newest entry in the registry instead of using the id the run itself returned. That guess breaks under concurrency.
- Hardcoding a profile or model name from one workstation. Discover both at runtime, every time.
- Treating the checklist file as scratch that someone else will clean up — it is an artifact this procedure created and this procedure removes.
- Retrying phase 1 on the same wording after it landed nothing, or retrying more than once. Reword or stop.
