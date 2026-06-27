import { describe, expect, it } from "vitest";
import { buildInspectSnapshot } from "../packages/cli/src/runtime/operator-inspect.ts";

function fakeBroker(bindings: Array<{ agentType: string; activeSessionId: string | null }>) {
	return {
		control: {
			listThreads: () => [],
			listSessionBindings: () => bindings.map((b) => ({
				agentType: b.agentType,
				activeSessionId: b.activeSessionId,
				bindingState: "bound",
				bindingSource: "mounted",
				targetTtyPath: null,
			})),
			listSessions: () => [],
			getRelayTurnState: () => ({
				turnOwner: "none", waitingAgent: null, handoffState: "idle", handoffAgeMs: null,
				orchestratorEnabled: false, currentRound: 0, maxRounds: 3, chainStatus: "done",
			}),
			getLatestHandedBackHandoff: () => null,
		},
	} as never;
}

describe("operator-inspect roles", () => {
	it("includes an agy role when agy is bound", () => {
		const snap = buildInspectSnapshot({
			broker: fakeBroker([{ agentType: "agy", activeSessionId: "s1" }]),
			state: { collabId: "c1", recovery: { state: "normal" } },
			now: "2026-06-27T00:00:00.000Z",
		});
		expect(snap.roles.map((r) => r.agentType)).toContain("agy");
	});
});
