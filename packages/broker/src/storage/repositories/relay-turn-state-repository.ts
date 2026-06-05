import type Database from "better-sqlite3";
import type { AgentType } from "@ai-whisper/shared";

export type RelayTurnStateRecord = {
	collabId: string;
	turnOwner: AgentType | "none";
	waitingAgent: AgentType | null;
	unresolvedHandoffId: string | null;
	handoffState: "idle" | "pending" | "deferred" | "accepted" | "stale_handoff" | "failed";
	handoffAgeMs: number | null;
	orchestratorEnabled: boolean;
	currentRound: number;
	maxRounds: number;
	chainStatus: "active" | "done" | "escalated" | "abandoned";
};

export function queryRelayTurnState(
	db: Database.Database,
	collabId: string,
	now = new Date().toISOString(),
): RelayTurnStateRecord {
	const row = db
		.prepare(
			`SELECT
				ts.collab_id AS collabId,
				ts.turn_owner AS turnOwner,
				ts.waiting_agent AS waitingAgent,
				ts.unresolved_handoff_id AS unresolvedHandoffId,
				ts.handoff_state AS handoffState,
				ts.orchestrator_enabled AS orchestratorEnabled,
				ts.current_round AS currentRound,
				ts.max_rounds AS maxRounds,
				ts.chain_status AS chainStatus,
				CASE
					WHEN h.created_at IS NULL THEN NULL
					ELSE CAST((julianday(?) - julianday(h.created_at)) * 86400000 AS INTEGER)
				END AS handoffAgeMs
			FROM relay_turn_state ts
			LEFT JOIN relay_handoff h ON h.handoff_id = ts.unresolved_handoff_id
			WHERE ts.collab_id = ?`,
		)
		.get(now, collabId) as
		| {
				collabId: string;
				turnOwner: string;
				waitingAgent: string | null;
				unresolvedHandoffId: string | null;
				handoffState: string;
				orchestratorEnabled: number;
				currentRound: number;
				maxRounds: number;
				chainStatus: string;
				handoffAgeMs: number | null;
		  }
		| undefined;

	if (!row) {
		return {
			collabId,
			turnOwner: "none",
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			handoffAgeMs: null,
			orchestratorEnabled: false,
			currentRound: 0,
			maxRounds: 3,
			chainStatus: "done",
		};
	}

	return {
		collabId: row.collabId,
		turnOwner: row.turnOwner as RelayTurnStateRecord["turnOwner"],
		waitingAgent: row.waitingAgent as RelayTurnStateRecord["waitingAgent"],
		unresolvedHandoffId: row.unresolvedHandoffId,
		handoffState: row.handoffState as RelayTurnStateRecord["handoffState"],
		handoffAgeMs: row.handoffAgeMs,
		orchestratorEnabled: row.orchestratorEnabled === 1,
		currentRound: row.currentRound,
		maxRounds: row.maxRounds,
		chainStatus: row.chainStatus as RelayTurnStateRecord["chainStatus"],
	};
}

export function upsertRelayTurnState(
	db: Database.Database,
	input: {
		collabId: string;
		turnOwner: AgentType | "none";
		waitingAgent: AgentType | null;
		unresolvedHandoffId: string | null;
		handoffState: RelayTurnStateRecord["handoffState"];
		updatedAt: string;
		orchestratorEnabled?: boolean;
		currentRound?: number;
		maxRounds?: number;
		chainStatus?: RelayTurnStateRecord["chainStatus"];
	},
): void {
	db.prepare(
		`INSERT INTO relay_turn_state (collab_id, turn_owner, waiting_agent, unresolved_handoff_id, handoff_state, updated_at, orchestrator_enabled, current_round, max_rounds, chain_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(collab_id) DO UPDATE SET
		   turn_owner = excluded.turn_owner,
		   waiting_agent = excluded.waiting_agent,
		   unresolved_handoff_id = excluded.unresolved_handoff_id,
		   handoff_state = excluded.handoff_state,
		   updated_at = excluded.updated_at,
		   orchestrator_enabled = excluded.orchestrator_enabled,
		   current_round = excluded.current_round,
		   max_rounds = excluded.max_rounds,
		   chain_status = excluded.chain_status`,
	).run(
		input.collabId,
		input.turnOwner,
		input.waitingAgent,
		input.unresolvedHandoffId,
		input.handoffState,
		input.updatedAt,
		input.orchestratorEnabled !== undefined ? (input.orchestratorEnabled ? 1 : 0) : 0,
		input.currentRound ?? 0,
		input.maxRounds ?? 3,
		input.chainStatus ?? "done",
	);
}
