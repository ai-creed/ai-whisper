import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "./open-database.js";
import { CURRENT_SCHEMA_VERSION } from "./apply-migrations.js";
import { isPidAlive } from "../runtime/broker-daemon-sweep.js";

export interface RecoveryExpectations {
	raw: { workflows: number; phases: number; chains: number; handoffs: number };
	distinct: { workflows: number; phases: number; chains: number; handoffs: number };
	closureFloor: { phases: number; chains: number; handoffs: number };
}

export interface RecoveryImportResult {
	imported: {
		workflows: number;
		phases: number;
		chains: number;
		handoffs: number;
		collabTombstones: number;
	};
	skipped: {
		unknownWorkflow: { phases: number; handoffs: number };
		missingChain: { phases: number; handoffs: number };
		unreferencedChains: number;
	};
}

// spec §6 predicates. lost_and_found rows carry no type tag, and the freelist
// contains same-width non-target records (e.g. an 8-field session row alongside
// an 8-field workflow_phases row), so the GLOB shape of the id column is the only
// discriminator. Widths and column ordinals are verified against the v8 schema.
const PREDICATES = {
	workflows: "nfield = 12 AND c0 GLOB 'wf_*'",
	phases: "nfield = 8 AND c0 GLOB 'wfp_*' AND c1 GLOB 'wf_*' AND c4 GLOB 'relay_ch_*'",
	chains: "nfield = 9 AND c0 GLOB 'relay_ch_*' AND c1 GLOB 'collab_*'",
	handoffs: "nfield = 29 AND c0 GLOB 'ho_*' AND c1 GLOB 'collab_*'",
} as const;

// Record widths per target table (== the number of columns in PRAGMA table_info
// order). The lost_and_found c0..c(width-1) ordinals map 1:1 onto them.
const WIDTHS = { workflows: 12, phases: 8, chains: 9, handoffs: 29 } as const;

type LafRow = Record<string, string | number | null>;

function assertNoLiveDaemon(db: Database.Database): void {
	const rows = db
		.prepare("SELECT pid FROM broker_daemon WHERE pid IS NOT NULL")
		.all() as Array<{ pid: number }>;
	for (const row of rows) {
		if (isPidAlive(row.pid)) {
			throw new Error(
				`Recovery aborted: a live broker daemon (pid ${row.pid}) owns the target database. Stop the daemon and retry.`,
			);
		}
	}
}

function rawCount(db: Database.Database, predicate: string): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM lost_and_found WHERE ${predicate}`).get() as {
			n: number;
		}
	).n;
}

function distinctCount(db: Database.Database, predicate: string): number {
	return (
		db
			.prepare(`SELECT COUNT(DISTINCT c0) AS n FROM lost_and_found WHERE ${predicate}`)
			.get() as { n: number }
	).n;
}

// One candidate record per distinct c0. GROUP BY c0 collapses the freelist
// duplicates the same record can leave behind; c0 is the primary key of every
// target table, so this is the natural dedup key.
function candidateRows(
	db: Database.Database,
	predicate: string,
	width: number,
): LafRow[] {
	const cols = Array.from({ length: width }, (_, i) => `c${i}`).join(", ");
	return db
		.prepare(`SELECT ${cols} FROM lost_and_found WHERE ${predicate} GROUP BY c0`)
		.all() as LafRow[];
}

function targetIds(
	db: Database.Database,
	table: string,
	column: string,
): Set<string> {
	const rows = db.prepare(`SELECT ${column} AS id FROM "${table}"`).all() as Array<{
		id: string;
	}>;
	return new Set(rows.map((r) => r.id));
}

function assertCountsMatch(
	tier: string,
	actual: Record<string, number>,
	expected: Record<string, number>,
): void {
	for (const key of Object.keys(expected)) {
		if (actual[key] !== expected[key]) {
			throw new Error(
				`Recovery aborted: ${tier} count mismatch for ${key} (expected ${expected[key]}, got ${actual[key]}). The recovery source does not match the verified snapshot.`,
			);
		}
	}
}

// Insert deduped candidate rows into a target table, mapping c0..c(width-1) onto
// the table's columns in PRAGMA table_info order. ON CONFLICT(pk) DO NOTHING —
// deliberately NOT `INSERT OR IGNORE`: PK re-imports are idempotent, but a genuine
// constraint violation (e.g. a NOT NULL column recovered as NULL) still throws so
// the single import transaction rolls back rather than silently dropping the row.
function insertRows(
	db: Database.Database,
	table: string,
	pk: string,
	rows: LafRow[],
	width: number,
): number {
	const cols = (
		db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
	).map((c) => c.name);
	if (cols.length !== width) {
		throw new Error(
			`Recovery aborted: target table ${table} has ${cols.length} columns, expected ${width}. The ordinal mapping is no longer valid for this schema.`,
		);
	}
	const stmt = db.prepare(
		`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
			`VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT("${pk}") DO NOTHING`,
	);
	let inserted = 0;
	for (const row of rows) {
		const bind = cols.map((_, i) => row[`c${i}`] ?? null);
		inserted += stmt.run(...bind).changes;
	}
	return inserted;
}

