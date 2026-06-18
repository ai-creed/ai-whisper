import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession, type AiEzioEngineSession } from "@ai-whisper/adapter-ai-ezio";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { submitInjectedProviderInput } from "../packages/cli/src/runtime/provider-submit-strategy.ts";

// Fake engine: on submit(text) it emits the finished turn + idle on a LATER tick
// (setTimeout macrotask) so the relay's acceptRelayHandoff (a microtask inside
// acceptPendingHandoff) flips the handoff to "accepted" BEFORE the idle-driven
// handback reads state via getAcceptedHandoff().
function fakeEngine(reply: string) {
	let emit: (e: ProtocolEvent) => void = () => {};
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		transcriptPath: undefined,
		newConversation: vi.fn(async () => {}),
		status: vi.fn(async () => ({ provider: "mock", model: "mock" })),
		submit: vi.fn(() => {
			setTimeout(() => {
				emit({ type: "assistant_turn_finished", turnId: "t1", content: reply });
				emit({ type: "idle" });
			}, 0);
		}),
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t1", content: reply })),
		registerDelegatedTools: vi.fn(),
		sendToolResult: vi.fn(),
		resume: vi.fn(async () => {}),
		onExit: vi.fn(),
		close: vi.fn(),
	};
	return {
		create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
			emit = opts.onEvent;
			return session;
		},
		session,
	};
}

// Fake broker: pending handoff h1 (target ai-ezio, sender claude). accept flips
// it to "accepted"; handoffBackRelay records the protocol handback.
function fakeBroker() {
	const handoff = {
		handoffId: "h1",
		status: "pending" as string,
		targetAgent: "ezio",
		senderAgent: "claude" as const,
		requestText: "Summarize the spec.",
	};
	const handoffBackRelay = vi.fn();
	const control = {
		getRelayTurnState: vi.fn(() => ({
			turnOwner: "ezio",
			unresolvedHandoffId: "h1",
			handoffState: handoff.status,
			handoffAgeMs: 1_000,
			waitingAgent: null,
		})),
		getRelayHandoff: vi.fn((id: string) => (id === "h1" ? { ...handoff } : null)),
		acceptRelayHandoff: vi.fn(({ handoffId }: { handoffId: string }) => {
			if (handoffId === "h1") handoff.status = "accepted";
		}),
		markRelayHandoffStale: vi.fn(),
		handoffBackRelay,
	};
	return { broker: { control } as never, handoffBackRelay };
}

describe("ai-ezio relay handoff (integration, protocol-native)", () => {
	it("delivers via submit() and hands back from the explicit idle event", async () => {
		const eng = fakeEngine("Here is the summary.");
		const live = createAiEzioLiveSession({
			stdout: { write: vi.fn() } as never,
			createEngineSession: eng.create,
		});
		await live.start();

		const { broker, handoffBackRelay } = fakeBroker();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "c1",
			currentAgent: "ezio",
			writeLocalMessage: vi.fn(),
			writeUserInput: (t: string) => live.writeUserInput(t),
			submitUserInput: async (text: string) => {
				await submitInjectedProviderInput({
					target: "ezio",
					text,
					writeUserInput: (t) => live.writeUserInput(t),
				});
			},
			openComposer: vi.fn(),
			suppressQuiescenceHandback: true,
		} as never);

		live.onTurnFinished?.((content) => {
			void relay.handbackResolvedContent(content);
		});

		await relay.checkIdleActions();
		await new Promise((r) => setTimeout(r, 20)); // let the engine's macrotask run

		// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock assertion, not invoked
		expect(eng.session.submit).toHaveBeenCalledWith("Summarize the spec.");
		expect(handoffBackRelay).toHaveBeenCalledTimes(1);
		expect(handoffBackRelay.mock.calls[0]![0]).toMatchObject({
			senderAgent: "ezio",
			targetAgent: "claude",
			requestText: "Here is the summary.",
			captureStatus: "ok",
		});
	});
});
