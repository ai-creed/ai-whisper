import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";
import { relayHandoffHasColumn } from "./relay-handoff-repository.js";

export type NoticePathFields = {
	deliveryPath: string | null;
	fetchedAt: string | null;
	fetchCount: number;
	capturePath: string | null;
	repliedAt: string | null;
	replyRefusedAt: string | null;
};

export function recordHandoffFetch(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.prepare(
		`UPDATE relay_handoff
		    SET fetched_at = COALESCE(fetched_at, ?), fetch_count = fetch_count + 1
		  WHERE handoff_id = ?`,
	).run(input.now, input.handoffId);
}

export function markHandoffReplied(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.prepare(
		"UPDATE relay_handoff SET capture_path = 'reply', replied_at = ? WHERE handoff_id = ?",
	).run(input.now, input.handoffId);
}

export function recordHandoffReplyRefused(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.prepare("UPDATE relay_handoff SET reply_refused_at = ? WHERE handoff_id = ?").run(
		input.now,
		input.handoffId,
	);
}

function sessionBindingHasTurnDoneAt(db: Database.Database): boolean {
	return (db.prepare("PRAGMA table_info(session_binding)").all() as Array<{ name: string }>).some(
		(c) => c.name === "turn_done_at",
	);
}

// Updates the seat's existing binding row only. Returns false when nothing was
// written: no binding row for the seat, or a DB that predates the column.
export function markSessionBindingTurnDone(
	db: Database.Database,
	input: { collabId: string; agent: AgentType; now: string },
): boolean {
	if (!sessionBindingHasTurnDoneAt(db)) return false;
	const result = db
		.prepare("UPDATE session_binding SET turn_done_at = ? WHERE collab_id = ? AND agent_type = ?")
		.run(input.now, input.collabId, input.agent);
	return result.changes > 0;
}

export function getSessionBindingTurnDone(
	db: Database.Database,
	input: { collabId: string; agent: AgentType },
): string | null {
	if (!sessionBindingHasTurnDoneAt(db)) return null;
	const row = db
		.prepare("SELECT turn_done_at FROM session_binding WHERE collab_id = ? AND agent_type = ?")
		.get(input.collabId, input.agent) as { turn_done_at: string | null } | undefined;
	return row?.turn_done_at ?? null;
}

export function findFetchedUnrepliedHandoff(
	db: Database.Database,
	input: { collabId: string; agent: AgentType },
): string | null {
	// Reads must not throw on a DB that predates the notice-path columns.
	if (!relayHandoffHasColumn(db, "fetched_at") || !relayHandoffHasColumn(db, "replied_at")) {
		return null;
	}
	const row = db
		.prepare(
			`SELECT handoff_id FROM relay_handoff
			  WHERE collab_id = ? AND target_agent = ? AND status = 'accepted'
			    AND workflow_id IS NOT NULL AND fetched_at IS NOT NULL AND replied_at IS NULL
			  ORDER BY accepted_at DESC LIMIT 1`,
		)
		.get(input.collabId, input.agent) as { handoff_id: string } | undefined;
	return row?.handoff_id ?? null;
}

export function getNoticePathFields(
	db: Database.Database,
	handoffId: string,
): NoticePathFields | null {
	const col = (name: string, fallback = "NULL") =>
		relayHandoffHasColumn(db, name) ? name : `${fallback} AS ${name}`;
	const row = db
		.prepare(
			`SELECT ${col("delivery_path")}, ${col("fetched_at")}, ${col("fetch_count", "0")},
			        ${col("capture_path")}, ${col("replied_at")}, ${col("reply_refused_at")}
			   FROM relay_handoff WHERE handoff_id = ?`,
		)
		.get(handoffId) as
		| {
				delivery_path: string | null;
				fetched_at: string | null;
				fetch_count: number;
				capture_path: string | null;
				replied_at: string | null;
				reply_refused_at: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		deliveryPath: row.delivery_path,
		fetchedAt: row.fetched_at,
		fetchCount: row.fetch_count,
		capturePath: row.capture_path,
		repliedAt: row.replied_at,
		replyRefusedAt: row.reply_refused_at,
	};
}
