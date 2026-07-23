# Halted-Workflow Resume Continuation — Design

**Date:** 2026-07-23
**Status:** Approved for planning
**Companion spec:** `2026-07-23-run-ledger-preservation-design.md` (Spec A — independent, shippable in either order)

## Problem

Resuming a halted workflow restarts the active phase from scratch. `resumeWorkflow` (`packages/broker/src/control/workflow-control.ts`) routes halted workflows to `resumeHaltedWorkflow`, which only flips status to `running` and emits `workflow.resumed`. The orchestration loop then finds no open phase run and calls `kickoffNextPhaseInternal`, which renders the phase kickoff template fresh — a brand-new chain at round 1, as if the phase had never run.

Everything the previous attempt learned is discarded, even though it is all persisted: `relay_handoff` holds every round's `handback_text`, `round_number`, orchestrator verdicts, and the escalation reason survives in `workflows.halt_reason`.

Observed cost (workflow `wf_82a697e7eb18418e`): the spec-refining phase ran three complete times — two full 5/5-round escalations, each resume restarting at round 1 — before passing on the third attempt at round 3. Roughly ten rounds of agent work repeated. The same workflow is now halted at plan-writing 5/5 with eight persisted handbacks a resume would ignore.

A second defect sits on the same path: `resumeWorkflow` accepts an optional operator `message`. The paused-resume path weaves it into a resume notice; the halted path calls `resumeHaltedWorkflow(workflow, input.now)` and silently drops it. The operator cannot hand guidance to the restarted phase at all.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Resume mechanism | **Seeded fresh chain** — new chain/phase-run as today, kickoff composed from persisted prior-attempt context. Chain rows stay immutable; no reopening of terminal chains. |
| D2 | Commit-range correctness | Seeded phase run inherits the **original** `baseBeforeExecution` (no resume-time re-anchor); seed text instructs agents to ignore commit hashes quoted in prior handbacks. |
| D3 | Round budget | **Fresh full budget** — the seeded chain gets the phase's normal max rounds. |
| D4 | Operator message | Halted resume carries `message` into the seed. Standalone-shippable bugfix. |

Rejected alternatives: reopening the escalated chain at round N+1 (violates chain-immutability assumptions across evaluator and orchestrator — highest-risk option); evaluator-written checkpoint artifacts at escalate time (adds an evaluator contract change and helps only future halts, not existing data).

## Design

### 1. Resume marks a pending seed

`resumeHaltedWorkflow` stops being a bare status flip. In the same transaction that sets `running`, it writes a pending resume-seed marker into `workflow_context`, recording:

- the halted phase index and the escalated chain's `chain_id`,
- the operator's `message` (if any),
- resume timestamp.

No kickoff happens inside resume itself — kickoff remains owned by the orchestration loop, exactly as today.

### 2. Seeded kickoff composition

When `kickoffNextPhaseInternal` (or the equivalent phase-start path) fires for a workflow holding a pending seed for the phase being started, the kickoff text is composed from, in order:

1. **Continuation preamble** — states this is a resumed attempt, not a first run.
2. **Halt reason** — from `workflows.halt_reason` (e.g. `max-rounds-reached (5/5)`).
3. **Final-round handback** — the escalated chain's last `handback_text` in full.
4. **Round history digest** — one line per prior round: round number, orchestrator verdict, first line of the handback. Bounded (cap total seed size; truncate oldest rounds first).
5. **Operator message** — verbatim, clearly attributed.
6. **Commit-range instruction** — see §3.
7. The phase's normal kickoff template content.

The seed is consumed (cleared from `workflow_context`) in the same transaction that creates the new phase run, mirroring the existing one-shot `resumeNotice` mechanics. A resume whose seed references a different phase index than the one being kicked off (e.g. operator advanced the phase manually in between) discards the seed and kicks off plain.

### 3. Commit-range correctness

Handbacks and review instructions reference commit hashes. A reviewer pointed at the wrong base reviews the wrong range and produces a wrong escalation. This failure mode is already documented and has a manual workaround (the "base re-anchor dance", memory `mem-2026-06-12-recover-a-halted-execute-phase-workflow-7a538c`); this spec makes the workaround obsolete.

Mechanism today: `beginPhaseRun` records the workspace HEAD at kickoff as `workflowContext.baseBeforeExecution` (input `executionBaseHeadSha`), and the review range is computed live as `baseBeforeExecution..HEAD` (`liveReviewCommitRange`, `workflow-control.ts`). On resume, the driver's `kickoffCurrentPhase` (`workflow-driver.ts`, ~line 150) re-reads workspace HEAD *at resume time* and **overwrites** `baseBeforeExecution`. With the prior attempt's work already committed, HEAD is the finished tip, the range becomes `tip..HEAD` — an empty diff — and the reviewer sees nothing, defeating the acceptance gate.

Therefore:

- For execute-type phases, a seeded kickoff must **not** re-anchor: the new phase run inherits the escalated attempt's original `baseBeforeExecution`. The review range stays `original-base..current-HEAD`, covering all prior-round commits **and** any commits the operator made while the workflow was halted.
- The seed's commit-range instruction states the authoritative base SHA explicitly and directs agents to ignore any commit hashes quoted inside prior handbacks — those describe historical rounds, not the current range.
- Non-execute phases (no base SHA requirement) omit this section.

Known pre-existing trap, out of scope but noted: if the workspace sat on an unrelated branch at the *first* kickoff, the recorded base can be garbage (not an ancestor of HEAD). Inheriting it faithfully preserves that garbage; validating base ancestry at kickoff is a separate hardening item.

### 4. Round budget

The seeded chain is a normal new chain: its round counter starts at 1 and the phase's configured max rounds apply unchanged. No counter mechanics are touched. An operator resuming after an escalation is making a deliberate "try again, now with context" call and gets the full runway.

### 5. Operator message bugfix

`resumeWorkflow`'s halted branch passes `input.message` through to the seed (§1). This piece is deliberately separable: even if seeding ships later, the message must stop being dropped.

## Out of scope

- Reopening or mutating terminal chains or handoffs.
- Changing escalation/evaluator verdict logic or round-count semantics.
- Paused-resume behavior (already carries notices; unchanged).
- Cross-phase seeding (seed applies only to the phase that halted).

## Testing

Test-first, reproducing the defect before fixing:

- **Amnesic-resume reproduction:** halt a workflow at max rounds, resume, capture the kickoff request text — must currently lack halt reason/handback (failing), must contain preamble, halt reason, final handback, and round digest after the change.
- **Base-SHA inheritance:** with prior-attempt work committed (HEAD = finished tip), resume today yields an empty `tip..HEAD` review range (failing reproduction); after the change, the seeded run's `baseBeforeExecution` equals the original attempt's, `liveReviewCommitRange` spans the full feature diff, and the kickoff text states the base.
- **Operator message:** `resume --message` on a halted workflow lands verbatim in the seeded kickoff; absent message produces no empty section.
- **Seed consumption:** seed cleared after one kickoff; second phase start is plain.
- **Stale seed:** seed for phase N discarded when kicking off phase N+1.
- **Non-execute phase:** seeded kickoff omits commit-range section.
- **Budget:** seeded chain escalates again at configured max rounds (fresh budget honored).
