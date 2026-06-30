import type Database from "better-sqlite3";
import { collabSchema, type Collab } from "@ai-whisper/shared";

export function insertCollab(db: Database.Database, collab: Collab): void {
	db.prepare(
		`INSERT INTO collab (
      collab_id,
      workspace_root,
      display_name,
      status,
      created_at,
      updated_at,
      orchestrator_enabled,
      orchestrator_max_rounds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		collab.collabId,
		collab.workspaceRoot,
		collab.displayName,
		collab.status,
		collab.createdAt,
		collab.updatedAt,
		collab.orchestratorEnabled ? 1 : 0,
		collab.orchestratorMaxRounds,
	);
}

export type CollabListRow = {
	collabId: string;
	workspaceRoot: string;
	workspaceId: string | null;
	status: "active" | "stopped";
	tmuxSession: string | null;
};

/**
 * Every collab across every workspace and status. Purpose-built for purge —
 * intentionally NOT a reuse of the cwd-scoped `WHERE workspace_id = ?` resolver
 * lookup; an under- or over-narrow WHERE here is the exact failure prior
 * incidents warned about.
 */
export function listAllCollabs(db: Database.Database): CollabListRow[] {
	const rows = db
		.prepare(
			`SELECT collab_id, workspace_root, workspace_id, status, tmux_session
         FROM collab
        ORDER BY created_at`,
		)
		.all() as Array<{
		collab_id: string;
		workspace_root: string;
		workspace_id: string | null;
		status: "active" | "stopped";
		tmux_session: string | null;
	}>;
	return rows.map((r) => ({
		collabId: r.collab_id,
		workspaceRoot: r.workspace_root,
		workspaceId: r.workspace_id,
		status: r.status,
		tmuxSession: r.tmux_session,
	}));
}

function tableHasCollabIdColumn(db: Database.Database, table: string): boolean {
	const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
		name: string;
	}>;
	return cols.some((c) => c.name === "collab_id");
}

/**
 * Every non-internal table carrying a `collab_id` column, EXCLUDING `collab`
 * itself (which has a collab_id column but is deleted last by
 * deleteCollabCascade, not by the introspection loop). `sqlite_%` internal
 * tables are excluded — they are never collab-scoped and must never be touched.
 * Single source of truth shared by deleteCollabCascade and the drift-guard test.
 */
export function listCollabIdTables(db: Database.Database): string[] {
	const names = (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((r) => r.name);
	return names.filter(
		(name) => name !== "collab" && tableHasCollabIdColumn(db, name),
	);
}

/**
 * Total rows a collab owns across every scoped table: the introspected
 * collab_id tables, the two child-via-parent tables, the special lease column,
 * and the collab row itself. Display/JSON only.
 */
export function countCollabRows(
	db: Database.Database,
	collabId: string,
): number {
	let total = 0;
	for (const table of listCollabIdTables(db)) {
		total += (
			db
				.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE collab_id = ?`)
				.get(collabId) as { n: number }
		).n;
	}
	total += (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM workflow_phases WHERE workflow_id IN (SELECT workflow_id FROM workflows WHERE collab_id = ?)",
			)
			.get(collabId) as { n: number }
	).n;
	total += (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM work_item_cancellation WHERE work_item_id IN (SELECT work_item_id FROM work_item WHERE collab_id = ?)",
			)
			.get(collabId) as { n: number }
	).n;
	total += (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM clipboard_capture_lease WHERE holder_collab_id = ?",
			)
			.get(collabId) as { n: number }
	).n;
	total += (
		db
			.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id = ?")
			.get(collabId) as { n: number }
	).n;
	return total;
}

/**
 * Remove a collab and EVERY row it owns. Runtime FK cascade is OFF (spec §2.1),
 * so this is an explicit multi-table delete. The CALLER owns the transaction;
 * this function does not BEGIN/COMMIT. Order matters only so the child-via-parent
 * subqueries still see their parent rows before the loop removes the parents.
 */
export function deleteCollabCascade(
	db: Database.Database,
	collabId: string,
): void {
	// (2) child-via-parent first, while parents (workflows / work_item) still exist.
	db.prepare(
		"DELETE FROM workflow_phases WHERE workflow_id IN (SELECT workflow_id FROM workflows WHERE collab_id = ?)",
	).run(collabId);
	db.prepare(
		"DELETE FROM work_item_cancellation WHERE work_item_id IN (SELECT work_item_id FROM work_item WHERE collab_id = ?)",
	).run(collabId);
	// (1) every collab_id table (excludes collab + sqlite_%).
	for (const table of listCollabIdTables(db)) {
		db.prepare(`DELETE FROM "${table}" WHERE collab_id = ?`).run(collabId);
	}
	// (3) special column.
	db.prepare(
		"DELETE FROM clipboard_capture_lease WHERE holder_collab_id = ?",
	).run(collabId);
	// (4) the collab row, last.
	db.prepare("DELETE FROM collab WHERE collab_id = ?").run(collabId);
}

export function getCollab(
	db: Database.Database,
	collabId: string,
): Collab | null {
	const row = db
		.prepare(
			`SELECT collab_id, workspace_root, display_name, status, created_at, updated_at,
			        orchestrator_enabled, orchestrator_max_rounds
       FROM collab
       WHERE collab_id = ?`,
		)
		.get(collabId) as
		| {
				collab_id: string;
				workspace_root: string;
				display_name: string;
				status: "active" | "stopped";
				created_at: string;
				updated_at: string;
				orchestrator_enabled: number;
				orchestrator_max_rounds: number;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return collabSchema.parse({
		version: 1,
		collabId: row.collab_id,
		workspaceRoot: row.workspace_root,
		displayName: row.display_name,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		orchestratorEnabled: row.orchestrator_enabled === 1,
		orchestratorMaxRounds: row.orchestrator_max_rounds,
	});
}
