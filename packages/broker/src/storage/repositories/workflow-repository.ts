import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";

export type WorkflowStatus = "running" | "paused" | "halted" | "done" | "canceled";

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
		workflowContext: JSON.parse(row.workflow_context) as Record<string, unknown>,
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
		throw new Error(`updateWorkflowContext: unknown workflowId ${input.workflowId}`);
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