/**
 * One-shot import of workflow history recovered from a purged state.db's freelist
 * (a sqlite3 `.recover` output with a `lost_and_found` table) into a live,
 * already-migrated run ledger.
 *
 * Ordering is load-bearing: (1) daemon guard, (2) three-tier count verification
 * (raw exact, distinct exact, closure floor) with NOTHING written until all pass,
 * (3) two-edge referential closure (a phase/handoff is kept only if its workflow
 * AND its chain resolve), (4) a single transaction that tombstones the recovered
 * collabs (as archived) and inserts chains before the phases/handoffs that
 * reference them. INSERT is PK-idempotent, so re-runs import nothing.
 */
export function runRecoveryImport(
	sourceDb: Database.Database,
	targetDb: Database.Database,
	expectations: RecoveryExpectations,
	now: string,
): RecoveryImportResult {
	// Defense-in-depth: the path entrypoint already refused a daemon-owned file,
	// but a direct caller must not import into a database a live daemon owns.
	assertNoLiveDaemon(targetDb);

	// Tier 1 + 2: raw and distinct counts must match the operator-verified snapshot
	// exactly, BEFORE any closure work or write.
	assertCountsMatch(
		"raw",
		{
			workflows: rawCount(sourceDb, PREDICATES.workflows),
			phases: rawCount(sourceDb, PREDICATES.phases),
			chains: rawCount(sourceDb, PREDICATES.chains),
			handoffs: rawCount(sourceDb, PREDICATES.handoffs),
		},
		expectations.raw,
	);
	assertCountsMatch(
		"distinct",
		{
			workflows: distinctCount(sourceDb, PREDICATES.workflows),
			phases: distinctCount(sourceDb, PREDICATES.phases),
			chains: distinctCount(sourceDb, PREDICATES.chains),
			handoffs: distinctCount(sourceDb, PREDICATES.handoffs),
		},
		expectations.distinct,
	);

	const workflowRows = candidateRows(sourceDb, PREDICATES.workflows, WIDTHS.workflows);
	const phaseRows = candidateRows(sourceDb, PREDICATES.phases, WIDTHS.phases);
	const chainRows = candidateRows(sourceDb, PREDICATES.chains, WIDTHS.chains);
	const handoffRows = candidateRows(sourceDb, PREDICATES.handoffs, WIDTHS.handoffs);

	// Known workflows = already in target ∪ recovered. A phase/handoff is "rooted"
	// only when its workflow id (phase c1, handoff c23) is known.
	const knownWorkflows = targetIds(targetDb, "workflows", "workflow_id");
	for (const w of workflowRows) knownWorkflows.add(String(w.c0));

	const rootedPhases = phaseRows.filter((p) => knownWorkflows.has(String(p.c1)));
	const rootedHandoffs = handoffRows.filter((h) => knownWorkflows.has(String(h.c23)));

	// Available chains = already in target ∪ recovered chains that a rooted edge
	// references (phase c4, handoff c12). A recovered chain referenced by nothing
	// is not imported.
	const referencedChainIds = new Set<string>();
	for (const p of rootedPhases) if (p.c4 != null) referencedChainIds.add(String(p.c4));
	for (const h of rootedHandoffs) if (h.c12 != null) referencedChainIds.add(String(h.c12));

	const importedChainRows = chainRows.filter((c) =>
		referencedChainIds.has(String(c.c0)),
	);
	const availableChains = targetIds(targetDb, "relay_chains", "chain_id");
	for (const c of importedChainRows) availableChains.add(String(c.c0));

	// Final = rooted AND chain-closed (a null chain reference is trivially closed).
	const finalPhases = rootedPhases.filter(
		(p) => p.c4 == null || availableChains.has(String(p.c4)),
	);
	const finalHandoffs = rootedHandoffs.filter(
		(h) => h.c12 == null || availableChains.has(String(h.c12)),
	);

	// Tier 3: the referentially closed graph must clear the operator's floor. This
	// is a lower bound (below → abort), not equality. Still nothing written.
	const floorActual = {
		phases: finalPhases.length,
		chains: importedChainRows.length,
		handoffs: finalHandoffs.length,
	} as const;
	for (const key of ["phases", "chains", "handoffs"] as const) {
		if (floorActual[key] < expectations.closureFloor[key]) {
			throw new Error(
				`Recovery aborted: closure count for ${key} (${floorActual[key]}) is below the verified floor (${expectations.closureFloor[key]}).`,
			);
		}
	}

	// Every recovered row's collab needs a tombstone parent so the ledger/dashboard
	// can render it. Phases carry no collab_id — their collab comes from the parent
	// workflow, already covered by workflowRows.
	const collabIds = new Set<string>();
	for (const w of workflowRows) collabIds.add(String(w.c1));
	for (const c of importedChainRows) collabIds.add(String(c.c1));
	for (const h of finalHandoffs) collabIds.add(String(h.c1));

	const result: RecoveryImportResult = {
		imported: { workflows: 0, phases: 0, chains: 0, handoffs: 0, collabTombstones: 0 },
		skipped: {
			unknownWorkflow: {
				phases: phaseRows.length - rootedPhases.length,
				handoffs: handoffRows.length - rootedHandoffs.length,
			},
			missingChain: {
				phases: rootedPhases.length - finalPhases.length,
				handoffs: rootedHandoffs.length - finalHandoffs.length,
			},
			unreferencedChains: chainRows.length - importedChainRows.length,
		},
	};

	const runImport = targetDb.transaction(() => {
		// Tombstones for collabs missing from the target, stamped archived at `now`
		// so they land straight in the ledger as stopped/archived cards.
		const tombstone = targetDb.prepare(
			"INSERT OR IGNORE INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at, archived_at) VALUES (?, 'recovered', ?, 'stopped', ?, ?, ?)",
		);
		for (const collabId of collabIds) {
			result.imported.collabTombstones += tombstone.run(
				collabId,
				collabId,
				now,
				now,
				now,
			).changes;
		}
		// Parents before children: workflows and chains before the phases and
		// handoffs that reference them.
		result.imported.workflows += insertRows(
			targetDb,
			"workflows",
			"workflow_id",
			workflowRows,
			WIDTHS.workflows,
		);
		result.imported.chains += insertRows(
			targetDb,
			"relay_chains",
			"chain_id",
			importedChainRows,
			WIDTHS.chains,
		);
		result.imported.phases += insertRows(
			targetDb,
			"workflow_phases",
			"phase_run_id",
			finalPhases,
			WIDTHS.phases,
		);
		result.imported.handoffs += insertRows(
			targetDb,
			"relay_handoff",
			"handoff_id",
			finalHandoffs,
			WIDTHS.handoffs,
		);
	});
	runImport();

	return result;
}

