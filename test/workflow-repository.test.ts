import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertWorkflow,
	getWorkflowById,
	listWorkflows,
	setWorkflowStatus,
	updateWorkflowContext,
	incrementCurrentPhaseIndex,
	countActiveWorkflowsForCollab,
	getHandsOffStats,
	COUNTED_STATUSES,
} from "../packages/broker/src/storage/repositories/workflow-repository.ts";

function bootstrap() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('c1','/tmp','c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	return { broker, db };
}

describe("workflow-repository", () => {
	it("inserts and reads a workflow", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "spec-driven-development",
			name: "feature x",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		const rec = getWorkflowById(db, "wf_1");
		expect(rec?.status).toBe("running");
		expect(rec?.roleBindings).toEqual({
			implementer: "claude",
			reviewer: "codex",
		});
		expect(rec?.workflowContext).toEqual({});
	});

	it("lists workflows filtered by status", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		expect(listWorkflows(db, { status: "running" })).toHaveLength(1);
		expect(listWorkflows(db, { status: "done" })).toHaveLength(0);
	});

	it("setWorkflowStatus can flip running→halted with reason", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		setWorkflowStatus(db, {
			workflowId: "wf_1",
			status: "halted",
			haltReason: "agent missing",
			now: "2026-04-21T00:01:00Z",
		});
		expect(getWorkflowById(db, "wf_1")?.status).toBe("halted");
		expect(getWorkflowById(db, "wf_1")?.haltReason).toBe("agent missing");
	});

	it("updateWorkflowContext merges JSON keys", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: { a: 1 },
			now: "2026-04-21T00:00:00Z",
		});
		updateWorkflowContext(db, {
			workflowId: "wf_1",
			patch: { baseBeforeExecution: "abc123" },
			now: "2026-04-21T00:00:01Z",
		});
		expect(getWorkflowById(db, "wf_1")?.workflowContext).toEqual({
			a: 1,
			baseBeforeExecution: "abc123",
		});
	});

	it("incrementCurrentPhaseIndex moves pointer forward", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		incrementCurrentPhaseIndex(db, {
			workflowId: "wf_1",
			now: "2026-04-21T00:01:00Z",
		});
		expect(getWorkflowById(db, "wf_1")?.currentPhaseIndex).toBe(1);
	});

	it("countActiveWorkflowsForCollab counts both running and paused", () => {
		const { db } = bootstrap();
		db.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
			 VALUES ('c2','/tmp','c2','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
		).run();
		const now = "2026-05-27T00:00:00Z";
		insertWorkflow(db, {
			workflowId: "wf_run",
			collabId: "c1",
			workflowType: "spec-driven-development",
			name: null,
			specPath: "s.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now,
		});
		insertWorkflow(db, {
			workflowId: "wf_pause",
			collabId: "c2",
			workflowType: "spec-driven-development",
			name: null,
			specPath: "s.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "paused",
			currentPhaseIndex: 0,
			workflowContext: {},
			now,
		});
		expect(countActiveWorkflowsForCollab(db, "c1")).toBe(1);
		expect(countActiveWorkflowsForCollab(db, "c2")).toBe(1);
		expect(countActiveWorkflowsForCollab(db, "c3")).toBe(0);
	});
});

describe("getHandsOffStats", () => {
	// Raw insert so created_at / updated_at / status are set independently
	// (insertWorkflow forces created_at === updated_at === now).
	// collabId defaults to 'c1'; pass a different value to avoid the partial
	// UNIQUE index workflows_one_running_per_collab (one running/paused per collab).
	function seed(
		db: ReturnType<typeof bootstrap>["db"],
		o: {
			id: string;
			status: string;
			createdAt: string;
			updatedAt: string;
			collabId?: string;
		},
	): void {
		const collabId = o.collabId ?? "c1";
		db.prepare(
			`INSERT INTO workflows
			   (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings,
			    status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
			 VALUES (?, ?, 'spec-driven-development', NULL, '/s', '{}', ?, 0, NULL, '{}', ?, ?)`,
		).run(o.id, collabId, o.status, o.createdAt, o.updatedAt);
	}

	function seedFixture(db: ReturnType<typeof bootstrap>["db"]): void {
		seed(db, {
			id: "doneA",
			status: "done",
			createdAt: "2026-05-01T00:00:00.000Z",
			updatedAt: "2026-05-01T02:00:00.000Z",
		}); // 2h
		seed(db, {
			id: "doneSkew",
			status: "done",
			createdAt: "2026-05-03T01:00:00.000Z",
			updatedAt: "2026-05-03T00:00:00.000Z",
		}); // clamp 0
		seed(db, {
			id: "doneBad",
			status: "done",
			createdAt: "not-a-date",
			updatedAt: "2026-05-04T00:00:00.000Z",
		}); // skipped
		seed(db, {
			id: "haltedD",
			status: "halted",
			createdAt: "2026-05-02T00:00:00.000Z",
			updatedAt: "2026-05-02T00:30:00.000Z",
		}); // 30m
		seed(db, {
			id: "runE",
			status: "running",
			createdAt: "2026-05-05T00:00:00.000Z",
			updatedAt: "2026-05-05T05:00:00.000Z",
		}); // excluded
		// pauseF uses collabId 'c2': the partial UNIQUE index allows only one running/paused per collab.
		seed(db, {
			id: "pauseF",
			status: "paused",
			createdAt: "2026-05-06T00:00:00.000Z",
			updatedAt: "2026-05-06T05:00:00.000Z",
			collabId: "c2",
		}); // excluded
		seed(db, {
			id: "cancelG",
			status: "canceled",
			createdAt: "2026-04-01T00:00:00.000Z",
			updatedAt: "2026-04-08T00:00:00.000Z",
		}); // excluded (7d)
	}

	it("counts only done + halted, clamps skew, skips unparseable, totals correctly", () => {
		const { db } = bootstrap();
		seedFixture(db);
		const stats = getHandsOffStats(db);

		expect(stats.count).toBe(3); // doneA, doneSkew, haltedD (doneBad skipped; run/pause/cancel excluded)
		expect(stats.totalMs).toBe(9_000_000); // 7_200_000 + 0 + 1_800_000
		expect(stats.byStatus.done).toEqual({ count: 2, totalMs: 7_200_000 });
		expect(stats.byStatus.halted).toEqual({ count: 1, totalMs: 1_800_000 });
		expect(stats.skipped).toBe(1);
		expect(stats.earliestKickoffAt).toBe("2026-05-01T00:00:00.000Z");
		// Consistency invariants.
		expect(stats.count).toBe(
			stats.byStatus.done.count + stats.byStatus.halted.count,
		);
		expect(stats.totalMs).toBe(
			stats.byStatus.done.totalMs + stats.byStatus.halted.totalMs,
		);
	});

	it("returns a zeroed result for an empty set", () => {
		const { db } = bootstrap();
		const stats = getHandsOffStats(db);
		expect(stats).toEqual({
			totalMs: 0,
			count: 0,
			byStatus: {
				done: { count: 0, totalMs: 0 },
				halted: { count: 0, totalMs: 0 },
			},
			earliestKickoffAt: null,
			skipped: 0,
		});
	});

	it("allowlist guard: byStatus keys equal COUNTED_STATUSES", () => {
		const { db } = bootstrap();
		seedFixture(db);
		const stats = getHandsOffStats(db);
		expect(Object.keys(stats.byStatus).sort()).toEqual(
			[...COUNTED_STATUSES].sort(),
		);
	});
});
