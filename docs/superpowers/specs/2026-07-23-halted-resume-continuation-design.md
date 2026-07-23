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
| D2 | Commit-range correctness | Every resumed phase with a usable existing `baseBeforeExecution` keeps the range live: base-**establishing** phases (execute-step or `anchorCommitBaseOnEntry`) inherit the original base with no resume-time re-anchor; base-**consuming** phases (e.g. SDD code-review) use the already-recorded base untouched; both render `{commitRange}` as `original-base..HEAD`, and seed text instructs agents to ignore commit hashes quoted in prior handbacks. |
| D3 | Round budget | **Fresh full budget** — the seeded chain gets the phase's normal max rounds. |
| D4 | Operator message | Halted resume carries `message` into the seed marker; delivery works for **every** halted resume, including halts with no escalated chain. Standalone-shippable bugfix. |

Rejected alternatives: reopening the escalated chain at round N+1 (violates chain-immutability assumptions across evaluator and orchestrator — highest-risk option); evaluator-written checkpoint artifacts at escalate time (adds an evaluator contract change and helps only future halts, not existing data).

## Design

### 1. Resume marks a pending seed

`resumeHaltedWorkflow` stops being a bare status flip. In the same transaction that sets `running`, it writes a pending resume-seed marker into `workflow_context`, recording:

- the halted phase index and resume timestamp (always present),
- the workflow's `halt_reason` **as captured at resume time** — the same transaction clears the `workflows.halt_reason` column when flipping status to `running` (`workflow-control.ts`, `resumeHaltedWorkflow`), so the seed is the only copy that survives to kickoff time,
- the escalated chain's `chain_id`, **if one exists** — some halts occur before any phase run or chain is created (e.g. the driver halts on an unbound target agent, `test/workflow-driver.test.ts` "unbound target agent"), so this field is optional,
- the operator's `message` (if any).

No kickoff happens inside resume itself — kickoff remains owned by the orchestration loop, exactly as today.

### 2. Seeded kickoff composition

When `kickoffNextPhaseInternal` (or the equivalent phase-start path) fires for a workflow holding a pending seed for the phase being started, the kickoff text is composed from, in order:

1. **Continuation preamble** — states this is a resumed attempt, not a first run.
2. **Halt reason** — from the seed's captured copy (§1), e.g. `max-rounds-reached (5/5)`. Never read from `workflows.halt_reason` at kickoff time — resume has already cleared that column.
3. **Final-round handback** — the escalated chain's last `handback_text`, in full up to its cap (§2a).
4. **Round history digest** — one line per prior round: round number, orchestrator verdict, first line of the handback. Bounded per §2a; oldest rounds dropped first.
5. **Operator message** — verbatim up to its cap (§2a), clearly attributed.
6. **Commit-range instruction** — see §3.
7. The phase's normal kickoff template content.

Each of sections 2–6 renders **only when its source data exists**; absent data produces no section, never an empty heading. In particular, a no-chain halt (§1) yields a seed of preamble + halt reason + operator message only — sections 3, 4, and 6 have no source and are omitted.

The seed is consumed (cleared from `workflow_context`) in the same transaction that creates the new phase run, mirroring the existing one-shot `resumeNotice` mechanics. If that transaction fails (phase-run creation aborts), the rollback must retain the seed so the next kickoff attempt can still use it. A resume whose seed references a different phase index than the one being kicked off (e.g. operator advanced the phase manually in between) discards the seed and kicks off plain.

### 2a. Size caps and overflow policy

The composed seed (sections 1–6, excluding the normal template content) has a hard total budget of **24,000 characters**, measured on the fully rendered seed text **including truncation markers**. Per-field caps bound **retained source characters only — markers do not count toward any field cap**; each marker is at most 80 characters, so marker overhead is bounded by construction (≤ 5 markers, ≤ 400 characters total). A truncated field is therefore exactly its retained source characters plus its marker — e.g. a truncated handback is the first 8,000 source characters, the elision marker, then the last 4,000 source characters. Per-field caps, all deterministic — identical inputs always produce an identical seed:

