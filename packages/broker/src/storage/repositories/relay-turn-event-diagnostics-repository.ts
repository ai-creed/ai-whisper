import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";

export type TurnEventAction =
	| "delivered"
	| "ignored_no_workflow"
	| "ignored_unrelated_turn"
	| "deferred_rearmed"
	| "rejected_mid_composition"
	| "fallback_indeterminate"
	| "fallback_exhausted";

export type TurnEventFidelityVerdict =
	| "clean"
	| "mid_composition"
	| "empty"
	| "superseded"
	| "n/a";

export type RelayTurnEventDiagnosticRecord = {
	eventId: string;
	receivedAt: string;
	provider: AgentType;
	workspaceId: string;
	cwd: string;
	sessionOrThreadId: string | null;
	turnId: string | null;
	workflowActive: boolean;
	collabId: string | null;
	workflowId: string | null;
	chainId: string | null;
	handoffId: string | null;
	inputCorrelated: boolean | null;
	containmentScore: number | null;
	fidelityVerdict: TurnEventFidelityVerdict;
	deferCount: number;
	action: TurnEventAction;
	messageLen: number;
	messageSample: string | null;
};

type InsertInput = Omit<RelayTurnEventDiagnosticRecord, "eventId">;

// Monotonic per-process counter so every received event yields a UNIQUE
// event_id even when two events share the same millisecond + handoff + action.
// Combined with process.pid it is unique across the broker process lifetime;
// with a plain INSERT (not INSERT OR REPLACE) it guarantees exactly one row per
// received event (spec §7: "every received event writes exactly one DB row").
let insertSeq = 0;

export function insertTurnEventDiagnostic(
	db: Database.Database,
	input: InsertInput,
): { eventId: string } {
	const eventId = `tevt_${input.receivedAt.replace(/[^0-9]/g, "")}_${(input.handoffId ?? input.workspaceId).slice(-8)}_${input.action}_${process.pid}_${(insertSeq++).toString(36)}`;
	db.prepare(
		`INSERT INTO relay_turn_event_diagnostics (
			event_id, received_at, provider, workspace_id, cwd,
			session_or_thread_id, turn_id, workflow_active, collab_id, workflow_id,
			chain_id, handoff_id, input_correlated, containment_score,
			fidelity_verdict, defer_count, action, message_len, message_sample
		) VALUES (
			@eventId, @receivedAt, @provider, @workspaceId, @cwd,
			@sessionOrThreadId, @turnId, @workflowActive, @collabId, @workflowId,
			@chainId, @handoffId, @inputCorrelated, @containmentScore,
			@fidelityVerdict, @deferCount, @action, @messageLen, @messageSample
		)`,
	).run({
		eventId,
		receivedAt: input.receivedAt,
		provider: input.provider,
		workspaceId: input.workspaceId,
		cwd: input.cwd,
		sessionOrThreadId: input.sessionOrThreadId,
		turnId: input.turnId,
		workflowActive: input.workflowActive ? 1 : 0,
		collabId: input.collabId,
		workflowId: input.workflowId,
		chainId: input.chainId,
		handoffId: input.handoffId,
		inputCorrelated:
			input.inputCorrelated === null ? null : input.inputCorrelated ? 1 : 0,
		containmentScore: input.containmentScore,
		fidelityVerdict: input.fidelityVerdict,
		deferCount: input.deferCount,
		action: input.action,
		messageLen: input.messageLen,
		messageSample: input.messageSample,
	});
	return { eventId };
}

type Row = {
	event_id: string;
	received_at: string;
	provider: string;
	workspace_id: string;
	cwd: string;
	session_or_thread_id: string | null;
	turn_id: string | null;
	workflow_active: number;
	collab_id: string | null;
	workflow_id: string | null;
	chain_id: string | null;
	handoff_id: string | null;
	input_correlated: number | null;
	containment_score: number | null;
	fidelity_verdict: string;
	defer_count: number;
	action: string;
	message_len: number;
	message_sample: string | null;
};

function rowToRecord(r: Row): RelayTurnEventDiagnosticRecord {
	return {
		eventId: r.event_id,
		receivedAt: r.received_at,
		provider: r.provider as RelayTurnEventDiagnosticRecord["provider"],
		workspaceId: r.workspace_id,
		cwd: r.cwd,
		sessionOrThreadId: r.session_or_thread_id,
		turnId: r.turn_id,
		workflowActive: r.workflow_active === 1,
		collabId: r.collab_id,
		workflowId: r.workflow_id,
		chainId: r.chain_id,
		handoffId: r.handoff_id,
		inputCorrelated:
			r.input_correlated === null ? null : r.input_correlated === 1,
		containmentScore: r.containment_score,
		fidelityVerdict: r.fidelity_verdict as TurnEventFidelityVerdict,
		deferCount: r.defer_count,
		action: r.action as TurnEventAction,
		messageLen: r.message_len,
		messageSample: r.message_sample,
	};
}

export function listTurnEventDiagnosticsByCollab(
	db: Database.Database,
	collabId: string,
	limit: number | null,
): RelayTurnEventDiagnosticRecord[] {
	const sql =
		"SELECT * FROM relay_turn_event_diagnostics WHERE collab_id = ? ORDER BY received_at DESC" +
		(limit !== null ? " LIMIT ?" : "");
	const rows = (
		limit !== null
			? db.prepare(sql).all(collabId, limit)
			: db.prepare(sql).all(collabId)
	) as Row[];
	return rows.map(rowToRecord);
}

export function deleteTurnEventDiagnosticsOlderThan(
	db: Database.Database,
	cutoffIso: string,
): number {
	const info = db
		.prepare("DELETE FROM relay_turn_event_diagnostics WHERE received_at < ?")
		.run(cutoffIso);
	return info.changes;
}
