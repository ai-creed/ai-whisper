# Hands-Off Time Saved Metric — Design

> **Status:** Approved for planning
> **Date:** 2026-07-01
> **Related:** `whisper collab dashboard`, `whisper workflow *` command group
> **Supersedes / depends on:** none

## 1. Overview

Every autonomous workflow (`whisper workflow start …`) runs unattended from
kickoff to completion. The wall-clock duration of that run is time the operator
did **not** spend babysitting the agents — they were free to do other things.
This feature surfaces the **accumulated** sum of that hands-off time across all
workflows the operator has ever run, as a single milestone number.

Two surfaces consume one shared aggregation:

1. `whisper workflow stats` — a headless, scriptable command (`--json` supported).
2. A one-line segment in the live `whisper collab dashboard` summary bar.

There is no existing aggregation query and no stored duration; the number is
computed on read from the `workflows` table's `created_at` / `updated_at`
timestamps.

## 2. Goals & Non-Goals

### Goals

- A single global, all-time accumulated "hands-off time saved" figure.
- Count workflows that reached `done` **or** `halted`.
- Measure each run's elapsed time literally (`updated_at − created_at`), with no
  cap.
- Expose the figure through a CLI command and the dashboard.
- Be correct-by-construction: no persisted state to drift, an allowlist of
  counted statuses so future statuses are excluded by default, and full
  determinism for tests.

### Non-Goals

- **No materialized counter.** The `workflows` table is tiny (~150 rows after
  ~40 days); a stored running total would add a migration, a write hook, a
  backfill, and drift risk for no measurable read benefit.
- **No per-collab scoping.** The figure is global. (A per-collab breakdown is
  listed under Future Work.)
- **No time-window filtering** (today / 7d / 30d). All-time only.
- **No "human-effort-equivalent" multiplier.** The metric reports freed
  wall-clock, not an estimate of equivalent manual engineering effort.
- **No inclusion of `canceled` runs.** A canceled run is one the operator came
  back to abort; it is not "saved" time, and abandoned cancels can sit idle for
  days, badly inflating any total.
- **No caching.** Compute-on-read is fast enough at this scale.

## 3. Definitions

- **Counted statuses:** `done` and `halted`. A `halted` run usually performed
  real autonomous work before escalating, so its elapsed time is credited.
- **Hands-off elapsed (per workflow):** `max(0, Date.parse(updated_at) −
  Date.parse(created_at))` milliseconds.
- **Accumulated hands-off time:** the sum of hands-off elapsed over every
  counted workflow, across all collabs and all history.

## 4. Architecture

**Approach: compute-on-read (chosen over a materialized counter).**

```
workflows table (SQLite, shared state.db)
        │
        │  SELECT status, created_at, updated_at
        │  WHERE status IN ('done','halted')
        ▼
getHandsOffStats(db)            ← packages/broker/src/storage/repositories/workflow-repository.ts
        │  (reduce in JS → HandsOffStats)
        ▼
broker.control.getHandsOffStats()   ← packages/broker/src/control/create-control-service.ts
        │
        ├── runWorkflowStats(deps)  ← packages/cli/src/commands/workflow/stats.ts   → CLI text / --json
        │
        └── dashboard poll          ← packages/cli/src/runtime/dashboard.ts         → WallState.handsOff → summary bar
```

Both surfaces call the same repo function through `broker.control`. The repo
returns raw numbers only; all formatting happens in the CLI layer via a new
`fmtDurCoarse` helper.

The reduction is done in TypeScript (not SQL `SUM(julianday(...))`) because
timestamps are ISO-8601 strings with a `Z` suffix and milliseconds;
`Date.parse` handles that format identically on every platform, avoiding any
SQLite `julianday()` timezone-suffix version dependence. With ~150 rows the
cost is negligible.

## 5. Detailed Design

### 5.1 Aggregation contract

The set of counted statuses is defined once, as an allowlist:

```ts
const COUNTED_STATUSES = ["done", "halted"] as const;
```

For each counted workflow:

- `start = Date.parse(created_at)`, `end = Date.parse(updated_at)`.
- If either is `NaN` (null or malformed), the row contributes `0` ms and
  increments the `skipped` counter.
- Otherwise the row contributes `max(0, end − start)` ms. The `max(0, …)` clamp
  protects against clock-skew rows where `updated_at < created_at`.

`updated_at` is used as the run's end time: `setWorkflowStatus` stamps
`updated_at` at the transition into a terminal status, so for a `done`/`halted`
run it equals the completion time, with no join required.

**Known caveat (accepted):** a post-terminal `updateWorkflowContext` write would
bump `updated_at` and slightly inflate that run's elapsed time. In practice
terminal runs are not context-written after completion. Joining
`relay_handoff.last_activity_at` for marginal accuracy is rejected (YAGNI). This
caveat is documented here and in the function's doc comment.

