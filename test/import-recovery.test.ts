import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	runRecoveryImport,
	runRecoveryImportFromPaths,
} from "../packages/broker/src/storage/import-recovery.ts";

const NOW = "2026-07-23T00:00:00.000Z";
const TOMBSTONE_COLLAB_ID = "collab_a";

function tmpPath(name: string): string {
	return path.join(mkdtempSync(path.join(os.tmpdir(), "recovery-")), name);
}

const LOST_AND_FOUND_DDL =
	"CREATE TABLE lost_and_found (rootpgno INTEGER, pgno INTEGER, nfield INTEGER, id INTEGER, " +
	Array.from({ length: 29 }, (_, i) => `c${i}`).join(", ") +
	")";

// Insert one recovered record. lost_and_found rows carry no type tag: nfield is
// the record width and c0..c28 the serialised field values in the source table's
// column order.
function insertRow(
	db: ReturnType<typeof openDatabase>,
	nfield: number,
	values: Record<string, string | number | null>,
): void {
	const cCols = Array.from({ length: 29 }, (_, i) => `c${i}`);
	const bind = cCols.map((c) => values[c] ?? null);
	db.prepare(
		`INSERT INTO lost_and_found (nfield, ${cCols.join(", ")}) VALUES (?, ${cCols
			.map(() => "?")
			.join(", ")})`,
	).run(nfield, ...bind);
}

