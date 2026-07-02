# Workflow Mark-Done — v1 "Operator completes an escalated run"

Status: design approved, not yet implemented
Date: 2026-07-02
Revision: 2026-07-02a

## Summary

A halted (escalated) workflow can be marked **done** by the human operator. Some runs finish all their work but cannot pass the final verification gate for environmental reasons the agents cannot fix — e.g. the e2e suite needs credentials or hardware the collab machine does not have. Today the operator's only options are `resume` (pointless — the blocker persists) or `cancel` (wrong — the work is complete and the run should count as a success). This feature adds the third option: the operator verifies the work manually and marks the workflow done, from the dashboard or the CLI.

## Verified codebase findings (2026-07-02)

- Workflow statuses: `running | paused | halted | done | canceled` (`packages/broker/src/storage/repositories/workflow-repository.ts`). Escalation sets `halted` + `halt_reason`.
- Two paths produce `halted`:
  - The orchestrator-verdict escalation path (`applyOrchestratorVerdict` in `packages/broker/src/control/workflow-control.ts` ~line 1058) — closes the open phase run with outcome `escalated` and sets the chain terminal `escalated` before flipping status.
  - The standalone `haltWorkflow` (~line 1213) — **only flips status**; it leaves the open phase run and chain untouched. A mark-done must therefore defensively sweep open phase runs, exactly as `cancelWorkflow` does.
- `cancelWorkflow` (~line 1430) is the model for a terminal operator transition: guard outside the transaction, re-check inside, close open phase runs with outcome `superseded`, set the chain terminal with a reason, set workflow status, reset relay turn state, `emitAndRecord` an event.
- The control service (`packages/broker/src/control/create-control-service.ts` line 1529) merges the whole `workflowControl` object into its return, so a new method on `createWorkflowControl`'s return is automatically exposed on `broker.control.<method>` — no per-method registration.
- Dashboard action machinery (`packages/cli/src/runtime/dashboard-state.ts`, `dashboard.ts`, `dashboard-view.tsx`): `WorkflowAction = "pause" | "resume" | "cancel"`, `actionsForStatus(status)` mirrors broker guards, keys `p`/`r`/`c` open a y/n confirm modal, `executeConfirmed` calls the matching `broker.control` method and sets a transient feedback line. There is no on-screen key legend to update — keys are documented in `docs/workflows.md` only.
- CLI workflow commands (`packages/cli/src/commands/workflow/{pause,resume,cancel}.ts`) are thin structural-deps wrappers registered in `packages/cli/src/create-cli.ts` (~line 593).
- `workflow.done` event: typed `{ workflowId }` in `packages/broker/src/runtime/broker-event-bus.ts:38`, already allowlisted in `event-socket-server.ts:27` — natural completion emits it (`workflow-control.ts:1162`), so downstream display reacts to an operator mark-done with zero new display code.
- Hands-off stats (`getHandsOffStats`, workflow-repository.ts): counts `done` and `halted` runs, elapsed = `updated_at − created_at`.

## Design decisions (approved 2026-07-02)

1. **Surfaces: dashboard + CLI.** The broker control method is required either way; the CLI command keeps parity with the pause/resume/cancel trio.
2. **Eligibility: `halted` only.** Matches the use case (escalated run, work complete, verification blocked). A paused workflow has mid-flight work and should be resumed or canceled instead. `running`, `done`, `canceled` all reject.
3. **Audit trail: fixed reason string.** Status → `done`, `halt_reason` → `"marked done by operator"`. Operator completion stays distinguishable from natural completion (`halt_reason` null). No optional note in v1.

## Broker: `markWorkflowDone`

New method in `createWorkflowControl` (`packages/broker/src/control/workflow-control.ts`), signature matching its siblings:

```ts
function markWorkflowDone(input: { workflowId: string; now: string }): void
```

Behavior:

1. **Guards (outside the transaction, mirroring `cancelWorkflow`):**
   - Unknown `workflowId` → throw `markWorkflowDone: unknown workflowId <id>`.
   - Status ≠ `halted` → throw `markWorkflowDone: workflow <id> is <status>, only halted (escalated) workflows can be marked done`.
