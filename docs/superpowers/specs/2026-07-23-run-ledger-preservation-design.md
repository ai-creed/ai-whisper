# Run Ledger Preservation & Dashboard Completeness — Design

**Date:** 2026-07-23
**Status:** Approved for planning
**Companion spec:** `2026-07-23-halted-resume-continuation-design.md` (Spec B — independent, shippable in either order)

## Problem

Two conflicting models coexist in the broker today:

- **Purge's model:** collab rows are disposable runtime state. `whisper collab purge` classifies a collab as *stale* when its daemon pid and all mounted agent pids are dead — which is true of every finished collab — and then `deleteCollabCascade` (`packages/broker/src/storage/repositories/collab-repository.ts`) deletes every row the collab owns, including `workflows`, `workflow_phases`, and `relay_handoff`.
- **Dashboard's model:** the DB is a permanent run ledger. `whisper collab dashboard --window all --all` promises "the complete run ledger".

Both cannot hold. In practice purge won: three `purge --force` runs (Jul 1, Jul 18, Jul 19) destroyed 100+ historical workflow runs, leaving 23. 67 rows were later recovered from the SQLite freelist into `~/.ai-whisper/recovery-2026-07-23/` (see §6).

Secondary dashboard defects found during investigation:

1. **Per-collab masking:** the default wall shows one card per collab, resolving to the running-or-latest workflow only (`LIMIT 1` in `dashboard-repository.ts`). Older runs in the same collab are invisible; the `--all` run-ledger flag is undiscoverable.
2. **No-handoff exclusion:** default-wall eligibility uses `HAVING MAX(h.last_activity_at) >= ?`. A collab with workflows but zero `relay_handoff` rows yields NULL and is silently excluded regardless of window.
3. **Esc conflict:** the dashboard inspect view binds Esc for back-to-wall (`packages/cli/src/runtime/dashboard-view.tsx`). Esc is the prefix byte of every ANSI escape sequence, so stray or partial sequences from other programs sharing the tty can decode as a lone Esc and kick the operator back to the wall.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Purge treatment of history | **Runtime/ledger split** — purge deletes runtime state only; ledger tables survive forever |
| D2 | Recovered rows | **One-shot import** of the 67 recovered workflows plus recoverable phases/handoffs |
| D3 | Ledger surfacing | **`--window all` implies run-ledger view**; `--all` remains an explicit override |
| D4 | Inspect-view back key | **`b` replaces Esc**; Esc unbound in the inspect view |

## Design

### 1. Data model: runtime/ledger table classification

Introduce an explicit table classification in code, a single source of truth following the existing `listCollabIdTables` pattern in `collab-repository.ts`:

- **Ledger tables (never purged):** `collab`, `workflows`, `workflow_phases`, `relay_handoff`.
- **Runtime tables (purge deletes):** every other collab-owned table — daemon rows, sessions, session attachments, sockets state, clipboard leases, duo assignments, work items, cancellations, recovery state, companion sessions.
- **Diagnostics tables:** unchanged; the existing 30-day sweep (`diagnostics-sweep.ts`) continues to own them.

A drift-guard test (mirroring the existing cascade drift-guard) must fail when a new `collab_id`-bearing table is added without being classified as ledger or runtime.

### 2. Collab lifecycle: `archived_at`

Because the `collab` row now survives purge, it needs a lifecycle marker:

- Add a nullable `archived_at` TEXT column to `collab` (additive `ALTER TABLE`).
- Purge sets `archived_at` instead of deleting the row.
- **Live paths** (collab start, mount, default dashboard wall, any query that resolves an addressable collab) exclude archived collabs.
- **Ledger paths** (run-ledger view, `--window all`) include them.
- Restarting work against an archived collab id is not supported; a new collab is created as today.

Consequence: once this ships, deleting `state.db` between iterations is no longer acceptable practice — the DB is the permanent record. The corresponding dev-habit memory will be deprecated when this lands.

### 3. Purge command semantics

- Classification buckets (live / protected / stale) and their detection logic are unchanged.
- Action on a stale collab becomes: delete its runtime-table rows, set `archived_at`. Ledger rows untouched.
- `--force` keeps its meaning (also act on protected collabs) with the same non-destructive action.
- Output language changes from "purged" to reflect reality, e.g. `Archived 12 collabs (runtime state removed, history kept)`.
- No `--drop-history` escape hatch. Destructive deletion of ledger rows is explicitly out of scope.

### 4. Dashboard changes

- **Mode implication:** `parseDashboardWindow` already maps `all`/`max`/`∞` to `MAX_SAFE_INTEGER`. When the parsed window is this sentinel, the dashboard enters run-ledger mode (one card per workflow run) as if `--all` were passed. Explicit `--all` continues to work with any window. Bounded windows keep the collab-grouped wall.
- **Eligibility fix:** default-wall eligibility treats a collab with workflows but no handoffs as eligible via a fallback on workflow `created_at` (the run-ledger query already does this; the wall query must match).
- **Archived visibility:** default wall excludes archived collabs; run-ledger view includes them, visually marked (e.g. dim/`archived` tag).
- **Key binding:** in the inspect view, `b` returns to the wall; the Esc handler is removed from that view. Footer hint updates from `Esc wall` to `b wall`. Other dashboard bindings unchanged.

### 5. Read-contract documentation

`docs/state-db-read-contract.md` gains the ledger/runtime classification and the `archived_at` semantics so external readers of `state.db` can rely on ledger permanence.

### 6. One-shot recovery import

A dev script (in `scripts/`, not shipped CLI surface) that:

1. Opens `~/.ai-whisper/recovery-2026-07-23/recovered.db` (path as argument) and reads `lost_and_found`.
2. Extracts full workflow rows (`nfield=12`, `c0 GLOB 'wf_*'`), plus recoverable `workflow_phases` and `relay_handoff` rows identified by their field signatures.
3. Inserts missing parent `collab` rows as archived tombstones (`archived_at` set, minimal fields).
4. Dedups on primary keys; idempotent on re-run; wraps in one transaction; refuses to run while a broker daemon holds the DB.

Expected outcome: ledger reflects ~90 known historical runs.

## Out of scope

- Deleting or compacting ledger rows (no retention policy for ledger tables).
- Ledger export/reporting features beyond the existing dashboard.
- Esc handling outside the dashboard inspect view.
- Spec B's resume semantics.

## Testing

- Purge on a stale collab: runtime rows gone, all four ledger tables intact, `archived_at` set, report wording correct.
- Drift guard: unclassified new `collab_id` table fails the suite.
- Wall eligibility: workflow-bearing collab with zero handoffs appears; archived collab does not.
- Run-ledger view: includes archived collabs' runs; `--window all` with no `--all` flag enters run-ledger mode; `--window 30m` does not.
- Inspect view: `b` returns to wall; Esc does nothing.
- Import script: correct row counts from a fixture recovery DB; second run inserts nothing.
