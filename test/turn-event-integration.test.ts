// test/turn-event-integration.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnEventListener } from "../packages/cli/src/runtime/mount-turn-event-listener.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { makeRelayHarness } from "./helpers/relay-harness.ts";

describe("turn-event integration: socket → receiver → relay gate → handback", () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		if (close) await close();
	});

	// Full real path: the shim's envelope → mount listener runs the ClaudeEventReceiver
	// (reading inputMessages from the transcript) → workflow gate → relevance
	// (input-correlated via transcript) → claude deliver-on-arrival.
	it("a relevant claude envelope normalizes mount-side (transcript read) and delivers a handback", async () => {
		const socketsDir = mkdtempSync(join(tmpdir(), "aiw-int-"));
		const transcript = join(mkdtempSync(join(tmpdir(), "aiw-int-tr-")), "t.jsonl");
		writeFileSync(
			transcript,
			JSON.stringify({ role: "user", message: { content: "produce the matrix" } }) + "\n",
		);

		const h = makeRelayHarness({
			acceptedHandoff: {
				handoffId: "hf1",
				senderAgent: "codex",
				targetAgent: "claude",
				requestText: "produce the matrix",
				collabId: "c",
				status: "accepted",
			},
			autonomous: true,
		});
		const relay = createMountedTurnOwnedRelay(h.input);
		const listener = await createTurnEventListener({
			socketsDir,
			workspaceId: "wsX",
			provider: "claude",
			onEvent: (e) => void relay.handleTurnEvent(e),
		});
		close = listener.close;

		const rawClaude = JSON.stringify({
			session_id: "s",
			cwd: "/r",
			last_assistant_message: "Review matrix rows and columns, all requirements assessed.",
			transcript_path: transcript,
		});
		await new Promise<void>((resolve, reject) => {
			const c = connect(listener.socketPath, () =>
				c.write(
					JSON.stringify({
						provider: "claude",
						raw: rawClaude,
						receivedAt: "2026-06-11T00:00:00.000Z",
					}),
					() => c.end(),
				),
			);
			c.on("close", () => resolve());
			c.on("error", reject);
		});
		await new Promise((r) => setTimeout(r, 80));
		expect(h.handoffBackCalls).toHaveLength(1);
		expect(h.handoffBackCalls[0]!.requestText).toContain("Review matrix");
		expect(h.turnEventDiagnostics.at(-1)!.action).toBe("delivered");
	});
});
