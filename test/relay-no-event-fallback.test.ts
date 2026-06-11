import { describe, expect, it } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";

const accepted = {
	handoffId: "hf1",
	senderAgent: "claude",
	targetAgent: "claude",
	requestText: "produce the matrix",
	collabId: "c",
	status: "accepted" as const,
};

describe("relay no-event fallback (§2/§8: a dropped event never halts)", () => {
	it("NO event arrives → within grace returns false (keep waiting), past grace returns true (run /copy)", () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		// No handleTurnEvent call at all — shim missing / stale socket / StopFailure.
		expect(relay.noEventFallbackDue(accepted.handoffId, 0)).toBe(false); // within grace
		expect(relay.noEventFallbackDue(accepted.handoffId, 60_000)).toBe(true); // grace elapsed → /copy
	});

	it("a held clean codex candidate is NOT pre-empted by the no-event timeout (settle delivers it)", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			scrapedTurnText: "Review matrix rows columns assessed thoroughly here words",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent({
			provider: "codex",
			workspaceId: "ws",
			cwd: "/r",
			sessionOrThreadId: "s",
			turnId: "t",
			message: "Review matrix rows columns assessed",
			inputMessages: ["produce the matrix"],
			receivedAt: "2026-06-11T00:00:00.000Z",
		});
		// A clean codex turn is held; the no-event timeout must NOT fire (settle owns it).
		expect(relay.noEventFallbackDue(accepted.handoffId, 60_000)).toBe(false);
	});

	it("once a handback has been delivered, the no-event timeout no longer fires", async () => {
		const h = makeRelayHarness({ acceptedHandoff: accepted, autonomous: true });
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.handleTurnEvent({
			provider: "claude",
			workspaceId: "ws",
			cwd: "/r",
			sessionOrThreadId: "s",
			turnId: null,
			message: "Review matrix rows and columns, the real answer here",
			inputMessages: ["produce the matrix"],
			receivedAt: "2026-06-11T00:00:00.000Z",
		});
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(relay.noEventFallbackDue(accepted.handoffId, 60_000)).toBe(false); // already resolved
	});

	// THE regression the spec demands: drive the REAL suppressed-idle path
	// (checkIdleActions), with the event path enabled and NO event ever received,
	// and assert the existing /copy capture actually delivers via handoffBackRelay.
	// This catches a wiring bug (forgot to consult noEventFallbackDue, never fell
	// through to /copy, etc.) that the boolean-only test above would miss.
	it("suppressed idle + NO event + grace ELAPSED → the existing /copy path captures and DELIVERS via handoffBackRelay", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			copyText: "the captured final answer from the clipboard",
			scrapedTurnText: "the captured final answer from the clipboard", // turn ≈ clip ⇒ classifyCapture "ok"
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		// The mount's 1s idle timer would call checkIdleActions(idleElapsedMs) once the
		// pane is idle; pass a value past the grace window. No event was ever received.
		await relay.checkIdleActions(60_000);
		expect(h.handoffBackCalls).toHaveLength(1); // the proven /copy fallback DELIVERED — no halt
		expect(h.handoffBackCalls[0]!.requestText).toContain("captured final answer");
	});

	it("suppressed idle + NO event + WITHIN grace → does NOT deliver yet (event path keeps its head start)", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			copyText: "x",
			scrapedTurnText: "x",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		await relay.checkIdleActions(0); // within grace
		expect(h.handoffBackCalls).toHaveLength(0); // suppressed; no premature /copy
	});

	// THE gate-reject fallback regression (spec §11 "fallback path when the gate
	// rejects"): an indeterminate event ARMS /copy; the next idle tick must CONSUME
	// the armed branch and DELIVER via the existing /copy path. Uses idleElapsedMs=0
	// (WITHIN grace) so this isolates the armed branch (step 2) from the no-event
	// grace branch (step 3) — catching a bug where checkIdleActions forgets to
	// consume copyFallbackArmed. (The codex-corroboration-fail path arms the same
	// flag via the same armCopyFallbackOnce(), so this one test covers both.)
	it("gate-reject (indeterminate) ARMS /copy → next idle tick CONSUMES the armed branch and DELIVERS via handoffBackRelay (within grace)", async () => {
		const h = makeRelayHarness({
			acceptedHandoff: accepted,
			autonomous: true,
			copyText: "the captured fallback answer",
			scrapedTurnText: "the captured fallback answer", // turn ≈ clip ⇒ classifyCapture "ok"
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		// Indeterminate event (no readable input, backstop not seeded) → arms /copy.
		await relay.handleTurnEvent({
			provider: "claude",
			workspaceId: "ws",
			cwd: "/r",
			sessionOrThreadId: "s",
			turnId: null,
			message: "ambiguous, nothing to correlate",
			inputMessages: [],
			receivedAt: "2026-06-11T00:00:00.000Z",
		});
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("fallback_indeterminate");
		expect(relay.isCopyFallbackArmed()).toBe(true); // armed, not yet delivered
		expect(h.handoffBackCalls).toHaveLength(0);
		// Idle tick WITHIN grace: the ARMED branch must fire (not the grace branch).
		await relay.checkIdleActions(0);
		expect(h.handoffBackCalls).toHaveLength(1); // /copy captured and DELIVERED
		expect(h.handoffBackCalls[0]!.requestText).toContain("captured fallback answer");
		expect(relay.isCopyFallbackArmed()).toBe(false); // armed flag consumed
	});
});
