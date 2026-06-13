import type Database from "better-sqlite3";

// The only event names the outbox carries: the four CLI-originated workflow
// lifecycle events that run on a transient BrokerRuntime and so never reach the
// daemon's in-process bus. Driver-native events (phase/round/halted/done) are
// emitted in the daemon and are NOT outboxed.
export type WorkflowOutboxEventName =
	| "workflow.created"
	| "workflow.paused"
	| "workflow.resumed"
	| "workflow.canceled";

export interface WorkflowOutboxRow {
	id: number;
	eventName: WorkflowOutboxEventName;
	payload: Record<string, unknown>;
}

export function appendWorkflowEvent(
	db: Database.Database,
	input: {
		collabId: string;
		eventName: WorkflowOutboxEventName;
		payload: Record<string, unknown>;
		now: string;
	},
): void {
	db.prepare(
		`INSERT INTO workflow_event_outbox (collab_id, event_name, payload_json, created_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.collabId, input.eventName, JSON.stringify(input.payload), input.now);
}

// Highest outbox id for a collab (0 when empty). The bridge seeds from this on
// start so a daemon restart never replays already-delivered transitions.
export function getMaxWorkflowEventId(
	db: Database.Database,
	collabId: string,
): number {
	const row = db
		.prepare(
			"SELECT MAX(id) AS maxId FROM workflow_event_outbox WHERE collab_id = ?",
		)
		.get(collabId) as { maxId: number | null };
	return row.maxId ?? 0;
}

// Append-only tail: every row with id > afterId, in insertion order. Because the
// log is append-only, a consumer that advances afterId past each returned id can
// never miss a transition — including two transitions written between two ticks.
export function listWorkflowEventsAfter(
	db: Database.Database,
	input: { collabId: string; afterId: number },
): WorkflowOutboxRow[] {
	const rows = db
		.prepare(
			`SELECT id, event_name, payload_json FROM workflow_event_outbox
			 WHERE collab_id = ? AND id > ? ORDER BY id ASC`,
		)
		.all(input.collabId, input.afterId) as Array<{
		id: number;
		event_name: string;
		payload_json: string;
	}>;
	return rows.map((r) => ({
		id: r.id,
		eventName: r.event_name as WorkflowOutboxEventName,
		payload: JSON.parse(r.payload_json) as Record<string, unknown>,
	}));
}