// A workflow record (nfield=12): c0=workflow_id, c1=collab_id, ... c10=created_at,
// c11=updated_at. Terminal status so the partial "one running per collab" index
// never applies to a recovered card.
function workflow(overrides: Record<string, string | number | null> = {}) {
	return {
		c0: "wf_a",
		c1: TOMBSTONE_COLLAB_ID,
		c2: "spec-driven-development",
		c3: "wf a",
		c4: "/spec.md",
		c5: "{}",
		c6: "completed",
		c7: 0,
		c8: null,
		c9: "{}",
		c10: "2026-07-01T00:00:00.000Z",
		c11: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function phase(id: string, workflowId: string, chainId: string) {
	// nfield=8: c0=phase_run_id, c1=workflow_id, c4=chain_id.
	return {
		c0: id,
		c1: workflowId,
		c2: 0,
		c3: "implement",
		c4: chainId,
		c5: "2026-07-01T00:00:00.000Z",
		c6: null,
		c7: null,
	};
}

function chain(id: string) {
	// nfield=9: c0=chain_id, c1=collab_id.
	return {
		c0: id,
		c1: TOMBSTONE_COLLAB_ID,
		c2: "done",
		c3: 1,
		c4: 3,
		c5: null,
		c6: null,
		c7: "2026-07-01T00:00:00.000Z",
		c8: "2026-07-01T00:00:00.000Z",
	};
}

function handoff(id: string, chainId: string | null, workflowId: string) {
	// nfield=29: c0=handoff_id, c1=collab_id, c12=chain_id, c23=workflow_id.
	// c2/c3/c4/c5/c6/c10 are the NOT NULL columns.
	return {
		c0: id,
		c1: TOMBSTONE_COLLAB_ID,
		c2: "claude",
		c3: "codex",
		c4: "do x",
		c5: "resolved",
		c6: "2026-07-01T00:00:00.000Z",
		c10: "2026-07-01T00:00:00.000Z",
		c12: chainId,
		c23: workflowId,
	};
}

function fillFixtureSource(db: ReturnType<typeof openDatabase>): void {
	db.exec(LOST_AND_FOUND_DDL);
	// 1 valid workflow, duplicated twice (dedup case).
	insertRow(db, 12, workflow());
	insertRow(db, 12, workflow());
	// phase rooted + chain-closed.
	insertRow(db, 8, phase("wfp_a", "wf_a", "relay_ch_a"));
	// phase rooted but chain missing -> skip: missingChain.
	insertRow(db, 8, phase("wfp_b", "wf_a", "relay_ch_missing"));
	// phase valid-shape but unknown workflow -> skip: unknownWorkflow.
	insertRow(db, 8, phase("wfp_c", "wf_ghost", "relay_ch_a"));
	// nfield=8 distractor (session-shaped c0) -> never a candidate.
	insertRow(db, 8, {
		c0: "sess_x",
		c1: TOMBSTONE_COLLAB_ID,
		c2: "claude",
		c3: "registered",
		c4: "healthy",
		c5: "{}",
		c6: "t",
		c7: "t",
	});
	// nfield=12 distractor (session-shaped c0, does NOT glob wf_*) -> proves the
	// workflows predicate's c0 GLOB is load-bearing, not just nfield=12.
	insertRow(db, 12, {
		...workflow(),
		c0: "sess_y",
	});
	// chain referenced by the closed phase/handoff.
	insertRow(db, 9, chain("relay_ch_a"));
	// chain referenced by nothing -> skip: unreferencedChains.
	insertRow(db, 9, chain("relay_ch_orphan"));
	// nfield=9 distractor (c0 does NOT glob relay_ch_*) -> proves the chains
	// predicate's c0 GLOB is load-bearing, not just nfield=9.
	insertRow(db, 9, {
		...chain("sess_z"),
	});
	// handoff rooted + chain-closed.
	insertRow(db, 29, handoff("ho_a", "relay_ch_a", "wf_a"));
	// handoff rooted, chain missing -> skip: missingChain.
	insertRow(db, 29, handoff("ho_b", "relay_ch_missing", "wf_a"));
	// handoff unknown workflow -> skip: unknownWorkflow.
	insertRow(db, 29, handoff("ho_c", "relay_ch_a", "wf_ghost"));
	// nfield=29 distractor (c0 does NOT glob ho_*) -> proves the handoffs
	// predicate's c0 GLOB is load-bearing, not just nfield=29.
	insertRow(db, 29, {
		...handoff("sess_w", "relay_ch_a", "wf_a"),
	});
}

function fixtureSource(): ReturnType<typeof openDatabase> {
	const db = openDatabase(tmpPath("recovered.db"));
	fillFixtureSource(db);
	return db;
}

function fixtureSourcePath(): string {
	const db = fixtureSource();
	db.close();
	return db.name;
}

function freshTarget(): ReturnType<typeof openDatabase> {
	const db = openDatabase(tmpPath("state.db"));
	applyMigrations(db);
	return db;
}

// Build a migrated target on disk. `liveDaemon` inserts a broker_daemon row owned
// by this process (always alive); `userVersion` stamps a pre-migration version so
// the entrypoint must refuse without migrating.
function buildTargetPath(opts: { liveDaemon?: boolean; userVersion?: number }): string {
	const p = tmpPath("state.db");
	const db = openDatabase(p);
	applyMigrations(db);
	if (opts.liveDaemon) {
		// broker_daemon.collab_id has an enforced FK to collab — seed the parent.
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('collab_daemon', '/w', 'd', 'active', ?, ?)",
		).run(NOW, NOW);
		db.prepare(
			"INSERT INTO broker_daemon (collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at) VALUES ('collab_daemon', '127.0.0.1', 9999, ?, NULL, ?, ?)",
		).run(process.pid, NOW, NOW);
	}
	if (opts.userVersion !== undefined) {
		db.pragma(`user_version = ${opts.userVersion}`);
	}
	// Close checkpoints and drops the -wal so the on-disk baseline is stable.
	db.close();
	return p;
}

const FIXTURE_EXPECTATIONS = {
	raw: { workflows: 2, phases: 3, chains: 2, handoffs: 3 },
	distinct: { workflows: 1, phases: 3, chains: 2, handoffs: 3 },
	closureFloor: { phases: 1, chains: 1, handoffs: 1 },
};

// Every verification-tier abort must leave the target completely unwritten —
// no imported rows AND no collab tombstones (tombstones are written first,
// inside the same guarded transaction, so a stray tombstone would mean the
// abort ran too late).
function expectNoImportedRows(target: ReturnType<typeof openDatabase>): void {
	for (const table of [
		"collab",
		"workflows",
		"workflow_phases",
		"relay_chains",
		"relay_handoff",
	]) {
		expect(target.prepare(`SELECT COUNT(*) n FROM "${table}"`).get()).toMatchObject({
			n: 0,
		});
	}
}

// WAL-aware snapshot: the target runs in WAL mode, so a forbidden pre-guard write
// could land in state.db-wal while the primary file's hash stays unchanged.
// Snapshot primary + WAL, including WAL existence/absence.
function snapshotDbFiles(dbPath: string): { db: string; wal: string | null } {
	const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
	const walPath = `${dbPath}-wal`;
	return { db: hash(dbPath), wal: existsSync(walPath) ? hash(walPath) : null };
}

describe("runRecoveryImport", () => {
	let source: ReturnType<typeof openDatabase>;
	let target: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		source = fixtureSource();
		target = freshTarget();
	});

	afterEach(() => {
		source.close();
		target.close();
	});

	it("imports only the referentially closed graph and logs skips per reason", () => {
		const result = runRecoveryImport(source, target, FIXTURE_EXPECTATIONS, NOW);
		expect(result.imported).toEqual({
			workflows: 1,
			phases: 1,
			chains: 1,
			handoffs: 1,
			collabTombstones: 1,
		});
		expect(result.skipped.missingChain).toEqual({ phases: 1, handoffs: 1 });
		expect(result.skipped.unknownWorkflow).toEqual({ phases: 1, handoffs: 1 });
		expect(result.skipped.unreferencedChains).toBe(1);
		// no dangling phase->workflow edges
		expect(
			target
				.prepare(
					"SELECT COUNT(*) n FROM workflow_phases p LEFT JOIN workflows w ON w.workflow_id = p.workflow_id WHERE w.workflow_id IS NULL",
				)
				.get(),
		).toMatchObject({ n: 0 });
		// no dangling handoff->chain edges
		expect(
			target
				.prepare(
					"SELECT COUNT(*) n FROM relay_handoff h LEFT JOIN relay_chains ch ON ch.chain_id = h.chain_id WHERE h.chain_id IS NOT NULL AND ch.chain_id IS NULL",
				)
				.get(),
		).toMatchObject({ n: 0 });
		// tombstone parent is archived
		expect(
			target
				.prepare("SELECT archived_at FROM collab WHERE collab_id = ?")
				.get(TOMBSTONE_COLLAB_ID),
		).toMatchObject({ archived_at: expect.any(String) });
		// same-width distractors (session-shaped c0, one per predicate width) never
		// import — the per-table imported total of exactly 1 already implies this,
		// but assert their ids directly so a dropped GLOB predicate fails loudly.
		expect(
			target.prepare("SELECT 1 FROM workflows WHERE workflow_id = ?").get("sess_y"),
		).toBeUndefined();
		expect(
			target.prepare("SELECT 1 FROM relay_chains WHERE chain_id = ?").get("sess_z"),
		).toBeUndefined();
		expect(
			target.prepare("SELECT 1 FROM relay_handoff WHERE handoff_id = ?").get("sess_w"),
		).toBeUndefined();
	});

	it("is idempotent — second run imports nothing", () => {
		runRecoveryImport(source, target, FIXTURE_EXPECTATIONS, NOW);
		const second = runRecoveryImport(source, target, FIXTURE_EXPECTATIONS, NOW);
		expect(second.imported).toEqual({
			workflows: 0,
			phases: 0,
			chains: 0,
			handoffs: 0,
			collabTombstones: 0,
		});
	});

	it("aborts before writing on a raw-count mismatch", () => {
		const bad = {
			...FIXTURE_EXPECTATIONS,
			raw: { ...FIXTURE_EXPECTATIONS.raw, workflows: 99 },
		};
		expect(() => runRecoveryImport(source, target, bad, NOW)).toThrow(/count/i);
		expectNoImportedRows(target);
	});

	// Raw is a straight COUNT(*); distinct is COUNT(DISTINCT c0) after freelist
	// duplicates collapse. A raw-only check would miss a predicate that matches
	// the right row COUNT but the wrong SET of rows (e.g. dedup collapsing
	// differently than expected) — so distinct must be verified independently,
	// with raw left correct, to prove tier 2 actually gates on its own.
	it("aborts before writing on a distinct-count mismatch (raw correct, distinct wrong)", () => {
		const bad = {
			...FIXTURE_EXPECTATIONS,
			distinct: { ...FIXTURE_EXPECTATIONS.distinct, phases: 99 },
		};
		expect(() => runRecoveryImport(source, target, bad, NOW)).toThrow(/count/i);
		expectNoImportedRows(target);
	});

	// Tier 3 (closure floor) is checked AFTER both count tiers pass and BEFORE
	// any write — one case per floor field, each raising just that field's floor
	// one above what this fixture's referential closure actually achieves (1).
	it.each(["phases", "chains", "handoffs"] as const)(
		"aborts before writing when the %s closure count falls below its floor",
		(field) => {
			const bad = {
				...FIXTURE_EXPECTATIONS,
				closureFloor: {
					...FIXTURE_EXPECTATIONS.closureFloor,
					[field]: FIXTURE_EXPECTATIONS.closureFloor[field] + 1,
				},
			};
			expect(() => runRecoveryImport(source, target, bad, NOW)).toThrow(/count/i);
			expectNoImportedRows(target);
		},
	);

	it("rolls back the whole transaction on a malformed row", () => {
		// fixture variant: a valid-shape workflow with NULL created_at (c10) —
		// violates NOT NULL on insert. ON CONFLICT DO NOTHING (unlike INSERT OR
		// IGNORE) does not swallow it, so the whole transaction rolls back.
		const malformedSource = openDatabase(tmpPath("recovered.db"));
		malformedSource.exec(LOST_AND_FOUND_DDL);
		insertRow(malformedSource, 12, workflow({ c10: null }));
		const malformedExpectations = {
			raw: { workflows: 1, phases: 0, chains: 0, handoffs: 0 },
			distinct: { workflows: 1, phases: 0, chains: 0, handoffs: 0 },
			closureFloor: { phases: 0, chains: 0, handoffs: 0 },
		};
		expect(() =>
			runRecoveryImport(malformedSource, target, malformedExpectations, NOW),
		).toThrow();
		expect(target.prepare("SELECT COUNT(*) n FROM workflows").get()).toMatchObject({
			n: 0,
		});
		// the collab tombstone written earlier in the same transaction is gone too
		expect(target.prepare("SELECT COUNT(*) n FROM collab").get()).toMatchObject({
			n: 0,
		});
		malformedSource.close();
	});
});

