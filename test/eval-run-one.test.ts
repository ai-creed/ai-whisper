import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLedger } from "../eval/runner/ledger.ts";
import { buildManifest, loadManifest, runKey, saveManifest } from "../eval/runner/manifest.ts";
import { DriftError } from "../eval/runner/pins.ts";
import { QuotaExhaustedError } from "../eval/runner/quota.ts";
import { runOne, type RunOneDeps } from "../eval/runner/run-one.ts";
import { HarnessFailure, type Pins, type RunOutcome } from "../eval/runner/types.ts";
import type { GradeResult } from "../eval/runner/grade.ts";

const pins: Pins = { implementerModel: "impl", reviewerModel: "rev", billing: "subscription", evaluator: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, cliVersions: { whisper: "0.16.0+a", claude: "2.0.0", codex: "0.50.0" } };
const outcome = (arm: "A" | "B" | "C"): RunOutcome => ({ stopReason: "completed", stopSource: null, usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }, tokenSource: "metered", costUsd: 0.01, seconds: 1, rounds: arm === "C" ? 1 : null, escalated: false, reviewFindings: arm === "C" ? 0 : null, failureMode: null, reviewerModel: arm === "C" ? "rev" : null, evaluator: arm === "C" ? { ...pins.evaluator, fallbackUsed: false } : null, workspaceDir: "/ws" });
const green: GradeResult = { hygiene: { typecheck: "pass", lint: "pass", tests: "pass" }, gradeTestsPassed: 1, gradeTestsTotal: 1, taskSuccess: true, logs: { typecheck: "", lint: "", tests: "", grade: "" } };

function campaign(root: string) {
	const tasksRoot = join(root, "tasks"); const dir = join(tasksRoot, "t1");
	mkdirSync(join(dir, "fixture"), { recursive: true }); mkdirSync(join(dir, "grade"));
	writeFileSync(join(dir, "task.md"), "# T\n\n## Task\nx\n\n## Scope\n- src/a.ts\n\n## Acceptance criteria\n- y\n");
	writeFileSync(join(dir, "approach.md"), "a\n"); writeFileSync(join(dir, "budget.json"), JSON.stringify({ wallClockSeconds: 10, tokenCap: 10 }));
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ category: "feature", shape: "quick-task" })); writeFileSync(join(dir, "grade", "a.grade.test.ts"), "");
	const campaignDir = join(root, "results", "c"); mkdirSync(campaignDir, { recursive: true });
	saveManifest(campaignDir, buildManifest({ campaignId: "c", taskSlugs: ["t1"], trials: 1, seed: 1, pins, sourceStateRoot: root, now: "x" }));
	return { campaignDir, tasksRoot };
}
const deps = (over: Partial<RunOneDeps> = {}): Partial<RunOneDeps> => ({
	runSolo: async (i) => outcome(i.arm), runPair: async () => outcome("C"), grade: () => green,
	prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
	liveReviewerModel: () => "rev", liveEvaluator: () => pins.evaluator, liveCliVersions: () => pins.cliVersions, now: () => "2026-08-19T00:00:00.000Z", ...over,
});

