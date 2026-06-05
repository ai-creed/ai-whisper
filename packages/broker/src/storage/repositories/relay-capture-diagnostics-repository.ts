import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";

export type CaptureStatus =
	| "ok"
	| "no_response_captured_confidently"
	| "no_response_captured";

export type RelayCaptureDiagnosticRecord = {
	captureId: string;
	handoffId: string;
	collabId: string;
	chainId: string | null;
	workflowId: string | null;
	targetProvider: AgentType;
	captureStatus: CaptureStatus;
	clipLen: number;
	turnLen: number;
	turnConfidence: "high" | "low";
	jaccardScore: number | null;
	containmentScore: number | null;
	clipSample: string | null;
	turnSample: string | null;
	abortedByRaceGuard: boolean;
	/** Optional on insert (defaults to false); always populated on read. */
	interferenceDetected?: boolean;
	createdAt: string;
};

type Row = {
	capture_id: string;
	handoff_id: string;
	collab_id: string;
	chain_id: string | null;
	workflow_id: string | null;
	target_provider: string;
	capture_status: string;
	clip_len: number;
	turn_len: number;
	turn_confidence: string;
	jaccard_score: number | null;
	containment_score: number | null;
	clip_sample: string | null;
	turn_sample: string | null;
	aborted_by_race_guard: number;
	interference_detected: number;
	created_at: string;
};

function rowToRecord(row: Row): RelayCaptureDiagnosticRecord {
	return {
		captureId: row.capture_id,
		handoffId: row.handoff_id,
		collabId: row.collab_id,
		chainId: row.chain_id,
		workflowId: row.workflow_id,
		targetProvider: row.target_provider as AgentType,
		captureStatus: row.capture_status as CaptureStatus,
		clipLen: row.clip_len,
		turnLen: row.turn_len,
		turnConfidence: row.turn_confidence as "high" | "low",
		jaccardScore: row.jaccard_score,
		containmentScore: row.containment_score,
		clipSample: row.clip_sample,
		turnSample: row.turn_sample,
		abortedByRaceGuard: row.aborted_by_race_guard === 1,
		interferenceDetected: row.interference_detected === 1,
		createdAt: row.created_at,
	};
}

export function insertCaptureDiagnostic(
	db: Database.Database,
	input: RelayCaptureDiagnosticRecord,
): void {
	db.prepare(
		`INSERT INTO relay_capture_diagnostics
		 (capture_id, handoff_id, collab_id, chain_id, workflow_id, target_provider,
		  capture_status, clip_len, turn_len, turn_confidence, jaccard_score,
		  containment_score, clip_sample, turn_sample, aborted_by_race_guard,
		  interference_detected, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.captureId,
		input.handoffId,
		input.collabId,
		input.chainId,
		input.workflowId,
		input.targetProvider,
		input.captureStatus,
		input.clipLen,
		input.turnLen,
		input.turnConfidence,
		input.jaccardScore,
		input.containmentScore,
		input.clipSample,
		input.turnSample,
		input.abortedByRaceGuard ? 1 : 0,
		input.interferenceDetected ? 1 : 0,
		input.createdAt,
	);
}

// The dashboard Inspector falls back to this query when there's no chain to
// scope by (brand-new workflow with no phase yet, or manual relay panes).
// Without an SQL-level workflow filter, the fallback would mix sibling-run
// diagnostics into the displayed Evidence section. Mirrors the shape used by
// listRelayHandoffs' `workflowFilter`.
export type CaptureDiagnosticsWorkflowFilter =
	| { workflowId: string }
	| { manualOnly: true };

export function listCaptureDiagnosticsByCollab(
	db: Database.Database,
	collabId: string,
	limit: number | null,
	opts?: { workflowFilter?: CaptureDiagnosticsWorkflowFilter },
): RelayCaptureDiagnosticRecord[] {
	const filter = opts?.workflowFilter;
	const filterClause =
		filter === undefined
			? ""
			: "workflowId" in filter
				? " AND workflow_id = ?"
				: " AND workflow_id IS NULL";
	const filterArgs: string[] =
		filter !== undefined && "workflowId" in filter ? [filter.workflowId] : [];
	if (limit === null) {
		const rows = db
			.prepare(
				`SELECT * FROM relay_capture_diagnostics
				 WHERE collab_id = ?${filterClause}
				 ORDER BY created_at DESC`,
			)
			.all(collabId, ...filterArgs) as Row[];
		return rows.map(rowToRecord);
	}
	const rows = db
		.prepare(
			`SELECT * FROM relay_capture_diagnostics
			 WHERE collab_id = ?${filterClause}
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(collabId, ...filterArgs, limit) as Row[];
	return rows.map(rowToRecord);
}

export function listCaptureDiagnosticsByCollabAndChain(
	db: Database.Database,
	collabId: string,
	chainId: string,
	limit: number | null,
): RelayCaptureDiagnosticRecord[] {
	if (limit === null) {
		const rows = db
			.prepare(
				`SELECT * FROM relay_capture_diagnostics
				 WHERE collab_id = ? AND chain_id = ?
				 ORDER BY created_at DESC`,
			)
			.all(collabId, chainId) as Row[];
		return rows.map(rowToRecord);
	}
	const rows = db
		.prepare(
			`SELECT * FROM relay_capture_diagnostics
			 WHERE collab_id = ? AND chain_id = ?
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(collabId, chainId, limit) as Row[];
	return rows.map(rowToRecord);
}

export function listCaptureDiagnosticsByHandoff(
	db: Database.Database,
	handoffId: string,
): RelayCaptureDiagnosticRecord[] {
	const rows = db
		.prepare(
			`SELECT * FROM relay_capture_diagnostics
			 WHERE handoff_id = ?
			 ORDER BY created_at ASC`,
		)
		.all(handoffId) as Row[];
	return rows.map(rowToRecord);
}

export function deleteCaptureDiagnosticsOlderThan(
	db: Database.Database,
	cutoffIso: string,
): number {
	const result = db
		.prepare("DELETE FROM relay_capture_diagnostics WHERE created_at < ?")
		.run(cutoffIso);
	return result.changes;
}
