import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverTasks, loadTask, parseTaskMd } from "../eval/runner/tasks.ts";

const TASK_MD = `# CSV: quoted fields

## Task
Add quoted-field support to the CSV parser.

## Scope
- \`src/parse.ts\`
- test/parse.test.ts

## Acceptance criteria
- \`parse('a,"b,c"')\` yields two fields.
`;

function writeTask(root: string, slug: string, opts: { approach?: boolean; shape?: string; gradeInsideFixture?: boolean } = {}) {
	const dir = join(root, slug);
	mkdirSync(join(dir, "fixture", "src"), { recursive: true });
	mkdirSync(join(dir, "grade"), { recursive: true });
	writeFileSync(join(dir, "task.md"), TASK_MD);
	writeFileSync(join(dir, "budget.json"), JSON.stringify({ wallClockSeconds: 900, tokenCap: 400000 }));
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ category: "feature", shape: opts.shape ?? "quick-task" }));
	writeFileSync(join(dir, "grade", "parse.grade.test.ts"), "// held out\n");
	if (opts.approach !== false) writeFileSync(join(dir, "approach.md"), "Extend the tokenizer state machine.\n");
	if (opts.gradeInsideFixture) { mkdirSync(join(dir, "fixture", "grade")); writeFileSync(join(dir, "fixture", "grade", "x.ts"), ""); }
	return dir;
}

describe("parseTaskMd", () => {
	it("extracts title, sections and scope paths", () => {
		const p = parseTaskMd(TASK_MD);
		expect(p.title).toBe("CSV: quoted fields");
		expect(p.taskSection).toContain("quoted-field support");
		expect(p.scopeBullets).toEqual(["src/parse.ts", "test/parse.test.ts"]);
		expect(p.acceptanceSection).toContain("yields two fields");
	});
	it("throws naming every missing section", () => {
		expect(() => parseTaskMd("# T\n\n## Task\nx\n")).toThrow(/Scope.*Acceptance criteria|Acceptance criteria.*Scope/s);
	});
});

describe("parseTaskMd strictness", () => {
	it("rejects annotated scope bullets, stray scope text and extra sections", () => {
		const bad = "# T\n\n## Task\nx\n\n## Scope\n- `src/a.ts` — entry point\n- src/b.ts src/c.ts\nstray text\n\n## Notes\nhi\n\n## Acceptance criteria\n- ok\n";
		let msg = "";
		try { parseTaskMd(bad); } catch (e) { msg = (e as Error).message; }
		expect(msg).toContain("Scope bullet must be a single bare path: `src/a.ts` — entry point");
		expect(msg).toContain("Scope bullet must be a single bare path: src/b.ts src/c.ts");
		expect(msg).toContain("Scope must contain only bullets");
		expect(msg).toContain("unexpected section: Notes");
	});
});

describe("loadTask / discoverTasks", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("loads a quick-task with approach.md", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		const dir = writeTask(root, "csv-parse-quoted");
		const t = loadTask(dir);
		expect(t).toMatchObject({ slug: "csv-parse-quoted", shape: "quick-task", category: "feature", approach: "Extend the tokenizer state machine.\n", budget: { wallClockSeconds: 900, tokenCap: 400000 } });
	});
	it("rejects a quick-task without approach.md and an SDD task with one", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		expect(() => loadTask(writeTask(root, "a", { approach: false }))).toThrow(/approach\.md/);
		expect(() => loadTask(writeTask(root, "b", { shape: "spec-driven-development" }))).toThrow(/approach\.md/);
	});
	it("rejects grade content reachable inside the fixture", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		expect(() => loadTask(writeTask(root, "c", { gradeInsideFixture: true }))).toThrow(/grade/);
	});
	it("rejects a held-out leak in task.md or a fixture file", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		const d = writeTask(root, "d");
		writeFileSync(join(d, "fixture", "src", "hint.ts"), "// see ../../grade/x.ts\n");
		expect(() => loadTask(d)).toThrow(/held-out leak: .*hint\.ts/);
		const e = writeTask(root, "e");
		writeFileSync(join(e, "task.md"), TASK_MD + "\nTests live in eval/tasks/e/grade.\n");
		expect(() => loadTask(e)).toThrow(/held-out leak: task\.md/);
	});
	it("rejects any symbolic link inside the fixture, including one aliasing grade/", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		const f = writeTask(root, "f");
		symlinkSync(join(f, "grade"), join(f, "fixture", "src", "answers"), "dir"); // a link named innocently, pointing at the held-out tests
		expect(() => loadTask(f)).toThrow(/held-out leak: .*answers is a symbolic link/);
		const g = writeTask(root, "g");
		symlinkSync("/etc/hostname", join(g, "fixture", "src", "note.txt")); // a file link to anywhere is rejected too
		expect(() => loadTask(g)).toThrow(/is a symbolic link/);
	});
	it("discovers tasks sorted by slug", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tasks-"));
		writeTask(root, "zeta"); writeTask(root, "alpha");
		expect(discoverTasks(root).map((t) => t.slug)).toEqual(["alpha", "zeta"]);
	});
});