describe("runRecoveryImportFromPaths", () => {
	it("refuses a daemon-held target BEFORE opening it writable — db AND wal byte-identical, even v7-shaped", () => {
		const sourcePath = fixtureSourcePath();
		const targetPath = buildTargetPath({ liveDaemon: true, userVersion: 7 });
		const before = snapshotDbFiles(targetPath);
		expect(() =>
			runRecoveryImportFromPaths(sourcePath, targetPath, FIXTURE_EXPECTATIONS, NOW),
		).toThrow(/daemon/i);
		expect(snapshotDbFiles(targetPath)).toEqual(before); // no writes to db OR wal; no wal created
	});

	it("aborts on a non-current-version target without migrating it — db AND wal byte-identical", () => {
		const sourcePath = fixtureSourcePath();
		const targetPath = buildTargetPath({ userVersion: 7 });
		const before = snapshotDbFiles(targetPath);
		expect(() =>
			runRecoveryImportFromPaths(sourcePath, targetPath, FIXTURE_EXPECTATIONS, NOW),
		).toThrow(/version/i);
		expect(snapshotDbFiles(targetPath)).toEqual(before);
	});

	it("imports through the entrypoint on a clean current-version target", () => {
		const sourcePath = fixtureSourcePath();
		const targetPath = buildTargetPath({});
		const result = runRecoveryImportFromPaths(
			sourcePath,
			targetPath,
			FIXTURE_EXPECTATIONS,
			NOW,
		);
		expect(result.imported).toEqual({
			workflows: 1,
			phases: 1,
			chains: 1,
			handoffs: 1,
			collabTombstones: 1,
		});
	});
});
