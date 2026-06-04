import type Database from "better-sqlite3";

export type AgentType = "codex" | "claude" | "ai-ezio";
export type AttachmentKind = "owned" | "adopted" | "mounted";

export type SessionAttachmentRecord = {
	collabId: string;
	agentType: AgentType;
	attachmentKind: AttachmentKind;
	sessionId: string | null;
	providerId: string | null;
	launchMode: "tmux" | "terminals" | null;
	ttyPath: string | null;
	pid: number | null;
	windowLabel: string | null;
	attachedAt: string;
};

type Row = {
	collab_id: string;
	agent_type: AgentType;
	attachment_kind: AttachmentKind;
	session_id: string | null;
	provider_id: string | null;
	launch_mode: "tmux" | "terminals" | null;
	tty_path: string | null;
	pid: number | null;
	window_label: string | null;
	attached_at: string;
};

function toRecord(row: Row): SessionAttachmentRecord {
	return {
		collabId: row.collab_id,
		agentType: row.agent_type,
		attachmentKind: row.attachment_kind,
		sessionId: row.session_id,
		providerId: row.provider_id,
		launchMode: row.launch_mode,
		ttyPath: row.tty_path,
		pid: row.pid,
		windowLabel: row.window_label,
		attachedAt: row.attached_at,
	};
}

export function upsertSessionAttachment(
	db: Database.Database,
	input: SessionAttachmentRecord,
): void {
	db.prepare(`
		INSERT INTO session_attachment
			(collab_id, agent_type, attachment_kind, session_id, provider_id,
			 launch_mode, tty_path, pid, window_label, attached_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(collab_id, agent_type, attachment_kind) DO UPDATE SET
			session_id = excluded.session_id,
			provider_id = excluded.provider_id,
			launch_mode = excluded.launch_mode,
			tty_path = excluded.tty_path,
			pid = excluded.pid,
			window_label = excluded.window_label,
			attached_at = excluded.attached_at
	`).run(
		input.collabId,
		input.agentType,
		input.attachmentKind,
		input.sessionId,
		input.providerId,
		input.launchMode,
		input.ttyPath,
		input.pid,
		input.windowLabel,
		input.attachedAt,
	);
}

export function listSessionAttachmentsByCollab(
	db: Database.Database,
	collabId: string,
): SessionAttachmentRecord[] {
	const rows = db
		.prepare(
			"SELECT collab_id, agent_type, attachment_kind, session_id, provider_id, launch_mode, tty_path, pid, window_label, attached_at FROM session_attachment WHERE collab_id = ? ORDER BY attached_at",
		)
		.all(collabId) as Row[];
	return rows.map(toRecord);
}

export function deleteSessionAttachment(
	db: Database.Database,
	input: { collabId: string; agentType: AgentType; attachmentKind: AttachmentKind },
): number {
	return db
		.prepare(
			"DELETE FROM session_attachment WHERE collab_id = ? AND agent_type = ? AND attachment_kind = ?",
		)
		.run(input.collabId, input.agentType, input.attachmentKind).changes;
}
