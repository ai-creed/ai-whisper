import { describe, it, expect } from "vitest";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
	CODE_REVIEW_SKILL_GUIDANCE,
	WORKFLOW_REVIEW_PROTOCOL,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("quick-task workflow definition", () => {
	const def = getWorkflowDefinition("quick-task");

	it("is registered and listed", () => {
		expect(def).toBeDefined();
		expect(listWorkflowTypes()).toContain("quick-task");
	});

	it("has exactly one phase named implement-and-review", () => {
		expect(def?.phases.map((p) => p.name)).toEqual(["implement-and-review"]);
	});

	it("matches the registry contract shape", () => {
		const phase = def!.phases[0]!;
		expect(phase.maxRounds).toBe(5);
		expect(phase.initialHandoffStep).toBe("implement");
		expect(phase.reviewMode).toBe("acceptance-review");
		expect(phase.evaluatorPromptKey).toBe("review-loop");
		expect(phase.artifactOut.kind).toBe("commit-range");
		expect(phase.anchorCommitBaseOnEntry).toBe(true);
		expect(phase.renderFixTemplateOnFindings).toBe(true);
	});

	it("defaults to claude implementer / codex reviewer", () => {
		expect(def?.defaultImplementer).toBe("claude");
		expect(def?.defaultReviewer).toBe("codex");
	});

	it("kickoff template carries the ratified-contract clause, the scope guard, and the commit instruction, plus the operator-control fragment via the registry", () => {
		const kickoff = def!.phases[0]!.kickoffTemplate;
		expect(kickoff).toContain("{specPath}");
		expect(kickoff).toMatch(/do NOT redesign/);
		expect(kickoff).toMatch(/CANNOT PROCEED/);
		expect(kickoff).toMatch(/non-test files beyond/);
		expect(kickoff).toMatch(/Commit your changes/);
		expect(kickoff).toContain("--- ai-whisper operator control ---");
	});

	it("review template carries {commitRange}, the live-HEAD wording, the out-of-scope blocking criterion, and both shared guidance blocks", () => {
		const review = def!.phases[0]!.stepTemplates.review!;
		expect(review).toContain("{commitRange}");
		expect(review).toMatch(/LIVE `HEAD`/);
		expect(review).toMatch(
			/non-test files beyond the declared Scope list is a blocking finding/,
		);
		expect(review).toContain(CODE_REVIEW_SKILL_GUIDANCE);
		expect(review).toContain(WORKFLOW_REVIEW_PROTOCOL);
	});

	it("fix template carries {commitRange} and the amend-or-add wording", () => {
		const fix = def!.phases[0]!.stepTemplates.fix!;
		expect(fix).toContain("{commitRange}");
		expect(fix).toMatch(/amend or add commits/);
	});
});
