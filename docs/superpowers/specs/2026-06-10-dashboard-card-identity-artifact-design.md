# Dashboard Card UX Polish — Agent Identity, Started-At, Artifact, Inspector Header

**Date:** 2026-06-10
**Status:** Design approved, pending spec review
**Surface:** `whisper collab dashboard` (Ink TUI) — Wall (cards) and Inspector
live view; the shared `RelayView` header (also used by `whisper relay`)

## Goal

Three card-level UX defects surfaced while dogfooding the dashboard with the
`ezio` workflow agent and with multiple concurrent workflows:

1. **Wrong agent identity.** A card whose relay is bound to `ezio` + `claude`
   renders `codex○  claude●` — a phantom dead `codex` and no `ezio` at all. The
   per-agent health dots are computed against a hardcoded `["codex", "claude"]`
   pair, so the real bound agent (`ezio`) is dropped and a never-present
   `codex` shows as dead.
2. **No start time.** Active cards never show when the workflow kicked off, so
   an operator can't tell a run that just started from one that has been going
   for an hour.
3. **No artifact / poor differentiation.** Two `spec-driven-development` runs in
   different projects render near-identically (`ai-cortex sdd R1/5` vs
   `ai-ezio sdd R1/5`). Nothing on the card says *which spec / goal / bug report*
   the run is working, so concurrent runs of the same workflow type are hard to
   tell apart.
4. **Inspector live header (`wf` row) defects.** The boxed live-view header
   renders `wf │ spec-driven-development  wf_7c20d5df8…  "spec-driven-development"`:
   the workflow type appears **twice** (once plainly, once as the quoted
   `name ?? workflowType` fallback that repeats the type when `name` is null);
   the **workflow id is truncated** to 12 chars (`wf_7c20d5df8…`) even though an
   operator copies the full id for debugging; and the **artifact is absent**.
   The agent-health row on the same card shows the same phantom-`codex` /
   missing-`ezio` defect as issue 1.

The fix keeps the existing status-first visual language and the card density
(four content lines per ACTIVE card, ~12-card screen target) intact.

## Non-Goals (YAGNI)

- No new keybindings, no theming/config surface, no pagination/allocation
  changes. The full ACTIVE card stays four content lines (height 6), so the
  group priority-fill geometry (`CARD_HEIGHT`, `allocateWallSections`) is
  unchanged.
- No new broker query and no widening of `workflowStatus`. The only broker
  change is one additive, nullable projection (`specPath`) from the workflow
  row already joined in `buildCollabSummary` — the same shape as the prior
  `workflowCreatedAt` addition.
- No abbreviation/aliasing of artifact paths beyond the truncation rule below.
- No change to how the relay decides its agent pair. We render whichever agents
  actually have a session row for the collab; we do not infer an "expected"
  pair from `role_bindings`.

## Fix 1 — Agent identity from real sessions (bug)

### Root cause

`packages/cli/src/runtime/relay-view-state.ts` defines a fixed pair:

```ts
const RELAY_AGENTS = ["codex", "claude"] as const;
```

`buildRelayViewState` builds `agentHealth` (and the derived `dots` string) by
iterating this fixed pair and matching each name against `snap.sessions` by
`agentType`. When the collab's real session is `ezio`, the `"codex"` lookup
finds nothing → `dead`, and the `ezio` session is never iterated → invisible.

### Change

Derive `agentHealth` from the **actual** `snap.sessions` rows, not a hardcoded
pair:

- For each session whose `agentType` is a valid `AgentType`
  (`"codex" | "claude" | "ezio"`), emit `{ agent, health }` using the existing
  three-way mapping (`healthy` → healthy, `degraded` → degraded, anything else
  / offline → dead). Sessions with an unrecognized `agentType` are filtered out
  (defensive against upstream data drift).
- Order is canonical and stable: the driver agent (`codex` or `ezio`) first,
  then `claude`. Concretely, sort by a fixed rank `{ codex: 0, ezio: 0,
  claude: 1 }` with `agentType` as the deterministic tiebreak. For a
  `codex`+`claude` collab this preserves today's `codex, claude` order, so no
  ordering regression.
- The `dots` string is rebuilt from the same `agentHealth` array (it already
  is — only its source list changes), so the Inspector live "health" line and
  the Wall dots stay consistent and both reflect the real agents.

`AGENT_COLOR.ezio` (violet `#A78BFA`) already exists in `theme.ts`; no theme
change is needed.

This is presentation-only. `computeLiveness` / stuck classification is
untouched — it already keys off the active agent (`turn.owner` / `waiting`) and
each session's `mountAlive`, independent of the display list.

