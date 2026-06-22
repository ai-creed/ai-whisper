import { describe, it, expect } from "vitest";
import {
	deliberationRunDir,
	deriveFindingsPath,
	WORKFLOW_DELIBERATION_PROTOCOL,
	DELIBERATION_CRAFT_SKILL_GUIDANCE,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("deliberationRunDir", () => {
	it("builds a gitignored run dir under .ai-whisper/deliberation", () => {
		expect(deliberationRunDir("/ws", "wf_abc")).toBe(
			"/ws/.ai-whisper/deliberation/wf_abc",
		);
	});
});

describe("deriveFindingsPath", () => {
	it("date-stamps + slugifies the seed basename under docs/superpowers/deliberations", () => {
		expect(deriveFindingsPath("docs/ideas/14all-samantha.md", "2026-06-21T09:00:00Z")).toBe(
			"docs/superpowers/deliberations/2026-06-21-14all-samantha.md",
		);
	});
	it("strips a leading date prefix from the seed name", () => {
		expect(deriveFindingsPath("2026-01-02-my-topic.txt", "2026-06-21")).toBe(
			"docs/superpowers/deliberations/2026-06-21-my-topic.md",
		);
	});
	it("falls back to 'deliberation' when the seed name has no usable slug", () => {
		expect(deriveFindingsPath("/tmp/.md", "2026-06-21")).toBe(
			"docs/superpowers/deliberations/2026-06-21-deliberation.md",
		);
	});
	it("throws on a malformed dateIso", () => {
		expect(() => deriveFindingsPath("seed.md", "nope")).toThrow(/YYYY-MM-DD/);
	});
});

describe("WORKFLOW_DELIBERATION_PROTOCOL content contract (spec §7)", () => {
	const p = WORKFLOW_DELIBERATION_PROTOCOL;
	it("requires independent derivation before reading the Explorer", () => {
		expect(p).toMatch(/independent derivation/i);
		expect(p).toMatch(/before reading the Explorer/i);
	});
	it("forbids recall-based verification and demands external sources", () => {
		expect(p).toMatch(/may NOT clear a material claim/i);
		expect(p).toMatch(/verified against/i);
	});
	it("encodes the four-way materiality sort", () => {
		expect(p).toMatch(/BLOCKING/);
		expect(p).toMatch(/OPEN QUESTION/);
		expect(p).toMatch(/NON-BLOCKING RISK/);
		expect(p).toMatch(/SUPPRESS/);
	});
	it("requires steelman + lens coverage and bans 'looks good'", () => {
		expect(p).toMatch(/steelman/i);
		expect(p).toMatch(/"Looks good" is not a legal handback/i);
	});
	it("keeps the reviewer/evaluator boundary (no workflow verdicts)", () => {
		expect(p).toMatch(/approved \/ not-approved \+ findings ONLY/);
		expect(p).toMatch(/is the evaluator's job/i);
	});
	it("keeps verdict line before the always-last Non-blocking risks section", () => {
		expect(p.indexOf("verdict line")).toBeLessThan(p.indexOf("Non-blocking risks:"));
	});
});

describe("DELIBERATION_CRAFT_SKILL_GUIDANCE", () => {
	it("names the craft skill and defers gate semantics to the protocol", () => {
		expect(DELIBERATION_CRAFT_SKILL_GUIDANCE).toMatch(/ai-whisper-deliberation-craft/);
		expect(DELIBERATION_CRAFT_SKILL_GUIDANCE).not.toMatch(/BLOCKING/);
		expect(DELIBERATION_CRAFT_SKILL_GUIDANCE).not.toMatch(/not-approved/);
	});
});

import {
	getWorkflowDefinition,
	listWorkflowTypes,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("deliberation workflow definition", () => {
	const def = getWorkflowDefinition("deliberation");
	it("is registered and listed", () => {
		expect(def).toBeDefined();
		expect(listWorkflowTypes()).toContain("deliberation");
	});
	it("has the four ordered layers", () => {
		expect(def?.phases.map((p) => p.name)).toEqual([
			"objectives", "approaches", "tradeoffs", "synthesis",
		]);
	});
	it("uses the deliberation-loop evaluator key on every layer", () => {
		for (const p of def!.phases) expect(p.evaluatorPromptKey).toBe("deliberation-loop");
	});
	it("applies the spec round budgets", () => {
		expect(def!.phases.map((p) => p.maxRounds)).toEqual([6, 10, 10, 5]);
	});
	it("starts each layer with the Explorer (implement) and renders the fix template on findings", () => {
		for (const p of def!.phases) {
			expect(p.initialHandoffStep).toBe("implement");
			expect(p.renderFixTemplateOnFindings).toBe(true);
			expect(p.stepTemplates.implement).toBeTruthy();
			expect(p.stepTemplates.review).toBeTruthy();
			expect(p.stepTemplates.fix).toBeTruthy();
		}
	});
	it("every layer review template carries the gate protocol + craft guidance", () => {
		for (const p of def!.phases) {
			expect(p.stepTemplates.review).toContain("deliberation review protocol");
			expect(p.stepTemplates.review).toContain("ai-whisper-deliberation-craft");
		}
	});
	it("the synthesis layer writes and commits the findings doc", () => {
		const synth = def!.phases.find((p) => p.name === "synthesis")!;
		expect(synth.stepTemplates.implement).toContain("{findingsPath}");
		expect(synth.stepTemplates.implement).toMatch(/commit/i);
		expect(synth.artifactOut).toEqual({ kind: "spec", pathTemplate: "{findingsPath}" });
	});
	it("embeds the operator-control fragment in every kickoff (via withOperatorControl)", () => {
		for (const p of def!.phases) expect(p.kickoffTemplate).toContain("ai-whisper operator control");
	});
});
