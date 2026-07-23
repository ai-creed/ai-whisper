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
| D2 | Recovered rows | **One-shot import** of the 67 recovered workflows plus recoverable phases, chains, and handoffs |
| D3 | Ledger surfacing | **`--window all` implies run-ledger view**; `--all` remains an explicit override |
| D4 | Inspect-view back key | **`b` replaces Esc**; Esc unbound in the inspect view |

## Design

### 1. Data model: runtime/ledger table classification

Introduce an explicit **three-way** table classification in code, a single source of truth following the existing `listCollabIdTables` pattern in `collab-repository.ts`. Every `collab_id`-bearing table must belong to exactly one class:

- **Ledger tables (never purged, never swept):** `collab`, `workflows`, `workflow_phases`, `relay_chains`, `relay_handoff`. `relay_chains` is ledger, not runtime: it is contract-visible (`state-db-read-contract.md`) and the dashboard reads chain status, round counters, and terminal reason from it when rendering workflow cards (`dashboard-repository.ts`) — classifying it as runtime would blank archived runs' status and rounds.
- **Runtime tables (purge deletes):** daemon rows, sessions, session attachments, sockets state, clipboard leases, duo assignments, work items, cancellations, recovery state, companion sessions.
- **Diagnostics tables (purge does NOT touch; age-based sweep owns them):** `relay_capture_diagnostics`, `relay_evaluator_diagnostics`, `relay_turn_event_diagnostics`. These carry `collab_id` (`apply-migrations.ts`) but are explicitly excluded from purge; the existing 30-day sweep (`diagnostics-sweep.ts`) remains their only deleter, so a purge inside the retention window must leave them intact.

A drift-guard test (mirroring the existing cascade drift-guard) must fail when a new `collab_id`-bearing table is added without exactly one of the three classifications — unclassified and doubly-classified are both failures.

### 2. Collab lifecycle: `archived_at`

Because the `collab` row now survives purge, it needs a lifecycle marker:

- Add a nullable `archived_at` TEXT column to `collab` (additive `ALTER TABLE`).
- **Migration delivery:** the column ships as a proper schema-version bump (current version → current + 1) in `apply-migrations.ts`, so existing production `state.db` files at today's version receive the `ALTER TABLE` on next daemon start. A body dropped into an already-applied migration would never run for existing DBs (`applyMigrations` executes bodies only below `CURRENT_SCHEMA_VERSION`); that path is explicitly rejected. An upgrade test starts from a current-version-shaped fixture DB and proves `archived_at` exists after migration.
- Purge sets `archived_at` instead of deleting the row.
- **Live paths** (collab start, mount, default dashboard wall, any query that resolves an addressable collab) exclude archived collabs.
- **Ledger paths** (run-ledger view, `--window all`) include them.
- **No-restart enforcement:** excluding archived collabs from the collab resolver is not sufficient — `resumeWorkflow` and friends operate by workflow ID and never look at the parent collab today (`workflow-control.ts`). Workflow lifecycle mutations (at minimum `resumeWorkflow`; any other mutation that would transition a workflow toward `running`) must reject a workflow whose parent collab is archived with an explicit error and **no state change**. Starting fresh work in the same workspace creates a new collab, as today.

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

`docs/state-db-read-contract.md` gains the three-way ledger/runtime/diagnostics classification and the `archived_at` semantics so external readers of `state.db` can rely on ledger permanence. Concretely: `archived_at` is added to the contract's enumerated `collab` field list, and the literal contract-guard test that pins those fields is updated in the same change — the new column is contract surface, not an internal detail.

### 6. One-shot recovery import

A dev script (in `scripts/`, not shipped CLI surface) that:

1. Opens `~/.ai-whisper/recovery-2026-07-23/recovered.db` (path as argument) and reads `lost_and_found`.
2. Extracts ledger rows using **exact predicates** — the source is not type-tagged and same-width non-target records exist (e.g. 403 `nfield=8` rows that are `session_*`/`collab_*` records, not phases), so width alone must never qualify a row. Each predicate requires the row width to equal the source schema's column count AND the leading ID columns to match their table's prefix conventions; columns map by ordinal (`c0` → column 0, …):
   - `workflows`: `nfield = 12 AND c0 GLOB 'wf_*'` → 12 columns per the `workflows` schema.
   - `workflow_phases`: `nfield = 8 AND c0 GLOB 'wfp_*' AND c1 GLOB 'wf_*' AND c4 GLOB 'relay_ch_*'` → 8 columns.
   - `relay_chains`: `nfield = 9 AND c0 GLOB 'relay_ch_*' AND c1 GLOB 'collab_*'` → 9 columns.
   - `relay_handoff`: `nfield = 29 AND c0 GLOB 'ho_*' AND c1 GLOB 'collab_*'` → 29 columns.