// Preflight the target WITHOUT opening the target file itself. Opening a WAL-mode
// database (which every live state.db is) makes SQLite recover the WAL on first
// connect and create the -wal/-shm side files — a mutation the preflight has not
// yet cleared the file for. So copy the db plus any live -wal/-shm to a throwaway
// and probe THAT copy. The target is only ever read (copyFileSync), never opened,
// so a refusal leaves it byte-identical — primary file AND -wal, existence
// included. The two checks run in the mandated order: daemon liveness first (a
// daemon-owned file is refused whatever its version; broker_daemon exists in every
// supported schema), schema-version equality second. This module NEVER migrates.
function preflightTarget(targetPath: string): void {
	const dir = mkdtempSync(join(tmpdir(), "recovery-preflight-"));
	const copyPath = join(dir, "state.db");
	try {
		copyFileSync(targetPath, copyPath);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(`${targetPath}${suffix}`)) {
				copyFileSync(`${targetPath}${suffix}`, `${copyPath}${suffix}`);
			}
		}
		const probe = new Database(copyPath, { readonly: true });
		try {
			assertNoLiveDaemon(probe);
			const version = probe.pragma("user_version", { simple: true }) as number;
			if (version !== CURRENT_SCHEMA_VERSION) {
				throw new Error(
					`Recovery aborted: target schema version is ${version}, expected ${CURRENT_SCHEMA_VERSION}. Run the broker once to migrate the target, then retry — this script never migrates it.`,
				);
			}
		} finally {
			probe.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Safety-bearing entrypoint used by the CLI wrapper and Task 9. Runs the preflight
 * (no live daemon, exact schema version) against the target BEFORE opening it
 * writable — nothing may touch the target file until both checks pass, and this
 * module NEVER migrates the target. Only then does it open writable and delegate
 * to `runRecoveryImport`.
 */
export function runRecoveryImportFromPaths(
	sourcePath: string,
	targetPath: string,
	expectations: RecoveryExpectations,
	now: string,
): RecoveryImportResult {
	preflightTarget(targetPath);

	// Both checks passed — safe to open writable and import. The source is opened
	// read-only: recovery must never mutate the `.recover` output.
	const targetDb = openDatabase(targetPath);
	const sourceDb = new Database(sourcePath, { readonly: true });
	try {
		return runRecoveryImport(sourceDb, targetDb, expectations, now);
	} finally {
		sourceDb.close();
		targetDb.close();
	}
}