- **Halt reason:** 500 characters; tail-truncated with an explicit `[... truncated]` marker.
- **Final-round handback:** 12,000 characters; if over, keep the first 8,000 and last 4,000 characters with an `[... N characters elided ...]` marker between. "In full" in §2 means full up to this cap.
- **Operator message:** 4,000 characters; tail-truncated with an `[... N characters truncated]` marker. "Verbatim" in §2 means verbatim up to this cap.
- **Round digest:** each line capped at 200 characters (tail-truncated); if the total seed still exceeds the budget, drop oldest rounds first and prepend a `(digest truncated: rounds 1–K omitted)` note.
- Preamble, halt reason, and commit-range instruction are bounded by construction and never compete for budget.

Overflow resolution order when the total still exceeds 24,000 after per-field caps: shrink the digest (drop oldest rounds, to zero if needed), then tighten the handback's middle elision, then the operator message tail. This order is fixed so the highest-signal content (final handback head/tail, operator message head) survives longest.

### 3. Commit-range correctness

Handbacks and review instructions reference commit hashes. A reviewer pointed at the wrong base reviews the wrong range and produces a wrong escalation. This failure mode is already documented and has a manual workaround (the "base re-anchor dance", memory `mem-2026-06-12-recover-a-halted-execute-phase-workflow-7a538c`); this spec makes the workaround obsolete.

Mechanism today: `beginPhaseRun` records the workspace HEAD at kickoff as `workflowContext.baseBeforeExecution` (input `executionBaseHeadSha`), and the review range is computed live as `baseBeforeExecution..HEAD` (`liveReviewCommitRange`, `workflow-control.ts`). The driver reads HEAD not only for execute-step phases but for **any phase with `anchorCommitBaseOnEntry: true`** (`workflow-driver.ts`, ~line 150) — currently complex-bug-fixing's diagnosis phase and quick-task's implement-and-review phase (`workflow-registry.ts`) — and `beginPhaseRun` overwrites `baseBeforeExecution` whenever that SHA is supplied. On resume, `kickoffCurrentPhase` re-reads workspace HEAD *at resume time* and **overwrites** `baseBeforeExecution`. With the prior attempt's work already committed, HEAD is the finished tip, the range becomes `tip..HEAD` — an empty diff — and the reviewer sees nothing, defeating the acceptance gate.

A second staleness channel: the normal kickoff template appended after the seed (§2 item 7) renders its `{commitRange}` placeholder from the **frozen** `workflowContext.commitRange` (`workflow-driver.ts`, kickoff render), and the review/fix step templates print that range verbatim (`workflow-registry.ts`, e.g. `SDD_CODE_REVIEW`, `QUICK_TASK_REVIEW`). A seed that states the correct base while the appended template quotes a stale range hands the agents two contradictory instructions.

Therefore, D2 applies to **every resumed phase with a usable existing `baseBeforeExecution`**, in two classes:

- **Base-establishing phases** — `initialHandoffStep === "execute"` or `anchorCommitBaseOnEntry === true`. A seeded kickoff must **not** re-anchor: the new phase run inherits the escalated attempt's original `baseBeforeExecution`. The review range stays `original-base..current-HEAD`, covering all prior-round commits **and** any commits the operator made while the workflow was halted.
- **Base-consuming phases** — phases that establish no base themselves but whose templates render `{commitRange}` from a base recorded by an earlier phase; today, SDD's `code-review` phase (`initialHandoffStep: "review"`, no anchor flag, `workflow-registry.ts`). A seeded kickoff leaves the recorded `baseBeforeExecution` untouched and applies the same live-range rendering below. Without this, an operator commit made while a code-review phase is halted leaves the resumed reviewer pinned to the frozen pre-halt range.

For both classes:

- The `{commitRange}` placeholder — in the kickoff template and in all subsequent step templates for the seeded phase run — renders as `original-base..HEAD` (the live-HEAD form), overriding the frozen `workflowContext.commitRange`, so no template content contradicts the seed.
- The seed's commit-range instruction states the authoritative base SHA explicitly and directs agents to ignore any commit hashes quoted inside prior handbacks — those describe historical rounds, not the current range.

Phases with **no usable `baseBeforeExecution`** — none recorded by any earlier phase and none established by the phase itself — omit this section.

Known pre-existing trap, out of scope but noted: if the workspace sat on an unrelated branch at the *first* kickoff, the recorded base can be garbage (not an ancestor of HEAD). Inheriting it faithfully preserves that garbage; validating base ancestry at kickoff is a separate hardening item.

### 4. Round budget

