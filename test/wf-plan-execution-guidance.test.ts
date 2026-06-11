import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	COMPLEX_BUG_FIXING,
	PLAN_EXECUTION_SKILL_GUIDANCE,
	RALPH_LOOP,
	SPEC_DRIVEN_DEVELOPMENT,
	WORKFLOW_OPERATOR_CONTROL,
	getWorkflowDefinition,
} from "../packages/broker/src/runtime/workflow-registry.ts";

function phase(def: typeof SPEC_DRIVEN_DEVELOPMENT, name: string) {
	const p = def.phases.find((ph) => ph.name === name);
	if (!p) throw new Error(`no phase ${name}`);
	return p;
}

describe("PLAN_EXECUTION_SKILL_GUIDANCE fragment", () => {
	it("names the skill", () => {
		expect(PLAN_EXECUTION_SKILL_GUIDANCE).toContain("ai-whisper-plan-execution");
	});

	it("keeps the handback contract authoritative and demands mode disclosure", () => {
		expect(PLAN_EXECUTION_SKILL_GUIDANCE).toMatch(
			/handback contract above remains authoritative/i,
		);
		expect(PLAN_EXECUTION_SKILL_GUIDANCE).toMatch(/which execution mode you used/i);
	});
});

describe("SDD plan-execution templates request the skill", () => {
	const planExec = phase(SPEC_DRIVEN_DEVELOPMENT, "plan-execution");

	it.each([
		["kickoffTemplate", planExec.kickoffTemplate],
		["stepTemplates.execute", planExec.stepTemplates.execute ?? ""],
	])("%s contains the fragment AFTER the task statement", (_name, tmpl) => {
		const taskIdx = tmpl.indexOf("Execute the plan at {planPath}");
		const fragIdx = tmpl.indexOf(PLAN_EXECUTION_SKILL_GUIDANCE);
		expect(taskIdx).toBe(0);
		expect(fragIdx).toBeGreaterThan(taskIdx);
	});

	it("keeps the handback-contract sentence intact", () => {
		expect(planExec.kickoffTemplate).toContain(
			"Hand back the commit SHAs and the verification output",
		);
		expect(planExec.stepTemplates.execute ?? "").toContain(
			"Hand back the commit SHAs and the verification output",
		);
	});

	it("registry-wrapped kickoff has the fragment and still ends with operator control", () => {
		const wrapped = getWorkflowDefinition("spec-driven-development");
		const p = wrapped?.phases.find((ph) => ph.name === "plan-execution");
		expect(p?.kickoffTemplate).toContain(PLAN_EXECUTION_SKILL_GUIDANCE);
		expect(p?.kickoffTemplate.endsWith(WORKFLOW_OPERATOR_CONTROL)).toBe(true);
	});
});

describe("no other template gains the fragment", () => {
	const others: Array<[string, string]> = [];
	for (const def of [SPEC_DRIVEN_DEVELOPMENT, RALPH_LOOP, COMPLEX_BUG_FIXING]) {
		for (const p of def.phases) {
			if (def === SPEC_DRIVEN_DEVELOPMENT && p.name === "plan-execution") {
				continue;
			}
			others.push([`${def.type}/${p.name}/kickoff`, p.kickoffTemplate]);
			for (const [step, tmpl] of Object.entries(p.stepTemplates)) {
				others.push([`${def.type}/${p.name}/${step}`, tmpl ?? ""]);
			}
			if (p.acceptanceReviewTemplate) {
				others.push([
					`${def.type}/${p.name}/acceptance`,
					p.acceptanceReviewTemplate,
				]);
			}
		}
	}

	it.each(others)("%s omits the fragment", (_name, tmpl) => {
		expect(tmpl).not.toContain("ai-whisper-plan-execution");
	});
});
