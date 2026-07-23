import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

function tmpDbPath(): string {
	return path.join(mkdtempSync(path.join(os.tmpdir(), "arch-")), "state.db");
}

function collabColumns(db: ReturnType<typeof openDatabase>): string[] {
	return (db.prepare("PRAGMA table_info(collab)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("collab.archived_at migration", () => {
	it("fresh DB has archived_at and user_version 8", () => {
		const db = openDatabase(tmpDbPath());
		applyMigrations(db);
		expect(CURRENT_SCHEMA_VERSION).toBe(8);
		expect(db.pragma("user_version", { simple: true })).toBe(8);
		expect(collabColumns(db)).toContain("archived_at");
	});

	it("true v7 DB (collab table WITHOUT archived_at, user_version 7) gains the column and keeps its rows", () => {
		// Build a genuine pre-upgrade fixture: raw DB, v7 collab shape (copied from
		// initMigrationSql, which has no archived_at), a seeded row, user_version 7.
		// A faulty implementation that only adds the column to the fresh-schema
		// CREATE would fail here, because CREATE IF NOT EXISTS skips this table.
		const db = openDatabase(tmpDbPath());
		// COMPLETE current-v7 collab shape — verbatim from a live v7 state.db
		// (`SELECT sql FROM sqlite_master WHERE name='collab'`): base columns plus
		// every PRAGMA-guard-added column that exists at v7. An incomplete fixture
		// could mask an archived_at ALTER accidentally tied to another column's
		// guard block.
		db.exec(`CREATE TABLE collab (
			collab_id TEXT PRIMARY KEY,
			workspace_root TEXT NOT NULL,
			display_name TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			orchestrator_enabled INTEGER NOT NULL DEFAULT 0,
			orchestrator_max_rounds INTEGER NOT NULL DEFAULT 3,
			workspace_id TEXT,
			stopped_at TEXT,
			launch_mode TEXT,
			tmux_session TEXT,
			relay_monitor_window_label TEXT,
			relay_monitor_pid INTEGER
		)`);
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('collab_v7', '/w', 'v7', 'stopped', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		).run();
		db.pragma("user_version = 7");
		applyMigrations(db);
		expect(db.pragma("user_version", { simple: true })).toBe(8);
		expect(collabColumns(db)).toContain("archived_at");
		const row = db.prepare("SELECT collab_id, archived_at FROM collab WHERE collab_id = 'collab_v7'").get() as { collab_id: string; archived_at: string | null };
		expect(row.collab_id).toBe("collab_v7"); // pre-existing row survived
		expect(row.archived_at).toBeNull();
	});
});
