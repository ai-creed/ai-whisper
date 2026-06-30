import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { findNonTerminalWorkflow } from "../packages/broker/src/storage/repositories/workflow-repository.ts";
import { listAllCollabs } from "../packages/broker/src/storage/repositories/collab-repository.ts";
import { classifyCollab } from "../packages/cli/src/commands/collab/purge.ts";

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

function seedCollabRow(
	d: ReturnType<typeof openDatabase>,
	id: string,
	status = "active",
) {
	d.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 't', ?, ?, 't', 't')`,
	).run(id, `/ws/${id}`, status, `wsid-${id}`);
}
function seedDaemon(
	d: ReturnType<typeof openDatabase>,
	id: string,
	pid: number | null,
) {
	d.prepare(
		`INSERT INTO broker_daemon (collab_id, host, port, pid, started_at, last_heartbeat_at)
     VALUES (?, '127.0.0.1', 0, ?, 't', 't')`,
	).run(id, pid);
}
function seedAttachment(
	d: ReturnType<typeof openDatabase>,
	id: string,
	pid: number | null,
) {
	d.prepare(
		`INSERT INTO session_attachment (collab_id, agent_type, attachment_kind, pid, attached_at)
     VALUES (?, 'codex', 'mounted', ?, 't')`,
	).run(id, pid);
}
function only(d: ReturnType<typeof openDatabase>, id: string) {
	return listAllCollabs(d).find((c) => c.collabId === id)!;
}

const DEAD = () => false;
const ALIVE = () => true;

describe("classifyCollab", () => {
	it("LIVE when the daemon pid is alive", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		const c = classifyCollab(d, only(d, "c1"), ALIVE);
		expect(c.bucket).toBe("live");
		expect(c.reason).toBe("live-daemon");
		d.close();
	});

	it("LIVE when any mounted agent pid is alive (daemon dead)", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		seedAttachment(d, "c1", 1000);
		const c = classifyCollab(d, only(d, "c1"), (pid) => pid === 1000);
		expect(c.bucket).toBe("live");
		expect(c.reason).toBe("live-mount");
		d.close();
	});

	it("PROTECTED when dead but a non-terminal workflow exists", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		seedWorkflow(d, "c1", "w1", "halted", "2026-06-30T00:00:00Z");
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("protected");
		expect(c.workflowId).toBe("w1");
		expect(c.workflowStatus).toBe("halted");
		d.close();
	});

	it("STALE when dead with no protecting workflow (active-but-dead-after-restart)", () => {
		const d = db();
		seedCollabRow(d, "c1", "active");
		seedDaemon(d, "c1", 999);
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("stale");
		expect(c.reason).toBe("dead-daemon");
		d.close();
	});

	it("STALE for a stopped leftover", () => {
		const d = db();
		seedCollabRow(d, "c1", "stopped");
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("stale");
		expect(c.reason).toBe("stopped");
		d.close();
	});
});

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
