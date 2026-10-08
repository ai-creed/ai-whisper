import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun, parseVitestJson } from "../eval/runner/grade.ts";
import { HarnessFailure, type TaskMeta } from "../eval/runner/types.ts";

// The real-tooling cases need `pnpm eval -- toolchain`: the toolchain lives outside the repo, so they skip without it.
const toolchain = process.env.AI_WHISPER_EVAL_TOOLCHAIN ?? join(homedir(), ".ai-whisper-eval", "toolchain", "node_modules");
const toolchainReady = existsSync(join(toolchain, ".bin", "vitest"));

function fixture(ws: string, opts: { impl: string; breakTooling?: boolean }) {
	mkdirSync(join(ws, "src"), { recursive: true });
	writeFileSync(join(ws, "src", "add.ts"), opts.impl);
	writeFileSync(join(ws, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", noEmit: true, skipLibCheck: true, types: [] }, include: ["src", "test", "__grade__"] }));
	writeFileSync(join(ws, "eslint.config.mjs"), "import js from '@eslint/js';\nexport default [js.configs.recommended, { ignores: ['node_modules/**'] }];\n");
	if (!opts.breakTooling) writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "fx", private: true, type: "module", scripts: { typecheck: "tsc -p tsconfig.json", lint: "eslint .", test: "vitest run --passWithNoTests --exclude __grade__" } }));
}
function task(root: string, gradeSrc?: string): TaskMeta {
	const dir = join(root, "task"); mkdirSync(join(dir, "grade"), { recursive: true });
	writeFileSync(join(dir, "grade", "add.grade.test.ts"), gradeSrc ?? "import { it, expect } from 'vitest';\nimport { add } from '../src/add.ts';\nit('adds', () => expect(add(2, 2)).toBe(4));\nit('adds negatives', () => expect(add(-1, -1)).toBe(-2));\n");
	return { slug: "t", category: "feature", shape: "quick-task", dir, title: "t", taskSection: "x", scopeBullets: ["src/add.ts"], acceptanceSection: "x", approach: "x", budget: { wallClockSeconds: 1, tokenCap: 1 } };
}

describe.skipIf(!toolchainReady)("gradeRun (needs the eval toolchain: run `pnpm eval -- toolchain`)", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("passes a green workspace", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return a + b; }\n" });
		const r = gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r.hygiene).toEqual({ typecheck: "pass", lint: "pass", tests: "pass" });
		expect(r).toMatchObject({ gradeTestsPassed: 2, gradeTestsTotal: 2, taskSuccess: true });
	}, 60_000);

	it("fails the run when a grade test fails, with partial credit recorded", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return Math.abs(a + b); }\n" });
		const r = gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r).toMatchObject({ gradeTestsPassed: 1, gradeTestsTotal: 2, taskSuccess: false });
	}, 60_000);

	it("agent config that excludes __grade__ → passed 0 of N, not a harness failure", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return a + b; }\n" });
		writeFileSync(join(ws, "vitest.config.ts"), "export default { test: { include: ['test/**/*.test.ts'] } };\n");
		const r = gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r).toMatchObject({ gradeTestsPassed: 0, gradeTestsTotal: 2, taskSuccess: false });
	}, 60_000);

	it("vitest binary missing → HarnessFailure (grading infrastructure)", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return a + b; }\n" });
		const emptyToolchain = join(root, "empty-nm"); mkdirSync(emptyToolchain);
		expect(() => gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: emptyToolchain })).toThrow(HarnessFailure);
	}, 60_000);

	it("a grade run that hangs (agent-caused infinite loop) is an unsuccessful run, not a harness failure", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { for (;;) { /* hang */ } }\n" });
		const src = "import { it, expect } from 'vitest';\nimport { add } from '../src/add.ts';\nit('adds', () => expect(add(2, 2)).toBe(4));\nit('adds negatives', () => expect(add(-1, -1)).toBe(-2));\n";
		const r = gradeRun({ task: task(root, src), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain, timeoutMs: 5000 });
		expect(r).toMatchObject({ gradeTestsPassed: 0, gradeTestsTotal: 2, taskSuccess: false });
		expect(r.logs.grade).toMatch(/^grade runner produced no result \(timeout\): /);
	}, 20_000);

	it("tooling removed by the agent → hygiene fail, row still produced", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return a + b; }\n", breakTooling: true });
		const r = gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r.hygiene).toEqual({ typecheck: "fail", lint: "fail", tests: "fail" });
		expect(r.taskSuccess).toBe(false);
		expect(r.gradeTestsTotal).toBe(2);
	}, 60_000);

	it("agent-planted __grade__ content is discarded", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return Math.abs(a + b); }\n" });
		mkdirSync(join(ws, "__grade__"));
		writeFileSync(join(ws, "__grade__", "planted.grade.test.ts"), "import { it, expect } from 'vitest';\nit('planted', () => expect(1).toBe(1));\n");
		writeFileSync(join(ws, "__grade__", "result.json"), JSON.stringify({ numPassedTests: 99, numTotalTests: 99 }));
		const r = gradeRun({ task: task(root), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r).toMatchObject({ gradeTestsPassed: 1, gradeTestsTotal: 2, taskSuccess: false });
	}, 60_000);

	it("it.each expansions count toward total", () => {
		root = mkdtempSync(join(tmpdir(), "eval-grade-"));
		const ws = join(root, "ws"); fixture(ws, { impl: "export function add(a: number, b: number): number { return a + b; }\n" });
		const src = "import { it, expect } from 'vitest';\nit.each([1, 2, 3])('case %i', (n) => expect(n).toBeLessThan(3));\n";
		const r = gradeRun({ task: task(root, src), workspaceDir: ws, gradeDir: join(root, "grade"), toolchainNodeModules: toolchain });
		expect(r).toMatchObject({ gradeTestsPassed: 2, gradeTestsTotal: 3, taskSuccess: false });
	}, 60_000);
});

describe("parseVitestJson", () => {
	it("reads vitest's json reporter counts", () => {
		expect(parseVitestJson(JSON.stringify({ numPassedTests: 3, numTotalTests: 5 }))).toEqual({ passed: 3, total: 5 });
		expect(parseVitestJson("garbage")).toBeNull();
	});
});
