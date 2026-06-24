# Dashboard `--all` mode: show every workflow run (no per-collab masking)

- **Date:** 2026-06-24
- **Status:** Design — spec-review findings addressed (paused-workflow handling, render keys); pending re-review
- **Area:** `whisper collab dashboard` (Wall view), broker dashboard repository

## Background / Problem

The `whisper collab dashboard` Wall renders **one card per eligible collab**, resolved to that collab's running-or-latest workflow (`buildCollabSummary`, `LIMIT 1` in `packages/broker/src/storage/repositories/dashboard-repository.ts`). A collab is *eligible* when it had relay activity within the `--window` (default 30m) or has a running workflow, backfilled to a small floor. The footer reports `N runs`, but `N` actually counts collab cards, not runs.

Two consequences surprised an operator during a real session:

- The footer said **55 runs** while the database held **107** workflow rows. (55 = the number of collabs with any relay activity; each contributes exactly one card.)
- Only **1 of 4** `deliberation` runs was visible. The other three were either masked by a newer workflow in the same collab (the card shows only the latest run) or lived in a collab with no relay activity at all (never eligible).

No data is lost — every run is present in the `workflows` table. The gap is purely in how the Wall *surfaces* history: it is a live "what's recent, one per collab" view, not a complete run ledger, and its "runs" label oversells it.

## Goal

Add an opt-in `--all` mode to the dashboard that renders **one card per workflow run** — no per-collab masking — so every run is visible and individually inspectable. Recency still respects `--window` at the run level, so:

- `--all --window all` → the complete run ledger (every workflow row).
- `--all` alone → recent unmasked runs (every run active within the default window).

Additionally, correct the **default-mode footer label** so it stops calling collab cards "runs".

## Non-goals

- In-TUI filtering by workflow type or status (future enhancement; cards already display type).
- Rendering manual (non-workflow) relay chats as cards. `--all` covers workflow runs only.
- Any change to default (non-`--all`) Wall eligibility/masking/selection behavior, beyond the footer label wording **and the paused-workflow correctness fix described below** (paused runs are a workflow status the current Wall silently drops; the complete-ledger contract forces handling them, and the fix is applied uniformly to both modes rather than forking status handling — see "Paused workflows").
- A global CLI list command (e.g. `workflow list --all`). The TUI dashboard was explicitly chosen as the surface.
- New schema, columns, or migrations. `paused` already exists as a `WorkflowStatus`; this work only teaches the dashboard projection to carry it.

## Approved approach (A): parametrize the existing Wall pipeline by run

Reuse the entire existing Wall machinery (`partitionWallGroups` → `allocateWallSections` → `projectPane` → Inspector). The only structural shift: summaries, snapshots, and pane selection key off the **run** (`workflowId`) instead of the collab.

A rejected alternative (B) was a separate parallel "all-runs" view path; it would duplicate the Wall's grouping/paging/projection and create two diverging code paths. The existing pipeline already operates per-run with a single keying change, so A is strictly less code and less risk.

### 1. Data layer (broker — `dashboard-repository.ts`)

- Extend `CollabSummary.workflowStatus` from `"running" | "done" | "halted" | "canceled" | null` to **include `"paused"`** (it is already a member of `WorkflowStatus` in `workflow-repository.ts` but is absent from the summary type, so a paused row cannot currently be represented). Widen the inline result-row type in `buildCollabSummary`'s latest-workflow query to match, so a paused latest workflow is carried through instead of mistyped.
- Extract the per-workflow projection currently inside `buildCollabSummary` into a reusable `buildWorkflowSummary(db, collabId, workflowRow)`. The existing collab path calls it with the collab's latest workflow (output unchanged); the new path calls it once per workflow row.
- Add `listAllWorkflowSummaries(db, { sinceMs, now })` → `CollabSummary[]`, **one row per workflow**, with **run-level eligibility**:
  - a workflow is eligible if `MAX(relay_handoff.last_activity_at WHERE workflow_id = w.workflow_id) >= cutoff`, **or** `w.status IN ('running','paused')` (both are non-terminal, in-flight states — a paused run is one the operator suspended and will resume, so it is always current and must always appear);
  - when a workflow has no handoffs, fall back to `w.created_at >= cutoff`, so a zero-handoff run (e.g. one that halted immediately) still appears under a wide window.
  - `cutoff` is computed exactly as in `listActiveCollabSummaries` (clamp to epoch `0` for very large `sinceMs` so `--window all` does not underflow).
