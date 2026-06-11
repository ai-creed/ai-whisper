import { describe, expect, it } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

const accepted = {
	handoffId: "hf1",
	senderAgent: "claude",
	targetAgent: "claude",
	requestText: "produce the matrix",
	collabId: "c",
	status: "accepted" as const,
};
// claude (deliver-on-arrival) for the shape-guard/exhaustion cases — no settle
// needed. A separate codex case exercises settle-on-last + deferred_rearmed.
function ev(message: string, provider: "claude" | "codex" = "claude"): TurnEvent {
	return {
		provider,
		workspaceId: "ws",
		cwd: "/r",
		sessionOrThreadId: "s",
		turnId: provider === "codex" ? "t" : null,
		message,
		inputMessages: ["produce the matrix"],
		receivedAt: "2026-06-11T00:00:00.000Z",
	};
}

describe("relay handleTurnEvent — fidelity gate (§4.3)", () => {
	it("REJECTS a drafting candidate (rejected_mid_composition), defers, then DELIVERS the real answer", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev("Let's draft")); // drafting → rejected, not delivered
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("rejected_mid_composition");
		expect(h.turnEventDiagnostics.at(-1)!.fidelityVerdict).toBe("mid_composition");

		await relay.handleTurnEvent(ev("Review matrix:\n| R | Result |\n| - | - |\n| A | Pass |"));
		expect(h.handoffBackCalls).toHaveLength(1);
		const delivered = h.turnEventDiagnostics.at(-1)!;
		expect(delivered.action).toBe("delivered");
		expect(delivered.fidelityVerdict).toBe("clean");
		expect(delivered.deferCount).toBe(1); // it took one defer to settle
	});

	it("exhausts the retry budget → fallback_exhausted and arms /copy", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		// AI_WHISPER_TURN_EVENT_MAX_DEFERS defaults to 3; drive 3 drafting events.
		await relay.handleTurnEvent(ev("Let's draft"));
		await relay.handleTurnEvent(ev("Maybe"));
		await relay.handleTurnEvent(ev("...")); // 3rd → budget exhausted
		expect(h.handoffBackCalls).toHaveLength(0);
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("fallback_exhausted");
		expect(relay.isCopyFallbackArmed()).toBe(true);
	});

	it("CODEX settle-on-last: holds clean A, a newer clean B supersedes it (deferred_rearmed), settle delivers B", async () => {
		// scrape corroborates BOTH clean messages so codex output corroboration passes.
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			scrapedTurnText: "Review matrix version alpha beta rows columns assessed thoroughly here",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent(ev("Review matrix version alpha rows assessed", "codex")); // A held
		expect(h.handoffBackCalls).toHaveLength(0); // settle-on-last: not delivered on arrival
		await relay.handleTurnEvent(ev("Review matrix version beta rows columns assessed", "codex")); // B supersedes A
		const rearmed = h.turnEventDiagnostics.at(-1)!;
		expect(rearmed.action).toBe("deferred_rearmed");
		expect(rearmed.fidelityVerdict).toBe("superseded");
		expect(h.handoffBackCalls).toHaveLength(0); // still held, awaiting idle settle

		relay.settleHeldTurnEvent(accepted.handoffId);
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.handoffBackCalls[0]!.requestText).toContain("beta"); // the LATEST clean turn
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("delivered");
	});
});
