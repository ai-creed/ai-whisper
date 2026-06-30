import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { findNonTerminalWorkflow } from "../packages/broker/src/storage/repositories/workflow-repository.ts";

function db() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "purge-wf-"));
	const d = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(d);
	return d;
}

function seedWorkflow(
	d: ReturnType<typeof openDatabase>,
	collabId: string,
	wfId: string,
	status: string,
	createdAt: string,
) {
	d.prepare(
		`INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at)
     VALUES (?, ?, 'spec-driven-development', '/s', '{}', ?, 0, ?, ?)`,
	).run(wfId, collabId, status, createdAt, createdAt);
}

describe("findNonTerminalWorkflow", () => {
	it("returns null when all workflows are done/canceled", () => {
		const d = db();
		seedWorkflow(d, "c1", "w1", "done", "2026-06-30T00:00:00Z");
		seedWorkflow(d, "c1", "w2", "canceled", "2026-06-30T00:00:01Z");
		expect(findNonTerminalWorkflow(d, "c1")).toBeNull();
		d.close();
	});

	it("returns the most recent non-terminal workflow", () => {
		const d = db();
		seedWorkflow(d, "c1", "w1", "halted", "2026-06-30T00:00:00Z");
		seedWorkflow(d, "c1", "w2", "paused", "2026-06-30T00:00:05Z");
		expect(findNonTerminalWorkflow(d, "c1")).toEqual({
			workflowId: "w2",
			status: "paused",
		});
		d.close();
	});
});
