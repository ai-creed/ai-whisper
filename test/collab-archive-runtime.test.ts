import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	archiveCollabRuntime,
	listCollabIdTables,
	DIAGNOSTICS_TABLES,
} from "../packages/broker/src/storage/repositories/collab-repository.ts";

// Row-seeding helpers below are copied (not imported) from
// test/collab-purge-cascade.test.ts per the run-ledger task-3 ambiguity
// resolution: the fixtures are similar enough to model on, but not similar
// enough (relay_chains needs concrete field values here) to share cleanly.

function freshDb() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "archive-"));
	const db = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(db);
	return { db, tmp };
}

function seedCollab(db: ReturnType<typeof openDatabase>, id: string) {
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 't', 'active', ?, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`,
	).run(id, `/ws/${id}`, `wsid-${id}`);
}

// workflows / work_item / relay_chains are seeded explicitly (below) with
// known ids and, for relay_chains, concrete field values the second test
// asserts on — the generic seeder skips them to avoid clobbering those.
const EXPLICITLY_SEEDED = new Set(["workflows", "work_item", "relay_chains"]);

// Insert one row into every OTHER collab_id table, driven by the live schema.
// NOT NULL columns with no default get a type-appropriate placeholder; integer
// primary keys are left to autoincrement. collab_id is always set to `id`
// (even where it is nullable) so the row is unambiguously scoped to this collab.
// This is what seeds all three DIAGNOSTICS_TABLES rows for free, since they
// carry a collab_id column too.
function seedRowInEveryScopedTable(db: ReturnType<typeof openDatabase>, id: string) {
	for (const table of listCollabIdTables(db)) {
		if (EXPLICITLY_SEEDED.has(table)) continue;
		const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
			name: string;
			type: string;
			notnull: number;
			dflt_value: unknown;
			pk: number;
		}>;
		const names: string[] = [];
		const values: unknown[] = [];
		for (const col of cols) {
			if (col.name === "collab_id") {
				names.push(col.name);
				values.push(id);
				continue;
			}
			const isIntPk = col.pk > 0 && /INT/i.test(col.type);
			if (isIntPk) continue; // autoincrement / rowid
			if (col.notnull === 1 && col.dflt_value === null) {
				names.push(col.name);
				values.push(/INT|REAL|NUM|DOUB|FLOA/i.test(col.type) ? 0 : "x");
			}
		}
		db.prepare(
			`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
		).run(...values);
	}
}

// Explicit parent + child-via-parent rows with known ids, plus a relay_chains
// row with concrete field values so the "chain fields survive" test has
// something meaningful to assert against.
function seedExplicitOwnedRows(db: ReturnType<typeof openDatabase>, id: string) {
	db.prepare(
		`INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at)
     VALUES (?, ?, 'spec-driven-development', '/s', '{}', 'halted', 0, 't', 't')`,
	).run(`wf-${id}`, id);
	db.prepare(
		`INSERT INTO workflow_phases (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at)
     VALUES (?, ?, 0, 'p', 'c', 't')`,
	).run(`ph-${id}`, `wf-${id}`);
	db.prepare(
		`INSERT INTO work_item (work_item_id, thread_id, collab_id, turn_index, sender_session_id, target_session_id, requested_action, instruction, context_packet_json, delivery_state, artifact_manifest_ids_json, created_at)
     VALUES (?, 'th', ?, 0, 's', 't', 'a', 'i', '{}', 'pending', '[]', 't')`,
	).run(`wi-${id}`, id);
	db.prepare(
		`INSERT INTO relay_chains (chain_id, collab_id, status, current_round, max_rounds, terminal_handoff_id, terminal_reason, created_at, updated_at)
     VALUES (?, ?, 'escalated', 5, 5, NULL, 'max_rounds_exceeded', 't', 't')`,
	).run(`ch-${id}`, id);
}

function countRows(db: ReturnType<typeof openDatabase>, table: string, id: string): number {
	return (
		db
			.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE collab_id = ?`)
			.get(id) as { n: number }
	).n;
}

function phaseCount(db: ReturnType<typeof openDatabase>, workflowId: string): number {
	return (
		db
			.prepare("SELECT COUNT(*) AS n FROM workflow_phases WHERE workflow_id = ?")
			.get(workflowId) as { n: number }
	).n;
}

function seedFixture(collabId: string) {
	const { db } = freshDb();
	seedCollab(db, collabId);
	seedRowInEveryScopedTable(db, collabId);
	seedExplicitOwnedRows(db, collabId);
	return db;
}

describe("archiveCollabRuntime", () => {
	it("deletes runtime rows, keeps all five ledger tables, stamps archived_at", () => {
		const collabId = "victim";
		const db = seedFixture(collabId);

		archiveCollabRuntime(db, collabId, "2026-07-23T00:00:00.000Z");

		for (const t of ["workflows", "relay_chains", "relay_handoff"]) {
			expect(countRows(db, t, collabId)).toBeGreaterThan(0);
		}
		expect(phaseCount(db, `wf-${collabId}`)).toBeGreaterThan(0); // workflow_phases via parent

		expect(countRows(db, "session", collabId)).toBe(0); // runtime gone
		expect(countRows(db, "broker_daemon", collabId)).toBe(0);

		for (const t of DIAGNOSTICS_TABLES) {
			expect(countRows(db, t, collabId)).toBeGreaterThan(0); // archive never touches diagnostics
		}

		const row = db
			.prepare("SELECT archived_at, status FROM collab WHERE collab_id = ?")
			.get(collabId) as { archived_at: string; status: string };
		expect(row.archived_at).toBe("2026-07-23T00:00:00.000Z");
		expect(row.status).toBe("stopped"); // frees the one-active-per-workspace slot

		db.close();
	});

	it("preserves chain status, rounds, and terminal reason for archived cards", () => {
		const collabId = "victim2";
		const db = seedFixture(collabId);
		const now = "2026-07-23T00:00:00.000Z";

		archiveCollabRuntime(db, collabId, now);

		const chain = db
			.prepare(
				"SELECT status, current_round, max_rounds, terminal_reason FROM relay_chains WHERE collab_id = ?",
			)
			.get(collabId);
		expect(chain).toMatchObject({
			status: "escalated",
			current_round: 5,
			max_rounds: 5,
			terminal_reason: "max_rounds_exceeded",
		});

		db.close();
	});
});
