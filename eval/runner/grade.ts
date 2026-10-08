import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gradeDirFor } from "./tasks.ts";
import { HarnessFailure, type GateResult, type TaskMeta } from "./types.ts";

export interface GradeResult {
	hygiene: { typecheck: GateResult; lint: GateResult; tests: GateResult };
	gradeTestsPassed: number;
	gradeTestsTotal: number;
	taskSuccess: boolean;
	logs: { typecheck: string; lint: string; tests: string; grade: string };
}

export function parseVitestJson(json: string): { passed: number; total: number } | null {
	try {
		const j = JSON.parse(json) as { numPassedTests?: number; numTotalTests?: number };
		if (typeof j.numPassedTests !== "number" || typeof j.numTotalTests !== "number") return null;
		return { passed: j.numPassedTests, total: j.numTotalTests };
	} catch { return null; }
}

function run(cwd: string, cmd: string, args: string[], timeoutMs: number): { ok: boolean; log: string } {
	try {
		const out = execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
		return { ok: true, log: out };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, log: `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}` };
	}
}

function countTests(gradeSrcDir: string): number {
	let n = 0;
	for (const f of readdirSync(gradeSrcDir)) {
		if (!f.endsWith(".grade.test.ts")) continue;
		n += (readFileSync(join(gradeSrcDir, f), "utf8").match(/^\s*(it|test)\(/gm) ?? []).length;
	}
	return n;
}

export function gradeRun(input: { task: TaskMeta; workspaceDir: string; gradeDir: string; toolchainNodeModules: string; timeoutMs?: number }): GradeResult {
	const timeoutMs = input.timeoutMs ?? 300_000;
	try {
		mkdirSync(input.gradeDir, { recursive: true });
		cpSync(input.workspaceDir, input.gradeDir, { recursive: true, filter: (src) => !/(^|[\\/])(node_modules|\.git|\.ai-whisper|__grade__)([\\/]|$)/.test(src) });
		symlinkSync(input.toolchainNodeModules, join(input.gradeDir, "node_modules"), "dir");
		// The grade dir lives under the repo's eval/results; vitest walks up for a config and would pick up the repo's root one.
		if (!["ts", "mts", "js", "mjs"].some((e) => existsSync(join(input.gradeDir, `vitest.config.${e}`)))) {
			writeFileSync(join(input.gradeDir, "vitest.config.mjs"), "export default {};\n");
		}
	} catch (e) {
		throw new HarnessFailure(`grading copy failed: ${(e as Error).message}`, e);
	}

	const hasPkg = existsSync(join(input.gradeDir, "package.json"));
	const gate = (script: string): { result: GateResult; log: string } => {
		if (!hasPkg) return { result: "fail", log: "package.json missing from delivered workspace" };
		const r = run(input.gradeDir, "npm", ["run", "--silent", script], timeoutMs);
		return { result: r.ok ? "pass" : "fail", log: r.log };
	};
	const typecheck = gate("typecheck");
	const lint = gate("lint");
	const tests = gate("test");

	const gradeSrc = gradeDirFor(input.task.dir);
	const gradeDst = join(input.gradeDir, "__grade__");
	let authored: number;
	try {
		rmSync(gradeDst, { recursive: true, force: true });
		mkdirSync(gradeDst, { recursive: true });
		for (const f of readdirSync(gradeSrc)) {
			if (f.endsWith(".grade.test.ts")) cpSync(join(gradeSrc, f), join(gradeDst, f));
		}
		authored = countTests(gradeSrc);
	} catch (e) {
		throw new HarnessFailure(`grading copy failed: ${(e as Error).message}`, e);
	}
	const vitestBin = join(input.toolchainNodeModules, ".bin", "vitest");
	if (!existsSync(vitestBin)) throw new HarnessFailure(`grade runner missing: ${vitestBin}`);
	const out = run(input.gradeDir, vitestBin, ["run", "__grade__", "--reporter=json", "--outputFile=__grade__/result.json"], timeoutMs);
	const resultPath = join(gradeDst, "result.json");
	if (!existsSync(resultPath)) throw new HarnessFailure(`grade runner produced no result: ${out.log.slice(-2000)}`);
	const parsed = parseVitestJson(readFileSync(resultPath, "utf8"));
	if (!parsed) throw new HarnessFailure("grade runner produced an unparsable result.json");
	// Expansions (it.each) can raise the count above the authored one; tests the agent's config hid leave parsed.total below it.
	const total = Math.max(authored, parsed.total);
	const passed = Math.min(parsed.passed, total);
	const hygiene = { typecheck: typecheck.result, lint: lint.result, tests: tests.result };
	const hygieneGreen = hygiene.typecheck === "pass" && hygiene.lint === "pass" && hygiene.tests === "pass";
	return {
		hygiene,
		gradeTestsPassed: passed,
		gradeTestsTotal: total,
		taskSuccess: hygieneGreen && total > 0 && parsed.total >= authored && parsed.passed === parsed.total,
		logs: { typecheck: typecheck.log, lint: lint.log, tests: tests.log, grade: out.log },
	};
}
