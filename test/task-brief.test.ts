import { describe, it, expect } from "vitest";
import {
	validateTaskBrief,
	isTestFilePath,
	QUICK_TASK_SCOPE_CAP,
} from "../packages/broker/src/runtime/task-brief.ts";

interface BriefSections {
	task?: string | null;
	approvedApproach?: string | null;
	scope?: string | null;
	acceptanceChecks?: string | null;
}

/**
 * Builds a well-formed task-brief markdown document, letting each test override
 * only the section(s) it cares about. Passing `null` for a section omits its
 * heading entirely (simulating a missing section); omitting a key keeps a
 * sensible default body.
 */
function buildBrief(sections: BriefSections = {}): string {
	const parts: string[] = [];
	const pushSection = (
		heading: string,
		body: string | null | undefined,
		defaultBody: string,
	): void => {
		if (body === null) return;
		parts.push(heading);
		parts.push(body === undefined ? defaultBody : body);
		parts.push("");
	};
	pushSection("## Task", sections.task, "Ship the quick task.");
	pushSection(
		"## Approved approach",
		sections.approvedApproach,
		"Do the minimal viable change.",
	);
	pushSection("## Scope", sections.scope, "- src/a.ts\n- src/b.ts");
	pushSection(
		"## Acceptance checks",
		sections.acceptanceChecks,
		"- Verify it works.",
	);
	return parts.join("\n");
}

function bulletList(n: number, prefix = "src/file"): string {
	return Array.from({ length: n }, (_, i) => `- ${prefix}${i}.ts`).join("\n");
}

describe("QUICK_TASK_SCOPE_CAP", () => {
	it("is 5", () => {
		expect(QUICK_TASK_SCOPE_CAP).toBe(5);
	});
});

describe("validateTaskBrief - happy path", () => {
	it("accepts a brief with all sections and mixed test/non-test scope bullets", () => {
		const content = buildBrief({
			scope: "- src/a.ts\n- src/b.ts\n- test/c.test.ts",
		});
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.scopeFiles).toHaveLength(3);
		expect(result.nonTestScopeCount).toBe(2);
	});
});

describe("validateTaskBrief - required sections", () => {
	const cases: Array<[keyof BriefSections, string]> = [
		["task", 'missing or empty required section "## Task"'],
		[
			"approvedApproach",
			'missing or empty required section "## Approved approach"',
		],
		["scope", 'missing or empty required section "## Scope"'],
		[
			"acceptanceChecks",
			'missing or empty required section "## Acceptance checks"',
		],
	];

	it.each(cases)("flags a missing %s section", (key, expectedViolation) => {
		const result = validateTaskBrief(buildBrief({ [key]: null }));
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([expectedViolation]);
	});

	it("flags a heading present with a whitespace-only body the same as missing", () => {
		const result = validateTaskBrief(buildBrief({ task: "   \n\t  \n" }));
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			'missing or empty required section "## Task"',
		]);
	});
});

describe("validateTaskBrief - scope bullet list", () => {
	it("flags a Scope section with prose but no bullet list", () => {
		const content = buildBrief({
			scope:
				"This section explains what will change but never lists files as bullets.",
		});
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			'"## Scope" must declare the files the task touches as a bullet list (one file per bullet)',
		]);
	});
});

describe("validateTaskBrief - scope cap", () => {
	it(`flags more than ${QUICK_TASK_SCOPE_CAP} non-test files, naming the count`, () => {
		const content = buildBrief({
			scope: bulletList(QUICK_TASK_SCOPE_CAP + 1),
		});
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			`scope declares ${QUICK_TASK_SCOPE_CAP + 1} non-test files; the cap is ${QUICK_TASK_SCOPE_CAP}`,
		]);
	});

	it(`allows exactly ${QUICK_TASK_SCOPE_CAP} non-test files`, () => {
		const content = buildBrief({ scope: bulletList(QUICK_TASK_SCOPE_CAP) });
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});
});

describe("validateTaskBrief - test-file exclusion", () => {
	it("excludes test-path bullets from nonTestScopeCount", () => {
		const content = buildBrief({
			scope: [
				bulletList(5),
				"- test/x.test.ts",
				"- src/a.spec.ts",
				"- foo_test.go",
				"- packages/x/__tests__/y.ts",
			].join("\n"),
		});
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.scopeFiles).toHaveLength(9);
		expect(result.nonTestScopeCount).toBe(5);
	});
});

describe("validateTaskBrief - parsing leniency", () => {
	it("parses ### headings, mixed-case titles, backticked paths and trailing bullet annotations", () => {
		const content = [
			"### Task",
			"Ship the thing.",
			"",
			"## Approved approach",
			"Do it simply.",
			"",
			"## SCOPE",
			"- `src/a.ts` — rework parser",
			"- src/b.ts",
			"",
			"### acceptance CHECKS",
			"- Verify output",
			"",
		].join("\n");
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.scopeFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.nonTestScopeCount).toBe(2);
	});
});

describe("validateTaskBrief - extra sections", () => {
	it("ignores an unrecognized heading but still treats it as a section boundary", () => {
		const content = [
			"## Task",
			"Ship it.",
			"",
			"## Approved approach",
			"Do it.",
			"",
			"## Scope",
			"- src/a.ts",
			"",
			"## Notes",
			"- src/should-not-count.ts",
			"",
			"## Acceptance checks",
			"- Check it.",
			"",
		].join("\n");
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(true);
		expect(result.scopeFiles).toEqual(["src/a.ts"]);
	});
});

describe("validateTaskBrief - multiple violations", () => {
	it("reports every violation together", () => {
		const content = buildBrief({
			task: null,
			acceptanceChecks: null,
			scope: bulletList(QUICK_TASK_SCOPE_CAP + 1),
		});
		const result = validateTaskBrief(content);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			'missing or empty required section "## Task"',
			'missing or empty required section "## Acceptance checks"',
			`scope declares ${QUICK_TASK_SCOPE_CAP + 1} non-test files; the cap is ${QUICK_TASK_SCOPE_CAP}`,
		]);
	});
});

describe("isTestFilePath", () => {
	const cases: Array<[string, boolean]> = [
		["test/x.test.ts", true],
		["tests/y.ts", true],
		["__tests__/z.ts", true],
		["packages/x/__tests__/y.ts", true],
		["src/a.spec.ts", true],
		["src/a.test.ts", true],
		["foo_test.go", true],
		["src/contest.ts", false],
		["src/index.ts", false],
	];

	it.each(cases)("classifies %s as test=%s", (path, expected) => {
		expect(isTestFilePath(path)).toBe(expected);
	});
});
