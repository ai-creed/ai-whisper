import { describe, expect, it } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

const event: TurnEvent = {
	provider: "claude",
	workspaceId: "ws",
	cwd: "/r",
	sessionOrThreadId: "s",
	turnId: null,
	message: "the answer",
	inputMessages: ["do the thing"],
	receivedAt: "2026-06-11T00:00:00.000Z",
};

describe("relay handleTurnEvent — workflow gate (§4.1)", () => {
	it("logs ignored_no_workflow and delivers nothing when there is no accepted handoff", async () => {
		const h = makeRelayHarness({ acceptedHandoff: null });
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(event);
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.map((d) => d.action)).toEqual(["ignored_no_workflow"]);
		expect(h.turnEventDiagnostics[0]!.workflowActive).toBe(false);
	});

	it("logs ignored_no_workflow when the accepted handoff is not autonomous", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: {
				handoffId: "hf1",
				senderAgent: "claude",
				targetAgent: "claude",
				requestText: "do the thing",
				collabId: "c",
				status: "accepted",
			},
			autonomous: false,
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(event);
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.map((d) => d.action)).toEqual(["ignored_no_workflow"]);
	});
});