2. **Inside one `db.transaction(...).immediate()`:**
   - Re-fetch; if status is no longer `halted`, return (race no-op).
   - Close any open phase runs (`endedAt === null`) with outcome `superseded`, and set each run's chain terminal: status `abandoned`, `terminalReason: "marked done by operator"`, terminal handoff = latest handoff of the chain (nullable). This is the `cancelWorkflow` sweep verbatim with a different reason — normally a no-op because the escalation verdict path already closed everything, but required for `haltWorkflow`-produced halts.
   - `setWorkflowStatus({ status: "done", haltReason: "marked done by operator" })`.
   - Reset relay turn state to idle with `chainStatus: "done"`, matching natural completion (`workflow-control.ts` ~line 838) rather than cancel's `abandoned` — the run concluded successfully from the operator's perspective. (Defensive; halted runs are normally already idle.)
   - A chain already terminal `escalated` stays `escalated` — that is true history; the workflow-level `done` is the operator overlay.
3. **After commit:** `emitAndRecord(collabId, "workflow.done", { workflowId }, now)` — the same event natural completion emits.

Exposure on `broker.control` is automatic via the control-service merge; add `markWorkflowDone` to the `createWorkflowControl` return object.

## Dashboard

- `WorkflowAction` union (`dashboard-state.ts`) gains `"done"`.
- `actionsForStatus`: `halted` → `["resume", "done", "cancel"]`. All other statuses unchanged (`done` is offered nowhere else, mirroring the broker guard).
- `actionForKey` (`dashboard.ts`): `d` → `"done"` (key currently unused in both wall and inspector modes).
- `ACTION_VERB` (`dashboard-view.tsx`): `done: "Mark done"` — confirm modal reads `Mark done <workflowId>? (y/n)`.
- `executeConfirmed`: `done` branch calls `c.markWorkflowDone({ workflowId, now })`, success feedback verb `marked done`.
- The stale-frame guard (`freshStatusFor` + `actionsForStatus` re-check in `requestAction`) covers the new action with no extra code.

## CLI

New command `whisper workflow complete <workflowId>`:

- `packages/cli/src/commands/workflow/complete.ts` — structural-deps wrapper mirroring `pause.ts`: `runWorkflowComplete(deps)` calls `deps.broker.control.markWorkflowDone({ workflowId, now })`.
- Registered in `create-cli.ts` beside pause/resume/cancel: description "Mark a halted (escalated) workflow as done after manual verification", success output `Workflow marked done: <workflowId>`.

## Docs

- `docs/workflows.md` — in the operator-controls section (~line 157): add the third option beside resume/cancel: when an escalated run's work is actually complete but verification was environment-blocked, verify manually and run `whisper workflow complete <workflowId>` (or press `d` on the run's dashboard card).
- `README.md` — one sentence in the escalation paragraph (~line 120): after the `resume` mention, note `whisper workflow complete <id>` for the verified-manually case. (Root README only; `packages/cli/README.md` is build-generated from it.)

## Accepted side effects

- **Hands-off stats bucket move.** Marking done moves the run from the `halted` bucket to the `done` bucket, and its elapsed recomputes to `mark-done-time − created_at`, so time spent sitting escalated awaiting the operator counts into "hands-off time saved". Accepted (YAGNI), consistent with the existing accepted caveat on post-terminal `updated_at` bumps documented in `getHandsOffStats`.
- **`workflow.done` event is indistinguishable from natural completion for event consumers.** Acceptable: the audit distinction lives in `halt_reason`, and no consumer currently branches on completion provenance.

## Testing

TDD throughout; tests live in root `test/` per repo convention.

- **Broker (`test/workflow-control*.test.ts` or new `test/workflow-mark-done.test.ts`):**
  - Unknown id throws; `running`/`paused`/`done`/`canceled` statuses throw with the exact guard message.
  - Halted (via escalation-verdict path) → status `done`, `halt_reason = "marked done by operator"`, `workflow.done` emitted once.
  - Halted via bare `haltWorkflow` with an open phase run → phase run closed `superseded`, chain terminal `abandoned` with reason `marked done by operator`, workflow `done`.
  - Chain already terminal `escalated` stays `escalated`.
- **Dashboard state:** `actionsForStatus` table test — `halted` includes `done`; no other status offers it.
- **Dashboard runtime:** reuse the existing p/r/c key-harness pattern — `d` on a halted card opens the `Mark done … (y/n)` confirm; `y` invokes `markWorkflowDone` on the control stub; `d` on a running card yields the `not available` hint feedback.
- **CLI:** `runWorkflowComplete` calls the control method with the given id/now (mirror the pause/cancel command tests if present).

## Out of scope (v1)

- Marking a **paused** workflow done.
- An operator note/message on completion (resume's `--message` pattern) — add later if audit needs grow.
- Un-doing a mark-done (done stays terminal; `cancelWorkflow` already rejects done runs).
- Dashboard on-screen key legend (none exists today for p/r/c either).
