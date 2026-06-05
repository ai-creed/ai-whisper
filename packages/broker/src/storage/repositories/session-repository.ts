import type Database from "better-sqlite3";
import { type AgentType,  sessionSchema, type Session } from "@ai-whisper/shared";

type SessionRow = {
	session_id: string;
	collab_id: string;
	agent_type: AgentType;
	registration_state: "registered";
	health_state: "healthy" | "degraded" | "offline";
	capabilities_json: string;
	registered_at: string;
	last_seen_at: string;
};

function mapRowToSession(row: SessionRow): Session {
	return sessionSchema.parse({
		version: 1,
		sessionId: row.session_id,
		collabId: row.collab_id,
		agentType: row.agent_type,
		registrationState: row.registration_state,
		healthState: row.health_state,
		capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown>,
		registeredAt: row.registered_at,
		lastSeenAt: row.last_seen_at,
	});
}

export function insertSession(db: Database.Database, session: Session): void {
	db.prepare(
		`INSERT INTO session (
      session_id,
      collab_id,
      agent_type,
      registration_state,
      health_state,
      capabilities_json,
      registered_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		session.sessionId,
		session.collabId,
		session.agentType,
		session.registrationState,
		session.healthState,
		JSON.stringify(session.capabilities),
		session.registeredAt,
		session.lastSeenAt,
	);
}

export function updateSessionHealth(
	db: Database.Database,
	sessionId: string,
	healthState: "healthy" | "degraded" | "offline",
	lastSeenAt: string,
): void {
	db.prepare(
		"UPDATE session SET health_state = ?, last_seen_at = ? WHERE session_id = ?",
	).run(healthState, lastSeenAt, sessionId);
}

export function getSession(
	db: Database.Database,
	sessionId: string,
): Session | null {
	const row = db
		.prepare(
			`SELECT session_id, collab_id, agent_type, registration_state, health_state, capabilities_json, registered_at, last_seen_at
     FROM session
     WHERE session_id = ?`,
		)
		.get(sessionId) as SessionRow | undefined;

	if (!row) {
		return null;
	}

	return mapRowToSession(row);
}

// Deletes superseded `session` rows for a (collab, agent), keeping only the
// active/kept session id. Scoped strictly to (collab_id, agent_type) so other
// agents and other collabs are never touched. No table FK-references `session`,
// so a plain DELETE is safe (verified against the schema). Returns the number
// of rows deleted.
export function reapSupersededSessions(
	db: Database.Database,
	collabId: string,
	agentType: string,
	keepSessionId: string,
): number {
	const res = db
		.prepare(
			`DELETE FROM session
			  WHERE collab_id = ? AND agent_type = ? AND session_id <> ?`,
		)
		.run(collabId, agentType, keepSessionId);
	return res.changes;
}

export function listSessionsForCollab(
	db: Database.Database,
	collabId: string,
): Session[] {
	const rows = db
		.prepare(
			`SELECT session_id, collab_id, agent_type, registration_state, health_state, capabilities_json, registered_at, last_seen_at
       FROM session
       WHERE collab_id = ?
       ORDER BY registered_at ASC`,
		)
		.all(collabId) as SessionRow[];

	return rows.map(mapRowToSession);
}
