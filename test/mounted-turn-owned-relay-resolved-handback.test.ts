import { describe, expect, it, vi } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

// getAcceptedHandoff() reads refreshTurnState() → getRelayTurnState(collabId, now)
// then getRelayHandoff(unresolvedHandoffId). Model exactly that surface.
function fakeBroker(handoff: {
	handoffId: string;
	status: string;
	targetAgent: string;
	senderAgent: "codex" | "claude";
	requestText: string;
} | null) {
	const handoffBackRelay = vi.fn();
	const control = {
		getRelayTurnState: vi.fn(() => ({
			turnOwner: "ezio",
			unresolvedHandoffId: handoff ? handoff.handoffId : null,
			handoffState: handoff ? "accepted" : null,
			handoffAgeMs: 1_000,
			waitingAgent: null,
		})),
		getRelayHandoff: vi.fn((id: string) => (handoff && id === handoff.handoffId ? handoff : null)),
		markRelayHandoffStale: vi.fn(),
		handoffBackRelay,
	};
	return { broker: { control } as never, handoffBackRelay };
}

const baseInput = {
	collabId: "c1",
	currentAgent: "ezio" as const,
	writeLocalMessage: vi.fn(),
	writeUserInput: vi.fn(),
	submitUserInput: vi.fn(),
	openComposer: vi.fn(),
};

describe("mounted-turn-owned-relay handbackResolvedContent", () => {
	it("hands back the provided content to the original sender, captureStatus ok", async () => {
		const { broker, handoffBackRelay } = fakeBroker({
			handoffId: "h1",
			status: "accepted",
			targetAgent: "ezio",
			senderAgent: "claude",
			requestText: "please do X",
		});
		const relay = createMountedTurnOwnedRelay({ ...baseInput, broker } as never);

		await relay.handbackResolvedContent("the final answer");

		expect(handoffBackRelay).toHaveBeenCalledTimes(1);
		const arg = handoffBackRelay.mock.calls[0]![0];
		expect(arg).toMatchObject({
			handoffId: "h1",
			senderAgent: "ezio",
			targetAgent: "claude",
			requestText: "the final answer",
			captureStatus: "ok",
		});
	});

	it("no-ops when there is no accepted handoff", async () => {
		const { broker, handoffBackRelay } = fakeBroker(null);
		const relay = createMountedTurnOwnedRelay({ ...baseInput, broker } as never);
		await relay.handbackResolvedContent("ignored");
		expect(handoffBackRelay).not.toHaveBeenCalled();
	});
});