describe("runOne", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("drives, grades, appends a row and marks the run done", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "A", trial: 1 });
		let dest = "", gradeDir = "";
		const r = await runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, deps({ prepare: (i) => { dest = i.dest; return { workspaceDir: i.dest, baselineSha: "0".repeat(40) }; }, grade: (i) => { gradeDir = i.gradeDir; return green; } }));
		expect(r.status).toBe("done");
		expect(dest).toBe(join(root, "ws-outside", "c", "t1", "A", "1", "attempt-1"));
		expect(gradeDir).toBe(join(root, "ws-outside", "c", "t1", "A", "1", "attempt-1.grade")); // outside the repo, beside the workspace
		expect(readFileSync(join(campaignDir, "runs", "t1", "A", "1", "attempt-1", "grade-path.txt"), "utf8").trim()).toBe(gradeDir);
		expect(readLedger(campaignDir)[0]).toMatchObject({ campaign_id: "c", seed: 1, scheduled_per_arm: 1 });
		expect(readLedger(campaignDir)).toHaveLength(1);
		expect(loadManifest(campaignDir).runs.find((x) => runKey(x) === key)?.status).toBe("done");
	});

	it("refuses an Arm C run on pin drift before claiming it", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "C", trial: 1 });
		await expect(runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, deps({ liveEvaluator: () => ({ ...pins.evaluator, fallbackModel: "changed" }) }))).rejects.toBeInstanceOf(DriftError);
		expect(loadManifest(campaignDir).runs.find((x) => runKey(x) === key)?.status).toBe("pending");
		expect(readLedger(campaignDir)).toHaveLength(0);
	});

	it("first harness failure leaves the run reclaimable; second writes a harness_failure row", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "B", trial: 1 });
		const d = deps({ runSolo: async () => { throw new HarnessFailure("ENOSPC"); } });
		await expect(runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, d)).rejects.toMatchObject({ retryable: true });
		expect(loadManifest(campaignDir).runs.find((x) => runKey(x) === key)).toMatchObject({ status: "running", attempts: 1 });
		const r = await runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, d);
		expect(r.status).toBe("failed");
		expect(r.row?.stop_reason).toBe("harness_failure");
		expect(loadManifest(campaignDir).runs.find((x) => runKey(x) === key)).toMatchObject({ status: "failed", attempts: 2 });
	});

	it("Arm C gets a short state root under <workspaceRoot>/../state so the mount's socket path stays under the macOS limit", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "C", trial: 1 });
		let stateRoot = "";
		await runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, deps({ runPair: async (i) => { stateRoot = i.stateRoot; return outcome("C"); } }));
		expect(stateRoot).toMatch(new RegExp(`^${join(root, "state")}/[0-9a-f]{12}$`));
		expect(existsSync(join(campaignDir, "runs", "t1", "C", "1", "attempt-1", "state-path.txt"))).toBe(true);
	});

	it("an Arm C product-stack failure is an unsuccessful run even when the workspace grades green, and not a harness failure", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "C", trial: 1 });
		const r = await runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, deps({ runPair: async () => ({ ...outcome("C"), stopReason: "agent_failure", failureMode: "mount_bind_timeout" }), grade: () => green }));
		expect(r.status).toBe("done");
		expect(r.row).toMatchObject({ stop_reason: "agent_failure", failure_mode: "mount_bind_timeout", task_success: false, grade_tests_passed: 1 });
	});

describe("billing pin", () => {
	it("hands the manifest's billing mode to both arm drivers", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const seen: string[] = [];
		const d = deps({ runSolo: async (i) => { seen.push(`${i.arm}:${i.billing}`); return outcome(i.arm); }, runPair: async (i) => { seen.push(`C:${i.billing}`); return outcome("C"); } });
		for (const arm of ["A", "C"] as const) await runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key: `t1/${arm}/1` }, d);
		expect(seen).toEqual(["A:subscription", "C:subscription"]);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("quota exhaustion", () => {
	it("writes no ledger row, puts the run back to pending with its attempt refunded, and propagates", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-runone-")); const { campaignDir, tasksRoot } = campaign(root);
		const key = runKey({ task: "t1", arm: "C", trial: 1 });
		const d = deps({ runPair: async () => { throw new QuotaExhaustedError("codex", "You've hit your usage limit"); } });
		await expect(runOne({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws-outside"), key }, d)).rejects.toBeInstanceOf(QuotaExhaustedError);
		expect(readLedger(campaignDir)).toEqual([]);
		const run = loadManifest(campaignDir).runs.find((r) => runKey(r) === key);
		expect(run).toMatchObject({ status: "pending", attempts: 0, runDir: null, startedAt: null });
		rmSync(root, { recursive: true, force: true });
	});
});
});