### Edge cases

- **Manual relay / no sessions:** `agentHealth` is empty → no dots. (Today it
  renders two dead dots, which is misleading; empty is correct.)
- **Single session present:** only that agent's dot renders. The missing peer's
  absence is already covered by liveness/stuck signals; we do not synthesize a
  dead dot for an agent that has no session row.

### Tests (TDD — write the failing test first)

In `test/relay-view-state.test.ts`:

- `sessions = [ezio healthy, claude healthy]` → `agentHealth` is exactly
  `[{ agent: "ezio", health: "healthy" }, { agent: "claude", health: "healthy" }]`,
  and the derived `dots`/health line contains `ezio` and **not** `codex`.
  (This is the failing repro for the reported bug.)
- `sessions = [codex healthy, claude healthy]` → order stays `[codex, claude]`
  (no regression).
- `sessions = []` (manual relay) → `agentHealth` is `[]`.
- A session with an unknown `agentType` is filtered out.

## Fix 2 — Started-at on the card (`HH:MM · elapsed`)

`CollabSummary.workflowCreatedAt` already exists and `projectPane` already
computes a frozen `elapsed` (now − createdAt, pinned to the last activity once
the workflow is terminal). The data is present; it just isn't rendered on the
ACTIVE card.

### Change

- `WallPaneState` gains `startIso: string | null` (= `workflowCreatedAt`). The
  existing `elapsed` field is kept as-is.
- The view formats the start as `HH:MM` in **UTC** (matching the existing relay
  log timestamps produced by `hhmmss`) and renders `HH:MM · <elapsed>` on the
  artifact subline (see Fix 3 for placement and width handling).
- When `startIso` is null (manual relay) the start segment is omitted; when it
  is unparseable, `elapsed` already renders `—` and the `HH:MM` segment is
  omitted.

## Fix 3 — Artifact subline (repo-relative path)

Every workflow row stores `spec_path` (`workflows.spec_path TEXT NOT NULL`),
set from the kickoff path (`--spec` / the goal / the bug report). It is the
canonical identifier of "the thing this run is working on."

### Broker change — one additive projection

`packages/broker/src/storage/repositories/dashboard-repository.ts`:

1. `CollabSummary` gains `specPath: string | null` (insert next to
   `workflowCreatedAt`).
2. The `wf` SELECT in `buildCollabSummary` adds `spec_path AS specPath` to its
   projected columns and widens its row type accordingly.
3. The returned object sets `specPath: wf?.specPath ?? null` (null for a
   manual-relay collab with no workflow).

Nothing else changes: no new query, no `workflowStatus` widening, the eligible
and backfill paths are untouched. This mirrors the prior `workflowCreatedAt`
addition exactly.

### Repo-relative rendering

`spec_path` is an absolute or kickoff-relative path. The card shows it
**relative to the collab's repo root**.

The broker does the prefix strip and projects the already-repo-relative string
as `specPath`. `buildCollabSummary` already reads `workspace_root` (it is the
label fallback) and has `spec_path` in the same row, so it calls the shared
`repoRelativePath(spec_path, workspace_root)` helper there: if `spec_path` is
under `workspace_root`, `specPath` is the repo-relative path (e.g.
`docs/superpowers/specs/2026-06-10-foo-design.md`); otherwise `specPath` is the
path as given (absolute fallback). This keeps path resolution in one place,
keeps the CLI free of it, and adds no second column. The view's only
responsibility is the truncation/middle-ellipsis rule below; if `specPath` is
empty it falls back to `basename`, and if still empty the artifact segment is
omitted.

### Subline layout and width handling

The ACTIVE card's second content line carries artifact + start:

```
  → <repo-relative artifact> · HH:MM · elapsed
```

Width rule:

- Reserve a fixed tail (~13 cols) for ` · HH:MM · NNm`.
- The artifact path takes the remaining width with a **middle ellipsis** so the
  filename (the most identifying part, at the end of the path) is always
  visible: `docs/superpowers/…/2026-06-10-foo-design.md`.
- On a narrow card (rendered width < `NARROW_PANE_COLS`, 48), drop the time
  tail entirely; the artifact uses the full subline width, still with a middle
  ellipsis.
- Everything stays `wrap="truncate"` so the line never wraps the layout.

A middle-ellipsis helper (`midEllipsis(path, width)`) is added to the view
module (or reused if one already exists) and unit-tested.

### Compact cards (DONE / IDLE / HALTED)

