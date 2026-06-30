# `whisper collab purge` — Stale-Collab Cleanup Design

**Status:** Proposed — design approved in brainstorming; awaiting spec review before the implementation plan.

**Date:** 2026-06-30

**Owners:** ai-whisper CLI / runtime

---

## 1. Summary

Add a `whisper collab purge` command that finds **stale** collabs across **all
workspaces** in the shared state DB and fully removes them. A collab is stale
when no live process backs it — its broker daemon is dead **and** none of its
mounted agents are alive. The command classifies every collab as **live**,
**protected**, or **stale**, prints the result, asks for confirmation, and then
deletes each stale collab together with every row it owns across the schema.

The command is CLI-only and daemon-free (it reads and writes the shared DB
directly, like `whisper collab stop`).

## 2. Motivation

After a machine or app restart, the mounted agent processes die but the `collab`
row keeps `status = 'active'` in the shared DB. Two mechanics make these dead
collabs linger:

1. **`status` does not reflect liveness.** The `collab.status` column is
   `'active' | 'stopped'`; nothing flips it to a dead state when the daemon or
   mounts die. `whisper collab status` reports `daemon: null` for a dead daemon,
   but the row itself stays `'active'`.
2. **Re-mount creates a new collab instead of recovering the old one.**
   `resolveCollab` picks the most-recent `status = 'active'` row for the
   workspace, so a re-mount after a restart can leave the old, dead collab behind
   as a duplicate (the split-brain captured in prior incidents). The
   `enforce-one-active-collab` mechanism reduces *new* duplication, but it does
   not clean up rows that already accumulated, nor dead-but-active rows from
   crashes.

Today the only remedy is running `whisper collab stop` in each affected
workspace by hand. `purge` replaces that with a single cross-workspace sweep.

### 2.1 Correctness finding that shapes this design

`PRAGMA foreign_keys` is **never enabled** on the shared-DB connection. In SQLite
foreign keys are **off by default per connection**, so the three
`ON DELETE CASCADE` foreign keys in the schema (`session_attachment`,
`broker_daemon`, `recovery_state` → `collab`) **do not cascade at runtime**.
`whisper collab stop` is unaffected because it deletes `broker_daemon`
explicitly and never relied on the cascade.

The consequence for purge: a bare `DELETE FROM collab` would **orphan rows in
every other collab-scoped table** (~20 of them). Fully removing a collab
therefore requires an explicit, transactional, multi-table delete. This is the
core of the feature (§4.2), and the reason purge is more than "stop across
workspaces."

We deliberately do **not** flip `foreign_keys = ON` globally: it would only fix
3 of ~20 tables and risks unrelated behavior changes elsewhere.

## 3. Goals and Non-Goals

### Goals

- A `whisper collab purge` command that sweeps **all workspaces** by default.
- Remove only collabs with **no live process** behind them; never touch a collab
  with a live daemon or a live mounted agent.
- **Protect resumable work**: skip (and report) a dead collab that still has a
  non-terminal workflow, unless `--force` is given.
- **Full removal**: a purged collab leaves **zero** rows behind in any
  collab-scoped table.
- A **drift guard** so future schema additions cannot silently reintroduce
  orphaned rows.
- Safe UX: interactive confirmation by default, a non-interactive bypass for
  scripts, and a dry-run preview.

### Non-Goals

- **No mount-time auto-reconcile.** Fixing the split-brain at its source (mount
  adopting/recovering an existing collab instead of creating a duplicate) is a
  separate spec. Purge only cleans up.
- **No background/auto sweep.** Purge is an explicit command, never automatic.
- **No version-mismatch staleness.** There is no per-collab/daemon version stamp
  today; schema version lives in `PRAGMA user_version` and migrations are
  additive. Version-based staleness would require adding a version stamp — out of
  scope here.
- **No dashboard surface.** Purge is CLI-only. (A dashboard tie-in was considered
  and explicitly dropped.)
- **No `workspace`-row cleanup.** The `workspace` registry rows are harmless and
  re-created on next use; purge leaves them.

## 4. Design

### 4.1 Staleness classifier (read-only)

Liveness reuses the existing `defaultIsAlive(pid)` from
`packages/broker/src/runtime/broker-daemon-sweep.ts`
(`process.kill(pid, 0)`; `ESRCH` ⇒ dead, `EPERM` ⇒ alive). No new liveness code.

