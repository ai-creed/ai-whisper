import { describe, expect, it } from "vitest";
import { buildRelayHandoffInput } from "../packages/cli/src/runtime/mount-session-main.ts";

describe("ezio-originated @@ directive → handoff (M6 outbound)", () => {
	it("a @@claude directive from an ezio mount yields senderAgent ezio", () => {
		const input = buildRelayHandoffInput({
			mountTarget: "ezio",
			directive: { target: "claude", instruction: "review the diff" },
			collabId: "collab_1",
			now: "2026-06-05T00:00:00.000Z",
		});
		expect(input).toMatchObject({
			collabId: "collab_1",
			senderAgent: "ezio",
			targetAgent: "claude",
			requestText: "review the diff",
		});
		expect(input.handoffId).toMatch(/^handoff_[0-9]+$/);
	});

	it("works symmetrically for a codex mount targeting ezio", () => {
		const input = buildRelayHandoffInput({
			mountTarget: "codex",
			directive: { target: "ezio", instruction: "take over" },
			collabId: "collab_2",
			now: "2026-06-05T00:00:01.000Z",
		});
		expect(input).toMatchObject({ senderAgent: "codex", targetAgent: "ezio" });
	});
});
