import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertDuoRoll,
	getDuoRoll,
	upsertDuoAssignment,
	getDuoAssignment,
	listDuoAssignments,
	deleteDuoAssignment,
	type DuoRollRecord,
	type DuoAssignmentRecord,
} from "../packages/broker/src/storage/repositories/duo-assignment-repository.ts";
import { deleteCollabCascade } from "../packages/broker/src/storage/repositories/collab-repository.ts";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function bootstrap() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4901,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('c1','/tmp','c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	return { broker, db };
}

const sampleRoll: DuoRollRecord = {
	collabId: "c1",
	duoId: "sherlock-watson",
	slots: [
		{ characterId: "sherlock", characterName: "Sherlock", role: "reviewer" },
		{ characterId: "watson", characterName: "Watson", role: "implementer" },
	],
	rolledAt: "2026-04-21T00:00:00Z",
};

describe("duo-assignment-repository", () => {
	it("round-trips a duo_roll insert/read (both slots, ids + names + roles)", () => {
		const { db } = bootstrap();
		insertDuoRoll(db, sampleRoll);
		expect(getDuoRoll(db, "c1")).toEqual(sampleRoll);
	});

	it("getDuoRoll returns null when absent", () => {
		const { db } = bootstrap();
		expect(getDuoRoll(db, "c1")).toBeNull();
	});

	it("rejects a second insertDuoRoll for the same collab (PK conflict)", () => {
		const { db } = bootstrap();
		insertDuoRoll(db, sampleRoll);
		expect(() =>
			insertDuoRoll(db, { ...sampleRoll, duoId: "batman-robin" }),
		).toThrow();
		// The original roll is untouched by the rejected second insert.
		expect(getDuoRoll(db, "c1")?.duoId).toBe("sherlock-watson");
	});

	it("round-trips a duo_assignment insert/read", () => {
		const { db } = bootstrap();
		const row: DuoAssignmentRecord = {
			collabId: "c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "reviewer",
			assignedAt: "2026-04-21T00:00:00Z",
		};
		upsertDuoAssignment(db, row);
		expect(getDuoAssignment(db, "c1", "codex")).toEqual(row);
	});

	it("getDuoAssignment returns null when absent", () => {
		const { db } = bootstrap();
		expect(getDuoAssignment(db, "c1", "codex")).toBeNull();
	});

	it("upsertDuoAssignment REPLACES on conflict (same collabId/agentType)", () => {
		const { db } = bootstrap();
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "reviewer",
			assignedAt: "2026-04-21T00:00:00Z",
		});
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "codex",
			duoId: "batman-robin",
			characterId: "batman",
			characterName: "Batman",
			role: "implementer",
			assignedAt: "2026-04-21T00:00:05Z",
		});
		const row = getDuoAssignment(db, "c1", "codex");
		expect(row?.characterId).toBe("batman");
		expect(row?.duoId).toBe("batman-robin");
		expect(listDuoAssignments(db, "c1")).toHaveLength(1);
	});

	it("listDuoAssignments returns every claimed row for the collab", () => {
		const { db } = bootstrap();
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "reviewer",
			assignedAt: "2026-04-21T00:00:00Z",
		});
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "claude",
			duoId: "sherlock-watson",
			characterId: "watson",
			characterName: "Watson",
			role: "implementer",
			assignedAt: "2026-04-21T00:00:01Z",
		});
		const rows = listDuoAssignments(db, "c1");
		expect(rows.map((r) => r.agentType).sort()).toEqual(["claude", "codex"]);
	});

	it("deleteDuoAssignment removes the row and is a no-op when absent", () => {
		const { db } = bootstrap();
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "reviewer",
			assignedAt: "2026-04-21T00:00:00Z",
		});
		expect(deleteDuoAssignment(db, "c1", "codex")).toBe(1);
		expect(getDuoAssignment(db, "c1", "codex")).toBeNull();
		expect(deleteDuoAssignment(db, "c1", "codex")).toBe(0);
	});

	it("deleteCollabCascade removes both duo_roll and duo_assignment rows for the collab", () => {
		const { db } = bootstrap();
		insertDuoRoll(db, sampleRoll);
		upsertDuoAssignment(db, {
			collabId: "c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "reviewer",
			assignedAt: "2026-04-21T00:00:00Z",
		});

		db.transaction(() => deleteCollabCascade(db, "c1")).immediate();

		expect(getDuoRoll(db, "c1")).toBeNull();
		expect(listDuoAssignments(db, "c1")).toHaveLength(0);
	});

	it("migration: fresh DB has both duo tables and user_version === 7", () => {
		const dir = mkdtempSync(join(tmpdir(), "duo-migration-"));
		const db = openDatabase(join(dir, "state.db"));
		applyMigrations(db);

		expect(CURRENT_SCHEMA_VERSION).toBe(7);
		expect(db.pragma("user_version", { simple: true })).toBe(7);

		const tableNames = (
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('duo_roll', 'duo_assignment')",
				)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(tableNames.sort()).toEqual(["duo_assignment", "duo_roll"]);
		db.close();
	});
});
