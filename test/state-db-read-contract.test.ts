import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	applyMigrations,
	CURRENT_SCHEMA_VERSION,
	EVENT_PROTOCOL_VERSION,
} from "@ai-whisper/broker";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

// LITERAL mirror of docs/state-db-read-contract.md §3. Intentionally NOT derived
// from repository code: a schema rename/drop without a contract+version bump
// must fail here.
const CONTRACT: Record<string, string[]> = {
	collab: ["collab_id", "workspace_root", "display_name", "status", "archived_at"],
	broker_daemon: ["collab_id", "host", "port", "pid", "last_heartbeat_at"],
	session_binding: ["collab_id", "agent_type", "binding_state"],
	workflows: [
		"workflow_id",
		"collab_id",
		"workflow_type",
		"status",
		"current_phase_index",
		"halt_reason",
		"updated_at",
	],
	workflow_phases: [
		"phase_run_id",
		"workflow_id",
		"phase_index",
		"phase_name",
		"chain_id",
		"started_at",
		"ended_at",
		"outcome",
	],
	relay_chains: [
		"chain_id",
		"collab_id",
		"status",
		"current_round",
		"max_rounds",
		"terminal_reason",
		"updated_at",
	],
	relay_handoff: [
		"handoff_id",
		"chain_id",
		"sender_agent",
		"target_agent",
		"request_text",
		"handback_text",
		"orchestrator_verdict",
		"round_number",
		"created_at",
	],
};

const DOC = readFileSync(
	join(process.cwd(), "docs/state-db-read-contract.md"),
	"utf8",
);

function freshMigratedDb() {
	const dir = mkdtempSync(join(tmpdir(), "contract-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

describe("state-db read contract", () => {
	it("doc's contract-version marker matches CURRENT_SCHEMA_VERSION", () => {
		const m = /<!--\s*contract-version:\s*(\d+)\s*-->/.exec(DOC);
		expect(m, "missing <!-- contract-version: N --> marker").not.toBeNull();
		expect(Number(m![1])).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("doc's protocol-version marker matches EVENT_PROTOCOL_VERSION", () => {
		const m = /<!--\s*protocol-version:\s*(\S+?)\s*-->/.exec(DOC);
		expect(m, "missing <!-- protocol-version: X --> marker").not.toBeNull();
		expect(m![1]).toBe(EVENT_PROTOCOL_VERSION);
	});

	it("migrated DB reports user_version === CURRENT_SCHEMA_VERSION", () => {
		const db = freshMigratedDb();
		expect(db.pragma("user_version", { simple: true })).toBe(
			CURRENT_SCHEMA_VERSION,
		);
	});

	it("every contract table/column exists in the migrated schema", () => {
		const db = freshMigratedDb();
		for (const [table, cols] of Object.entries(CONTRACT)) {
			const present = (
				db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
			expect(present.length, `table ${table} does not exist`).toBeGreaterThan(0);
			for (const col of cols) {
				expect(present, `${table}.${col} missing — schema drift`).toContain(col);
			}
		}
	});

	it("the doc names every contract table and column (doc/test alignment)", () => {
		for (const [table, cols] of Object.entries(CONTRACT)) {
			expect(DOC, `doc omits table ${table}`).toContain(`\`${table}\``);
			for (const col of cols) {
				expect(DOC, `doc omits ${table}.${col}`).toContain(`\`${col}\``);
			}
		}
	});
});
