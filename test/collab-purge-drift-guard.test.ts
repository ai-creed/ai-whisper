import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listCollabIdTables } from "../packages/broker/src/storage/repositories/collab-repository.ts";

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
