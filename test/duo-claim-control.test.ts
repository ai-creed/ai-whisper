import { describe, expect, it } from "vitest";
import { createBrokerRuntime, upsertSessionAttachment } from "../packages/broker/src/index.ts";
import {
	getDuoRoll,
	type DuoRollSlot,
} from "../packages/broker/src/storage/repositories/duo-assignment-repository.ts";

function bootstrap() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4902,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('collab_c1','/tmp','collab_c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	return { broker, db };
}

const sherlockWatsonRoll: { duoId: string; slots: [DuoRollSlot, DuoRollSlot] } = {
	duoId: "sherlock-watson",
	slots: [
		{ characterId: "watson", characterName: "Watson", role: "body" },
		{ characterId: "sherlock", characterName: "Sherlock", role: "brain" },
	],
};

// A deliberately DIFFERENT roll a second claimant might propose — must be
// ignored once a roll already exists for the collab.
const batmanRobinRoll: { duoId: string; slots: [DuoRollSlot, DuoRollSlot] } = {
	duoId: "batman-robin",
	slots: [
		{ characterId: "robin", characterName: "Robin", role: "body" },
		{ characterId: "batman", characterName: "Batman", role: "brain" },
	],
};

function seedMounted(
	db: ReturnType<typeof bootstrap>["db"],
	agentType: "codex" | "claude" | "ezio",
	pid: number | null,
) {
	upsertSessionAttachment(db, {
		collabId: "collab_c1",
		agentType,
		attachmentKind: "mounted",
		sessionId: `session_${agentType}`,
		providerId: null,
		launchMode: null,
		ttyPath: "/dev/ttys001",
		pid,
		windowLabel: null,
		attachedAt: "2026-04-21T00:00:00Z",
	});
}

