# Dashboard Summary Bar + In-Dashboard Workflow Actions — Design

**Date:** 2026-06-25
**Status:** Approved for planning
**Component:** `packages/cli` dashboard runtime (`whisper collab dashboard`)

## Goal

Add two improvements to the collab dashboard, in one phase:

1. **Summary bar** — a single header line on the Wall showing live counts of every
   card state (running / paused / stuck / done / canceled / idle), so an operator
   reads overall fleet health at a glance without scanning every card.
2. **In-dashboard workflow actions** — pause, resume, and cancel a workflow run
   directly from the dashboard (Wall or Inspector), each behind a confirmation
   prompt, instead of dropping out to the separate `whisper workflow …` CLI
   commands.

## Background

The dashboard (`packages/cli/src/runtime/dashboard.ts` + `dashboard-view.tsx` +
`dashboard-state.ts`) is an Ink terminal UI with two surfaces:

- **Wall** — status cards partitioned into sections (ACTIVE / IDLE-MANUAL /
  HALTED / DONE-CANCELED), paginated, with a footer and a bottom glyph legend.
- **Inspector** — a per-run drill-in with Live / Timeline / Evidence / Cost tabs.

It is currently **observe-only**. Navigation is keyboard-driven: Wall uses
`↑↓`/`jk` to select, `[`/`]` to page, `↵` to inspect, `q` to quit; Inspector uses
`1-4` for sections, `g`/`G`/`f`/`↑↓` to scroll, `Esc` to return, `q` to quit.

The dashboard holds the broker **in-process** as `input.broker` (`BrokerRuntime`).
`input.broker.control` already exposes the three workflow controls we need, each
**synchronous** and each enforcing its own state guards by throwing:

- `pauseWorkflow({ workflowId, now })` — only a `running` workflow can be paused;
  throws otherwise.
- `resumeWorkflow({ workflowId, now, message? })` — only `paused` or `halted` can
  be resumed; throws otherwise. (We pass no `message` this phase.)
- `cancelWorkflow({ workflowId, now })` — any non-terminal workflow can be
  canceled; throws if already `done` or `canceled`.

Because the broker is in-process and these methods already exist, **no broker
changes are required**. The work is entirely in the CLI dashboard runtime + view.

## Non-goals (this phase)

- **Resume-with-message.** No in-TUI text-input mode. A plain resume only; the
  operator note path (`whisper workflow resume --message`) stays a CLI command.
- **Other workflow operations** — start, escalate, phase navigation, role
  rebinding, etc. Out of scope.
- **Filtering / search / sorting controls** on the Wall. Out of scope.
- **Real token metering** (Cost tab stays estimate-based). Out of scope.
- **Per-card precise stuck counting in the summary bar.** The bar uses the cheap
  Wall-side static stuck signal (see "Summary bar" below); it does not fetch
  snapshots to recompute precise liveness for off-screen cards.

## Architecture

Thin imperative hooks in the existing `dashboard.ts` closure, backed by pure
decision functions in `dashboard-state.ts`:

- All *decisions* are pure and unit-tested: how to count card states
  (`summarizeWall`) and which actions a status permits (`actionsForStatus`).
- The runtime closure owns small mutable UI state for the confirm prompt and the
  result feedback line, and calls `broker.control.*` directly on confirm.
- The view renders the summary bar, the confirm prompt, and the feedback line as
  pure functions of props.

