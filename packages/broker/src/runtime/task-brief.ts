/**
 * Pure gate for `quick-task` task-brief markdown files (spec:
 * docs/superpowers/specs/2026-07-03-quick-task-workflow-design.md, §3).
 *
 * No fs, no process access — callers read the file and pass the raw text in.
 * Parsing is strict on the contract (required sections, scope bullet list,
 * non-test scope cap) and lenient everywhere else (heading level, case,
 * backticked vs. plain paths, trailing bullet annotations).
 */

/** Non-test scope files above this count fail the gate. Test-file paths are uncounted. */
export const QUICK_TASK_SCOPE_CAP = 5;

export interface TaskBriefValidation {
	/** true iff violations.length === 0 */
	ok: boolean;
	/** All violations, reported together (never short-circuited on the first). */
	violations: string[];
	/** Every declared scope path, in document order (test + non-test). */
	scopeFiles: string[];
	/** Count of scopeFiles that are NOT test files. */
	nonTestScopeCount: number;
}

/**
 * A path counts as a test file when it has a `test/`, `tests/`, or
 * `__tests__/` path segment, or its basename contains `.test.`/`.spec.`, or
 * its basename matches `_test.<ext>`. Boundary-anchored so e.g. `src/contest.ts`
 * (which merely contains the substring "test") is correctly non-test.
 */
export function isTestFilePath(path: string): boolean {
	if (/(^|\/)(test|tests|__tests__)\//.test(path)) return true;
	const basename = path.slice(path.lastIndexOf("/") + 1);
	if (basename.includes(".test.") || basename.includes(".spec.")) return true;
	if (/_test\.[^.]+$/.test(basename)) return true;
	return false;
}

interface RequiredSection {
	/** Lowercased, trimmed heading text to match against. */
	key: string;
	/** Canonical `##` + title rendering used in violation messages. */
	canonical: string;
}

const REQUIRED_SECTIONS: readonly RequiredSection[] = [
	{ key: "task", canonical: "## Task" },
	{ key: "approved approach", canonical: "## Approved approach" },
	{ key: "scope", canonical: "## Scope" },
	{ key: "acceptance checks", canonical: "## Acceptance checks" },
];

interface HeadingLine {
	/** Index into the split lines array. */
	lineIndex: number;
	/** Number of leading `#` characters. */
	level: number;
	/** Heading text, trimmed. */
	text: string;
}

function findHeadings(lines: readonly string[]): HeadingLine[] {
	const headings: HeadingLine[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const match = /^(#{1,6})\s(.*)$/.exec(lines[lineIndex]!);
		if (match) {
			headings.push({ lineIndex, level: match[1]!.length, text: match[2]!.trim() });
		}
	}
	return headings;
}

/** Body lines run from just after `heading` until the next heading (any level) or EOF. */
function sectionBody(
	lines: readonly string[],
	heading: HeadingLine,
	allHeadings: readonly HeadingLine[],
): string[] {
	const next = allHeadings.find((h) => h.lineIndex > heading.lineIndex);
	const end = next ? next.lineIndex : lines.length;
	return lines.slice(heading.lineIndex + 1, end);
}

function isNonEmptyBody(body: readonly string[]): boolean {
	return body.some((line) => line.trim().length > 0);
}

function stripEnclosingBackticks(token: string): string {
	if (token.length >= 2 && token.startsWith("`") && token.endsWith("`")) {
		return token.slice(1, -1);
	}
	return token;
}

/** Top-level scope bullets only — indented sub-bullets are annotations and are ignored. */
function parseScopeBullets(body: readonly string[]): string[] {
	const paths: string[] = [];
	for (const line of body) {
		const match = /^[-*]\s+(.+)$/.exec(line);
		if (!match) continue;
		const firstToken = match[1]!.trim().split(/\s+/)[0]!;
		paths.push(stripEnclosingBackticks(firstToken));
	}
	return paths;
}

export function validateTaskBrief(content: string): TaskBriefValidation {
	const lines = content.split(/\r?\n/);
	const headings = findHeadings(lines);
	const violations: string[] = [];
	let scopeBody: string[] | null = null;

	for (const { key, canonical } of REQUIRED_SECTIONS) {
		const heading = headings.find(
			(h) => (h.level === 2 || h.level === 3) && h.text.toLowerCase() === key,
		);
		const body = heading ? sectionBody(lines, heading, headings) : null;
		if (!heading || !isNonEmptyBody(body!)) {
			violations.push(`missing or empty required section "${canonical}"`);
			continue;
		}
		if (key === "scope") {
			scopeBody = body;
		}
	}

	const scopeFiles = scopeBody ? parseScopeBullets(scopeBody) : [];
	if (scopeBody && scopeFiles.length === 0) {
		violations.push(
			'"## Scope" must declare the files the task touches as a bullet list (one file per bullet)',
		);
	}

	const nonTestScopeCount = scopeFiles.filter((path) => !isTestFilePath(path)).length;
	if (nonTestScopeCount > QUICK_TASK_SCOPE_CAP) {
		violations.push(
			`scope declares ${nonTestScopeCount} non-test files; the cap is ${QUICK_TASK_SCOPE_CAP}`,
		);
	}

	return {
		ok: violations.length === 0,
		violations,
		scopeFiles,
		nonTestScopeCount,
	};
}