- No masking: each eligible workflow yields its own summary row, even when several share a `collabId`.
- Expose `listAllWorkflowSummaries` via the control service alongside `listActiveCollabSummaries`.

### 2. Host (CLI — `runtime/dashboard.ts`)

- Add a `showAll` runtime flag (sourced from the CLI `--all`).
- In `node()`, when `showAll`, fetch `listAllWorkflowSummaries(windowMs, isoNow)` instead of `listActiveCollabSummaries(windowMs, isoNow)`.
- Key the `snapshots` map by `runKey = s.workflowId ?? s.collabId` (instead of `s.collabId`), so sibling runs on one collab no longer collide. Snapshot *content* is already run-scoped (handoffs are fetched with `workflowFilter: { workflowId }`).
- Replace `lastPaneCollabIds: string[]` with a per-pane `Array<{ collabId; workflowId }>`. On Enter, set `inspectorCollabId` **and** `inspectorWorkflowId` from the **selected pane's** run (not the collab's latest). The Inspector path is unchanged — it already scopes every query to `inspectorWorkflowId`.

### 3. State + view (CLI — `runtime/dashboard-state.ts`, `runtime/dashboard-glyph.ts`, `runtime/dashboard-view.tsx`)

- `projectPane` / `buildWallState` look up the snapshot by `runKey` rather than `sum.collabId`. `WallPaneState` already carries `workflowId`, so no new field is needed for rendering.
- **Rendered card keys** in `dashboard-view.tsx` currently use `key={pane.collabId}` for both `FullCard` and `CompactCard` (`dashboard-view.tsx:355,362`). In default mode that is unique (one card per collab), but under `--all` two runs share a `collabId` and would produce **duplicate React keys**, causing reconciliation collisions and a runtime warning. Change both to `key={pane.workflowId ?? pane.collabId}` — unique per run, and identical to today for manual/idle panes (one per collab, `workflowId === null` → falls back to `collabId`). This closes the last layer where same-collab sibling runs could collide.
- `totalRuns` already sums the group lengths; in `--all` mode it now counts run-cards, so the footer count matches reality.

### 4. Flag + footer label (CLI — `create-cli.ts`, `commands/collab/dashboard.ts`, `runtime/dashboard-view.tsx`)

- `whisper collab dashboard --all` — boolean; plumb through `runCollabDashboard` → `createDashboardRuntime({ showAll })`. Composes with the existing `--window`.
- Footer wording:
  - default mode: `N collabs` (one latest run each) — replaces the misleading `N runs`.
  - `--all` mode: `N runs` (every run, unmasked).
  - Exact phrasing finalized during implementation; the intent is that the default footer counts collab cards honestly and `--all` counts runs.

## Paused workflows (cross-cutting correctness fix)

