import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	applyMigrations,
	CURRENT_SCHEMA_VERSION,
} from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "ver-"));
	return openDatabase(join(dir, "broker.sqlite"));
}

describe("apply-migrations: PRAGMA user_version", () => {
	it("sets user_version to CURRENT_SCHEMA_VERSION on a fresh DB", () => {
		const db = freshDb();
		applyMigrations(db);
		const v = db.pragma("user_version", { simple: true }) as number;
		expect(v).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("is a no-op when called twice", () => {
		const db = freshDb();
		applyMigrations(db);
		applyMigrations(db);
		const v = db.pragma("user_version", { simple: true }) as number;
		expect(v).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("still writes broker_state for backward compatibility", () => {
		const db = freshDb();
		applyMigrations(db);
		const row = db
			.prepare("SELECT schema_version, migrated FROM broker_state WHERE id = 1")
			.get() as { schema_version: number; migrated: number } | undefined;
		expect(row?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
		expect(row?.migrated).toBe(1);
	});

	it("a persisted older-version DB re-runs the body and gains new schema", () => {
		const db = freshDb();
		applyMigrations(db);
		// Simulate a DB created before the relay_monitor columns existed: drop
		// them and pin user_version back to an earlier schema.
		db.exec("ALTER TABLE collab DROP COLUMN relay_monitor_window_label");
		db.exec("ALTER TABLE collab DROP COLUMN relay_monitor_pid");
		db.pragma("user_version = 2");

		applyMigrations(db);

		const cols = (
			db.prepare("PRAGMA table_info(collab)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("relay_monitor_window_label");
		expect(cols).toContain("relay_monitor_pid");
		expect(db.pragma("user_version", { simple: true })).toBe(
			CURRENT_SCHEMA_VERSION,
		);
	});

	it("fresh DB has evaluator_status column in broker_daemon", () => {
		const db = freshDb();
		applyMigrations(db);
		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
	});

	it("upgrade from v3: broker_daemon without evaluator_status gains the column", () => {
		const db = freshDb();
		applyMigrations(db);
		// Simulate a v3 DB that lacked the column: drop it and roll back user_version.
		db.exec("ALTER TABLE broker_daemon DROP COLUMN evaluator_status");
		db.pragma("user_version = 3");

		applyMigrations(db);

		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
		expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("calling applyMigrations twice on a fresh DB is a no-op (idempotent)", () => {
		const db = freshDb();
		applyMigrations(db);
		expect(() => applyMigrations(db)).not.toThrow();
		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
	});

	it("fresh DB has the workflow_event_outbox table", () => {
		const db = freshDb();
		applyMigrations(db);
		const t = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_event_outbox'",
			)
			.get();
		expect(t).toBeDefined();
	});

	it("an existing v6 DB missing workflow_event_outbox gains it WITHOUT a version bump", () => {
		const db = freshDb();
		applyMigrations(db);
		// Simulate a v6 DB created before the outbox existed: drop only that table
		// and leave user_version at the CURRENT value, so the version-gated
		// runMigrationBody stays skipped on the next call.
		db.exec("DROP TABLE workflow_event_outbox");
		expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);

		applyMigrations(db); // must re-create the table ungated, despite user_version == CURRENT

		const t = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_event_outbox'",
			)
			.get();
		expect(t).toBeDefined();
		// The internal table must NOT have moved the contract version.
		expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
	});
});

describe("apply-migrations: one-active-collab enforcement", () => {
	function freshDb2() {
		const dir = mkdtempSync(join(tmpdir(), "ver-enf-"));
		return openDatabase(join(dir, "broker.sqlite"));
	}

	it("creates idx_collab_one_active_per_workspace on a fresh DB", () => {
		const db = freshDb2();
		applyMigrations(db);
		const row = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_collab_one_active_per_workspace'",
			)
			.get();
		expect(row).toBeDefined();
	});

	it("deduplicates seeded duplicate active collabs on applyMigrations", () => {
		const db = freshDb2();
		applyMigrations(db);
		// Simulate an incident-era DB that predates the index: drop it so the
		// duplicate active rows can be seeded (the unique index would otherwise
		// reject the second insert), then re-run applyMigrations as a daemon
		// restart would — enforcement dedups and re-creates the index.
		db.exec("DROP INDEX IF EXISTS idx_collab_one_active_per_workspace");
		for (const [id, created] of [
			["older", "2026-05-24T23:16:00Z"],
			["newer", "2026-05-24T23:30:00Z"],
		] as const) {
			db.prepare(
				"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, '/ws/ws1', ?, 'active', 'ws1', ?, ?, 1, 3)",
			).run(id, id, created, created);
		}
		db.prepare(
			"INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at) VALUES ('wf1', 'older', 'spec-driven-development', '/spec.md', '{}', 'running', 0, '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')",
		).run();

		applyMigrations(db);

		const active = (
			db
				.prepare(
					"SELECT collab_id FROM collab WHERE workspace_id = 'ws1' AND status = 'active'",
				)
				.all() as Array<{ collab_id: string }>
		).map((r) => r.collab_id);
		expect(active).toEqual(["older"]); // workflow-owning collab survives
	});

	function seedConflict(db: ReturnType<typeof openDatabase>) {
		// Pre-index state with two active collabs that each own a running workflow.
		db.exec("DROP INDEX IF EXISTS idx_collab_one_active_per_workspace");
		for (const [id, created] of [
			["a", "2026-05-24T23:16:00Z"],
			["b", "2026-05-24T23:30:00Z"],
		] as const) {
			db.prepare(
				"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, '/ws/ws1', ?, 'active', 'ws1', ?, ?, 1, 3)",
			).run(id, id, created, created);
		}
		for (const [wf, c] of [
			["wfa", "a"],
			["wfb", "b"],
		] as const) {
			db.prepare(
				"INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at) VALUES (?, ?, 'spec-driven-development', '/spec.md', '{}', 'running', 0, '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')",
			).run(wf, c);
		}
	}

	function indexPresent(db: ReturnType<typeof openDatabase>): boolean {
		return (
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_collab_one_active_per_workspace'",
				)
				.get() !== undefined
		);
	}

	it("startup does not crash on an irreducible conflict: both stay active, index skipped, warning emitted", () => {
		const db = freshDb2();
		applyMigrations(db); // schema + index
		seedConflict(db); // drops index, seeds two running-workflow collabs

		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// applyMigrations IS the daemon-startup path. It must not throw on an
			// irreducible duplicate (a CREATE UNIQUE INDEX would otherwise blow up
			// startup), must leave both running-workflow collabs active, and must
			// skip the table-wide index until the conflict is resolved.
			expect(() => applyMigrations(db)).not.toThrow();

			const active = (
				db
					.prepare(
						"SELECT collab_id FROM collab WHERE workspace_id = 'ws1' AND status = 'active' ORDER BY collab_id",
					)
					.all() as Array<{ collab_id: string }>
			).map((r) => r.collab_id);
			expect(active).toEqual(["a", "b"]); // neither running workflow orphaned
			expect(indexPresent(db)).toBe(false); // index skipped table-wide

			const warned = warnSpy.mock.calls.flat().join("\n");
			expect(warned).toContain("a");
			expect(warned).toContain("b");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("creates the index on a later applyMigrations once the operator resolves the conflict", () => {
		const db = freshDb2();
		applyMigrations(db);
		seedConflict(db);

		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		applyMigrations(db); // conflict → no index
		warnSpy.mockRestore();
		expect(indexPresent(db)).toBe(false);

		// Operator stops the extra collab manually, then the daemon restarts.
		db.prepare("UPDATE collab SET status = 'stopped' WHERE collab_id = 'b'").run();
		applyMigrations(db);

		expect(indexPresent(db)).toBe(true);
		const active = (
			db
				.prepare(
					"SELECT collab_id FROM collab WHERE workspace_id = 'ws1' AND status = 'active'",
				)
				.all() as Array<{ collab_id: string }>
		).map((r) => r.collab_id);
		expect(active).toEqual(["a"]);
	});
});