The seeded chain is a normal new chain: its round counter starts at 1 and the phase's configured max rounds apply unchanged. No counter mechanics are touched. An operator resuming after an escalation is making a deliberate "try again, now with context" call and gets the full runway.

### 5. Operator message bugfix

`resumeWorkflow`'s halted branch passes `input.message` through to the seed marker (§1). The standalone-shippable unit is the **minimal marker**: phase index, resume timestamp, and `message`, with every chain-derived field absent. Kickoff composition (§2) renders whatever the marker holds, so this unit works with no escalated chain, no handbacks, and no digest — it depends on none of the seeding machinery beyond the marker itself and the §2 render hook.

This covers every halted resume, not just max-round escalations: a workflow halted before any phase run existed (binding failure, HEAD-read failure) still delivers the operator's message into the next kickoff via the same marker. Even if full seeding (handback, digest, commit-range inheritance) ships later, the message must stop being dropped first.

## Out of scope

- Reopening or mutating terminal chains or handoffs.
- Changing escalation/evaluator verdict logic or round-count semantics.
- Paused-resume behavior (already carries notices; unchanged).
- Cross-phase seeding (seed applies only to the phase that halted).

## Testing

Test-first, reproducing the defect before fixing:

- **Amnesic-resume reproduction:** halt a workflow at max rounds, resume, capture the kickoff request text — must currently lack halt reason/handback (failing), must contain preamble, halt reason, final handback, and round digest after the change. The halt-reason assertion compares against the **exact string held by `workflows.halt_reason` at halt time** (captured before resume clears the column, per §1) — not merely "a reason appears".
- **Base-SHA inheritance:** with prior-attempt work committed (HEAD = finished tip), resume today yields an empty `tip..HEAD` review range (failing reproduction); after the change, the seeded run's `baseBeforeExecution` equals the original attempt's, `liveReviewCommitRange` spans the full feature diff, and the kickoff text states the base. Run this for an execute-step phase **and** for an `anchorCommitBaseOnEntry` phase (quick-task implement-and-review or bugfix diagnosis) — both establish a base and both must inherit.
- **Base-consuming phase (halted code-review):** halt an SDD `code-review` phase, make an operator commit while halted, resume — the seeded kickoff and subsequent step templates render `original-base..HEAD` (a range spanning the intervening commit), with zero occurrences of the frozen pre-halt range, and `baseBeforeExecution` is left untouched.
- **No stale range in rendered kickoff:** with operator commits made while halted (so the frozen `workflowContext.commitRange` provably differs from `original-base..HEAD`), the full seeded kickoff text — seed plus appended normal template — contains the `original-base..HEAD` form and **zero occurrences of the stale frozen range**. A test that only checks "states the base" is insufficient (§3).
- **Operator message:** `resume --message` on a halted workflow lands verbatim in the seeded kickoff; absent message produces no empty section. Cover both a seeded max-round halt **and** a no-chain halt (workflow halted before any phase run existed, e.g. unbound-agent halt): the minimal marker (§5) must deliver the message in both, with no handback/digest/commit-range sections in the no-chain case.
- **Caps and overflow:** a handback over 12,000 characters, a message over 4,000, and a digest pushing the seed past the 24,000 total are each truncated exactly per §2a — field caps count retained source characters only (markers excluded), so the truncated handback is exactly the first 8,000 source characters + elision marker + last 4,000 source characters; markers present, resolution order honored, and the same inputs produce a byte-identical seed on repeat composition.
- **Seed consumption:** seed cleared after one kickoff; second phase start is plain.
- **Consumption rollback:** force phase-run creation to fail after resume — the transaction rolls back, no partial chain/phase-run rows exist, and the seed is **retained** for the next kickoff attempt.
- **Chain immutability (D1):** after a seeded resume, the new phase run's `chain_id` differs from the escalated chain's; the escalated chain's status and every one of its `relay_handoff` rows are byte-identical to their pre-resume state.
- **Stale seed:** seed for phase N discarded when kicking off phase N+1.
- **No-base phase:** a seeded kickoff for a phase with no usable `baseBeforeExecution` (none recorded by an earlier phase, none established by the phase itself) omits the commit-range section; base-establishing and base-consuming phases are covered by the tests above, not this one.
- **Budget:** seeded chain escalates again at configured max rounds (fresh budget honored).
