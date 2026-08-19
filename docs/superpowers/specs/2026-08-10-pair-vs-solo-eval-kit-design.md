# Pair-vs-Solo Evaluation Kit — Design

**Date:** 2026-08-10
**Status:** Approved design (brainstormed in session `research-loop-graph-engineering-vs-whisper`)
**Origin:** Recommendation §8.5 of the research report *Loop Engineering, Graph Engineering, and ai-whisper* (canonical copy in `~/.ai-pref-nsync/local-docs/ai-whisper/knowledge-references/2026-07-29-loop-graph-engineering-vs-ai-whisper.md`). The report's central critique: ai-whisper's core value claim — a cross-vendor implement/review pair beats a solo agent at equal capability — is plausible, evidence-aligned, and **unmeasured**. This kit measures it.

## Goal

A reusable, resumable evaluation campaign comparing three arms on a purpose-built task suite:

- **Arm A — Solo:** one agent, headless, no review structure.
- **Arm B — Solo + self-review:** same agent, with a mandated structured self-review protocol.
- **Arm C — ai-whisper pair:** claude implements, codex reviews, driven through real ai-whisper workflows.

**What this measures:** an **end-to-end system comparison** — the ai-whisper pair as shipped versus a solo agent with the same implementer model — not a single-variable isolation of "review structure." Arm C necessarily differs from A/B in more than review: workflow prompts and generated artifacts, a second model in the reviewer seat, the evaluator, and mounted interactive sessions versus headless mode. The parity controls below hold equal everything that can be held equal — implementer model, task content, per-run budget ceiling — and `report.md` must name the residual confounds explicitly rather than claim clean isolation.

**Scale (decided):** 15 tasks × 3 arms × 2 trials = 90 runs, executed in resumable slices.

## Layout

```
eval/
  tasks/<slug>/
    fixture/          # small self-contained TS/Node project the agents work in
    task.md           # the ask + user-visible acceptance criteria (checkable prose)
    approach.md       # quick-task-shaped tasks only: the implementation approach,
                      # ratified by the benchmark operator at task-authoring time
                      # and shown identically to every arm
    budget.json       # wall-clock + token caps for this task
    grade/            # HELD-OUT acceptance tests + grade script — never present
                      # in the working copy agents see; applied at grading time
  runner/             # campaign scripts (manifest, arm drivers, grader, reporter)
  results/<campaign>/ # committed: manifest, ledger.jsonl, report.md
                      # gitignored: raw run dirs, transcripts, workspaces
  README.md           # how to author tasks, run slices, grade, report
```

## Task suite

15 fresh-authored tasks (no git-history or training-data contamination), all TypeScript/Node:

- **8 features, 4 bug fixes, 3 refactors.**
- 12 quick-task-shaped (scope ≤5 non-test files — must clear the quick-task hard gate); the 3 largest are SDD-shaped with a proper spec.
- Authoring rules: solvable within budget by a competent engineer; acceptance tests deterministic (no network, no timing flakiness); `task.md` states acceptance criteria in checkable prose but never reveals the graded test code; fixture ships green (typecheck/lint/tests pass before the task is attempted).
- Each quick-task-shaped task also ships `approach.md`: the implementation approach the quick-task workflow's `## Approved approach` section requires. The benchmark operator ratifies it once, at task-authoring time — that authoring-time ratification is the human approval the quick-task contract demands, made before any run and identical for all 90 runs. SDD-shaped tasks need no `approach.md`; their spec is the approved artifact.

## Arm drivers

- **A — Solo:** fresh fixture copy; `claude -p` headless with `task.md` — plus `approach.md` where the task ships one — as the prompt payload; JSON output format for token usage capture.
- **B — Solo + self-review:** as A, plus an appended protocol: after implementing, run a structured review of your own diff against the acceptance criteria, fix the findings, maximum 2 review-fix cycles, then stop.
- **C — Pair:** runner generates the quick-task brief (four required sections, scope list — `## Approved approach` filled with `approach.md` verbatim) or SDD spec from `task.md`; tmux-automated `whisper collab mount claude` / `whisper collab mount codex` in the fixture workspace; `whisper workflow start --type=quick-task|spec-driven-development --spec=...`; completion detected by polling the state DB per `docs/state-db-read-contract.md` (never by chat); rounds and per-step verdicts read from the run ledger; tokens and cost per **Token & cost accounting** below. Escalated runs are recorded as escalations, graded as-is.

**Parity controls:**

- Identical implementer model across arms, pinned and recorded in the ledger; CLI versions pinned and recorded; fresh fixture copy per trial.
- Prompt parity: `task.md` — and `approach.md` where present — is the shared task content for every arm. Solo arms receive both files in the prompt payload; Arm C's generated brief/spec embeds the same content verbatim (`approach.md` as the `## Approved approach` section) and adds only the structural sections the workflow's shape gate requires; the generated artifact is saved in the run dir for audit.
- Budget: each task's `budget.json` sets a wall-clock ceiling and a token ceiling for the **whole run** in every arm (Arm C's combined implementer + reviewer + evaluator usage counts against the same ceilings as a solo run). The wall-clock cap is the authoritative, uniformly enforced ceiling — the runner's own clock stops every arm the same way. The token cap is **nominal**: enforceable from metered usage in Arms A/B but only from the character-based estimate in Arm C, so it is a spend guard, not a parity control, and `report.md` lists token-budget parity as nominal-only among the residual confounds. A run stopped at either ceiling is graded as delivered.
- Run order: the manifest randomizes task×arm×trial order once at init with a recorded seed, so no arm systematically runs earlier, later, or clustered.
- Read-fanout guidance (Spec 1) already landed, so Arm C measures the current pair.