For each `collab` row, compute exactly one classification:

- **LIVE** — `defaultIsAlive(broker_daemon.pid).alive` is true, **or** any
  `session_attachment.pid` for the collab is alive. A live process backs it.
  *Never deleted.* The current workspace's active collab is LIVE by this rule, so
  it is protected without special-casing.
- **PROTECTED** — not LIVE, but the collab has ≥1 workflow with
  `status NOT IN ('done', 'canceled')` — i.e. a `running` / `paused` / `halted`
  run that `whisper workflow recover` + `resume` could revive. *Skipped and
  reported unless `--force`.*
- **STALE** — not LIVE and not PROTECTED. Covers both `status = 'stopped'`
  leftovers and `status = 'active'`-but-dead-after-restart collabs. *Purge
  candidate.*

**PID-reuse stance:** `defaultIsAlive` cannot distinguish a reused PID, so a dead
daemon whose PID was recycled reads as alive. This biases toward **skipping** a
collab (treating it as LIVE), never toward wrongly deleting a live one — the safe
direction. Documented, accepted.

### 4.2 `deleteCollabCascade(db, collabId)` — full wipe

Because runtime cascade is off (§2.1), removing a collab is an explicit
multi-table delete inside a single transaction. Built so it cannot rot:

1. **Introspect** `sqlite_master` for every `type = 'table'` whose name does
   **not** match `sqlite_%` — SQLite's internal bookkeeping tables (e.g.
   `sqlite_sequence`, created because several tables use `AUTOINCREMENT`) appear
   in `sqlite_master`, are never collab-scoped, and must never be touched. For
   each remaining table, read `pragma_table_info(<table>)`; if it has a
   `collab_id` column, run `DELETE FROM <table> WHERE collab_id = ?`. This
   automatically covers every directly-scoped table (see §5) and any future one.
   The `collab` table itself has a `collab_id` column but is **excluded** from
   this loop and deleted last (step 4) — it is therefore the one `collab_id`
   table the loop deliberately does not handle.
2. **Explicit child deletes** for tables that have **no** `collab_id` and chain
   through a parent id (introspection blind spots). Run these **before** the
   introspection loop removes their parents:
   - `DELETE FROM workflow_phases WHERE workflow_id IN (SELECT workflow_id FROM workflows WHERE collab_id = ?)`
   - `DELETE FROM work_item_cancellation WHERE work_item_id IN (SELECT work_item_id FROM work_item WHERE collab_id = ?)`