This matches the dashboard's established pattern (closure + mutable runtime state
+ `__test` seams + pure builders in `dashboard-state.ts`). Rejected alternatives:
a dedicated reducer/FSM module (a new pattern, overkill for three actions) and
shelling out to `whisper workflow …` (the broker is already in-process; a
subprocess would be slower and lose the broker's error messages).

## Feature 1 — Summary bar

### Data

New pure function in `dashboard-state.ts`:

```ts
export type WallSummaryCounts = {
	running: number;
	paused: number;
	stuck: number;
	done: number;
	canceled: number;
	idle: number;
};

export function summarizeWall(summaries: CollabSummary[]): WallSummaryCounts;
```

Counts are derived **only** from each summary's `workflowStatus` plus the existing
cheap `isStuckRunning(s)` heuristic already defined in `dashboard-state.ts` (the
same signal that drives stuck-pinning in `partitionWallGroups`). No snapshot fetch.

Bucketing rules (each summary lands in exactly one bucket):

| bucket    | rule                                                        |
|-----------|-------------------------------------------------------------|
| `stuck`   | `workflowStatus === "halted"` OR (`"running"` AND `isStuckRunning(s)`) |
| `running` | `workflowStatus === "running"` AND NOT `isStuckRunning(s)`   |
| `paused`  | `workflowStatus === "paused"`                               |
| `done`    | `workflowStatus === "done"`                                 |
| `canceled`| `workflowStatus === "canceled"`                            |
| `idle`    | `workflowStatus === null` (manual-relay slice, no workflow) |

Evaluate `stuck` before `running` so an `isStuckRunning` running workflow counts
once, as stuck. Any unknown future status is not counted (defensive, mirrors
`partitionWallGroups`).

Because it reads the `summaries` array the Wall is already given (which already
reflects `--all` and `--window`), the bar counts the **full visible scope across
all pages**, not just the on-screen page.

### Rendering

`summarizeWall` is called in `dashboard.ts#node()` on the same `summaries` used to
build the Wall, and the result is passed to `<Wall>` as a new `counts` prop. The
`Wall` component renders it as the **first line**, above the section headers:

```
● 3 running  ‖ 1 paused  ⚠ 2 stuck  ✓ 5 done  ✖ 0 canceled  ◌ 1 idle
```

- Glyphs and colors match the existing bottom legend (`● running ‖ paused ⚠
  stuck/halted ✓ done ✖ canceled ◌ idle`).
- Each segment is colored by its theme color when its count is non-zero, and
  dimmed (`THEME.muted`) when its count is zero, so attention states stand out.
- `wrap="truncate"` — on a narrow terminal the line truncates rather than wraps.
- When there are zero runs in scope, the Wall already short-circuits to the
  "no active collabs" message; the bar is not rendered in that case.

### Known nuance (documented, intended)

A visible card's *precise* `computeLiveness` may flag a few additional `running`
cards as ⚠ on screen than the bar's static `isStuckRunning` count reflects. The
bar deliberately trades that precision for being page-independent and
snapshot-free. This is acceptable: the bar is a fleet-health glance, the cards
remain authoritative per-run.

## Feature 2 — In-dashboard workflow actions

### Action validity (pure)

New pure function in `dashboard-state.ts`:

```ts
export type WorkflowAction = "pause" | "resume" | "cancel";

export function actionsForStatus(
	status: "running" | "paused" | "done" | "halted" | "canceled" | null,
): WorkflowAction[];
```

Mirrors the broker's own guards so the UI never opens a confirm for a transition
the broker would reject:

| status              | valid actions      |
|---------------------|--------------------|
| `running`           | pause, cancel      |
| `paused`            | resume, cancel     |
| `halted`            | resume, cancel     |
| `done`              | — none —           |
| `canceled`          | — none —           |
| `null` (manual)     | — none —           |

### Keys

The same keys work on both surfaces; none collide with existing bindings
(Wall: `jk`/`[]`/`↵`/`q`/`↑↓`; Inspector: `1-4`/`g`/`G`/`f`/`q`/`Esc`/`↑↓`):

- `p` — pause
- `r` — resume
- `c` — cancel

### Target resolution

- **Wall:** the selected pane resolves to `{ collabId, workflowId }` via the
  existing `lastPaneRuns[wallSelected]`.
- **Inspector:** the focused run is the existing `inspectorWorkflowId`.

A target with `workflowId === null` (manual-relay slice / idle card) has no
workflow to act on.

### Confirmation flow (all actions confirmed)

Every action is confirmed — a single uniform path, because a mistyped key on a
live workflow must never execute silently.

1. On `p`/`r`/`c`, resolve the target and **re-fetch its current summary** (the
   same fresh-fetch the Enter handler already does) so validity is checked against
   live status, not a stale frame.
2. Pre-check: if `workflowId === null`, or the action is not in
   `actionsForStatus(freshStatus)`, set a **hint** in the feedback line (e.g.
   `pause not available (paused)` or `no workflow on this card`) and stop — **no
   prompt, no broker call**.
3. Otherwise open a modal confirm: `pendingConfirm = { workflowId, action }`. The
   view renders the action-specific prompt:
   - `Pause wf_xxxx? (y/n)`
   - `Resume wf_xxxx? (y/n)`
   - `Cancel wf_xxxx? (y/n)`
4. While a confirm is pending it is **modal**: only `y`/`↵` (execute), `n`/`Esc`
   (dismiss) are honored; all other keys are swallowed.
5. On execute: re-validate against fresh status once more, then call the matching
   `broker.control.*({ workflowId, now })` inside try/catch:
   - success → feedback `{ kind: "ok", text: "paused wf_xxxx" }` (green),
   - throw → feedback `{ kind: "err", text: <broker error message> }` (red) — the
     broker's guard messages are operator-meaningful and surfaced verbatim.
   Clear `pendingConfirm` and trigger an immediate `rerender()`.

`pendingConfirm` carries `{ workflowId, action }` (not cancel-only), giving one
confirm path for all three actions.

### Feedback line

- `actionFeedback: { kind: "ok" | "err" | "hint"; text: string } | null` plus an
  `actionFeedbackAtMs` timestamp.
- Rendered near the footer, color-coded: ok → `THEME.ok`, err → `THEME.err`, hint
  → `THEME.muted`.
- Auto-expires ~4s after it is set, evaluated against an **injected clock**
  `nowMs(): number` (defaults to `Date.now`, overridable so tests are
  deterministic). Expiry is checked during render/poll; a new action also replaces
  any prior feedback.

### Help text / legend

The Wall footer help and the Inspector help line gain `p pause · r resume · c
cancel`. The bottom glyph legend is unchanged.

### Test seams

Add `__pendingConfirm()` and `__actionFeedback()` getters to the runtime handle
(alongside the existing `__mode`, `__section`, `__wallSelected`,
`__inspectorWorkflowId`, etc.) so host tests can assert confirm/feedback state
without rendering.

## Edge cases

1. **No workflow on card** — `p`/`r`/`c` on a manual-relay / idle card (null
   `workflowId`) → hint, no prompt, no broker call.
2. **Action invalid for status** — e.g. `p` on a paused run, `r` on a running run,
   any action on done/canceled → hint, no prompt, no broker call.
3. **Status changed between render and keypress** — the pre-check re-fetches fresh
   status; if the action became invalid, it falls to the hint path.
4. **Status changed between confirm-open and execute** — re-validation at execute
   time catches it; if the broker still rejects (race), the throw becomes red
   error feedback.
5. **Confirm is modal** — any non-`y`/`n`/`↵`/`Esc` key while a confirm is pending
   is swallowed (does not move selection, page, change section, or quit).
6. **Feedback expiry on idle** — with no further input, the feedback line clears
   on the next poll after ~4s (injected clock).
7. **Narrow terminal** — the summary bar truncates (`wrap="truncate"`); the
   confirm/feedback lines truncate likewise.
8. **Page-independent bar vs per-card precise stuck** — documented nuance above;
   the bar may under-count stuck relative to on-screen ⚠ cards.
9. **Inspector action with null workflowId** — a manual-relay Inspector view has
   no `inspectorWorkflowId`; actions hint and do nothing.
10. **`q` still quits, scroll keys unaffected** — `p`/`r`/`c`/`y`/`n` do not
    overlap any existing Wall or Inspector binding.

## Testing

- **`dashboard-state.test.ts`**
  - `summarizeWall`: each bucket counted correctly; `isStuckRunning` running
    counts as stuck not running; halted counts as stuck; null counts as idle;
    mixed multi-run fixture totals; empty input → all zeros.
  - `actionsForStatus`: the full status→actions table above, including `null` and
    terminal statuses → `[]`.
- **`dashboard-host.test.ts`**
  - valid action key opens the matching confirm (`__pendingConfirm`);
  - `y`/`↵` executes and calls the correct `broker.control.*` with the resolved
    `workflowId`; `n`/`Esc` dismisses without calling the broker;
  - confirm is modal (a swallowed key does not change selection/section);
  - invalid-for-status and no-workflow presses produce a hint and **no** broker
    call;
  - fresh-status re-fetch on keypress (status changed since last render);
  - broker throw → red error feedback; success → ok feedback;
  - feedback auto-expiry via a fake `nowMs` clock;
  - actions work identically from the Inspector surface.
- **`dashboard-view.test.tsx`**
  - summary bar renders with correct counts and is the first line;
  - zero buckets dimmed, non-zero colored;
  - confirm prompt renders the action-specific text;
  - feedback line renders ok/err/hint with the right color.

## Files touched

- `packages/cli/src/runtime/dashboard-state.ts` — `summarizeWall`,
  `WallSummaryCounts`, `actionsForStatus`, `WorkflowAction`.
- `packages/cli/src/runtime/dashboard-view.tsx` — summary bar in `Wall`, confirm
  prompt + feedback line in `Wall` and `Inspector`, help-text additions.
- `packages/cli/src/runtime/dashboard.ts` — action key handlers (Wall +
  Inspector), confirm/feedback runtime state, injected `nowMs`, fresh-status
  re-fetch + execute, `__pendingConfirm`/`__actionFeedback` seams, new `counts`
  wiring into `node()`.
- Tests: `dashboard-state.test.ts`, `dashboard-host.test.ts`,
  `dashboard-view.test.tsx`.
- Docs: `docs/relay-handoff-flows.md` (dashboard actions section), `README.md`
  (one-line note).

## Decomposition (for the implementation plan)

Four TDD tasks, each independently testable:

1. **Summary bar** — `summarizeWall` + `WallSummaryCounts` (state + tests), render
   the bar in `Wall`, wire `counts` from `node()` (view + state tests).
2. **Action validity + pause/resume** — `actionsForStatus` + `WorkflowAction`
   (state + tests); confirm/feedback runtime state + injected `nowMs`; `p`/`r`
   key handling with target resolution, fresh-status pre-check, modal confirm,
   execute, feedback; confirm + feedback rendering (host + view tests).
3. **Cancel + Inspector surface** — `c` action; ensure all three actions work from
   the Inspector; complete the modal/edge-case matrix (host + view tests).
4. **Docs + help text** — footer/Inspector help additions, `relay-handoff-flows.md`
   section, `README.md` note.

## Global constraints (carried into the plan)

- TypeScript strict; no unused symbols; exact-optional spread pattern
  `...(x != null ? { x } : {})` where applicable.
- Indentation is **tabs**.
- **Do NOT run `pnpm format:write`** (repo-wide formatter; reformats hundreds of
  unrelated files — the repo is not prettier-enforced in CI). Match surrounding
  style by hand.
- All four gates must pass before handing back: `pnpm typecheck && pnpm test &&
  pnpm lint && pnpm build`.
- New keys must not collide with existing Wall/Inspector bindings.
- Confirm prompts use the literal `(y/n)` form; feedback colors are ok→`THEME.ok`,
  err→`THEME.err`, hint→`THEME.muted`.
