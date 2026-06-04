import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	CODE_REVIEW_SKILL_GUIDANCE,
	WORKFLOW_REVIEW_PROTOCOL,
	SPEC_DRIVEN_DEVELOPMENT,
	RALPH_LOOP,
	COMPLEX_BUG_FIXING,
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

describe("CODE_REVIEW_SKILL_GUIDANCE fragment", () => {
	it("names the skill", () => {
		expect(CODE_REVIEW_SKILL_GUIDANCE).toContain("ai-whisper-code-review");
	});
	it("says the protocol controls output format and evaluator semantics", () => {
		expect(CODE_REVIEW_SKILL_GUIDANCE).toMatch(
			/output format and evaluator semantics/i,
		);
	});
});

describe("code-bearing review prompts request the skill", () => {
	// Derived from the real exported workflow definitions, not hand-built text.
	const codeBearing: Array<[string, string]> = [
		["sdd code-review", reviewTemplate(SPEC_DRIVEN_DEVELOPMENT, "code-review")],
		["ralph per-item", reviewTemplate(RALPH_LOOP, "ralph-iteration")],
		[
			"ralph acceptance",
			RALPH_LOOP.phases.find((p) => p.name === "ralph-iteration")
				?.acceptanceReviewTemplate ?? "",
		],
		["bugfix fix-and-verify", reviewTemplate(COMPLEX_BUG_FIXING, "fix-and-verify")],
	];

	it.each(codeBearing)("%s contains ai-whisper-code-review", (_name, tmpl) => {
		expect(tmpl).toContain("ai-whisper-code-review");
	});

	it.each(codeBearing)("%s still contains WORKFLOW_REVIEW_PROTOCOL", (_name, tmpl) => {
		// Assert containment of the REAL exported protocol value, not just its
		// header — a stale/truncated inline copy sharing the header would pass a
		// header-only check while dropping the rest of the protocol contract.
		expect(tmpl).toContain(WORKFLOW_REVIEW_PROTOCOL);
	});

	it.each(codeBearing)(
		"%s places the guidance BEFORE the protocol",
		(_name, tmpl) => {
			const guidanceIdx = tmpl.indexOf("ai-whisper-code-review");
			const protocolIdx = tmpl.indexOf(WORKFLOW_REVIEW_PROTOCOL);
			expect(guidanceIdx).toBeGreaterThan(-1);
			expect(protocolIdx).toBeGreaterThan(guidanceIdx);
		},
	);

	it.each(codeBearing)(
		"%s keeps the verdict line before the trailing Non-blocking risks section",
		(_name, tmpl) => {
			// separateReviewSections() strips from the LAST `Non-blocking risks:`
			// header onward; injecting guidance before the protocol must not move
			// the verdict line after that header.
			const verdictIdx = tmpl.indexOf('"Approved.');
			const lastRisksIdx = tmpl.lastIndexOf("Non-blocking risks:");
			expect(verdictIdx).toBeGreaterThan(-1);
			expect(lastRisksIdx).toBeGreaterThan(verdictIdx);
		},
	);
});

describe("non-code review prompts do NOT request the skill", () => {
	const nonCode: Array<[string, string]> = [
		["sdd spec-refining", reviewTemplate(SPEC_DRIVEN_DEVELOPMENT, "spec-refining")],
		["sdd plan-writing", reviewTemplate(SPEC_DRIVEN_DEVELOPMENT, "plan-writing")],
		["bugfix diagnosis", reviewTemplate(COMPLEX_BUG_FIXING, "diagnosis")],
		["bugfix post-mortem", reviewTemplate(COMPLEX_BUG_FIXING, "post-mortem")],
	];

	it.each(nonCode)("%s omits ai-whisper-code-review", (_name, tmpl) => {
		expect(tmpl).not.toContain("ai-whisper-code-review");
	});
});
