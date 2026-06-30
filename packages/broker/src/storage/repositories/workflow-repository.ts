import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";

export type WorkflowStatus =
	| "running"
	| "paused"
	| "halted"
	| "done"
	| "canceled";

export type WorkflowRecord = {
	workflowId: string;
	collabId: string;
	workflowType: string;
	name: string | null;
	specPath: string;
	roleBindings: Record<string, AgentType>;
	status: WorkflowStatus;
	currentPhaseIndex: number;
	haltReason: string | null;
	workflowContext: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

function rowToRecord(row: {
	workflow_id: string;
	collab_id: string;
	workflow_type: string;
	name: string | null;
	spec_path: string;
	role_bindings: string;
	status: string;
	current_phase_index: number;
	halt_reason: string | null;
	workflow_context: string;
	created_at: string;
	updated_at: string;
}): WorkflowRecord {
	return {
		workflowId: row.workflow_id,
		collabId: row.collab_id,
		workflowType: row.workflow_type,
		name: row.name,
		specPath: row.spec_path,
		roleBindings: JSON.parse(row.role_bindings) as Record<string, AgentType>,
		status: row.status as WorkflowStatus,
		currentPhaseIndex: row.current_phase_index,
		haltReason: row.halt_reason,
		workflowContext: JSON.parse(row.workflow_context) as Record<
			string,
			unknown
		>,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function insertWorkflow(
	db: Database.Database,
	input: {
		workflowId: string;
		collabId: string;
		workflowType: string;
		name: string | null;
		specPath: string;
		roleBindings: Record<string, AgentType>;
		status: WorkflowStatus;
		currentPhaseIndex: number;
		workflowContext: Record<string, unknown>;
		now: string;
	},
): void {
	db.prepare(
		`INSERT INTO workflows
		 (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status,
		  current_phase_index, halt_reason, workflow_context, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
	).run(
		input.workflowId,
		input.collabId,
		input.workflowType,
		input.name,
		input.specPath,
		JSON.stringify(input.roleBindings),
		input.status,
		input.currentPhaseIndex,
		JSON.stringify(input.workflowContext),
		input.now,
		input.now,
	);
}

export function getWorkflowById(
	db: Database.Database,
	workflowId: string,
): WorkflowRecord | null {
	const row = db
		.prepare("SELECT * FROM workflows WHERE workflow_id = ?")
		.get(workflowId) as Parameters<typeof rowToRecord>[0] | undefined;
	return row ? rowToRecord(row) : null;
}

export function listWorkflows(
	db: Database.Database,
	filter: { collabId?: string; status?: WorkflowStatus } = {},
): WorkflowRecord[] {
	const clauses: string[] = [];
	const args: unknown[] = [];
	if (filter.collabId) {
		clauses.push("collab_id = ?");
		args.push(filter.collabId);
	}
	if (filter.status) {
		clauses.push("status = ?");
		args.push(filter.status);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = db
		.prepare(`SELECT * FROM workflows ${where} ORDER BY created_at DESC`)
		.all(...args) as Array<Parameters<typeof rowToRecord>[0]>;
	return rows.map(rowToRecord);
}

export function setWorkflowStatus(
	db: Database.Database,
	input: {
		workflowId: string;
		status: WorkflowStatus;
		haltReason: string | null;
		now: string;
	},
): void {
	db.prepare(
		`UPDATE workflows
		   SET status = ?, halt_reason = ?, updated_at = ?
		 WHERE workflow_id = ?`,
	).run(input.status, input.haltReason, input.now, input.workflowId);
}

export function updateWorkflowContext(
	db: Database.Database,
	input: { workflowId: string; patch: Record<string, unknown>; now: string },
): void {
	const existing = getWorkflowById(db, input.workflowId);
	if (!existing) {
		throw new Error(
			`updateWorkflowContext: unknown workflowId ${input.workflowId}`,
		);
	}
	const merged = { ...existing.workflowContext, ...input.patch };
	db.prepare(
		"UPDATE workflows SET workflow_context = ?, updated_at = ? WHERE workflow_id = ?",
	).run(JSON.stringify(merged), input.now, input.workflowId);
}

export function incrementCurrentPhaseIndex(
	db: Database.Database,
	input: { workflowId: string; now: string },
): void {
	db.prepare(
		`UPDATE workflows
		   SET current_phase_index = current_phase_index + 1, updated_at = ?
		 WHERE workflow_id = ?`,
	).run(input.now, input.workflowId);
}

export function countActiveWorkflowsForCollab(
	db: Database.Database,
	collabId: string,
): number {
	const row = db
		.prepare(
			"SELECT COUNT(*) AS n FROM workflows WHERE collab_id = ? AND status IN ('running', 'paused')",
		)
		.get(collabId) as { n: number };
	return row.n;
}

/** @deprecated use countActiveWorkflowsForCollab — kept until all callers migrate. */
export const countRunningWorkflowsForCollab = countActiveWorkflowsForCollab;

/**
 * The most-recent workflow for a collab whose status is non-terminal
 * (NOT IN ('done','canceled')) — a running/paused/halted run that recover+resume
 * could revive. Returns null when none. Drives purge's PROTECTED bucket and its
 * display (workflow id + status).
 */
export function findNonTerminalWorkflow(
	db: Database.Database,
	collabId: string,
): { workflowId: string; status: WorkflowStatus } | null {
	const row = db
		.prepare(
			`SELECT workflow_id, status
			   FROM workflows
			  WHERE collab_id = ? AND status NOT IN ('done', 'canceled')
			  ORDER BY created_at DESC
			  LIMIT 1`,
		)
		.get(collabId) as { workflow_id: string; status: string } | undefined;
	return row
		? { workflowId: row.workflow_id, status: row.status as WorkflowStatus }
		: null;
}

/**
 * The statuses whose runs count toward accumulated "hands-off time saved".
 * Single source of truth: both the SQL `IN (…)` filter and the `byStatus`
 * buckets derive from this allowlist, so a future status is excluded by
 * default until deliberately added here AND given a bucket below.
 */
export const COUNTED_STATUSES = ["done", "halted"] as const;

export interface HandsOffStatusBucket {
	count: number;
	totalMs: number;
}

export interface HandsOffStats {
	/** Σ hands-off elapsed across all counted runs, in ms. */
	totalMs: number;
	/** Number of counted runs (done + halted). */
	count: number;
	byStatus: {
		done: HandsOffStatusBucket;
		halted: HandsOffStatusBucket;
	};
	/** Earliest created_at among counted runs (ISO), or null when none. */
	earliestKickoffAt: string | null;
	/** Rows excluded because a timestamp could not be parsed. */
	skipped: number;
}

/**
 * Accumulated hands-off time saved: the summed wall-clock elapsed
 * (`max(0, updated_at − created_at)`) of every counted (done/halted) workflow,
 * across all collabs and all history. Computed on read — no persisted counter.
 *
 * `updated_at` is the run's end time: setWorkflowStatus stamps it at the
 * transition into a terminal status. Caveat (accepted, YAGNI): a post-terminal
 * updateWorkflowContext write would bump updated_at and slightly inflate that
 * run's elapsed; in practice terminal runs are not context-written.
 *
 * Deterministic — only terminal runs are counted, so no "now" clock is needed.
 */
export function getHandsOffStats(db: Database.Database): HandsOffStats {
	const placeholders = COUNTED_STATUSES.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT status, created_at, updated_at
			   FROM workflows
			  WHERE status IN (${placeholders})`,
		)
		.all(...COUNTED_STATUSES) as Array<{
		status: "done" | "halted";
		created_at: string;
		updated_at: string;
	}>;

	const stats: HandsOffStats = {
		totalMs: 0,
		count: 0,
		byStatus: {
			done: { count: 0, totalMs: 0 },
			halted: { count: 0, totalMs: 0 },
		},
		earliestKickoffAt: null,
		skipped: 0,
	};

	for (const row of rows) {
		const start = Date.parse(row.created_at);
		const end = Date.parse(row.updated_at);
		if (Number.isNaN(start) || Number.isNaN(end)) {
			stats.skipped += 1;
			continue;
		}
		const elapsed = Math.max(0, end - start);
		stats.totalMs += elapsed;
		stats.count += 1;
		stats.byStatus[row.status].count += 1;
		stats.byStatus[row.status].totalMs += elapsed;
		if (
			stats.earliestKickoffAt === null ||
			row.created_at < stats.earliestKickoffAt
		) {
			stats.earliestKickoffAt = row.created_at;
		}
	}

	return stats;
}
