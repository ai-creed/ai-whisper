# Pair-vs-Solo Evaluation Kit — Design

**Date:** 2026-08-10
**Status:** Approved design (brainstormed in session `research-loop-graph-engineering-vs-whisper`)
**Origin:** Recommendation §8.5 of the research report *Loop Engineering, Graph Engineering, and ai-whisper* (canonical copy in `~/.ai-pref-nsync/local-docs/ai-whisper/knowledge-references/2026-07-29-loop-graph-engineering-vs-ai-whisper.md`). The report's central critique: ai-whisper's core value claim — a cross-vendor implement/review pair beats a solo agent at equal capability — is plausible, evidence-aligned, and **unmeasured**. This kit measures it.

## Goal

A reusable, resumable evaluation campaign comparing three arms on a purpose-built task suite:

- **Arm A — Solo:** one agent, headless, no review structure.
- **Arm B — Solo + self-review:** same agent, with a mandated structured self-review protocol.
- **Arm C — ai-whisper pair:** claude implements, codex reviews, driven through real ai-whisper workflows.

The measured delta between arms isolates the *review structure*: the same model drives A, B, and C's implementer.

**Scale (decided):** 15 tasks × 3 arms × 2 trials = 90 runs, executed in resumable slices.

## Layout

```
eval/
  tasks/<slug>/
    fixture/          # small self-contained TS/Node project the agents work in
    task.md           # the ask + user-visible acceptance criteria (checkable prose)
    budget.json       # token + wall-clock caps for this task
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

## Arm drivers

- **A — Solo:** fresh fixture copy; `claude -p` headless with `task.md` as the prompt payload; JSON output format for token usage capture.
- **B — Solo + self-review:** as A, plus an appended protocol: after implementing, run a structured review of your own diff against the acceptance criteria, fix the findings, maximum 2 review-fix cycles, then stop.
- **C — Pair:** runner generates the quick-task brief (four required sections, scope list) or SDD spec from `task.md`; tmux-automated `whisper collab mount claude` / `whisper collab mount codex` in the fixture workspace; `whisper workflow start --type=quick-task|spec-driven-development --spec=...`; completion detected by polling the state DB per `docs/state-db-read-contract.md` (never by chat); rounds, per-step verdicts, and cost read from the run ledger. Escalated runs are recorded as escalations, graded as-is.

**Controls:** identical implementer model across arms; CLI versions pinned and recorded in the ledger; fresh fixture copy per trial; per-task budget caps enforced by the runner; read-fanout guidance (Spec 1) already landed, so Arm C measures the current pair.

## Grading & metrics

Mechanical, no human judgment in the primary metric:

1. Copy the run's resulting workspace to a grading dir; apply `grade/`; run typecheck + lint (hygiene gate) and the held-out tests.
2. **Primary:** held-out test pass rate per arm.
3. **Secondary:** defects caught by review (Arm C: `findings` verdicts in the run trail; Arm B: parsed self-review findings), rounds used, escalation rate, tokens, wall-clock.
4. Output: `ledger.jsonl` (one row per run: task, arm, trial, pass counts, tokens, seconds, rounds, escalated, CLI versions) + a generated `report.md` with per-arm tables and explicit n=2 caveats (directional, not statistical proof).

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
- **Cost overrun** → per-task budgets, slice execution, pausable manifest, running cost visible on the dashboard.
- **Fixture-authorship bias** (kit author also tuned the system under test) → acknowledged in the report; the primary metric stays mechanical.

## Acceptance criteria

1. `eval/` layout exists as specified; 15 tasks each with `fixture/`, `task.md`, `budget.json`, `grade/`; no `grade/` content reachable from any agent working copy.
2. Runner commands cover: manifest init/status, running a single task×arm×trial, running a slice, grading, report generation.
3. Dry-run mode passes end-to-end against the fake model without external API spend.
4. One real smoke task completes across all three arms and produces correct ledger rows.
5. `report.md` generator produces the per-arm comparison table from the ledger.
6. Raw run outputs are gitignored; manifest, ledger, and report are committable.
7. Root `pnpm typecheck` / `pnpm test` remain green (eval kit code is typechecked; fixtures are excluded from the root test run).

## Sequencing

1. Spec `2026-08-10-read-fanout-guidance-design.md` lands first.
2. Build the kit; pass the dry-run gate; run the real smoke task.
3. Execute the 90-run campaign in slices; publish `report.md`.