Because only terminal runs are counted, the computation needs no "now" clock and
is fully deterministic — every counted run has a fixed end time. This makes the
function reproducible in tests without time mocking.

### 5.2 Repo query + types

Added to `packages/broker/src/storage/repositories/workflow-repository.ts`,
beside the existing workflow reads:

```ts
export interface HandsOffStatusBucket {
	count: number;
	totalMs: number;
}

export interface HandsOffStats {
	/** Σ hands-off elapsed across all counted runs, in ms. */
	totalMs: number;
	/** Number of counted runs (done + halted). */
	count: number;
	byStatus: {
		done: HandsOffStatusBucket;
		halted: HandsOffStatusBucket;
	};
	/** Earliest created_at among counted runs (ISO), or null when none. */
	earliestKickoffAt: string | null;
	/** Rows excluded because a timestamp could not be parsed. */
	skipped: number;
}

export function getHandsOffStats(db: Database.Database): HandsOffStats;
```

Implementation outline:

```ts
const COUNTED_STATUSES = ["done", "halted"] as const;

export function getHandsOffStats(db: Database.Database): HandsOffStats {
	const placeholders = COUNTED_STATUSES.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT status, created_at, updated_at
			 FROM workflows
			 WHERE status IN (${placeholders})`,
		)
		.all(...COUNTED_STATUSES) as Array<{
		status: "done" | "halted";
		created_at: string;
		updated_at: string;
	}>;

	const stats: HandsOffStats = {
		totalMs: 0,
		count: 0,
		byStatus: { done: { count: 0, totalMs: 0 }, halted: { count: 0, totalMs: 0 } },
		earliestKickoffAt: null,
		skipped: 0,
	};

	for (const row of rows) {
		const start = Date.parse(row.created_at);
		const end = Date.parse(row.updated_at);
		if (Number.isNaN(start) || Number.isNaN(end)) {
			stats.skipped += 1;
			continue;
		}
		const elapsed = Math.max(0, end - start);
		stats.totalMs += elapsed;
		stats.count += 1;
		stats.byStatus[row.status].count += 1;
		stats.byStatus[row.status].totalMs += elapsed;
		if (
			stats.earliestKickoffAt === null ||
			row.created_at < stats.earliestKickoffAt
		) {
			stats.earliestKickoffAt = row.created_at;
		}
	}

	return stats;
}
```

The SQL `IN (…)` clause is built from `COUNTED_STATUSES`, so the query has a
single source of truth — adding a status to the const automatically widens the
query. The `byStatus` object is a typed literal; a guard test asserts that
`Object.keys(byStatus)` equals `COUNTED_STATUSES`, so the buckets cannot drift
from the counted set (see §7). ISO-8601 timestamps sort lexicographically, so
the string comparison `row.created_at < stats.earliestKickoffAt` correctly finds
the minimum without parsing.

### 5.3 Broker control exposure + exports

In `packages/broker/src/control/create-control-service.ts`, import the repo
function and expose it on the control object (mirroring
`listAllWorkflowSummaries`):

```ts
import { getHandsOffStats as getHandsOffStatsRepo } from "../storage/repositories/workflow-repository.js";
// …
getHandsOffStats(): HandsOffStats {
	return getHandsOffStatsRepo(db);
},
```

Re-export `getHandsOffStats` and the `HandsOffStats` / `HandsOffStatusBucket`
types from `packages/broker/src/index.ts`.

### 5.4 Coarse duration formatter

`fmtDur` (in `packages/cli/src/runtime/relay-view-state.ts`) stops at minutes
(`"5m03s"`), which is unreadable for hundreds of hours. A sibling helper is
added next to it:

```ts
export function fmtDurCoarse(ms: number): string {
	const totalMin = Math.floor(Math.max(0, ms) / 60000);
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	const m = totalMin % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}
```

**Rule:** render the two largest place-value units — days + hours at day scale
(≥ 1 day), hours + minutes at hour scale (≥ 1 hour and < 1 day), and minutes
alone below an hour. The second unit is always shown even when it is zero, so
day-scale values keep a stable `Xd Yh` shape (an exact day is `1d 0h`) and
hour-scale values an `Xh Ym` shape (an exact hour is `1h 0m`). Seconds are never
shown; any sub-minute total renders `0m`. This matches the implementation above:
once `d > 0` it always emits `${d}d ${h}h`, and once `h > 0` it always emits
`${h}h ${m}m` — the lower field is not suppressed when zero.

| Input | Output |
| --- | --- |
| `0` | `0m` |
| `45_000` (45 s) | `0m` |
| `2_820_000` (47 m) | `47m` |
| `3_600_000` (exact 1 h) | `1h 0m` |
| `12_240_000` (3 h 24 m) | `3h 24m` |
| `86_400_000` (exact 1 d) | `1d 0h` |
| `90_000_000` (25 h) | `1d 1h` |
| `1_138_800_000` (13 d 4 h 20 m) | `13d 4h` |

### 5.5 CLI command — `whisper workflow stats`

New handler `packages/cli/src/commands/workflow/stats.ts`, following the pure
`run*(deps)` pattern used by `runWorkflowList`:

```ts
export interface WorkflowStatsDeps {
	broker: { control: { getHandsOffStats: () => HandsOffStats } };
	json?: boolean;
	stdout?: NodeJS.WritableStream;
}

