import type Database from "better-sqlite3";
import { sessionBindingSchema, type SessionBinding } from "@ai-whisper/shared";

type SessionBindingRow = {
	collab_id: string;
	agent_type: "codex" | "claude" | "ai-ezio";
	binding_state: "unbound" | "pending_attach" | "bound";
	active_session_id: string | null;
	binding_source: "launched" | "attached" | "adopted" | null;
	target_tty_path: string | null;
	pending_claim_id: string | null;
	pending_claim_expires_at: string | null;
	updated_at: string;
};

function mapRowToBinding(row: SessionBindingRow): SessionBinding {
	return sessionBindingSchema.parse({
		version: 1,
		collabId: row.collab_id,
		agentType: row.agent_type,
		bindingState: row.binding_state,
		activeSessionId: row.active_session_id ?? null,
		bindingSource: row.binding_source ?? null,
		targetTtyPath: row.target_tty_path ?? null,
		pendingClaimId: row.pending_claim_id ?? null,
		pendingClaimExpiresAt: row.pending_claim_expires_at ?? null,
		updatedAt: row.updated_at,
	});
}

export function upsertSessionBinding(
	db: Database.Database,
	binding: SessionBinding,
): void {
	db.prepare(
		`INSERT INTO session_binding (
      collab_id,
      agent_type,
      binding_state,
      active_session_id,
      binding_source,
      target_tty_path,
      pending_claim_id,
      pending_claim_expires_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collab_id, agent_type) DO UPDATE SET
      binding_state = excluded.binding_state,
      active_session_id = excluded.active_session_id,
      binding_source = excluded.binding_source,
      target_tty_path = excluded.target_tty_path,
      pending_claim_id = excluded.pending_claim_id,
      pending_claim_expires_at = excluded.pending_claim_expires_at,
      updated_at = excluded.updated_at`,
	).run(
		binding.collabId,
		binding.agentType,
		binding.bindingState,
		binding.activeSessionId ?? null,
		binding.bindingSource ?? null,
		binding.targetTtyPath ?? null,
		binding.pendingClaimId ?? null,
		binding.pendingClaimExpiresAt ?? null,
		binding.updatedAt,
	);
}

export function getSessionBinding(
	db: Database.Database,
	collabId: string,
	agentType: "codex" | "claude" | "ai-ezio",
): SessionBinding | null {
	const row = db
		.prepare(
			`SELECT collab_id, agent_type, binding_state, active_session_id, binding_source, target_tty_path, pending_claim_id, pending_claim_expires_at, updated_at
       FROM session_binding
       WHERE collab_id = ? AND agent_type = ?`,
		)
		.get(collabId, agentType) as SessionBindingRow | undefined;

	if (!row) {
		return null;
	}

	return mapRowToBinding(row);
}

export function listSessionBindingsForCollab(
	db: Database.Database,
	collabId: string,
): SessionBinding[] {
	const rows = db
		.prepare(
			`SELECT collab_id, agent_type, binding_state, active_session_id, binding_source, target_tty_path, pending_claim_id, pending_claim_expires_at, updated_at
       FROM session_binding
       WHERE collab_id = ?
       ORDER BY agent_type ASC`,
		)
		.all(collabId) as SessionBindingRow[];

	return rows.map(mapRowToBinding);
}
