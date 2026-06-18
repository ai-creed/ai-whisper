import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAiEzioLiveSession } from "../packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts";
import type { AiEzioEngineSession } from "../packages/adapter-ai-ezio/src/ai-ezio-engine.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";

// Reuse the sibling test's real construction pattern: a fake engine captures the
// session's onEvent callback so we drive the REAL event path (no mock of the
// handler). `emit` plays protocol events through the actual handler under test.
function fakeEngine() {
	let onEvent: (e: ProtocolEvent) => void = () => {};
	const submit = vi.fn();
	const session: AiEzioEngineSession = {
		start: vi.fn(async () => ({ type: "ready" })),
		transcriptPath: undefined,
		newConversation: vi.fn(async () => {}),
		status: vi.fn(async () => ({ provider: "mock", model: "mock" })),
		submit,
		interrupt: vi.fn(),
		submitAndWait: vi.fn(async () => ({ turnId: "t", content: "" })),
		registerDelegatedTools: vi.fn(),
		sendToolResult: vi.fn(),
		resume: vi.fn(async () => {}),
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
		});
		live.onTurnFinished?.((c) => handbacks.push(c));
		// Register via the SAME onFidelityDecision surface the mount wires to
		// relay.recordEzioFidelityDecision — so this exercises the production path.
		live.onFidelityDecision?.((d) => decisions.push(d));
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

	it("persists ezio fidelity decisions to relay_turn_event_diagnostics in the REAL wiring path (onFidelityDecision → recordEzioFidelityDecision → row)", async () => {
		const f = fakeEngine();
		const live = createAiEzioLiveSession({
			createEngineSession: f.create,
			stdout: { write: vi.fn() } as never,
		});
		// EXACT production wiring (mount-session-main): the ezio session's
		// onFidelityDecision is registered to the relay's recordEzioFidelityDecision,
		// which writes a relay_turn_event_diagnostics row. No injected in-memory sink.
		const h = makeRelayHarness({
			acceptedHandoff: {
				handoffId: "hf1",
				senderAgent: "claude",
				targetAgent: "ezio",
				requestText: "produce the review matrix",
				collabId: "c",
				status: "accepted",
			},
			autonomous: true,
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		live.onFidelityDecision?.((d) => relay.recordEzioFidelityDecision(d));
		await live.start();

		// The 2026-06-10 sequence: drafting → transient idle → real answer → idle.
		f.emit({ type: "assistant_turn_finished", turnId: "t1", content: "Let's draft" });
		f.emit({ type: "idle" });
		f.emit({
			type: "assistant_turn_finished",
			turnId: "t2",
			content: "Review matrix:\n| R | Result |\n| - | - |\n| A | Pass |",
		});
		f.emit({ type: "idle" });

		// Both decisions left queryable rows, provider "ezio", in the same table.
		expect(h.turnEventDiagnostics.map((r) => r.action)).toEqual([
			"rejected_mid_composition",
			"delivered",
		]);
		expect(h.turnEventDiagnostics.every((r) => r.provider === "ezio")).toBe(true);
		expect(h.turnEventDiagnostics[0]!.fidelityVerdict).toBe("mid_composition");

		// Spec §4.3/§7: the REJECTED row must retain the exact drafting fragment so
		// the 2026-06-10 "Let's draft" content is queryable after the fact.
		const rejected = h.turnEventDiagnostics[0]!;
		expect(rejected.messageSample).toBe("Let's draft");
		expect(rejected.messageLen).toBe("Let's draft".length);
		// The delivered row retains the real answer's content too.
		expect(h.turnEventDiagnostics[1]!.messageSample).toContain("Review matrix");
	});
});
