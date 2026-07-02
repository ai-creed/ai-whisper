import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentType } from "@ai-whisper/shared";

/** Cosmetic-only flavor for a claimed duo character; carries no behavioral
 * meaning beyond what is printed in the mount banner. Mirrors the CLI-side
 * `DuoRole` (packages/cli/src/duo/duo-table.ts) WITHOUT importing it — the
 * broker never depends on packages/cli. */
export const duoRoleSchema = z.enum(["reviewer", "implementer"]);
export type DuoRole = z.infer<typeof duoRoleSchema>;

export const duoRollSlotSchema = z.object({
	characterId: z.string().min(1),
	characterName: z.string().min(1),
	role: duoRoleSchema,
});
export type DuoRollSlot = z.infer<typeof duoRollSlotSchema>;

/** Shape of the CLI-rolled duo as it crosses into the broker as plain data
 * (matches `RolledDuo` from packages/cli/src/duo/roll-duo.ts by convention
 * only — defined independently here, never imported). */
export const proposedDuoRollSchema = z.object({
	duoId: z.string().min(1),
	slots: z.tuple([duoRollSlotSchema, duoRollSlotSchema]),
});
export type ProposedDuoRoll = z.infer<typeof proposedDuoRollSchema>;

/** The full rolled pair persisted at first claim, keyed by collab. Both
 * slots are stored (including the still-latent one) so the broker can hand
 * it to the second claimant without re-consulting the CLI-side duo table. */
export type DuoRollRecord = {
	collabId: string;
	duoId: string;
	slots: [DuoRollSlot, DuoRollSlot];
	rolledAt: string;
};

/** One agent's CLAIMED duo character for a collab. Display surfaces key
 * exclusively on this record (never on the latent `duo_roll` slot). */
export type DuoAssignmentRecord = {
	collabId: string;
	agentType: AgentType;
	duoId: string;
	characterId: string;
	characterName: string;
	role: DuoRole;
	assignedAt: string;
};

type DuoRollRow = {
	collab_id: string;
	duo_id: string;
	slot0_character_id: string;
	slot0_character_name: string;
	slot0_role: string;
	slot1_character_id: string;
	slot1_character_name: string;
	slot1_role: string;
	rolled_at: string;
};

function rowToDuoRoll(row: DuoRollRow): DuoRollRecord {
	return {
		collabId: row.collab_id,
		duoId: row.duo_id,
		slots: [
			duoRollSlotSchema.parse({
				characterId: row.slot0_character_id,
				characterName: row.slot0_character_name,
				role: row.slot0_role,
			}),
			duoRollSlotSchema.parse({
				characterId: row.slot1_character_id,
				characterName: row.slot1_character_name,
				role: row.slot1_role,
			}),
		],
		rolledAt: row.rolled_at,
	};
}

/**
 * Persist the full rolled pair for a collab. The table PK is `collab_id`, so
 * a second insert for the same collab throws a UNIQUE constraint error
 * rather than silently creating (or replacing) a second roll — callers must
 * check `getDuoRoll` first (as `claimDuoCharacter` does).
 */
export function insertDuoRoll(db: Database.Database, roll: DuoRollRecord): void {
	const [slot0, slot1] = roll.slots;
	db.prepare(
		`INSERT INTO duo_roll (
			collab_id, duo_id,
			slot0_character_id, slot0_character_name, slot0_role,
			slot1_character_id, slot1_character_name, slot1_role,
			rolled_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		roll.collabId,
		roll.duoId,
		slot0.characterId,
		slot0.characterName,
		slot0.role,
		slot1.characterId,
		slot1.characterName,
		slot1.role,
		roll.rolledAt,
	);
}

export function getDuoRoll(
	db: Database.Database,
	collabId: string,
): DuoRollRecord | null {
	const row = db
		.prepare(
			`SELECT collab_id, duo_id,
			        slot0_character_id, slot0_character_name, slot0_role,
			        slot1_character_id, slot1_character_name, slot1_role,
			        rolled_at
			   FROM duo_roll
			  WHERE collab_id = ?`,
		)
		.get(collabId) as DuoRollRow | undefined;
	return row ? rowToDuoRoll(row) : null;
}

type DuoAssignmentRow = {
	collab_id: string;
	agent_type: AgentType;
	duo_id: string;
	character_id: string;
	character_name: string;
	role: string;
	assigned_at: string;
};

function rowToDuoAssignment(row: DuoAssignmentRow): DuoAssignmentRecord {
	return {
		collabId: row.collab_id,
		agentType: row.agent_type,
		duoId: row.duo_id,
		characterId: row.character_id,
		characterName: row.character_name,
		role: duoRoleSchema.parse(row.role),
		assignedAt: row.assigned_at,
	};
}

/** Insert-or-replace a claimed slot for (collabId, agentType). */
export function upsertDuoAssignment(
	db: Database.Database,
	row: DuoAssignmentRecord,
): void {
	db.prepare(
		`INSERT INTO duo_assignment
			(collab_id, agent_type, duo_id, character_id, character_name, role, assigned_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(collab_id, agent_type) DO UPDATE SET
			duo_id = excluded.duo_id,
			character_id = excluded.character_id,
			character_name = excluded.character_name,
			role = excluded.role,
			assigned_at = excluded.assigned_at`,
	).run(
		row.collabId,
		row.agentType,
		row.duoId,
		row.characterId,
		row.characterName,
		row.role,
		row.assignedAt,
	);
}

export function getDuoAssignment(
	db: Database.Database,
	collabId: string,
	agentType: AgentType,
): DuoAssignmentRecord | null {
	const row = db
		.prepare(
			`SELECT collab_id, agent_type, duo_id, character_id, character_name, role, assigned_at
			   FROM duo_assignment
			  WHERE collab_id = ? AND agent_type = ?`,
		)
		.get(collabId, agentType) as DuoAssignmentRow | undefined;
	return row ? rowToDuoAssignment(row) : null;
}

export function listDuoAssignments(
	db: Database.Database,
	collabId: string,
): DuoAssignmentRecord[] {
	const rows = db
		.prepare(
			`SELECT collab_id, agent_type, duo_id, character_id, character_name, role, assigned_at
			   FROM duo_assignment
			  WHERE collab_id = ?
			  ORDER BY assigned_at`,
		)
		.all(collabId) as DuoAssignmentRow[];
	return rows.map(rowToDuoAssignment);
}

/** Deletes the assignment row if present; a no-op (0 changes) when absent. */
export function deleteDuoAssignment(
	db: Database.Database,
	collabId: string,
	agentType: AgentType,
): number {
	return db
		.prepare("DELETE FROM duo_assignment WHERE collab_id = ? AND agent_type = ?")
		.run(collabId, agentType).changes;
}