export function runWorkflowStats(deps: WorkflowStatsDeps): void;
```

The handler reads `getHandsOffStats()` and writes formatted output. It is
registered in the `workflow` command group in `packages/cli/src/create-cli.ts`,
beside `list`/`inspect`. **The command is global:** its registration opens the
shared state DB directly via `getSharedSqlitePath()` +
`createBrokerRuntime({ sqlitePath, runWorkflowDriver: false,
runDiagnosticsSweep: false, runDaemonHeartbeat: false, runBrokerDaemonSweep:
false })` (the same pattern as `runCollabDashboard`), then `broker.stop()` in a
`finally`. It does **not** use `connectToWorkspaceBroker` and therefore does not
require an active collab in the current directory.

**Human output (default):**

```
Hands-off time saved: 13d 4h  (112 workflows, since 2026-05-21)
  done     98 runs · 11d 6h
  halted   14 runs · 1d 22h
```

- The `since` date is the calendar date of `earliestKickoffAt`.
- `byStatus` lines use `fmtDurCoarse` per bucket.

**Empty database** (`count === 0`):

```
Hands-off time saved: 0m (no completed workflows yet)
```

**`--json` output:** the raw `HandsOffStats` plus formatted mirror fields, so
scripts get both machine and display values:

```json
{
  "totalMs": 1138800000,
  "totalHuman": "13d 4h",
  "count": 112,
  "since": "2026-05-21T03:17:25.898Z",
  "byStatus": {
    "done":   { "count": 98, "totalMs": 972000000, "human": "11d 6h" },
    "halted": { "count": 14, "totalMs": 166800000, "human": "1d 22h" }
  },
  "skipped": 0
}
```

For the empty case, `--json` reports `totalMs: 0`, `count: 0`, `since: null`,
zeroed buckets, `skipped: 0`.

The only option is `--json`; the command exits `0` on success.

### 5.6 Dashboard summary-bar segment

The live dashboard gains one dim-styled segment in the summary-counts row of
`packages/cli/src/runtime/dashboard-view.tsx`:

```
running 2 · paused 0 · halted 1 · done 5     │  hands-off saved 13d 4h (112)
```

Plumbing:

- `createDashboardRuntime`'s existing 1 s poll
  (`packages/cli/src/runtime/dashboard.ts`) already calls
  `broker.control.listActiveCollabSummaries(...)`. Add a sibling
  `broker.control.getHandsOffStats()` call in the same tick.
- Thread `{ totalMs, count }` onto `WallState` in
  `packages/cli/src/runtime/dashboard-state.ts` as `handsOff`.
- Render it in the summary bar with `fmtDurCoarse(totalMs)` and the run count.

The extra query is one tiny aggregate per poll — acceptable under the
compute-on-read decision. If the figure is unavailable for any reason (e.g. zero
rows), the segment renders `hands-off saved 0m (0)`.

## 6. Edge Cases

| Case | Behavior |
| --- | --- |
| No `done`/`halted` runs yet | `totalMs: 0, count: 0, earliestKickoffAt: null`; CLI prints the "no completed workflows yet" line; dashboard shows `0m (0)`. |
| `updated_at < created_at` (clock skew) | Per-run elapsed clamped to `0` via `max(0, …)`. |
| Null or malformed timestamp | Row skipped, contributes `0`, increments `skipped`. |
| Post-terminal context write bumps `updated_at` | Accepted minor inflation; documented in §5.1 and the doc comment. |
| `canceled` / `running` / `paused` runs | Never counted (allowlist excludes them). |
| A future migration adds a new status | Excluded by default until `COUNTED_STATUSES` and the SQL are deliberately updated. |
| Very large accumulated total | `fmtDurCoarse` renders days + hours. |
| Command run outside any collab workspace | Works — opens the shared state DB directly, no active collab required. |

## 7. Testing Strategy

All tests use the established top-level `/test/` directory with Vitest and an
in-memory SQLite broker (`bootstrap()` pattern from
`test/workflow-repository.test.ts`), seeding workflows with explicit
`created_at` / `updated_at` / `status` values.

**`getHandsOffStats` (repo):**

- Sums only `done` + `halted`; rows with `running`, `paused`, `canceled` are
  excluded from `totalMs`, `count`, and `byStatus`.
- Per-run elapsed equals `updated_at − created_at`; a skew row
  (`updated_at < created_at`) contributes `0`, not a negative.
- A row with a malformed/null timestamp is counted in `skipped` and contributes
  `0`.
- `byStatus.done` and `byStatus.halted` buckets are correct, and
  `count === done.count + halted.count`, `totalMs === done.totalMs +
  halted.totalMs`.
- `earliestKickoffAt` equals the minimum `created_at` among counted rows, and is
  `null` for an empty set.
- **Allowlist guard:** a test asserts the SQL's counted set and the `byStatus`
  keys match `COUNTED_STATUSES`, so adding a status to one without the other
  fails the suite (mirrors the purge drift-guard's intent).

**`fmtDurCoarse` (formatter):** a table test covering each row in the §5.4 table,
including the boundaries `0`, sub-minute, exact hour, exact day, and
minutes-dropped-when-days-present.

**`runWorkflowStats` (CLI):**

- Default human output matches the §5.5 format for a seeded multi-status fixture,
  including the `since` date and per-bucket lines.
- `--json` output has the exact shape in §5.5, with `totalHuman`,
  `byStatus.*.human`, and `since`.
- Empty-DB fixture produces the "no completed workflows yet" line (human) and
  `totalMs: 0, count: 0, since: null` (`--json`).
- The handler is exercised with an injected `broker.control.getHandsOffStats`
  stub, so no Ink rendering is involved.

**CLI wiring:** `test/cli-command-wiring.test.ts` is extended so the `workflow`
group's subcommand list includes `stats` in its exact sorted position (matching
the existing exact-list assertion contract).

**Dashboard:** verified at two layers, because AC-11 requires a *visible*
segment, not merely populated state:

- *State plumbing:* `WallState.handsOff` is populated from `getHandsOffStats` on
  each poll tick (state-level assertion).
- *Ink render:* a render test is added to the existing "Wall summary bar"
  `describe` block in `test/dashboard-view.test.tsx`, following the
  `render(<Wall … counts={…} />)` + `lastFrame()` pattern already established
  there. It asserts that for a seeded non-zero `handsOff` the summary bar's first
  line contains `hands-off saved <coarse> (<count>)`, and that a zero/absent
  figure renders `hands-off saved 0m (0)`. This proves the segment is actually
  emitted, so an implementation that fetches and threads the value but never
  renders it fails the suite. (The codebase already exercises the Wall summary
  bar through `ink-testing-library`, so this layer is consistent with existing
  tests — not a new testing approach.)

## 8. Acceptance Criteria

- **AC-1** `getHandsOffStats` counts only `done` + `halted`; `running`,
  `paused`, and `canceled` never contribute.
- **AC-2** Per-workflow elapsed is `max(0, updated_at − created_at)`; clock-skew
  rows clamp to `0`.
- **AC-3** Rows with an unparseable timestamp are skipped, contribute `0`, and
  increment `skipped`.
- **AC-4** `byStatus` buckets are correct and consistent with `count` and
  `totalMs`; `earliestKickoffAt` is the minimum counted `created_at`, or `null`.
- **AC-5** `COUNTED_STATUSES` is the single allowlist; a status added to the SQL
  or the buckets but not the other fails the guard test.
- **AC-6** `fmtDurCoarse` renders the two largest place-value units per the §5.4
  table: days + hours at day scale (the hours field shown even when zero, so an
  exact day is `1d 0h`), hours + minutes at hour scale (an exact hour is
  `1h 0m`), and minutes alone below an hour. The exact-day and exact-hour
  boundary rows are required table-test cases.
- **AC-7** `whisper workflow stats` prints the §5.5 human format, and the
  empty-DB message when there are no counted runs.
- **AC-8** `whisper workflow stats --json` emits the §5.5 JSON shape, including
  `totalHuman`, per-bucket `human`, and `since`.
- **AC-9** The command opens the shared state DB globally and succeeds with no
  active collab in the working directory.
- **AC-10** `broker.control.getHandsOffStats()` is exposed and the function and
  types are exported from the broker package index.
- **AC-11** The dashboard summary bar shows a `hands-off saved <coarse> (<count>)`
  segment sourced from `getHandsOffStats`, computed once per poll. An Ink render
  test (per §7) asserts the segment is actually displayed in the rendered bar —
  populated `WallState.handsOff` alone is insufficient.

## 9. Deferred / Future Work

- Optional `--since <window>` filter (today / 7d / 30d) on the CLI command.
- Per-collab breakdown (e.g. on each dashboard collab card).
- In-process TTL cache if the `workflows` table ever grows large enough that the
  per-poll aggregate is measurable.
- A "human-effort-equivalent" estimate as a separate, clearly-labeled figure.