describe("duo claim/release control", () => {
	it("first claim persists the FULL proposed roll and claims slot 0", () => {
		const { broker, db } = bootstrap();
		const result = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "codex",
			proposedRoll: sherlockWatsonRoll,
		});

		expect(result.outcome).toBe("claimed");
		expect(result.assignment).toMatchObject({
			collabId: "collab_c1",
			agentType: "codex",
			duoId: "sherlock-watson",
			characterId: "watson",
			characterName: "Watson",
			role: "body",
		});
		expect(result.teammate).toBeNull();

		const roll = getDuoRoll(db, "collab_c1");
		expect(roll?.duoId).toBe("sherlock-watson");
		expect(roll?.slots).toEqual(sherlockWatsonRoll.slots);
	});

	it("second claim (other agentType) gets the latent slot verbatim; its own DIFFERENT proposedRoll is ignored", () => {
		const { broker } = bootstrap();
		const first = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "codex",
			proposedRoll: sherlockWatsonRoll,
		});

		const second = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "claude",
			proposedRoll: batmanRobinRoll, // ignored: roll already exists
		});

		expect(second.outcome).toBe("claimed");
		expect(second.assignment).toMatchObject({
			collabId: "collab_c1",
			agentType: "claude",
			duoId: "sherlock-watson",
			characterId: "sherlock",
			characterName: "Sherlock",
			role: "brain",
		});
		// teammate populated: the first claimer's row.
		expect(second.teammate).toEqual(first.assignment);
	});

	it("same agentType re-claim is idempotent (existing, same row)", () => {
		const { broker } = bootstrap();
		const first = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "codex",
			proposedRoll: sherlockWatsonRoll,
		});

		const again = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "codex",
			proposedRoll: batmanRobinRoll, // irrelevant on remount
		});

		expect(again.outcome).toBe("existing");
		expect(again.assignment).toEqual(first.assignment);
	});

	it("third agent falls back (no trio) when both owners are live", () => {
		const { broker, db } = bootstrap();
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "codex", proposedRoll: sherlockWatsonRoll });
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "claude", proposedRoll: sherlockWatsonRoll });

		seedMounted(db, "codex", 100);
		seedMounted(db, "claude", 200);

		const third = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "ezio",
			proposedRoll: sherlockWatsonRoll,
			isPidAlive: () => true,
		});

		expect(third.outcome).toBe("fallback");
		expect(third.assignment).toBeNull();
		expect(broker.control.listDuoAssignmentsForCollab("collab_c1")).toHaveLength(2);
	});

	it("third agent inherits when the owner's pid is present but isPidAlive() reports dead", () => {
		const { broker, db } = bootstrap();
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "codex", proposedRoll: sherlockWatsonRoll });
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "claude", proposedRoll: sherlockWatsonRoll });

		seedMounted(db, "codex", 100); // dead
		seedMounted(db, "claude", 200); // alive

		const third = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "ezio",
			proposedRoll: sherlockWatsonRoll,
			isPidAlive: (pid) => pid !== 100,
		});

		expect(third.outcome).toBe("inherited");
		expect(third.assignment).toMatchObject({ agentType: "ezio", characterId: "watson" });
		expect(third.teammate).toMatchObject({ agentType: "claude", characterId: "sherlock" });
		expect(broker.control.listDuoAssignmentsForCollab("collab_c1").find((r) => r.agentType === "codex")).toBeUndefined();
	});

	it("third agent inherits when the owner has no session_attachment row at all", () => {
		const { broker, db } = bootstrap();
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "codex", proposedRoll: sherlockWatsonRoll });
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "claude", proposedRoll: sherlockWatsonRoll });

		// No attachment row seeded for codex at all.
		seedMounted(db, "claude", 200); // alive

		const third = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "ezio",
			proposedRoll: sherlockWatsonRoll,
			isPidAlive: () => true,
		});

		expect(third.outcome).toBe("inherited");
		expect(third.assignment).toMatchObject({ agentType: "ezio", characterId: "watson" });
	});

	it("third agent inherits when the owner's attachment row has a null pid", () => {
		const { broker, db } = bootstrap();
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "codex", proposedRoll: sherlockWatsonRoll });
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "claude", proposedRoll: sherlockWatsonRoll });

		seedMounted(db, "codex", null); // attachment row present, pid null
		seedMounted(db, "claude", 200); // alive

		const third = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "ezio",
			proposedRoll: sherlockWatsonRoll,
			isPidAlive: () => true,
		});

		expect(third.outcome).toBe("inherited");
		expect(third.assignment).toMatchObject({ agentType: "ezio", characterId: "watson" });
	});

	it("releaseDuoCharacter deletes the claim but leaves duo_roll intact; the freed slot re-claims identically", () => {
		const { broker, db } = bootstrap();
		broker.control.claimDuoCharacter({ collabId: "collab_c1", agentType: "codex", proposedRoll: sherlockWatsonRoll });

		broker.control.releaseDuoCharacter({ collabId: "collab_c1", agentType: "codex" });

		expect(broker.control.listDuoAssignmentsForCollab("collab_c1")).toHaveLength(0);
		expect(getDuoRoll(db, "collab_c1")).not.toBeNull();

		const reclaim = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "claude",
			proposedRoll: batmanRobinRoll, // still ignored: roll persists
		});

		expect(reclaim.outcome).toBe("claimed");
		expect(reclaim.assignment).toMatchObject({
			agentType: "claude",
			characterId: "watson",
			characterName: "Watson",
			role: "body",
		});
	});

	it("normalizes a legacy reviewer/implementer proposedRoll (mixed-version safety)", () => {
		const { broker } = bootstrap();
		const result = broker.control.claimDuoCharacter({
			collabId: "collab_c1",
			agentType: "codex",
			proposedRoll: {
				duoId: "sherlock-watson",
				slots: [
					{ characterId: "sherlock", characterName: "Sherlock", role: "reviewer" },
					{ characterId: "watson", characterName: "Watson", role: "implementer" },
				],
			} as never,
		});

		expect(result.outcome).toBe("claimed");
		expect(result.assignment?.role).toBe("brain");
	});
});