3. **Referential closure:** predicate-matched rows are imported only when they attach to the run graph rooted in the **known-workflow set** = workflows already present in the target DB ∪ recovered workflow rows, AND their chain links resolve. Both parent edges are enforced, in dependency order:
   - **Chains first:** a chain imports when its `chain_id` is referenced by a workflow-rooted phase (`c4`) or workflow-rooted handoff (`c12`). The **available-chain set** = imported chains ∪ chains already present in the target DB.
   - **Phases:** import only when `workflow_id` (ordinal `c1`) is in the known-workflow set AND `chain_id` (`c4`) is null or in the available-chain set. A phase's `chain_id` is mandatory in the schema and the dashboard resolves chain status/rounds through it, so a workflow-rooted phase whose chain row was not recoverable is **skipped** — importing it would strand a dangling chain reference.
   - **Handoffs:** import only when `workflow_id` (ordinal `c23`) is in the known-workflow set AND `chain_id` (`c12`) is null or in the available-chain set.

   Valid-shape rows failing any parent edge are **skipped, not imported** — no fabricated workflow or chain tombstones (a placeholder parent with unknown type/status/rounds would pollute run counts and chain displays, and dashboard run queries resolve phases/handoffs by workflow, so unrooted rows are unreachable anyway). Skipped orphans remain available in the recovery archive file; the script logs skip counts per table and per reason (unknown workflow vs missing chain).
4. Inserts missing parent `collab` rows for imported rows as archived tombstones (`archived_at` set, minimal fields).
5. Dedups on primary keys; idempotent on re-run; wraps in one transaction; refuses to run while a broker daemon holds the DB.
6. **Pre-import verification:** before writing anything, the script reports and asserts, per table:
   - **Raw candidate counts** (predicate matches, duplicates included) exactly equal to the values measured on 2026-07-23 from the frozen recovery file: 67 workflows, 342 phases, 328 chains, 1258 handoffs. Any mismatch aborts (predicates or source drifted).
   - **Post-dedup distinct counts** exactly 67 workflows, 322 phases, 289 chains, 1096 handoffs.
   - **Post-closure import counts** at or above the 2026-07-23 baseline of 135 phases, 152 chains, 306 handoffs — floors rather than exact matches, because the known-workflow and available-chain sets include the live target DB, which only grows. Counts below a floor abort. (For reference: workflow-rooting alone admits 203 phases and 450 handoffs; the chain-link condition further excludes 68 phases and 144 handoffs whose mandatory chain reference has no recoverable chain row.)

Expected outcome: ledger reflects ~90 known historical runs, each with only referentially-closed phase, chain, and handoff detail for the recovered era.

## Out of scope

- Deleting or compacting ledger rows (no retention policy for ledger tables).
- Ledger export/reporting features beyond the existing dashboard.
- Esc handling outside the dashboard inspect view.
- Spec B's resume semantics.

## Testing

- Purge on a stale collab: runtime rows gone, all five ledger tables intact, `archived_at` set, report wording correct.
- Chain durability: after purge, `relay_chains` rows keep their status, `current_round`, `max_rounds`, and terminal reason, and an archived run's card in run-ledger mode still renders chain status and round counters from them.
- Diagnostics retention: purge on a stale collab leaves all three diagnostics tables' rows intact when they are inside the sweep retention window (only the age-based sweep may delete them).
- Drift guard: an unclassified new `collab_id` table fails the suite; so does a table classified under more than one of ledger/runtime/diagnostics.
- Migration upgrade: a fixture DB shaped like today's current schema version migrates cleanly and exposes `collab.archived_at`; the read-contract literal guard includes the new field.
- No-restart: `whisper workflow resume` against a workflow whose parent collab is archived fails with the explicit error and provably makes no state change (workflow status and collab row unchanged); creating a fresh collab in the same workspace afterward succeeds.
- Wall eligibility: workflow-bearing collab with zero handoffs appears; archived collab does not.
- Run-ledger view: includes archived collabs' runs; `--window all` with no `--all` flag enters run-ledger mode; `--window 30m` does not.
- Archived marker: a rendered-frame (or view-state) assertion proves an archived run's card carries the archived marker in run-ledger mode — the marker cannot silently disappear while other dashboard tests pass.
- Inspect view: `b` returns to wall; Esc does nothing.
- Import script: correct row counts from a fixture recovery DB whose `lost_and_found` includes same-width distractor rows for every target table (e.g. `nfield=8` session/collab records alongside real phase rows) — distractors must not be imported; second run inserts nothing.
- Import referential closure: fixture includes valid-shape `wfp_*` and `ho_*` rows whose `workflow_id` matches no known workflow, a valid-shape chain referenced by nothing, AND valid-shape workflow-rooted `wfp_*`/`ho_*` rows whose non-null `chain_id` has no recoverable chain candidate — none are imported, skip counts are logged per reason, and after import every phase/handoff resolves to a present workflow and (when its chain link is non-null) a present chain row (no dangling parent edges in the ledger).
- Import pre-verification: candidate counts diverging from the expected raw/distinct reference counts, or closure counts below the recorded floor, abort the import before any write.
- Import safety: with a live broker daemon holding the target DB, the importer refuses and the target is byte-identical afterward; a fixture containing one malformed row aborts the import and rolls back the entire transaction (zero rows inserted).