- **Compact cards** stay two content lines. Line 1 keeps `glyph · label ·
  type`. Line 2 becomes `→ <artifact> · <status> · <elapsed>` (artifact leads;
  the existing `P/x · status · elapsed` content follows, middle-ellipsis on the
  artifact under the same width rule). Manual-relay/idle cards (no artifact)
  keep today's line 2 unchanged.

The Inspector live view surfaces the artifact in its `wf` header row, not on
the compact card path — see Fix 4.

### Shared repo-relative helper

The `spec_path → repo-relative` reduction is needed in three places (the broker
`buildCollabSummary` projection here, and both relay-snapshot builders in
Fix 4). To single-source it, add a pure helper `repoRelativePath(absPath,
root)` to `@ai-whisper/shared` (no new deps — plain string/`path` work): if
`absPath` is under `root`, return the path relative to `root`; otherwise return
`absPath` unchanged; empty input returns `""`. Every site that renders an
artifact uses this helper so the display form is identical across Wall,
compact, and Inspector.

## Fix 4 — Inspector live header (`wf` row)

The boxed live header is the shared `RelayView`, whose `wf` row renders the
`s.wf` string built in `buildRelayViewState`:

```ts
const wf = snap.workflow
  ? `${workflowType}  ${workflowId.slice(0, WF_ID_DISPLAY_LEN)}…  "${name ?? workflowType}"`
  : "(no workflow — manual relay)";
```

This is the source of all three header defects (truncated id, duplicated type,
no artifact). The agent-health row below it is fixed by Fix 1 (it renders
`s.health`, built from the now-correct `dots`/`agentHealth`).

### Change

Rebuild the `wf` string to lead with the **full** id, then the type, then the
artifact:

```
wf │ <FULL workflowId>   <workflowType>   → <repo-relative artifact>
```

- **Full id first.** Drop `WF_ID_DISPLAY_LEN` slicing; render the complete
  `workflowId`. Leading with the id means that under width pressure the
  `wrap="truncate"` clip removes the artifact tail first and the id is never
  truncated — directly serving the "operator copies the id" need.
- **Type once.** Remove the quoted `"${name ?? workflowType}"` segment that
  duplicated the type. The type still appears once, plainly. (In the dashboard
  Inspector the type is also in the title line; in the standalone `whisper
  relay` view the title is absent, so keeping the type on the `wf` row is
  correct for both callers of the shared component.)
- **Artifact.** Append `  → <repo-relative artifact>` when present, omitted for
  manual relay. Manual relay keeps `(no workflow — manual relay)` unchanged.

No `RelayView` row is added: `STATUS_BLOCK_ROWS` stays 7, and
`logViewportHeight` / the host scroll clamp are untouched. The artifact rides
the existing `wf` row.

### Threading the artifact into the snapshot

`RelayViewSnapshot.workflow` gains `artifact?: string | null` (the repo-relative
spec path). Both snapshot builders populate it via the shared helper:

- `packages/cli/src/runtime/dashboard.ts` (Inspector path, ~`:259-267`):
  `artifact: repoRelativePath(wf.specPath, <collab workspaceRoot>)`. The
  workflow record fetched here already carries `specPath`; the collab's
  workspace root is available on the inspected collab.
- `packages/cli/src/runtime/relay-monitor.ts` (standalone `whisper relay`,
  ~`:159-166`): same projection from `wfRow.specPath` + the collab workspace
  root.

If a builder cannot resolve a workspace root, it passes the raw `specPath`
(absolute fallback) — `repoRelativePath` still returns a usable string.

### Tests

- `relay-view-state.test.ts`: with a workflow snapshot carrying
  `workflowId: "wf_<long>"`, `name: null`, `artifact: "docs/.../foo.md"`, the
  `wf` string contains the **full** id, the type **once**, and `→
  docs/.../foo.md`; it does **not** contain `…` after the id and does **not**
  repeat the type. Manual relay (`workflow: null`) keeps the existing string.
- A focused builder test (or extension of existing dashboard/relay-monitor
  tests) asserts `snapshot.workflow.artifact` is the repo-relative spec path.

## Components & Data Flow

- `packages/shared/src/` — new pure `repoRelativePath(absPath, root)` helper
  (Fix 3 + Fix 4 single-source the spec-path → repo-relative reduction here).
- `packages/broker/src/storage/repositories/dashboard-repository.ts` — additive
  `specPath: string | null` on `CollabSummary`, projected (repo-relative via the
  shared helper) from the joined `workflows.spec_path` + `collab.workspace_root`
  in `buildCollabSummary`.
