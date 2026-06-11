import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";

// Reuse the sibling test's real construction pattern: a fake engine captures the
// session's onEvent callback so we drive the REAL event path (no mock of the
// handler). `emit` plays protocol events through the actual handler under test.
function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const submit = vi.fn();
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		submit,
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
		registerDelegatedTools: vi.fn(),
		sendToolResult: vi.fn(),
		onExit: vi.fn(),
		close: vi.fn(),
	};
	return {
		create: (opts: { onEvent: (e: ProtocolEvent) => void }) => {
			onEvent = opts.onEvent;
			return session;
		},
		emit: (e: ProtocolEvent) => onEvent(e),
		session,
		submit,
	};
}

describe("ezio handback fidelity (2026-06-10 reproduction)", () => {
	it("does NOT relay a drafting turn on a transient idle; relays the real answer; LOGS each decision", async () => {
		const f = fakeEngine();
		const handbacks: string[] = [];
		const decisions: Array<{ action: string; verdict: string }> = [];
		const live = createAiEzioLiveSession({
			createEngineSession: f.create,
			stdout: { write: vi.fn() } as never,
			onFidelityDecision: (d) => decisions.push(d),
		});
		live.onTurnFinished?.((c) => handbacks.push(c));
		await live.start();

		// Recorded sequence: drafting turn finishes → transient idle → real answer → idle.
		f.emit({ type: "assistant_turn_finished", turnId: "t1", content: "Let's draft" });
		f.emit({ type: "idle" }); // transient — MUST NOT fire the drafting handback
		f.emit({
			type: "assistant_turn_finished",
			turnId: "t2",
			content: "Review matrix:\n| R | Result |\n| - | - |\n| A | Pass |",
		});
		f.emit({ type: "idle" }); // genuine quiescence — fire the real answer

		expect(handbacks).toHaveLength(1);
		expect(handbacks[0]).toContain("Review matrix");
		expect(handbacks[0]).not.toContain("Let's draft");

		// Spec §4.3: every fidelity decision is logged — the drafting candidate left a
		// rejection decision and the real answer a delivered decision; neither is silent.
		expect(decisions.map((d) => d.action)).toEqual([
			"rejected_mid_composition",
			"delivered",
		]);
		expect(decisions[0]!.verdict).toBe("mid_composition");
	});
});
