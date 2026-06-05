import type Database from "better-sqlite3";
import { type AgentType,  attachClaimSchema, type AttachClaim } from "@ai-whisper/shared";

type AttachClaimRow = {
	claim_id: string;
	collab_id: string;
	agent_type: AgentType;
	mode: "attach" | "rebind" | "reconnect";
	target_mode: "snippet_shell" | "adopt_current_tty" | "explicit_tty" | null;
	target_tty_path: string | null;
	secret: string;
	status: "pending" | "consumed" | "expired" | "replaced";
	created_at: string;
	expires_at: string;
	consumed_at: string | null;
};

function mapRowToClaim(row: AttachClaimRow): AttachClaim {
	return attachClaimSchema.parse({
		version: 1,
		claimId: row.claim_id,
		collabId: row.collab_id,
		agentType: row.agent_type,
		mode: row.mode,
		targetMode: row.target_mode ?? "snippet_shell",
		targetTtyPath: row.target_tty_path ?? null,
		secret: row.secret,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at ?? null,
	});
}

export function insertAttachClaim(
	db: Database.Database,
	claim: AttachClaim,
): void {
	db.prepare(
		`INSERT INTO attach_claim (
      claim_id,
      collab_id,
      agent_type,
      mode,
      target_mode,
      target_tty_path,
      secret,
      status,
      created_at,
      expires_at,
      consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		claim.claimId,
		claim.collabId,
		claim.agentType,
		claim.mode,
		claim.targetMode,
		claim.targetTtyPath ?? null,
		claim.secret,
		claim.status,
		claim.createdAt,
		claim.expiresAt,
		claim.consumedAt ?? null,
	);
}

export function getAttachClaim(
	db: Database.Database,
	claimId: string,
): AttachClaim | null {
	const row = db
		.prepare(
			`SELECT claim_id, collab_id, agent_type, mode, target_mode, target_tty_path, secret, status, created_at, expires_at, consumed_at
       FROM attach_claim
       WHERE claim_id = ?`,
		)
		.get(claimId) as AttachClaimRow | undefined;

	if (!row) {
		return null;
	}

	return mapRowToClaim(row);
}

export function markAttachClaimConsumed(
	db: Database.Database,
	claimId: string,
	consumedAt: string,
): void {
	db.prepare(
		"UPDATE attach_claim SET status = 'consumed', consumed_at = ? WHERE claim_id = ?",
	).run(consumedAt, claimId);
}

export function markAttachClaimReplaced(
	db: Database.Database,
	claimId: string,
): void {
	db.prepare(
		"UPDATE attach_claim SET status = 'replaced' WHERE claim_id = ?",
	).run(claimId);
}
