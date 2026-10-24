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

export type NoticePathState = {
	deliveryPath: string | null;
	noticeSentAt: string | null;
	reminderSentAt: string | null;
	nudgeSentAt: string | null;
	fetchedAt: string | null;
	capturePath: string | null;
	repliedAt: string | null;
	replyRefusedAt: string | null;
	/** The handoff target seat's session_binding.turn_done_at. */
	turnDoneAt: string | null;
};

export function getNoticePathState(
	db: Database.Database,
	handoffId: string,
): NoticePathState | null {
	const col = (name: string) => (relayHandoffHasColumn(db, name) ? name : `NULL AS ${name}`);
	const row = db
		.prepare(
			`SELECT collab_id, target_agent, ${col("delivery_path")}, ${col("notice_sent_at")},
			        ${col("reminder_sent_at")}, ${col("nudge_sent_at")}, ${col("fetched_at")},
			        ${col("capture_path")}, ${col("replied_at")}, ${col("reply_refused_at")}
			   FROM relay_handoff WHERE handoff_id = ?`,
		)
		.get(handoffId) as
		| {
				collab_id: string;
				target_agent: AgentType;
				delivery_path: string | null;
				notice_sent_at: string | null;
				reminder_sent_at: string | null;
				nudge_sent_at: string | null;
				fetched_at: string | null;
				capture_path: string | null;
				replied_at: string | null;
				reply_refused_at: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		deliveryPath: row.delivery_path,
		noticeSentAt: row.notice_sent_at,
		reminderSentAt: row.reminder_sent_at,
		nudgeSentAt: row.nudge_sent_at,
		fetchedAt: row.fetched_at,
		capturePath: row.capture_path,
		repliedAt: row.replied_at,
		replyRefusedAt: row.reply_refused_at,
		turnDoneAt: getSessionBindingTurnDone(db, {
			collabId: row.collab_id,
			agent: row.target_agent,
		}),
	};
}

// Caller owns the transaction and has already verified the claim preconditions.
// Returns false (writing nothing) on a DB that predates the columns.
export function markHandoffNoticeSent(
	db: Database.Database,
	input: { handoffId: string; now: string },
): boolean {
	if (!relayHandoffHasColumn(db, "notice_sent_at") || !relayHandoffHasColumn(db, "delivery_path")) {
		return false;
	}
	return (
		db
			.prepare(
				`UPDATE relay_handoff SET notice_sent_at = ?, delivery_path = 'notice'
				  WHERE handoff_id = ? AND notice_sent_at IS NULL`,
			)
			.run(input.now, input.handoffId).changes > 0
	);
}

export function claimNoticeStep(
	db: Database.Database,
	input: { handoffId: string; kind: "reminder" | "nudge"; now: string },
): boolean {
	const column = input.kind === "reminder" ? "reminder_sent_at" : "nudge_sent_at";
	if (!relayHandoffHasColumn(db, column)) return false;
	return (
		db
			.prepare(`UPDATE relay_handoff SET ${column} = ? WHERE handoff_id = ? AND ${column} IS NULL`)
			.run(input.now, input.handoffId).changes > 0
	);
}

// First writer wins, except that a handoff already on the notice path may switch
// to paste when the ladder falls back, and only while it is unfetched: a fetched
// request is never pasted. Returns whether the row changed.
export function markHandoffDeliveryPath(
	db: Database.Database,
	input: { handoffId: string; path: "paste" | "native" },
): boolean {
	if (!relayHandoffHasColumn(db, "delivery_path")) return false;
	const unfetched = relayHandoffHasColumn(db, "fetched_at") ? "fetched_at IS NULL" : "1";
	return (
		db
			.prepare(
				`UPDATE relay_handoff SET delivery_path = ?
				  WHERE handoff_id = ?
				    AND (delivery_path IS NULL
				         OR (delivery_path = 'notice' AND ? = 'paste' AND ${unfetched}))`,
			)
			.run(input.path, input.handoffId, input.path).changes > 0
	);
}

export function countWorkflowFallbacks(db: Database.Database, workflowId: string): number {
	if (!relayHandoffHasColumn(db, "delivery_path") || !relayHandoffHasColumn(db, "capture_path")) {
		return 0;
	}
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM relay_handoff
			  WHERE workflow_id = ? AND (delivery_path = 'paste' OR capture_path = 'copy')`,
		)
		.get(workflowId) as { n: number };
	return row.n;
}
