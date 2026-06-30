import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	listAllCollabs,
	deleteCollabCascade,
	countCollabRows,
	listCollabIdTables,
} from "../packages/broker/src/storage/repositories/collab-repository.ts";

function freshDb() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "purge-"));
	const db = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(db);
	return { db, tmp };
}

function seedCollab(
	db: ReturnType<typeof openDatabase>,
	id: string,
	opts: {
		workspaceId?: string;
		workspaceRoot?: string;
		status?: string;
		tmuxSession?: string | null;
	} = {},
) {
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, tmux_session, created_at, updated_at)
     VALUES (?, ?, 't', ?, ?, ?, '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`,
	).run(
		id,
		opts.workspaceRoot ?? `/ws/${id}`,
		opts.status ?? "active",
		opts.workspaceId ?? `wsid-${id}`,
		opts.tmuxSession ?? null,
	);
}

// workflows + work_item are seeded explicitly (below) with known ids so their
// child rows can chain to them; the generic seeder skips them to avoid a PK clash.
const EXPLICITLY_SEEDED = new Set(["workflows", "work_item"]);

// Insert one row into EVERY collab_id table for `id`, driven by the live schema.
// NOT NULL columns with no default get a type-appropriate placeholder; integer
// primary keys are left to autoincrement. collab_id is always set to `id` (even
// where it is nullable) so the row is unambiguously scoped to this collab.
function seedRowInEveryScopedTable(
	db: ReturnType<typeof openDatabase>,
	id: string,
) {
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

// Explicit parent + child-via-parent + special rows with known ids so those
// non-introspected deletes (workflow_phases, work_item_cancellation, the lease)
// are proven too.
function seedExplicitOwnedRows(
	db: ReturnType<typeof openDatabase>,
	id: string,
) {
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
		"INSERT INTO work_item_cancellation (work_item_id, requested_at) VALUES (?, 't')",
	).run(`wi-${id}`);
	db.prepare(
		`INSERT OR REPLACE INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at)
     VALUES (1, ?, 123, 't')`,
	).run(id);
}

function rowsFor(
	db: ReturnType<typeof openDatabase>,
	table: string,
	id: string,
): number {
	return (
		db
			.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE collab_id = ?`)
			.get(id) as { n: number }
	).n;
}

describe("listAllCollabs", () => {
	it("returns every collab regardless of workspace or status", () => {
		const { db } = freshDb();
		seedCollab(db, "c1", { workspaceId: "wsA", status: "active" });
		seedCollab(db, "c2", {
			workspaceId: "wsB",
			status: "stopped",
			tmuxSession: "aiw-c2",
		});
		const rows = listAllCollabs(db);
		db.close();
		expect(rows.map((r) => r.collabId).sort()).toEqual(["c1", "c2"]);
		const c2 = rows.find((r) => r.collabId === "c2")!;
		expect(c2.status).toBe("stopped");
		expect(c2.workspaceId).toBe("wsB");
		expect(c2.tmuxSession).toBe("aiw-c2");
	});
});

describe("deleteCollabCascade", () => {
	it("leaves zero rows in EVERY live-schema collab-scoped table; other collabs intact", () => {
		const { db } = freshDb();
		seedCollab(db, "victim", { workspaceId: "wsA" });
		seedCollab(db, "survivor", { workspaceId: "wsB" });
		seedRowInEveryScopedTable(db, "victim");
		seedExplicitOwnedRows(db, "victim");
		// survivor owns rows that MUST survive the victim's wipe.
		db.prepare(
			"INSERT INTO recovery_state (collab_id, state, idle_after_recovery) VALUES ('survivor', 'normal', 0)",
		).run();

		// NON-VACUOUS GUARD: prove every collab_id table actually holds a victim row
		// BEFORE the wipe, so the post-wipe zero-rows assertion is meaningful for all
		// of them (a delete that omits a table would fail HERE if unseeded, or in the
		// post-wipe loop if seeded-but-not-deleted).
		for (const table of listCollabIdTables(db)) {
			expect(
				rowsFor(db, table, "victim"),
				`${table} should be seeded before the wipe`,
			).toBeGreaterThan(0);
		}
		expect(countCollabRows(db, "victim")).toBeGreaterThan(0);

		db.transaction(() => deleteCollabCascade(db, "victim")).immediate();

		// Zero victim rows across EVERY introspected scoped table.
		for (const table of listCollabIdTables(db)) {
			expect(
				rowsFor(db, table, "victim"),
				`${table} should have 0 victim rows`,
			).toBe(0);
		}
		// Child-via-parent + special + the collab row itself.
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM workflow_phases WHERE phase_run_id = 'ph-victim'",
					)
					.get() as { n: number }
			).n,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM work_item_cancellation WHERE work_item_id = 'wi-victim'",
					)
					.get() as { n: number }
			).n,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM clipboard_capture_lease WHERE holder_collab_id = 'victim'",
					)
					.get() as { n: number }
			).n,
		).toBe(0);
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM collab WHERE collab_id = 'victim'",
					)
					.get() as { n: number }
			).n,
		).toBe(0);
		expect(countCollabRows(db, "victim")).toBe(0);

		// Survivor untouched.
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM collab WHERE collab_id = 'survivor'",
					)
					.get() as { n: number }
			).n,
		).toBe(1);
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM recovery_state WHERE collab_id = 'survivor'",
					)
					.get() as { n: number }
			).n,
		).toBe(1);

		db.close();
	});
});
