import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnEventListener } from "../packages/cli/src/runtime/mount-turn-event-listener.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";

function sendAgy(socketPath: string, raw: string, event: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const c = connect(socketPath, () =>
			c.write(
				JSON.stringify({ provider: "agy", raw, receivedAt: "2026-06-27T00:00:00.000Z", event }),
				() => c.end(),
			),
		);
		c.on("close", () => resolve());
		c.on("error", reject);
	});
}

describe("agy turn-event integration", () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		if (close) await close();
		close = undefined;
	});

	it("a gated parent Stop arms /copy and the idle path delivers capture+handback exactly once (workspace mode)", async () => {
		const socketsDir = mkdtempSync(join(tmpdir(), "aiw-agy-int-"));
		const delivered: TurnEvent[] = [];
		const h = makeRelayHarness({
			acceptedHandoff: {
				handoffId: "hf1",
				senderAgent: "claude",
				targetAgent: "agy",
				requestText: "do the work",
				collabId: "c",
				status: "accepted",
			},
			autonomous: true,
			// An agy turn-end carries an EMPTY message (v1 capture is via /copy), so the
			// relevance gate is indeterminate and ARMS /copy; the idle path then runs
			// captureHandbackText. copyText ≈ scrapedTurnText ⇒ classifyCapture "ok".
			copyText: "the captured agy answer from the clipboard",
			scrapedTurnText: "the captured agy answer from the clipboard",
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		// workspace mode = the runtime's wired default (Task 8): only our session
		// loads the workspace hooks file, so the FIRST event received adopts the
		// parent conversationId. The stream below starts with the parent's pause.
		const listener = await createTurnEventListener({
			socketsDir,
			workspaceId: "wsAgyInt",
			provider: "agy",
			onEvent: (e) => {
				delivered.push(e);
				void relay.handleTurnEvent(e);
			},
			agy: { mode: "workspace", mountCwd: "/ws" },
		});
		close = listener.close;

		// Parent dispatches a subagent (pause adopts "parent"), subagent finishes, parent finishes.
		await sendAgy(listener.socketPath, JSON.stringify({ conversationId: "parent", fullyIdle: false }), "Stop");
		await sendAgy(listener.socketPath, JSON.stringify({ conversationId: "subagent", fullyIdle: true }), "Stop");
		await sendAgy(listener.socketPath, JSON.stringify({ conversationId: "parent", fullyIdle: true }), "Stop");
		await new Promise((r) => setTimeout(r, 80));

		// Gating: exactly ONE turn-event reached the relay — the parent's fullyIdle:true.
		// The subagent Stop (foreign id) and the parent's fullyIdle:false pause did not
		// (the pause is a heartbeat, routed to onActivity, which this test omits).
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.provider).toBe("agy");
		expect(delivered[0]!.sessionOrThreadId).toBe("parent");

		// That single gated Stop ARMED /copy (indeterminate: empty agy message) and has
		// NOT yet delivered — proving no premature handback.
		expect(relay.isCopyFallbackArmed()).toBe(true);
		expect(h.handoffBackCalls).toHaveLength(0);

		// The mount's idle tick consumes the armed branch → /copy capture DELIVERS the
		// handback (criterion 1: gated Stop triggers capture + handoff). This is the
		// REAL relay outcome via handoffBackRelay, not merely handleTurnEvent delivery.
		await relay.checkIdleActions(0);
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.handoffBackCalls[0]!.requestText).toContain("captured agy answer");

		// Exactly once: a second idle tick does NOT re-deliver (autoHandbackFiredFor guard).
		await relay.checkIdleActions(0);
		expect(h.handoffBackCalls).toHaveLength(1);
	});

	it("global mode: an unrelated session firing first with empty workspacePaths is never delivered (criterion 9)", async () => {
		const socketsDir = mkdtempSync(join(tmpdir(), "aiw-agy-int2-"));
		const delivered: TurnEvent[] = [];
		const listener = await createTurnEventListener({
			socketsDir,
			workspaceId: "wsAgyInt2",
			provider: "agy",
			onEvent: (e) => delivered.push(e),
			agy: { mode: "global", mountCwd: "/ws" },
		});
		close = listener.close;

		// Unrelated session fires first with empty workspacePaths → never adopted.
		await sendAgy(listener.socketPath, JSON.stringify({ conversationId: "other", fullyIdle: true, workspacePaths: [] }), "Stop");
		await new Promise((r) => setTimeout(r, 60));
		expect(delivered).toHaveLength(0);
	});
});