3. **Special column:** `DELETE FROM clipboard_capture_lease WHERE holder_collab_id = ?`
   (the lease's collab reference uses `holder_collab_id`, not `collab_id`).
4. `DELETE FROM collab WHERE collab_id = ?`.

Order within the transaction: step 2 (child-via-parent) → step 1 (introspection
loop, deletes the parents and all `collab_id` tables) → step 3 → step 4. With
`foreign_keys` off there is no FK enforcement to order around; the ordering exists
only so the step-2 subqueries still see their parent rows.

#### Drift guard

A test (mirroring the existing `test/agent-type-drift-guard.test.ts` pattern)
introspects the live schema — every `type = 'table'` in `sqlite_master` whose
name does **not** match `sqlite_%` (the same internal-table exclusion the delete
loop applies, so `sqlite_sequence` and any future `sqlite_*` table are out of
scope for both sides of the partition) — and partitions the remaining tables
into:

- **has `collab_id`** — handled by the introspection loop, **with the single
  deliberate exception of `collab` itself**, which also has a `collab_id` column
  but is deleted last in step 4. The test asserts the loop's table set equals
  this set **minus `collab`**, and separately asserts that `collab` is the one
  excluded `collab_id` table. This catches an accidental exclusion of a real
  scoped table while still accounting for the intentional `collab` special-case.
- **no `collab_id`** — the test asserts this set equals a maintained allowlist:
  the explicit child tables handled in step 2 (`workflow_phases`,
  `work_item_cancellation`), the special-column table (`clipboard_capture_lease`),
  and the intentionally-preserved tables (`workspace`, `broker_state`).

A new table added to the schema lands in neither side's expectation and **fails
the test**, forcing a conscious decision (introspected automatically, added to the
child list, or allowlisted as out-of-scope). This is the anti-rot mechanism.

### 4.3 Command surface and flags

`whisper collab purge` — registered as a `collab` subcommand in
`packages/cli/src/create-cli.ts`, implemented in
`packages/cli/src/commands/collab/purge.ts`. Daemon-free.

| Flag | Behavior |
| --- | --- |
| *(none)* | Sweep all workspaces; classify; print the table. If STALE collabs exist and stdin is a TTY, prompt `Delete these N collab(s)? [y/N]`. If **not** a TTY and `--yes` is absent, **refuse safely**: print the table, delete nothing, exit non-zero with guidance to pass `--yes`. |
| `--dry-run` | Classify and print only. Never prompts, never deletes. Exit 0. |
| `--yes`, `-y` | Skip the prompt and proceed with deletion (scripts / non-TTY). |
| `--force` | Also purge PROTECTED collabs (those with a non-terminal workflow). Still subject to the confirm/`--yes` gate. |
| `--collab <id>` | Narrow the sweep to one collab id. |
| `--workspace <path>` | Narrow the sweep to one workspace (`realpath` → `workspace_id`). |
| `--json` | Emit machine-readable classification + outcome instead of the human table (matches `status --json` / `env --json` convention). With `--json` and no `--yes`/`--dry-run`, behave as dry-run (no interactive prompt in JSON mode). |

`--collab` and `--workspace` are mutually exclusive with each other; either may
combine with the behavior flags.

### 4.4 Data flow

1. Open the shared DB at `getSharedSqlitePath()`.
2. `listAllCollabs(db)` — a **new**, purpose-built query returning every collab
   across every workspace and status. This is intentionally **not** a reuse of
   the cwd-scoped `WHERE workspace_id = ?` lookup; reusing an under-narrow or
   over-narrow WHERE here is the exact failure prior incidents warned about.
3. Apply the `--collab` / `--workspace` scope filter, if any.
4. Classify each collab (§4.1), awaiting `defaultIsAlive` for daemon and mount
   PIDs.
5. Print the classification table: collab id, workspace root, `status`, bucket,
   reason (`dead-daemon` / `dead-mounts` / `stopped`), the owning workflow id +
   status for PROTECTED rows, and the count of rows that will be deleted.
6. If there are no STALE candidates (and, without `--force`, no actionable rows):
   print "nothing to purge" and exit 0.
7. If `--dry-run` (or `--json` without `--yes`): exit after printing.
8. Confirm gate: `--yes` ⇒ proceed; else TTY ⇒ prompt `[y/N]`; else ⇒ refuse
   safely (§4.3).
9. **Delete loop**, per stale collab, each in its own immediate transaction:
   - **Re-verify the collab is still not LIVE inside the transaction** (TOCTOU
     guard). If it went live since classification, skip and report it.
   - Otherwise `deleteCollabCascade(db, collabId)`.
10. **Best-effort artifact cleanup** (non-fatal): remove the daemon log file at
    `<stateRoot>/daemons/<collabId>.log` if present, and kill a leftover
    `tmux_session` if the collab recorded one and that session still exists.
11. Print a summary: purged, skipped (went-live / error), protected counts.

### 4.5 Error and edge handling

- **Per-collab transactions** — one collab's failure (DB busy, etc.) is reported
  and the sweep continues; it does not abort the whole run.
- **Unreadable `--workspace` path** — `realpath` throws ⇒ clear error, exit
  non-zero, delete nothing.
- **DB busy / locked** — surfaced per collab; the immediate transaction either
  succeeds atomically or is reported as a skip.
- **TOCTOU** — the in-transaction liveness re-check (§4.4 step 9) prevents
  deleting a collab that came alive mid-sweep.
- **PID reuse** — conservative skip (§4.1).
- **Empty DB / no collabs** — "nothing to purge", exit 0.

## 5. Data-model touchpoints

Tables with a direct `collab_id` column (handled by the §4.2 introspection loop):
`session`, `thread`, `work_item`, `reply`, `artifact_manifest`,
`artifact_attachment`, `companion_session`, `event_log`, `attach_claim`,
`session_binding`, `relay_monitor`, `relay_event`, `relay_turn_state`,
`relay_handoff`, `workflows`, `relay_chains`, `session_attachment`,
`broker_daemon`, `recovery_state`, `workflow_event_outbox`,
`relay_capture_diagnostics`, `relay_evaluator_diagnostics`,
`relay_turn_event_diagnostics`, and `collab` itself (deleted last).

Tables chained through a parent id, **no** `collab_id` (handled explicitly):
`workflow_phases` (via `workflows.workflow_id`), `work_item_cancellation` (via
`work_item.work_item_id`).

Special column: `clipboard_capture_lease.holder_collab_id`.

Preserved intentionally: `workspace`, `broker_state`.

> This inventory is a snapshot for the plan; the **drift-guard test (§4.2) is the
> authority** — it recomputes the partition from the live schema and fails if the
> code and schema diverge.

## 6. Files to touch

- **New:** `packages/cli/src/commands/collab/purge.ts` — `runCollabPurge(opts)`
  (classifier, table render, confirm gate, delete loop, artifact cleanup).
- **New:** `deleteCollabCascade(db, collabId)` and `listAllCollabs(db)` in
  `packages/broker/src/storage/repositories/collab-repository.ts` (alongside the
  existing `insertCollab` / `getCollab`).
- **New:** a non-terminal-workflow lookup in
  `packages/broker/src/storage/repositories/workflow-repository.ts`
  (`hasNonTerminalWorkflow(db, collabId)` or a count with
  `status NOT IN ('done','canceled')`).
- **Modify:** `packages/cli/src/create-cli.ts` — register the `purge` subcommand
  with the §4.3 flags.
- **New test:** `test/collab-purge.test.ts` and a schema drift-guard test
  (mirroring `test/agent-type-drift-guard.test.ts`).

Liveness (`defaultIsAlive`), the shared-DB path (`getSharedSqlitePath`,
`getStateRoot`), and the daemon-free command pattern (`stop.ts`) are reused, not
rebuilt.

## 7. Testing strategy

- **Classifier units** — fake `isAlive` + seeded rows: live daemon, live mount,
  fully dead, `stopped`, and protected-by-non-terminal-workflow.
- **Full-wipe verification** — after purging a collab, assert **zero** remaining
  rows for that collab id across *every* introspected table and the child/special
  tables.
- **Drift guard** — §4.2: schema partition matches the handled/allowlisted sets.
- **`--force`** — PROTECTED collab is skipped without `--force`, purged with it.
- **Multi-workspace WHERE-scope regression** — seed collabs in workspaces A and
  B; purge with no scope removes stale ones in both; a **live** collab in B is
  never touched; `--workspace A` confines deletion to A.
- **UX** — `--dry-run` deletes nothing; `--yes` bypasses the prompt; non-TTY
  without `--yes` refuses and deletes nothing; TTY answering `n` aborts.
- **TOCTOU** — a collab that becomes live between classify and delete is skipped.
- **`--json`** — shape assertion.

## 8. Acceptance criteria

- **AC-1** `whisper collab purge` enumerates collabs across all workspaces (not
  just cwd) and classifies each LIVE / PROTECTED / STALE per §4.1.
- **AC-2** A collab with a live daemon **or** a live mounted agent is never
  deleted, including the current workspace's active collab.
- **AC-3** A dead collab with a non-terminal workflow is skipped and reported
  without `--force`, and deleted with `--force`.
- **AC-4** Purging a stale collab leaves zero rows across all collab-scoped tables
  (verified against the live schema, not a hardcoded list).
- **AC-5** Adding a new collab-scoped table without updating the purge handling
  fails the drift-guard test.
- **AC-6** Default run with STALE collabs prompts on a TTY; `--dry-run` previews
  with no deletion; `--yes` bypasses the prompt; a non-TTY run without `--yes`
  deletes nothing and exits non-zero with guidance.
- **AC-7** `--collab` / `--workspace` correctly narrow the sweep; a live collab in
  an unrelated workspace is unaffected.
- **AC-8** A collab that becomes live between classification and deletion is
  skipped (TOCTOU), and a per-collab failure does not abort the sweep.

## 9. Open questions

None — resolved during brainstorming (scope: command-only; staleness: dead +
protect-resumable; UX: interactive confirm with `--yes` bypass and non-TTY
refuse; depth: full wipe).
