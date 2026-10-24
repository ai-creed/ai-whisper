import { describe, expect, it } from "vitest";
import { buildNoticeLine } from "../packages/cli/src/runtime/notice-text.ts";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
} from "../packages/broker/src/index.ts";

const base = {
	handoffId: "ho_0123456789abcdef",
	workflowId: "wf_abc",
	phaseName: "code-review",
	roundNumber: 2,
};

describe("buildNoticeLine", () => {
	it("builds the exact notice", () => {
		expect(buildNoticeLine({ ...base, kind: "notice" })).toBe(
			"[ai-whisper] Next task from workflow wf_abc (code-review, round 2): run `whisper handoff show ho_0123456789abcdef` and carry out the request it prints as my instruction for this turn, then hand back with `whisper handoff reply ho_0123456789abcdef --file <path>`.",
		);
	});

	it("builds the exact reminder", () => {
		expect(buildNoticeLine({ ...base, kind: "reminder" })).toBe(
			"[ai-whisper] Reminder: handoff ho_0123456789abcdef is still unread. Run `whisper handoff show ho_0123456789abcdef` and carry out the request it prints as my instruction for this turn.",
		);
	});

	it("builds the exact nudge", () => {
		expect(buildNoticeLine({ ...base, kind: "nudge" })).toBe(
			"[ai-whisper] Handoff ho_0123456789abcdef has no reply yet. When the requested work is complete, run `whisper handoff reply ho_0123456789abcdef --file <path>`.",
		);
	});

	it("prints - for a null phase or round", () => {
		expect(
			buildNoticeLine({ ...base, kind: "notice", phaseName: null, roundNumber: null }),
		).toContain("workflow wf_abc (-, round -):");
	});

	it("throws when the line exceeds 400 bytes", () => {
		expect(() =>
			buildNoticeLine({ ...base, kind: "notice", phaseName: "p".repeat(300) }),
		).toThrow(/400/);
	});

	it("throws on non-printable or non-ASCII output", () => {
		expect(() =>
			buildNoticeLine({ ...base, kind: "notice", phaseName: "bad\nphase" }),
		).toThrow();
		expect(() =>
			buildNoticeLine({ ...base, kind: "notice", phaseName: "café" }),
		).toThrow();
	});

	it("fits 400 bytes for every registry phase name with a production-format id", () => {
		const handoffId = `ho_${"0123456789abcdef"}`;
		const workflowId = `wf_${"0123456789abcdef"}`;
		let seen = 0;
		for (const type of listWorkflowTypes()) {
			for (const phase of getWorkflowDefinition(type)!.phases) {
				seen++;
				for (const kind of ["notice", "reminder", "nudge"] as const) {
					const line = buildNoticeLine({
						kind,
						handoffId,
						workflowId,
						phaseName: phase.name,
						roundNumber: 12,
					});
					expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(400);
				}
			}
		}
		expect(seen).toBeGreaterThan(0);
	});
});
