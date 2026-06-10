import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	listActiveCollabSummaries,
	listRunCostRows,
} from "../packages/broker/src/storage/repositories/dashboard-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-dash-"));
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
function insWorkflow(db: ReturnType<typeof freshDb>, w: { id: string; collab: string; type?: string; name?: string | null; status?: string; phaseIdx?: number; createdAt?: string; specPath?: string }) {
	db.prepare(
		`INSERT INTO workflows (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,current_phase_index,halt_reason,workflow_context,created_at,updated_at)
		 VALUES (?,?,?,?, ?, '{}', ?, ?, NULL, '{}', ?, ?)`,
	).run(w.id, w.collab, w.type ?? "spec-driven-development", w.name ?? null, w.specPath ?? "/s", w.status ?? "running", w.phaseIdx ?? 1, w.createdAt ?? "2026-05-20T00:01:00.000Z", w.createdAt ?? "2026-05-20T00:01:00.000Z");
}
function insPhase(db: ReturnType<typeof freshDb>, p: { id: string; wf: string; idx: number; name: string; chain: string; started: string; ended?: string | null; outcome?: string | null }) {
	db.prepare(
		`INSERT INTO workflow_phases (phase_run_id,workflow_id,phase_index,phase_name,chain_id,started_at,ended_at,outcome)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(p.id, p.wf, p.idx, p.name, p.chain, p.started, p.ended ?? null, p.outcome ?? null);
}
function insChain(db: ReturnType<typeof freshDb>, c: { id: string; collab: string; status?: string; round?: number; max?: number }) {
	db.prepare(
		`INSERT INTO relay_chains (chain_id,collab_id,status,current_round,max_rounds,terminal_handoff_id,terminal_reason,created_at,updated_at)
		 VALUES (?,?,?,?,?,NULL,NULL,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z')`,
	).run(c.id, c.collab, c.status ?? "active", c.round ?? 1, c.max ?? 5);
}
function insHandoff(db: ReturnType<typeof freshDb>, h: { id: string; collab: string; wf?: string | null; phase?: string | null; chain?: string | null; createdAt: string; lastAct?: string; status?: string }) {
	db.prepare(
		`INSERT INTO relay_handoff (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,last_activity_at,workflow_id,phase_run_id,chain_id)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
	).run(h.id, h.collab, "codex", "claude", "req", h.status ?? "handed_back", h.createdAt, h.lastAct ?? h.createdAt, h.wf ?? null, h.phase ?? null, h.chain ?? null);
}

describe("listActiveCollabSummaries", () => {
	const NOW = "2026-05-20T01:00:00.000Z";
	const sinceMs = 30 * 60_000;

	it("resolves a running workflow run, recency-filters, and labels", () => {
		const db = freshDb();
		insCollab(db, "c_run", "Runner");
		insWorkflow(db, { id: "wf1", collab: "c_run", name: "oauth", phaseIdx: 1 });
		insChain(db, { id: "ch1", collab: "c_run", status: "active", round: 3, max: 5 });
		insPhase(db, { id: "pr1", wf: "wf1", idx: 1, name: "plan-writing", chain: "ch1", started: "2026-05-20T00:50:00.000Z", ended: null });
		insHandoff(db, { id: "h1", collab: "c_run", wf: "wf1", phase: "pr1", chain: "ch1", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:30.000Z" });
		insCollab(db, "c_old");
		insHandoff(db, { id: "hx", collab: "c_old", createdAt: "2026-05-19T23:00:00.000Z", lastAct: "2026-05-19T23:00:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows.map((r) => r.collabId)).toEqual(["c_run"]);
		expect(rows[0]).toMatchObject({
			collabId: "c_run", label: "oauth", workflowId: "wf1",
			workflowType: "spec-driven-development", workflowStatus: "running",
			currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
			currentRound: 3, maxRounds: 5, chainStatus: "active",
			lastActivityAt: "2026-05-20T00:59:30.000Z",
		});
	});

	it("manual-relay collab (no workflow) appears with null workflow fields", () => {
		const db = freshDb();
		insCollab(db, "c_man", "Manual");
		insHandoff(db, { id: "h1", collab: "c_man", createdAt: "2026-05-20T00:58:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });
		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]).toMatchObject({
			collabId: "c_man", label: "Manual", workflowId: null, workflowType: null,
			workflowStatus: null, currentPhaseRunId: null, chainStatus: null,
		});
	});

	it("picks the running workflow over an older terminal one", () => {
		const db = freshDb();
		insCollab(db, "c2");
		insWorkflow(db, { id: "old", collab: "c2", status: "done", createdAt: "2026-05-20T00:00:30.000Z" });
		insWorkflow(db, { id: "new", collab: "c2", status: "running", createdAt: "2026-05-20T00:40:00.000Z" });
		insHandoff(db, { id: "h", collab: "c2", wf: "new", createdAt: "2026-05-20T00:50:00.000Z", lastAct: "2026-05-20T00:59:00.000Z" });
		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]?.workflowId).toBe("new");
		expect(rows[0]?.workflowStatus).toBe("running");
	});

	it("REGRESSION: re-read reflects an in-place status mutation (no cursor staleness)", () => {
		const db = freshDb();
		insCollab(db, "c3");
		insWorkflow(db, { id: "wf", collab: "c3", status: "running" });
		insHandoff(db, { id: "h", collab: "c3", wf: "wf", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:55:00.000Z" });
		expect(listActiveCollabSummaries(db, { sinceMs, now: NOW })[0]?.workflowStatus).toBe("running");
		db.prepare("UPDATE workflows SET status='halted' WHERE workflow_id='wf'").run();
		db.prepare("UPDATE relay_handoff SET last_activity_at='2026-05-20T00:59:50.000Z' WHERE handoff_id='h'").run();
		const after = listActiveCollabSummaries(db, { sinceMs, now: NOW })[0];
		expect(after?.workflowStatus).toBe("halted");
		expect(after?.lastActivityAt).toBe("2026-05-20T00:59:50.000Z");
	});

	it("returns [] when nothing is recently active", () => {
		const db = freshDb();
		expect(listActiveCollabSummaries(db, { sinceMs, now: NOW })).toEqual([]);
	});

	// A single collab can have multiple workflow runs over time plus manual
	// relays. `lastActivityAt` drives Wall liveness/stuck and the sort
	// tie-break (`actKey`). It must reflect the RESOLVED RUN's activity, not
	// a cross-run MAX — otherwise a sibling run's activity keeps a stale
	// pane looking fresh and sorts it to the top.
	it("lastActivityAt scopes to the resolved workflow run (sibling-run activity does NOT leak)", () => {
		const db = freshDb();
		insCollab(db, "c_mix");
		insWorkflow(db, { id: "wf_a", collab: "c_mix", status: "running", phaseIdx: 0, createdAt: "2026-05-20T00:30:00.000Z" });
		insWorkflow(db, { id: "wf_b", collab: "c_mix", status: "done", createdAt: "2026-05-20T00:00:00.000Z" });
		// wf_a's latest activity is OLDER than wf_b's and OLDER than a manual relay.
		insHandoff(db, { id: "h_a1", collab: "c_mix", wf: "wf_a", createdAt: "2026-05-20T00:50:00.000Z", lastAct: "2026-05-20T00:50:00.000Z" });
		insHandoff(db, { id: "h_b1", collab: "c_mix", wf: "wf_b", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });
		insHandoff(db, { id: "h_man", collab: "c_mix", createdAt: "2026-05-20T00:56:00.000Z", lastAct: "2026-05-20T00:56:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]?.workflowId).toBe("wf_a"); // resolver picks running
		// MUST be wf_a's latest ("00:50:00"), NOT the cross-run MAX ("00:58:00").
		expect(rows[0]?.lastActivityAt).toBe("2026-05-20T00:50:00.000Z");
	});

	it("backfills finished-workflow collabs to a floor of 3 when fewer are recently active (newest-first)", () => {
		const db = freshDb();
		// One recently-active running collab (eligible).
		insCollab(db, "c_active");
		insWorkflow(db, { id: "wf_a", collab: "c_active", status: "running", createdAt: "2026-05-20T00:40:00.000Z" });
		insHandoff(db, { id: "ha", collab: "c_active", wf: "wf_a", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:00.000Z" });
		// Three FINISHED collabs whose activity is well outside the recency window —
		// so they are NOT eligible on their own. Distinct created_at for ordering.
		insCollab(db, "c_done");
		insWorkflow(db, { id: "wf_d", collab: "c_done", status: "done", createdAt: "2026-05-19T10:00:00.000Z" });
		insCollab(db, "c_halt");
		insWorkflow(db, { id: "wf_h", collab: "c_halt", status: "halted", createdAt: "2026-05-19T12:00:00.000Z" });
		insCollab(db, "c_cancel");
		insWorkflow(db, { id: "wf_c", collab: "c_cancel", status: "canceled", createdAt: "2026-05-19T11:00:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const ids = rows.map((r) => r.collabId);
		// Floor of 3: the active one + the two NEWEST finished (halt@12:00, cancel@11:00).
		expect(rows).toHaveLength(3);
		expect(ids).toContain("c_active");
		expect(ids).toContain("c_halt");
		expect(ids).toContain("c_cancel");
		expect(ids).not.toContain("c_done"); // oldest finished — beyond the floor
		// Backfilled summaries are fully projected (status reflected).
		expect(rows.find((r) => r.collabId === "c_halt")?.workflowStatus).toBe("halted");
	});

	it("does NOT backfill when 3+ collabs are already recently active", () => {
		const db = freshDb();
		for (const id of ["a1", "a2", "a3"]) {
			insCollab(db, id);
			insHandoff(db, { id: `h_${id}`, collab: id, createdAt: "2026-05-20T00:58:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });
		}
		// A finished-only collab that must stay OFF when the floor is already met.
		insCollab(db, "c_finished_extra");
		insWorkflow(db, { id: "wf_x", collab: "c_finished_extra", status: "done", createdAt: "2026-05-19T09:00:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.collabId)).not.toContain("c_finished_extra");
	});

	it("manual-relay lastActivityAt scopes to workflow_id IS NULL only (tagged handoffs do NOT leak)", () => {
		const db = freshDb();
		// No workflow records on this collab → resolver picks manual (null wf).
		insCollab(db, "c_man_mix");
		insHandoff(db, { id: "h_man1", collab: "c_man_mix", createdAt: "2026-05-20T00:50:00.000Z", lastAct: "2026-05-20T00:50:00.000Z" });
		// A tagged sibling handoff (orphan workflow_id) on the same collab — must
		// not bump the manual summary's lastActivityAt.
		insHandoff(db, { id: "h_orphan", collab: "c_man_mix", wf: "wf_orphan", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]?.workflowId).toBe(null);
		expect(rows[0]?.lastActivityAt).toBe("2026-05-20T00:50:00.000Z");
	});

	it("projects workflowCreatedAt from the joined workflow row", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, {
			id: "wf1",
			collab: "c1",
			type: "spec-driven-development",
			name: "demo",
			status: "running",
			createdAt: "2026-05-28T01:02:03.000Z",
		});
		insHandoff(db, {
			id: "h1",
			collab: "c1",
			wf: "wf1",
			createdAt: "2026-05-20T00:55:00.000Z",
			lastAct: "2026-05-20T00:59:30.000Z",
		});

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const row = rows.find((r) => r.collabId === "c1");
		expect(row?.workflowCreatedAt).toBe("2026-05-28T01:02:03.000Z");
	});

	it("workflowCreatedAt is null for a manual-relay collab (no workflow)", () => {
		const db = freshDb();
		insCollab(db, "c2");
		insHandoff(db, {
			id: "h2",
			collab: "c2",
			createdAt: "2026-05-20T00:50:00.000Z",
			lastAct: "2026-05-20T00:50:00.000Z",
		});

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const row = rows.find((r) => r.collabId === "c2");
		expect(row?.workflowId).toBeNull();
		expect(row?.workflowCreatedAt).toBeNull();
	});

	it("projects specPath repo-relative to the collab workspace_root", () => {
		const db = freshDb();
		insCollab(db, "c1"); // workspace_root = /tmp/c1
		insWorkflow(db, { id: "wf1", collab: "c1", specPath: "/tmp/c1/docs/specs/foo-design.md", createdAt: "2026-05-20T00:50:00.000Z" });
		insHandoff(db, { id: "h1", collab: "c1", wf: "wf1", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:30.000Z" });
		const row = listActiveCollabSummaries(db, { sinceMs, now: NOW }).find((r) => r.collabId === "c1");
		expect(row?.specPath).toBe("docs/specs/foo-design.md");
	});

	it("specPath falls back to the absolute path when spec_path is outside workspace_root", () => {
		const db = freshDb();
		insCollab(db, "c2"); // workspace_root = /tmp/c2
		insWorkflow(db, { id: "wf2", collab: "c2", specPath: "/elsewhere/bar.md", createdAt: "2026-05-20T00:50:00.000Z" });
		insHandoff(db, { id: "h2", collab: "c2", wf: "wf2", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:30.000Z" });
		const row = listActiveCollabSummaries(db, { sinceMs, now: NOW }).find((r) => r.collabId === "c2");
		expect(row?.specPath).toBe("/elsewhere/bar.md");
	});

	it("specPath is null for a manual-relay collab (no workflow)", () => {
		const db = freshDb();
		insCollab(db, "c3");
		insHandoff(db, { id: "h3", collab: "c3", createdAt: "2026-05-20T00:50:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });
		const row = listActiveCollabSummaries(db, { sinceMs, now: NOW }).find((r) => r.collabId === "c3");
		expect(row?.workflowId).toBeNull();
		expect(row?.specPath).toBeNull();
	});

	it("specPath is null for a whitespace-only spec_path (omit rather than render an empty artifact)", () => {
		const db = freshDb();
		insCollab(db, "c4"); // workspace_root = /tmp/c4
		insWorkflow(db, { id: "wf4", collab: "c4", specPath: "   ", createdAt: "2026-05-20T00:50:00.000Z" });
		insHandoff(db, { id: "h4", collab: "c4", wf: "wf4", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:30.000Z" });
		const row = listActiveCollabSummaries(db, { sinceMs, now: NOW }).find((r) => r.collabId === "c4");
		expect(row?.workflowId).toBe("wf4");
		expect(row?.specPath).toBeNull();
	});
});

function insCostHandoff(db: ReturnType<typeof freshDb>, h: { id: string; collab: string; wf?: string | null; phase?: string | null; createdAt: string; resolvedAt?: string | null; lastAct?: string; req?: string; root?: string | null; back?: string | null }) {
	db.prepare(
		`INSERT INTO relay_handoff (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,resolved_at,last_activity_at,workflow_id,phase_run_id,root_request_text,handback_text)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(h.id, h.collab, "codex", "claude", h.req ?? "", "handed_back", h.createdAt, h.resolvedAt ?? null, h.lastAct ?? h.createdAt, h.wf ?? null, h.phase ?? null, h.root ?? null, h.back ?? null);
}

describe("listRunCostRows", () => {
	it("returns per-handoff char counts + timestamps for a workflow run (no raw text)", () => {
		const db = freshDb();
		insCostHandoff(db, { id: "h1", collab: "c", wf: "wf", phase: "pr1", createdAt: "2026-05-20T00:00:00.000Z", resolvedAt: "2026-05-20T00:02:00.000Z", req: "abcd", root: "ef", back: "ghijk" });
		insCostHandoff(db, { id: "h2", collab: "c", wf: "wf", phase: "pr1", createdAt: "2026-05-20T00:03:00.000Z", lastAct: "2026-05-20T00:04:00.000Z", req: "x", root: null, back: null });
		insCostHandoff(db, { id: "hz", collab: "c", wf: "other", phase: "prZ", createdAt: "2026-05-20T00:01:00.000Z", req: "zzzzz" });
		const rows = listRunCostRows(db, { collabId: "c", workflowId: "wf" });
		expect(rows).toEqual([
			{ phaseRunId: "pr1", createdAt: "2026-05-20T00:00:00.000Z", resolvedAt: "2026-05-20T00:02:00.000Z", lastActivityAt: "2026-05-20T00:00:00.000Z", inChars: 6, outChars: 5 },
			{ phaseRunId: "pr1", createdAt: "2026-05-20T00:03:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:04:00.000Z", inChars: 1, outChars: 0 },
		]);
		const json = JSON.stringify(rows);
		expect(json).not.toContain("abcd");
		expect(json).not.toContain("ghijk");
	});

	it("manual-relay run (workflowId null) scopes to workflow_id IS NULL", () => {
		const db = freshDb();
		insCostHandoff(db, { id: "m1", collab: "c", wf: null, createdAt: "2026-05-20T00:00:00.000Z", req: "aa", back: "bbb" });
		insCostHandoff(db, { id: "w1", collab: "c", wf: "wf", createdAt: "2026-05-20T00:01:00.000Z", req: "ccccc" });
		const rows = listRunCostRows(db, { collabId: "c", workflowId: null });
		expect(rows).toEqual([
			{ phaseRunId: null, createdAt: "2026-05-20T00:00:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:00:00.000Z", inChars: 2, outChars: 3 },
		]);
	});

	it("REGRESSION: re-read reflects an in-place handback update", () => {
		const db = freshDb();
		insCostHandoff(db, { id: "h", collab: "c", wf: "wf", createdAt: "2026-05-20T00:00:00.000Z", req: "ab", back: null });
		expect(listRunCostRows(db, { collabId: "c", workflowId: "wf" })[0]?.outChars).toBe(0);
		db.prepare("UPDATE relay_handoff SET handback_text='wxyz', resolved_at='2026-05-20T00:05:00.000Z' WHERE handoff_id='h'").run();
		const after = listRunCostRows(db, { collabId: "c", workflowId: "wf" })[0];
		expect(after?.outChars).toBe(4);
		expect(after?.resolvedAt).toBe("2026-05-20T00:05:00.000Z");
	});
});

describe("listActiveCollabSummaries — huge sinceMs (no-window mode)", () => {
	it("does not throw RangeError when sinceMs is Number.MAX_SAFE_INTEGER (`--window all`)", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf1", collab: "c1", status: "done" });
		insHandoff(db, {
			id: "h1",
			collab: "c1",
			wf: "wf1",
			createdAt: "2026-05-20T00:00:00.000Z",
		});
		// Pre-fix, `new Date(Date.now() - MAX_SAFE_INTEGER).toISOString()` threw
		// `RangeError: Invalid time value` because the resulting ms is far below
		// epoch. The clamp to 0 means the cutoff degenerates to 1970-01-01.
		expect(() =>
			listActiveCollabSummaries(db, {
				sinceMs: Number.MAX_SAFE_INTEGER,
				now: "2026-05-21T00:00:00.000Z",
			}),
		).not.toThrow();

		const out = listActiveCollabSummaries(db, {
			sinceMs: Number.MAX_SAFE_INTEGER,
			now: "2026-05-21T00:00:00.000Z",
		});
		// All-time mode: every collab with any activity ever is eligible.
		expect(out.map((s) => s.collabId)).toContain("c1");
	});
});
