import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listAllWorkflowSummaries } from "../packages/broker/src/storage/repositories/dashboard-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-all-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}
function insCollab(db: ReturnType<typeof freshDb>, id: string, name = id) {
	db.prepare(
		`INSERT INTO collab (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
		 VALUES (?,?,?,'active','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z',0,3)`,
	).run(id, `/tmp/${id}`, name);
}
function insWorkflow(
	db: ReturnType<typeof freshDb>,
	w: { id: string; collab: string; type?: string; name?: string | null; status?: string; createdAt: string },
) {
	db.prepare(
		`INSERT INTO workflows (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,current_phase_index,halt_reason,workflow_context,created_at,updated_at)
		 VALUES (?,?,?,?, '/s', '{}', ?, 0, NULL, '{}', ?, ?)`,
	).run(w.id, w.collab, w.type ?? "deliberation", w.name ?? null, w.status ?? "done", w.createdAt, w.createdAt);
}
function insHandoff(
	db: ReturnType<typeof freshDb>,
	h: { id: string; collab: string; wf: string | null; createdAt: string; lastAct?: string },
) {
	db.prepare(
		`INSERT INTO relay_handoff (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,last_activity_at,workflow_id,phase_run_id,chain_id)
		 VALUES (?,?,?,?,?,'handed_back',?,?,?,NULL,NULL)`,
	).run(h.id, h.collab, "codex", "claude", "req", h.createdAt, h.lastAct ?? h.createdAt, h.wf);
}

describe("listAllWorkflowSummaries", () => {
	const NOW = "2026-05-20T01:00:00.000Z";
	const sinceMs = 30 * 60_000; // 30m window → cutoff 00:30:00

	it("emits one row per run with NO per-collab masking (2 runs on one collab → 2 rows)", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf_a", collab: "c1", status: "done", createdAt: "2026-05-20T00:40:00.000Z" });
		insWorkflow(db, { id: "wf_b", collab: "c1", status: "done", createdAt: "2026-05-20T00:50:00.000Z" });
		insHandoff(db, { id: "ha", collab: "c1", wf: "wf_a", createdAt: "2026-05-20T00:41:00.000Z", lastAct: "2026-05-20T00:45:00.000Z" });
		insHandoff(db, { id: "hb", collab: "c1", wf: "wf_b", createdAt: "2026-05-20T00:51:00.000Z", lastAct: "2026-05-20T00:55:00.000Z" });
		const rows = listAllWorkflowSummaries(db, { sinceMs, now: NOW });
		expect(rows.map((r) => r.workflowId)).toEqual(["wf_b", "wf_a"]); // created_at desc
		expect(rows.every((r) => r.collabId === "c1")).toBe(true);
	});

	it("respects the window cutoff (a run whose only activity predates the cutoff is excluded)", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf_old", collab: "c1", status: "done", createdAt: "2026-05-20T00:00:00.000Z" });
		insHandoff(db, { id: "h", collab: "c1", wf: "wf_old", createdAt: "2026-05-20T00:00:00.000Z", lastAct: "2026-05-20T00:05:00.000Z" });
		expect(listAllWorkflowSummaries(db, { sinceMs, now: NOW })).toEqual([]);
	});

	it("includes a running run with no handoffs (status eligibility)", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf_run", collab: "c1", status: "running", createdAt: "2026-05-20T00:00:00.000Z" });
		const rows = listAllWorkflowSummaries(db, { sinceMs, now: NOW });
		expect(rows.map((r) => r.workflowId)).toEqual(["wf_run"]);
		expect(rows[0]?.workflowStatus).toBe("running");
	});

	it("includes a PAUSED run regardless of window, and carries workflowStatus='paused'", () => {
		const db = freshDb();
		insCollab(db, "c1");
		// created long before the cutoff, no recent handoffs → only status keeps it in
		insWorkflow(db, { id: "wf_pause", collab: "c1", status: "paused", createdAt: "2026-05-19T00:00:00.000Z" });
		const rows = listAllWorkflowSummaries(db, { sinceMs, now: NOW });
		expect(rows.map((r) => r.workflowId)).toEqual(["wf_pause"]);
		expect(rows[0]?.workflowStatus).toBe("paused");
	});

	it("zero-handoff run appears under a wide window via the created_at fallback", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf_halt", collab: "c1", status: "halted", createdAt: "2026-05-20T00:00:00.000Z" });
		// narrow window → excluded
		expect(listAllWorkflowSummaries(db, { sinceMs, now: NOW })).toEqual([]);
		// wide window ('all' → MAX_SAFE_INTEGER) → included via created_at >= epoch
		const wide = listAllWorkflowSummaries(db, { sinceMs: Number.MAX_SAFE_INTEGER, now: NOW });
		expect(wide.map((r) => r.workflowId)).toEqual(["wf_halt"]);
	});

	it("does not emit manual (workflow-less) relay rows", () => {
		const db = freshDb();
		insCollab(db, "c_man");
		insHandoff(db, { id: "h", collab: "c_man", wf: null, createdAt: "2026-05-20T00:58:00.000Z" });
		expect(listAllWorkflowSummaries(db, { sinceMs, now: NOW })).toEqual([]);
	});
});
