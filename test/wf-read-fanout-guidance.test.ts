import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	WORKFLOW_READ_FANOUT_GUIDANCE,
	CODE_REVIEW_SKILL_GUIDANCE,
	SPEC_DRIVEN_DEVELOPMENT,
	RALPH_LOOP,
	COMPLEX_BUG_FIXING,
	QUICK_TASK,
	DELIBERATION,
} from "../packages/broker/src/runtime/workflow-registry.ts";

/** Pull a phase's review-step template from a real exported workflow def. */
function reviewTemplate(
	def: typeof SPEC_DRIVEN_DEVELOPMENT,
	phaseName: string,
): string {
	const phase = def.phases.find((p) => p.name === phaseName);
	if (!phase) throw new Error(`no phase ${phaseName}`);
	return phase.stepTemplates.review ?? "";
}

describe("WORKFLOW_READ_FANOUT_GUIDANCE fragment", () => {
	it("is harness-conditional", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/If your harness supports dispatching subagents/,
		);
	});
	it("scopes fan-out to read-only work", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toContain("read-only work");
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/Anything that writes .* stays inline and serial/,
		);
	});
	it("requires synthesis before handback", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/synthesize the results yourself before handing back/,
		);
	});
	it("isolates subagents from the relay and the other agent", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/never hands back, never touches the relay, and never communicates with the other agent/,
		);
	});
	it("has a sequential fallback", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/no subagent dispatch, do the same reads sequentially/,
		);
	});
	it("ends with a paragraph break so it composes by + and by interpolation", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE.endsWith("\n\n")).toBe(true);
	});
});

describe("code-review guidance composes read fan-out by construction", () => {
	// THE structural invariant: any template that carries the code-review
	// skill pointer — including templates that do not exist yet — inherits
	// the fan-out fragment, because the pointer constant itself contains it.
	it("CODE_REVIEW_SKILL_GUIDANCE contains WORKFLOW_READ_FANOUT_GUIDANCE", () => {
		expect(CODE_REVIEW_SKILL_GUIDANCE).toContain(WORKFLOW_READ_FANOUT_GUIDANCE);
	});
});

describe("code-bearing review prompts carry the read fan-out fragment", () => {
	// Integration checks derived from the real exported workflow definitions —
	// these follow from the invariant above but pin today's five templates.
	const codeBearing: Array<[string, string]> = [
		["sdd code-review", reviewTemplate(SPEC_DRIVEN_DEVELOPMENT, "code-review")],
		["quick-task review", reviewTemplate(QUICK_TASK, "implement-and-review")],
		["ralph per-item", reviewTemplate(RALPH_LOOP, "ralph-iteration")],
		[
			"ralph acceptance",
			RALPH_LOOP.phases.find((p) => p.name === "ralph-iteration")
				?.acceptanceReviewTemplate ?? "",
		],
		["bugfix fix-and-verify", reviewTemplate(COMPLEX_BUG_FIXING, "fix-and-verify")],
	];
	for (const [label, template] of codeBearing) {
		it(`${label} template contains the fragment`, () => {
			expect(template).toContain(WORKFLOW_READ_FANOUT_GUIDANCE);
		});
		it(`${label} keeps the fragment before the review protocol`, () => {
			expect(template.indexOf(WORKFLOW_READ_FANOUT_GUIDANCE)).toBeLessThan(
				template.indexOf("--- ai-whisper workflow review protocol"),
			);
		});
	}
});

describe("deliberation Explorer research layers carry the fragment; Synthesis does not", () => {
	const kickoff = (phaseName: string): string => {
		const phase = DELIBERATION.phases.find((p) => p.name === phaseName);
		if (!phase) throw new Error(`no phase ${phaseName}`);
		return phase.kickoffTemplate;
	};
	for (const layer of ["objectives", "approaches", "tradeoffs"]) {
		it(`${layer} kickoff contains the fragment`, () => {
			expect(kickoff(layer)).toContain(WORKFLOW_READ_FANOUT_GUIDANCE);
		});
	}
	it("synthesis kickoff does NOT contain the fragment (composition, not breadth research)", () => {
		expect(kickoff("synthesis")).not.toContain(WORKFLOW_READ_FANOUT_GUIDANCE);
	});
});

describe("bugfix diagnosis kickoff carries the fragment", () => {
	it("diagnosis implementer kickoff contains the fragment", () => {
		const phase = COMPLEX_BUG_FIXING.phases.find((p) => p.name === "diagnosis");
		if (!phase) throw new Error("no diagnosis phase");
		expect(phase.kickoffTemplate).toContain(WORKFLOW_READ_FANOUT_GUIDANCE);
	});
});