`paused` is a first-class `WorkflowStatus` (`workflow-repository.ts:4`) and is part of the active-workflow uniqueness constraint (`apply-migrations.ts`), yet the dashboard silently drops it today: it is absent from `CollabSummary.workflowStatus`, has no `statusGlyph` branch, and `partitionWallGroups` explicitly discards it ("paused or any unknown status is dropped"). For the default Wall this rarely surfaces (a collab's latest run is usually running/terminal), but the `--all --window all` **complete-ledger contract requires every workflow row**, which makes paused handling mandatory. The fix is applied to the shared projection so both modes behave consistently (no forked status logic):

- **Type** — `CollabSummary.workflowStatus` includes `"paused"` (section 1).
- **Eligibility** — `listAllWorkflowSummaries` treats `paused` like `running` (always eligible, window-independent), since a paused run is in-flight (section 1).
- **Grouping** — `partitionWallGroups` buckets `paused` into the **ACTIVE** group (non-terminal, resumable, in-flight), removing the "dropped" branch. Paused runs are not stuck-pinned (`isStuckRunning` checks `running`), so they sort by recency within the non-stuck block; full-card rendering applies as for other ACTIVE cards.
- **Glyph** — add a `"paused"` `StatusKey` to `statusGlyph` with a distinct, quiescent glyph (suggested `⏸` with `THEME.muted`; implementation verifies it renders single-width in the terminal and falls back to a mono-safe alternative such as `‖` if not). Distinct from running (`●` accent) and halted (`⚠` err) — paused is suspended, not failed.
- **Default-mode impact** — a collab whose latest workflow is paused now appears in ACTIVE instead of vanishing. This is strictly more correct (the run exists and is resumable) and is the sole carve-out from "default unchanged" (see Non-goals); behavior for already-visible statuses (running/done/halted/canceled/idle) is untouched.

## Data flow

**`--all`:** `control.listAllWorkflowSummaries(windowMs, now)` → `CollabSummary[]` (one per run, including paused) → `partitionWallGroups` → `allocateWallSections` (page) → per-run snapshot fetch (key = `workflowId`) → `projectPane` → `Wall` (card `key = workflowId ?? collabId`). Enter → `Inspector` with `inspectorWorkflowId` = the selected run.

**Default:** unchanged — `control.listActiveCollabSummaries` → one summary per collab (now also carrying paused if the latest run is paused).

## Edge cases

- **Two runs, same collab, both eligible** → two cards, distinct snapshots, distinct render keys, each inspects its own run.
- **Zero-handoff run** (immediately halted) → appears under `--window all` via the `created_at` fallback; under the default window only if created within it.
- **Running workflow with no handoffs yet** → eligible via `status = 'running'`; its `lastActivityAt = ""` sorts first (existing `actKey` sentinel).
- **Paused run** → always eligible (window-independent) in `--all`; grouped under ACTIVE with the paused glyph; inspectable like any other run. In default mode, a paused *latest* run now surfaces under ACTIVE (previously dropped).
- **Large DONE group** (e.g. 72 cards) → existing paging handles it; per-page snapshot fetch keeps cost bounded.
- **`--all` with no eligible runs** → empty Wall (identical to the default empty state).
- **Selection index across polls** → existing clamp logic applies (selection is index-based; acceptable and matches current behavior).
- **Manual relay collab** (`workflowId === null`) → excluded from `--all` (workflows only); still shown in default mode as today, with render key falling back to `collabId`.

## Testing (TDD, per chunk)

- **Repo** (`listAllWorkflowSummaries`): one row per run; masking removed (a collab with 2 runs yields 2 rows); window cutoff respected; running-status eligibility; **paused-status eligibility (window-independent)**; zero-handoff `created_at` fallback under a wide window; deterministic ordering. Plus: `CollabSummary` for a paused workflow carries `workflowStatus: "paused"`.
- **State/glyph**: `partitionWallGroups` places a paused summary in `active` (not dropped); `statusGlyph` returns the paused branch (distinct glyph/key) for `workflowStatus: "paused"`.
- **Host/state**: snapshots keyed per run (2 runs on one collab → no collision); Enter inspects the selected run's `workflowId`; default mode behavior unchanged.
- **View**: footer label differs between default and `--all`; **rendered card key is unique per run** (two same-collab runs → two distinct keys, no duplicate-key warning).
- **CLI**: `--all` parses and plumbs through; composes with `--window`.

## Decomposition (sequential, independently testable)

1. **Broker data layer** — extend `CollabSummary.workflowStatus` with `"paused"` + widen `buildCollabSummary`'s query row type; `buildWorkflowSummary` extraction; `listAllWorkflowSummaries` (eligibility incl. running **and** paused, `created_at` fallback); control exposure; repo tests.
2. **Host/state per-run keying + paused rendering** — snapshot key = run, inspect-by-run, per-pane identity; **render card `key` = `workflowId ?? collabId`** (`dashboard-view.tsx`); **paused bucketed into ACTIVE** in `partitionWallGroups`; **paused branch in `statusGlyph`** (`dashboard-glyph.ts`); tests (default behavior unchanged for existing statuses).
3. **CLI flag + footer label** — `--all` parse/plumb + footer wording + view test.
4. **Docs** — dashboard `--all` in CLI help text and in `docs/relay-handoff-flows.md` (Inspecting state); brief mention near the dashboard usage in `README.md`; note paused runs now appear (ACTIVE group, `⏸`).

## Rollout / risk

- Additive; default behavior is unchanged except the footer wording and the paused-run correctness fix (paused latest runs now surface instead of being dropped).
- No schema changes, no migration — `paused` already exists as a status.
- Reuses the existing projection, grouping, paging, and Inspector, so the blast radius is the new query, the paused projection/glyph/grouping, the snapshot/pane/render keying, and the flag plumbing.
