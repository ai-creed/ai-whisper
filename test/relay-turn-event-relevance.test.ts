import { describe, expect, it } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

const accepted = {
	handoffId: "hf1",
	senderAgent: "claude",
	targetAgent: "claude",
	requestText: "Please produce the review matrix.",
	collabId: "c",
	status: "accepted" as const,
};

// Default provider is CLAUDE (Stop = structurally last turn → deliver on
// arrival), so the basic relevance-routing cases assert immediate delivery.
// Codex (settle-on-last + output corroboration) is tested with explicit provider
// overrides below; a clean structured message clears the Task-12 shape guard.
function ev(over: Partial<TurnEvent>): TurnEvent {
	return {
		provider: "claude",
		workspaceId: "ws",
		cwd: "/r",
		sessionOrThreadId: "s",
		turnId: null,
		message: "Review matrix rows and columns, all requirements assessed.",
		inputMessages: ["Please produce the review matrix."],
		receivedAt: "2026-06-11T00:00:00.000Z",
		...over,
	};
}

describe("relay handleTurnEvent — relevance gate (§4.2)", () => {
	it("RELEVANT (claude): matching input → delivers on arrival + logs delivered", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev({}));
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.handoffBackCalls[0]!.requestText).toContain("Review matrix");
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("delivered");
		expect(relay.isCopyFallbackArmed()).toBe(false);
	});

	it("POSITIVE MISMATCH: unrelated input → ignored_unrelated_turn, NO delivery, /copy NOT armed", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev({ inputMessages: ["what's the weather?"], message: "It is sunny." }));
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("ignored_unrelated_turn");
		expect(relay.isCopyFallbackArmed()).toBe(false); // the no-false-handback guarantee
	});

	it("INDETERMINATE: no readable input and no sequence backstop seeded → fallback_indeterminate, /copy ARMED", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		// The harness does NOT seed the sequence backstop (which acceptPendingHandoff
		// sets in production for the first post-injection turn), so a no-input event
		// is indeterminate — not relevant — and releases /copy without burning the guard.
		await relay.handleTurnEvent(ev({ inputMessages: [], message: "ambiguous, no input to correlate" }));
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("fallback_indeterminate");
		expect(relay.isCopyFallbackArmed()).toBe(true); // proven path released
	});

	it("CODEX corroboration FAIL: input matches but scrape does not corroborate → fallback_indeterminate, /copy ARMED", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			scrapedTurnText: "totally different pane text about the weather today",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev({ provider: "codex", turnId: "t1", message: "Review matrix rows and columns assessed" }));
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("fallback_indeterminate");
		expect(relay.isCopyFallbackArmed()).toBe(true);
	});

	it("CODEX corroboration PASS: input matches and scrape corroborates → HELD (not delivered yet); settle delivers", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			scrapedTurnText: "Review matrix rows and columns assessed with extra scrape words",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev({ provider: "codex", turnId: "t1", message: "Review matrix rows and columns assessed" }));
		// Settle-on-last: codex holds the clean candidate — not delivered until idle.
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(relay.isCopyFallbackArmed()).toBe(false); // corroboration passed → not a fallback
		relay.settleHeldTurnEvent(accepted.handoffId);
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("delivered");
	});

	it("CLAUDE: output corroboration is NOT applied (lossy TUI scrape) — input match alone delivers", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			scrapedTurnText: "garbled cursor-positioned claude TUI scrape, nothing alike",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev({ provider: "claude", message: "Review matrix rows and columns, the real answer" }));
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("delivered");
	});
});
