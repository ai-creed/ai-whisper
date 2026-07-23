import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	LEDGER_TABLES,
	DIAGNOSTICS_TABLES,
	RUNTIME_TABLES,
	assertCollabTablesClassified,
	listCollabIdTables,
} from "../packages/broker/src/storage/repositories/collab-repository.ts";

// The drift-guard authority: tables with NO collab_id column that purge must
// still account for. A NEW no-collab_id table lands outside this set and fails
// the test, forcing a conscious decision (explicit child delete, special
// column, or intentional preservation). See spec §4.2.
const EXPECTED_NO_COLLAB_ID = new Set([
	"workflow_phases", // child-via-parent (workflows)
	"work_item_cancellation", // child-via-parent (work_item)
	"clipboard_capture_lease", // special column: holder_collab_id
	"workspace", // intentionally preserved
	"broker_state", // intentionally preserved
]);

function migratedDb() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "drift-"));
	const db = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(db);
	return db;
}

function hasCollabIdColumn(
	db: ReturnType<typeof openDatabase>,
	table: string,
): boolean {
	const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
		name: string;
	}>;
	return cols.some((c) => c.name === "collab_id");
}

describe("collab purge schema drift guard", () => {
	it("partitions the live schema exactly, excluding sqlite_% internals", () => {
		const db = migratedDb();
		// sqlite_sequence exists because several tables use AUTOINCREMENT — it must
		// be excluded from both partitions.
		const allTables = (
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all() as Array<{ name: string }>
		).map((r) => r.name);

		const withCollabId = new Set(
			allTables.filter((t) => hasCollabIdColumn(db, t)),
		);
		const noCollabId = new Set(
			allTables.filter((t) => !hasCollabIdColumn(db, t)),
		);

		// collab itself has a collab_id column but is deleted last (not by the loop).
		expect(withCollabId.has("collab")).toBe(true);

		// The loop set = (tables with collab_id) minus collab.
		const expectedLoop = new Set(
			[...withCollabId].filter((t) => t !== "collab"),
		);
		expect(new Set(listCollabIdTables(db))).toEqual(expectedLoop);

		// The no-collab_id set must equal the maintained allowlist exactly.
		expect(noCollabId).toEqual(EXPECTED_NO_COLLAB_ID);

		db.close();
	});
});

describe("ledger/runtime/diagnostics classification drift guard", () => {
	it("every collab_id table is in exactly one explicit class", () => {
		const db = migratedDb();
		const all = new Set([...listCollabIdTables(db), "collab"]);
		const ledger = new Set(LEDGER_TABLES);
		const diagnostics = new Set(DIAGNOSTICS_TABLES);
		const runtime = new Set(RUNTIME_TABLES);
		for (const table of all) {
			const memberships = [ledger.has(table), diagnostics.has(table), runtime.has(table)].filter(Boolean).length;
			expect(memberships, `table ${table} must be classified exactly once`).toBe(1);
		}
		// classified names must exist in the live schema (catches typos/renames);
		// workflow_phases is ledger-by-policy but child-via-parent (no collab_id).
		for (const table of [...ledger, ...diagnostics, ...runtime]) {
			if (table === "workflow_phases") continue;
			expect(all.has(table), `classified table ${table} must exist with collab_id`).toBe(true);
		}
		expect(() => assertCollabTablesClassified(db)).not.toThrow();
	});

	it("a newly added collab_id table fails the guard until deliberately classified", () => {
		const db = migratedDb();
		db.exec("CREATE TABLE zz_new_feature_state (collab_id TEXT NOT NULL, blob TEXT)");
		expect(() => assertCollabTablesClassified(db)).toThrow(/zz_new_feature_state/);
	});
});
