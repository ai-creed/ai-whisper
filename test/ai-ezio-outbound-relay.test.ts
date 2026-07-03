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

describe("buildRelayHandoffInput duo persona fragment", () => {
	it("omits the duo line entirely when no duo info is provided", () => {
		const input = buildRelayHandoffInput({
			mountTarget: "codex",
			directive: { target: "claude", instruction: "review the diff" },
			collabId: "collab_3",
			now: "2026-07-02T00:00:00.000Z",
		});
		expect(input.requestText).toBe("review the diff");
		expect(input.requestText.split("\n")).toHaveLength(1);
	});

	it("appends exactly one pinned duo line when the teammate has a character", () => {
		const input = buildRelayHandoffInput({
			mountTarget: "codex",
			directive: { target: "claude", instruction: "review the diff" },
			collabId: "collab_4",
			now: "2026-07-02T00:00:01.000Z",
			duo: {
				character: "HEISENBERG",
				role: "brain",
				teammateCharacter: "JESSE",
			},
		});
		const lines = input.requestText.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("review the diff");
		expect(lines[1]).toBe(
			"[duo] You are HEISENBERG (brain); teammate claude is JESSE. Character flavor in prose only; never alter code, commits, or workflow verdict labels.",
		);
	});

	it('falls back to the literal "unassigned" when the teammate has no character', () => {
		const input = buildRelayHandoffInput({
			mountTarget: "codex",
			directive: { target: "claude", instruction: "review the diff" },
			collabId: "collab_5",
			now: "2026-07-02T00:00:02.000Z",
			duo: {
				character: "HEISENBERG",
				role: "brain",
				teammateCharacter: null,
			},
		});
		expect(input.requestText).toContain("teammate claude is unassigned.");
		expect(input.requestText.split("\n")).toHaveLength(2);
	});

	it("the duo line always contains the character, the role, and the 'never alter' guardrail", () => {
		const input = buildRelayHandoffInput({
			mountTarget: "codex",
			directive: { target: "claude", instruction: "go" },
			collabId: "collab_6",
			now: "2026-07-02T00:00:03.000Z",
			duo: {
				character: "BATMAN",
				role: "brain",
				teammateCharacter: "ROBIN",
			},
		});
		expect(input.requestText).toContain("BATMAN");
		expect(input.requestText).toContain("(brain)");
		expect(input.requestText).toContain("never alter");
	});
});