## Token & cost accounting

The broker run ledger's usage totals are character-based estimates, not metered usage (`packages/cli/src/runtime/dashboard-state.ts` labels them "not metered"), so they are never reported as tokens. Instead:

- **Arms A/B (metered):** token usage and cost come from the `claude -p --output-format json` result per run — authoritative.
- **Arm C:** the runner harvests metered usage from each seat's own CLI session records where the CLI exposes them (claude session transcripts carry per-turn usage; codex session logs carry token counts), summed per run across the components it can meter (implementer, reviewer, evaluator). Any component without a metered source falls back to the broker's character-based estimate for that component.
- Every ledger row records `token_source: "metered" | "estimated"`; a run is `metered` only if all of its components are. Cross-arm token/cost tables in `report.md` are computed over metered runs only; estimated-only rows appear in a separate column explicitly labeled "character-based estimate — not comparable across arms".
- The wall-clock cap is enforced by the runner's clock identically in every arm. Mid-run token-cap enforcement uses metered usage in Arms A/B and the character-based estimate in Arm C (nominal, per Parity controls); when a run is stopped at a ceiling, the ledger records which cap and which source triggered the stop.

## Grading & metrics

Mechanical, no human judgment in the primary metric:

1. Copy the run's resulting workspace to a grading dir; apply `grade/`; run the hygiene gate (the fixture's own typecheck, lint, and pre-existing tests) and the held-out grade tests.
2. **Per-run score — binary task success:** a run succeeds iff the hygiene gate is fully green AND 100% of the held-out grade tests pass. A hygiene failure fails the run regardless of grade-test results.
3. **Primary metric:** per-arm task success rate = successful runs ÷ (30 scheduled runs − unrecovered harness failures), with a per-task breakdown (successes out of trials graded). Agent-caused failures (gave up, empty or broken delivery, budget exhausted) stay in the denominator as unsuccessful runs; escalated Arm C runs are graded as delivered and scored normally, with escalation tracked separately. Harness failures (infra faults the runner classifies before grading — tmux/mount/daemon errors, never agent output) are retried once; a run failing the harness twice is an **unrecovered harness failure**: marked `failed` in the manifest, subtracted from that arm's denominator by the formula above, and reported run-by-run together with a per-arm coverage line (e.g. "graded 29/30 scheduled").
4. **Secondary:** micro-averaged held-out test pass fraction (grade tests passed ÷ total, averaged per arm — partial credit, never a substitute for the primary); defects caught by review (Arm C: `findings` verdicts in the run trail; Arm B: parsed self-review findings); rounds used; escalation rate; tokens/cost per **Token & cost accounting**; wall-clock.
5. Output: `ledger.jsonl` (one row per run: task, arm, trial, task_success, grade tests passed/total, hygiene result, tokens, token_source, cost, seconds, rounds, escalated, CLI versions) + a generated `report.md` with per-arm tables, the named residual confounds, and explicit n=2 caveats (directional, not statistical proof).

## Campaign operations

- A manifest tracks every task×arm×trial as `pending / running / done / failed`; any slice of the 90 runs can be executed in one sitting and the campaign resumed later.
- Pair runs execute serially (one collab at a time); solo arms may run in parallel.
- **Dry-run gate:** before any real spend, the harness must pass an end-to-end dry run driving the existing fake-model pattern (`scripts/e2e/fake-claude-model.mjs`), then one real smoke task, then slices.

## Non-goals

- No external-benchmark comparability (SWE-bench etc.).
- No CI integration; not a permanent regression suite.
- No claim of statistical significance at n=2 — the report says so explicitly.

## Risks (accepted, mitigated)

- **tmux/idle-detection flakiness** → reuse the proven smoke-script mount patterns and turn events; failed runs are marked `failed` in the manifest and retried once, then reported as harness failures, never silently dropped.
- **Cost overrun** → per-task budgets, slice execution, pausable manifest, running cost visible on the dashboard (a character-based estimate — good enough for overrun watching, never for reporting; see Token & cost accounting).
- **Fixture-authorship bias** (kit author also tuned the system under test) → acknowledged in the report; the primary metric stays mechanical.

## Acceptance criteria

1. `eval/` layout exists as specified; 15 tasks each with `fixture/`, `task.md`, `budget.json`, `grade/`, plus `approach.md` for the 12 quick-task-shaped tasks; no `grade/` content reachable from any agent working copy.
2. Runner commands cover: manifest init/status, running a single task×arm×trial, running a slice, grading, report generation.
3. Dry-run mode passes end-to-end against the fake model without external API spend.
4. One real smoke task completes across all three arms and produces correct ledger rows.
5. `report.md` generator produces the per-arm comparison table from the ledger.
6. Raw run outputs are gitignored; manifest, ledger, and report are committable.
7. Root `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm build` all remain green (eval kit code is typechecked and linted; fixtures are excluded from the root test and lint runs).

## Sequencing

1. Spec `2026-08-10-read-fanout-guidance-design.md` lands first.
2. Build the kit; pass the dry-run gate; run the real smoke task.
3. Execute the 90-run campaign in slices; publish `report.md`.
