import { describe, expect, it } from "vitest";
import { SELF_REVIEW_PROTOCOL, composeSoloPrompt } from "../eval/runner/arms/solo-prompt.ts";
import type { TaskMeta } from "../eval/runner/types.ts";

const task: TaskMeta = {
	slug: "csv-parse-quoted", category: "feature", shape: "quick-task", dir: "/t",
	title: "CSV: quoted fields", taskSection: "Add quoted-field support.", scopeBullets: ["src/parse.ts", "test/parse.test.ts"],
	acceptanceSection: "- parse handles quotes", approach: "Extend the tokenizer state machine.",
	budget: { wallClockSeconds: 900, tokenCap: 400000 },
};

describe("composeSoloPrompt", () => {
	it("embeds task.md content and approach.md verbatim for Arm A", () => {
		const p = composeSoloPrompt(task, "A");
		expect(p).toContain("# CSV: quoted fields");
		expect(p).toContain("## Task\nAdd quoted-field support.");
		expect(p).toContain("## Scope\n- src/parse.ts\n- test/parse.test.ts");
		expect(p).toContain("## Acceptance criteria\n- parse handles quotes");
		expect(p).toContain("## Approved approach\nExtend the tokenizer state machine.");
		expect(p).not.toContain(SELF_REVIEW_PROTOCOL);
	});
	it("appends the self-review protocol only for Arm B", () => {
		const p = composeSoloPrompt(task, "B");
		expect(p.endsWith(SELF_REVIEW_PROTOCOL)).toBe(true);
		expect(SELF_REVIEW_PROTOCOL).toMatch(/maximum of 2 review-fix cycles/);
		expect(SELF_REVIEW_PROTOCOL).toContain("FINDING: ");
		expect(SELF_REVIEW_PROTOCOL).toContain("SELF-REVIEW CYCLE <n> COMPLETE");
	});
	it("omits the approach section for SDD-shaped tasks", () => {
		expect(composeSoloPrompt({ ...task, shape: "spec-driven-development", approach: null }, "A")).not.toContain("## Approved approach");
	});
	it("never mentions held-out grading", () => {
		expect(composeSoloPrompt(task, "B")).not.toMatch(/grade/i);
	});
});
