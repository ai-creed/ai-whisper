import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdInit, cmdReport, cmdSlice, cmdStatus, cmdValidateTasks } from "../eval/runner/commands.ts";
import { loadManifest, runKey } from "../eval/runner/manifest.ts";
import type { RunOutcome } from "../eval/runner/types.ts";
import type { GradeResult } from "../eval/runner/grade.ts";

function writeTask(tasksRoot: string, slug: string, category: string, shape: string) {
	const dir = join(tasksRoot, slug);
	mkdirSync(join(dir, "fixture"), { recursive: true }); mkdirSync(join(dir, "grade"));
	writeFileSync(join(dir, "task.md"), `# ${slug}\n\n## Task\nx\n\n## Scope\n- src/a.ts\n\n## Acceptance criteria\n- y\n`);
	if (shape === "quick-task") writeFileSync(join(dir, "approach.md"), "a\n");
	writeFileSync(join(dir, "budget.json"), JSON.stringify({ wallClockSeconds: 10, tokenCap: 10 }));
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ category, shape }));
	writeFileSync(join(dir, "grade", "a.grade.test.ts"), "it('x', () => {});\n");
}
const evaluator = { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null };
const cliVersions = { whisper: "0.16.0+a", claude: "2", codex: "0.5" };
const ok: RunOutcome = { stopReason: "completed", stopSource: null, usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }, tokenSource: "metered", costUsd: 0, seconds: 1, rounds: null, escalated: false, reviewFindings: null, failureMode: null, reviewerModel: null, evaluator: null, workspaceDir: "/ws" };
const green: GradeResult = { hygiene: { typecheck: "pass", lint: "pass", tests: "pass" }, gradeTestsPassed: 1, gradeTestsTotal: 1, taskSuccess: true, logs: { typecheck: "", lint: "", tests: "", grade: "" } };

describe("commands", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("init → status → slice (solo only) → report", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const campaignDir = join(root, "results", "c");
		const m = cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 5, implementerModel: "impl", reviewerModel: "rev", sourceStateRoot: root, cliVersions, evaluator });
		expect(m.runs).toHaveLength(12);
		expect(() => cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 5, implementerModel: "impl", reviewerModel: "rev", sourceStateRoot: root, cliVersions, evaluator })).toThrow(/exists/);
		expect(cmdStatus({ campaignDir })).toMatch(/pending\s+12/);
		const order: string[] = [];
		const res = await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), arms: ["A", "B"], parallelSolo: 2 }, {
			runSolo: async (i) => { order.push(i.arm); return ok; }, grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x",
		});
		expect(res).toEqual({ done: 8, failed: 0 });
		expect(order).toHaveLength(8);
		expect(loadManifest(campaignDir).runs.filter((r) => r.status === "done")).toHaveLength(8);
		rmSync(join(campaignDir, "manifest.json")); // the report must not need it
		const md = cmdReport({ campaignDir });
		expect(md).toContain("## Primary metric");
	});

	it("slice executes in manifest order; a pair run never reorders past its neighbours", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const campaignDir = join(root, "results", "c");
		const m = cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 9, implementerModel: "impl", reviewerModel: "rev", sourceStateRoot: root, cliVersions, evaluator });
		const expected = m.runs.map(runKey);
		const started: string[] = []; let inFlight = 0, maxInFlight = 0, pairSawSolo = false;
		const track = async (key: string, isPair: boolean) => { started.push(key); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); if (isPair && inFlight > 1) pairSawSolo = true; await new Promise((r) => setTimeout(r, 5)); inFlight--; };
		await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), parallelSolo: 2 }, {
			runSolo: async (i) => { await track(`${i.task.slug}/${i.arm}/?`, false); return ok; },
			runPair: async (i) => { await track(`${i.task.slug}/C/?`, true); return { ...ok, rounds: 1, reviewFindings: 0, reviewerModel: "rev", evaluator: { ...evaluator, fallbackUsed: false } }; },
			grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x",
		});
		// Pair runs must appear at the same relative positions as in the manifest (solo neighbours may swap only among themselves).
		const pairPositions = (keys: string[]) => keys.map((k, i) => (k.includes("/C/") ? i : -1)).filter((i) => i >= 0);
		expect(pairPositions(started)).toEqual(pairPositions(expected));
		expect(pairSawSolo).toBe(false);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("validate-tasks reports suite-count violations", () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "only", "feature", "quick-task");
		const v = cmdValidateTasks({ tasksRoot, toolchainNodeModules: root });
		expect(v.join("\n")).toMatch(/expected 15 tasks/);
		expect(v.join("\n")).toMatch(/8 feature/);
	});
});