- `packages/cli/src/runtime/relay-view-state.ts` — (Fix 1) `agentHealth` derived
  from real `snap.sessions` (canonical order), `RELAY_AGENTS` removed; (Fix 4)
  the `wf` string rebuilt to full-id + type-once + artifact, `WF_ID_DISPLAY_LEN`
  slicing dropped, and `RelayViewSnapshot.workflow` gains `artifact?: string |
  null`.
- `packages/cli/src/runtime/dashboard.ts` & `relay-monitor.ts` — populate
  `snapshot.workflow.artifact` via `repoRelativePath` (Fix 4).
- `packages/cli/src/runtime/dashboard-state.ts` — `WallPaneState` gains
  `startIso: string | null` and `artifact: string | null`; `projectPane`
  populates them from the summary. `agentHealth` continues to flow through
  unchanged (it is now correct upstream).
- `packages/cli/src/runtime/dashboard-view.tsx` — render the artifact + start
  subline on the full card with the width rule; mirror onto compact cards;
  add/reuse the `midEllipsis` helper.
- `packages/cli/src/runtime/relay-view.tsx` — no structural change; the `wf`
  row renders the rebuilt `s.wf` string. `STATUS_BLOCK_ROWS` unchanged.
- `packages/cli/src/runtime/theme.ts` — no change (`AGENT_COLOR.ezio` exists).

## Error Handling / Edge Cases

- **Manual relay (no workflow):** no `specPath`, no `startIso`, no dots; card is
  the `◌` idle compact card as today.
- **Missing `workflowCreatedAt`:** start `HH:MM` omitted; `elapsed` renders `—`.
- **`spec_path` not under `workspaceRoot`:** show the path as given (absolute
  fallback); never throw.
- **Empty/whitespace `spec_path`:** fall back to `basename`; if still empty,
  omit the artifact segment.
- **Unknown `agentType` in sessions:** filtered out of `agentHealth`.
- **Long path on a narrow card:** middle-ellipsis keeps the basename; time tail
  drops first.

## Testing

- **Agent identity** (`relay-view-state.test.ts`): the four cases in Fix 1.
- **Broker projection** (`dashboard-repository.test.ts`): `specPath` is the
  repo-relative form of the joined `spec_path` for a workflow-bound collab; an
  absolute path outside the workspace root is returned unchanged; `null` for a
  manual-relay collab. No other field shape change.
- **Pane projection** (`dashboard-state.test.ts`): `projectPane` populates
  `startIso` and `artifact` from the summary; both null for manual relay.
- **View** (`dashboard-view.test.tsx`):
  - Full card renders the artifact subline with `→`, the repo-relative path,
    `HH:MM`, and elapsed; agent dots show real agents (`ezio` tinted violet, no
    `codex` when absent).
  - `midEllipsis` keeps the basename and fits the budget; narrow card drops the
    time tail.
  - Compact card renders the artifact line; idle/manual card unchanged.
- **Shared helper** (`repoRelativePath` test): under-root → relative,
  outside-root → unchanged, empty → `""`.
- **Inspector `wf` row + snapshot** (Fix 4): the `relay-view-state` cases above
  plus a builder assertion that `snapshot.workflow.artifact` is the repo-relative
  spec path in the dashboard Inspector and `whisper relay` paths.

## File / Commit Plan

Per the >3-file rule, the work is split into focused TDD commits:

1. **Shared helper:** `packages/shared` `repoRelativePath` + test.
2. **Fix 1 + Fix 4 (relay-view-state):** `relay-view-state.ts` +
   `relay-view-state.test.ts` — failing repro tests first, then session-driven
   `agentHealth` and the rebuilt `wf` string (full id, type once, artifact);
   add `artifact` to `RelayViewSnapshot.workflow`.
3. **Fix 4 snapshot wiring:** `dashboard.ts` + `relay-monitor.ts` populate
   `snapshot.workflow.artifact` via the shared helper (+ builder tests).
4. **Fix 3 (broker):** `dashboard-repository.ts` + `dashboard-repository.test.ts`
   — additive repo-relative `specPath` projection (via the shared helper).
5. **Fix 2 + 3 (Wall view):** `dashboard-state.ts`, `dashboard-view.tsx` +
   `dashboard-state.test.ts`, `dashboard-view.test.tsx` — `startIso`/`artifact`
   on the pane, the subline render with the width rule, compact mirror.

## Open Risks

- Repo-relative stripping depends on `workspace_root` matching the `spec_path`
  prefix; if the kickoff path was relative or symlinked, the absolute fallback
  keeps it readable rather than mangled. Covered by the broker test's
  outside-root case.
- The subline competes for horizontal space with the progress/dots line; the
  fixed time-tail reservation plus middle-ellipsis is the mitigation, covered
  by the narrow-card view test.
