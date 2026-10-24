import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listRelayHandoffs } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "rh-log-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function insertHandoff(
	db: ReturnType<typeof freshDb>,
	h: {
		id: string;
		collab: string;
		createdAt: string;
		status?: string;
		handback?: string | null;
		lastActivityAt?: string | null;
		workflowId?: string | null;
		phaseRunId?: string | null;
		round?: number | null;
		step?: string | null;
		verdict?: string | null;
		confidence?: number | null;
		reason?: string | null;
		capture?: string | null;
	},
) {
	// NOTE: relay_handoff has NO max_rounds column — RelayHandoffRecord.maxRounds
	// is derived via JOIN collab c (c.orchestrator_max_rounds). Do not insert it.
	db.prepare(
		`INSERT INTO relay_handoff
		 (handoff_id,collab_id,sender_agent,target_agent,request_text,status,
		  created_at,last_activity_at,capture_status,chain_id,round_number,
		  handback_text,workflow_id,phase_run_id,handoff_step,
		  evaluator_verdict,evaluator_confidence,evaluator_reason)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		h.id, h.collab, "codex", "claude", "req", h.status ?? "handed_back",
		h.createdAt, h.lastActivityAt ?? h.createdAt, h.capture ?? null, "chain_1",
		h.round ?? null, h.handback === undefined ? "did the thing" : h.handback,
		h.workflowId ?? null, h.phaseRunId ?? null, h.step ?? null, h.verdict ?? null,
		h.confidence ?? null, h.reason ?? null,
	);
}

// The lifecycle the original incremental-cursor design missed: a row is
// inserted pending, then UPDATEd in place on the same handoff_id/created_at.
function updateHandoffInPlace(
	db: ReturnType<typeof freshDb>,
	id: string,
	patch: {
		status?: string;
		handback?: string | null;
		verdict?: string | null;
		confidence?: number | null;
		reason?: string | null;
		lastActivityAt?: string | null;
	},
) {
	db.prepare(
		`UPDATE relay_handoff
		    SET status = COALESCE(?, status),
		        handback_text = COALESCE(?, handback_text),
		        evaluator_verdict = COALESCE(?, evaluator_verdict),
		        evaluator_confidence = COALESCE(?, evaluator_confidence),
		        evaluator_reason = COALESCE(?, evaluator_reason),
		        last_activity_at = COALESCE(?, last_activity_at)
		  WHERE handoff_id = ?`,
	).run(
		patch.status ?? null, patch.handback ?? null, patch.verdict ?? null,
		patch.confidence ?? null, patch.reason ?? null, patch.lastActivityAt ?? null,
		id,
	);
}

describe("listRelayHandoffs", () => {
	it("returns collab handoffs ordered by (created_at, handoff_id), with lastActivityAt", () => {
		const db = freshDb();
		insertHandoff(db, { id: "h2", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z" });
		insertHandoff(db, {
			id: "h1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z",
			lastActivityAt: "2026-05-19T00:09:00.000Z",
			workflowId: "wf1", phaseRunId: "pr1", round: 2, step: "fix",
			verdict: "approve", confidence: 0.95, reason: "ok", capture: "ok",
		});
		insertHandoff(db, { id: "other", collab: "c2", createdAt: "2026-05-19T00:00:00.000Z" });

		const rows = listRelayHandoffs(db, { collabId: "c1" });

		expect(rows.map((r) => r.handoffId)).toEqual(["h1", "h2"]);
		expect(rows[0]).toMatchObject({
			handoffId: "h1", workflowId: "wf1", phaseRunId: "pr1",
			roundNumber: 2, handoffStep: "fix", evaluatorVerdict: "approve",
			evaluatorConfidence: 0.95, evaluatorReason: "ok", captureStatus: "ok",
			senderAgent: "codex", targetAgent: "claude", status: "handed_back",
			lastActivityAt: "2026-05-19T00:09:00.000Z",
		});
		expect(rows[1]).toMatchObject({
			handoffId: "h2", workflowId: null, evaluatorVerdict: null,
		});
	});

	it("REGRESSION: re-read reflects in-place handback/verdict updates (not stale pending)", () => {
		const db = freshDb();
		// Inserted pending — exactly how a workflow handoff starts.
		insertHandoff(db, {
			id: "h1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z",
			status: "pending", handback: null, lastActivityAt: "2026-05-19T00:00:01.000Z",
			workflowId: "wf1", phaseRunId: "pr1", round: 1, step: "implement",
		});

		const first = listRelayHandoffs(db, { collabId: "c1" });
		expect(first[0]).toMatchObject({
			handoffId: "h1", status: "pending", handbackText: null,
			evaluatorVerdict: null, lastActivityAt: "2026-05-19T00:00:01.000Z",
		});

		// Same row mutated in place (handback then evaluator) — created_at and
		// handoff_id are UNCHANGED, which is what defeated the old cursor.
		updateHandoffInPlace(db, "h1", {
			status: "handed_back", handback: "wrote spec.plan.md; 5 tasks",
			lastActivityAt: "2026-05-19T00:01:30.000Z",
		});
		updateHandoffInPlace(db, "h1", {
			verdict: "delivered", confidence: 0.95, reason: "looks good",
			lastActivityAt: "2026-05-19T00:01:45.000Z",
		});

		const second = listRelayHandoffs(db, { collabId: "c1" });
		expect(second).toHaveLength(1);
		expect(second[0]).toMatchObject({
			handoffId: "h1", status: "handed_back",
			handbackText: "wrote spec.plan.md; 5 tasks",
			evaluatorVerdict: "delivered", evaluatorConfidence: 0.95,
			evaluatorReason: "looks good",
			lastActivityAt: "2026-05-19T00:01:45.000Z",
		});
	});

	it("limit returns the NEWEST N rows, still ascending", () => {
		const db = freshDb();
		for (let i = 0; i < 5; i++) {
			insertHandoff(db, {
				id: `h${i}`, collab: "c1",
				createdAt: `2026-05-19T00:00:0${i}.000Z`,
			});
		}
		const rows = listRelayHandoffs(db, { collabId: "c1", limit: 3 });
		// newest 3 (h2,h3,h4) but presented oldest→newest
		expect(rows.map((r) => r.handoffId)).toEqual(["h2", "h3", "h4"]);
	});

	it("returns [] for an unknown collab", () => {
		const db = freshDb();
		expect(listRelayHandoffs(db, { collabId: "nope" })).toEqual([]);
	});

	// The dashboard renders multiple runs per collab over time — a single collab
	// can accumulate handoffs from several workflow runs and from manual relay
	// turns. Without a workflow-level filter at the SQL layer, listRelayHandoffs
	// returns mixed rows and (worse) starves a quiet run when a noisier run on
	// the same collab consumes the LIMIT budget.
	describe("workflowFilter", () => {
		it("workflowId scopes to that run's handoffs only", () => {
			const db = freshDb();
			insertHandoff(db, { id: "ha1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z", workflowId: "wf_a", phaseRunId: "pr_a", round: 1, step: "implement" });
			insertHandoff(db, { id: "hb1", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z", workflowId: "wf_b", phaseRunId: "pr_b", round: 1, step: "implement" });
			insertHandoff(db, { id: "hm1", collab: "c1", createdAt: "2026-05-19T00:00:03.000Z" /* manual: workflow_id NULL */ });

			const rows = listRelayHandoffs(db, { collabId: "c1", workflowFilter: { workflowId: "wf_a" } });
			expect(rows.map((r) => r.handoffId)).toEqual(["ha1"]);
			expect(rows.every((r) => r.workflowId === "wf_a")).toBe(true);
		});

		it("manualOnly scopes to handoffs with workflow_id IS NULL", () => {
			const db = freshDb();
			insertHandoff(db, { id: "ha1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z", workflowId: "wf_a", phaseRunId: "pr_a" });
			insertHandoff(db, { id: "hm1", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z" });
			insertHandoff(db, { id: "hm2", collab: "c1", createdAt: "2026-05-19T00:00:03.000Z" });

			const rows = listRelayHandoffs(db, { collabId: "c1", workflowFilter: { manualOnly: true } });
			expect(rows.map((r) => r.handoffId)).toEqual(["hm1", "hm2"]);
			expect(rows.every((r) => r.workflowId === null)).toBe(true);
		});

		// STARVATION: this is the real reason the filter must be SQL-level, not
		// post-LIMIT. With a tight LIMIT, a noisier sibling run on the same
		// collab can consume all the budget and the selected run gets nothing.
		it("filter is applied at SQL level — selected run is NOT starved by noisier sibling rows", () => {
			const db = freshDb();
			// wf_a (quiet, older): 2 rows
			insertHandoff(db, { id: "ha1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z", workflowId: "wf_a", phaseRunId: "pr_a", round: 1, step: "implement" });
			insertHandoff(db, { id: "ha2", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z", workflowId: "wf_a", phaseRunId: "pr_a", round: 2, step: "review" });
			// wf_b (noisy, newer): 5 rows that would crowd out wf_a under limit=2 without SQL filter
			for (let i = 0; i < 5; i++) {
				insertHandoff(db, { id: `hb${i}`, collab: "c1", createdAt: `2026-05-19T00:00:1${i}.000Z`, workflowId: "wf_b", phaseRunId: "pr_b", round: i + 1, step: "implement" });
			}

			const rows = listRelayHandoffs(db, { collabId: "c1", limit: 2, workflowFilter: { workflowId: "wf_a" } });
			expect(rows.map((r) => r.handoffId)).toEqual(["ha1", "ha2"]);
			expect(rows.every((r) => r.workflowId === "wf_a")).toBe(true);
		});

		it("absence of workflowFilter preserves the original collab-only behavior (back-compat)", () => {
			const db = freshDb();
			insertHandoff(db, { id: "ha1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z", workflowId: "wf_a" });
			insertHandoff(db, { id: "hb1", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z", workflowId: "wf_b" });
			insertHandoff(db, { id: "hm1", collab: "c1", createdAt: "2026-05-19T00:00:03.000Z" });

			const rows = listRelayHandoffs(db, { collabId: "c1" });
			expect(rows.map((r) => r.handoffId)).toEqual(["ha1", "hb1", "hm1"]);
		});
	});
});

describe("listRelayHandoffs notice-path fields", () => {
	it("carries deliveryPath and capturePath, null when unset", () => {
		const db = freshDb();
		insertHandoff(db, { id: "n1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z" });
		insertHandoff(db, { id: "n2", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z" });
		db.prepare(
			"UPDATE relay_handoff SET delivery_path = 'notice', capture_path = 'reply' WHERE handoff_id = 'n1'",
		).run();
		const rows = listRelayHandoffs(db, { collabId: "c1" });
		expect(rows[0]).toMatchObject({ handoffId: "n1", deliveryPath: "notice", capturePath: "reply" });
		expect(rows[1]).toMatchObject({ handoffId: "n2", deliveryPath: null, capturePath: null });
	});

	it("reads both as null on a database without the columns", () => {
		const db = freshDb();
		insertHandoff(db, { id: "o1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z" });
		db.exec("ALTER TABLE relay_handoff DROP COLUMN delivery_path");
		db.exec("ALTER TABLE relay_handoff DROP COLUMN capture_path");
		const rows = listRelayHandoffs(db, { collabId: "c1" });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ deliveryPath: null, capturePath: null });
	});
});

describe("control.listRelayHandoffs", () => {
	it("is exposed on broker.control, collab-scoped, and reflects in-place updates", () => {
		const dir = mkdtempSync(join(tmpdir(), "rh-ctl-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(dir, "state.db"),
			host: "127.0.0.1",
			port: 4733,
		});
		try {
			insertHandoff(broker.db, {
				id: "h1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z",
				status: "pending", handback: null, workflowId: "wf1",
				round: 1, step: "review",
			});
			expect(broker.control.listRelayHandoffs("c1")[0]).toMatchObject({
				handoffId: "h1", status: "pending", evaluatorVerdict: null,
			});
			updateHandoffInPlace(broker.db, "h1", {
				status: "handed_back", verdict: "approve",
				lastActivityAt: "2026-05-19T00:02:00.000Z",
			});
			const after = broker.control.listRelayHandoffs("c1");
			expect(after[0]).toMatchObject({
				handoffId: "h1", status: "handed_back",
				evaluatorVerdict: "approve",
				lastActivityAt: "2026-05-19T00:02:00.000Z",
			});
		} finally {
			void broker.stop();
		}
	});
});
