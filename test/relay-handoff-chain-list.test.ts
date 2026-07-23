import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { listRelayHandoffsForChain } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";

describe("listRelayHandoffsForChain", () => {
	it("returns only the chain's handoffs, ascending, with handback and verdict fields", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		broker.control.startCollab({
			collabId: "collab_c1", workspaceRoot: "/tmp", displayName: "c1",
			orchestratorEnabled: true, orchestratorMaxRounds: 3, now: "2026-07-23T00:00:00Z",
		});
		const insert = broker.db.prepare(
			`INSERT INTO relay_handoff (handoff_id, collab_id, sender_agent, target_agent, status, request_text,
			   chain_id, round_number, handoff_step, handback_text, orchestrator_verdict, created_at, last_activity_at)
			 VALUES (?, 'collab_c1', 'claude', 'codex', 'handed_back', 'req', ?, ?, ?, ?, ?, ?, ?)`,
		);
		insert.run("ho_2", "ch_a", 2, "review", "second", "escalate", "2026-07-23T00:02:00Z", "2026-07-23T00:02:00Z");
		insert.run("ho_1", "ch_a", 1, "review", "first", "findings", "2026-07-23T00:01:00Z", "2026-07-23T00:01:00Z");
		insert.run("ho_x", "ch_other", 1, "review", "other-chain", "findings", "2026-07-23T00:01:30Z", "2026-07-23T00:01:30Z");

		const rows = listRelayHandoffsForChain(broker.db, "ch_a");
		expect(rows.map((r) => r.handoffId)).toEqual(["ho_1", "ho_2"]);
		expect(rows[0]).toMatchObject({
			roundNumber: 1, handoffStep: "review", handbackText: "first", orchestratorVerdict: "findings",
		});
	});
});
