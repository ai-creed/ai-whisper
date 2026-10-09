import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBillingFlagScope, parseArms, parseBilling, parseNonNegativeInt, parsePositiveInt, UsageError } from "../eval/runner/cli-args.ts";
import { cmdInit, cmdReport, cmdRun, cmdSlice, cmdStatus, cmdValidateTasks } from "../eval/runner/commands.ts";
import { QuotaExhaustedError } from "../eval/runner/quota.ts";
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
		const m = cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 5, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator });
		expect(m.runs).toHaveLength(12);
		expect(() => cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 5, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator })).toThrow(/exists/);
		expect(cmdStatus({ campaignDir })).toMatch(/pending\s+12/);
		const order: string[] = [];
		const res = await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), arms: ["A", "B"], parallelSolo: 2 }, {
			runSolo: async (i) => { order.push(i.arm); return ok; }, grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x", preflight: () => {},
		});
		expect(res).toEqual({ done: 8, failed: 0 });
		expect(order).toHaveLength(8);
		expect(loadManifest(campaignDir).runs.filter((r) => r.status === "done")).toHaveLength(8);
		rmSync(join(campaignDir, "manifest.json")); // the report must not need it
		const md = cmdReport({ campaignDir });
		expect(md).toContain("## Primary metric");
	});

	it("init with a tasks filter schedules only those tasks", () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const m = cmdInit({ campaignDir: join(root, "results", "c"), tasksRoot, trials: 1, seed: 5, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator, tasks: ["t1"] });
		expect(m.runs).toHaveLength(3);
		expect(new Set(m.runs.map((r) => r.task))).toEqual(new Set(["t1"]));
		expect(() => cmdInit({ campaignDir: join(root, "results", "d"), tasksRoot, trials: 1, seed: 5, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator, tasks: ["nope"] })).toThrow(/nope/);
	});

	it("slice executes in manifest order; a pair run never reorders past its neighbours", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const campaignDir = join(root, "results", "c");
		const m = cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 9, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator });
		const expected = m.runs.map(runKey);
		const started: string[] = []; let inFlight = 0, maxInFlight = 0, pairSawSolo = false;
		const track = async (key: string, isPair: boolean) => { started.push(key); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); if (isPair && inFlight > 1) pairSawSolo = true; await new Promise((r) => setTimeout(r, 5)); inFlight--; };
		await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), parallelSolo: 2 }, {
			runSolo: async (i) => { await track(`${i.task.slug}/${i.arm}/?`, false); return ok; },
			runPair: async (i) => { await track(`${i.task.slug}/C/?`, true); return { ...ok, rounds: 1, reviewFindings: 0, reviewerModel: "rev", evaluator: { ...evaluator, fallbackUsed: false } }; },
			grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x", preflight: () => {},
		});
		// Pair runs must appear at the same relative positions as in the manifest (solo neighbours may swap only among themselves).
		const pairPositions = (keys: string[]) => keys.map((k, i) => (k.includes("/C/") ? i : -1)).filter((i) => i >= 0);
		expect(pairPositions(started)).toEqual(pairPositions(expected));
		expect(pairSawSolo).toBe(false);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("slice and run gate on the billing preflight with the manifest's pin, before any run; dry runs skip it", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task");
		const campaignDir = join(root, "results", "c");
		const m = cmdInit({ campaignDir, tasksRoot, trials: 1, seed: 9, implementerModel: "impl", reviewerModel: "rev", billing: "subscription", sourceStateRoot: root, cliVersions, evaluator });
		const seen: string[] = []; let runs = 0;
		const deps = (preflight: (i: { billing: string }) => void) => ({
			runSolo: async () => { runs++; return ok; }, runPair: async () => { runs++; return { ...ok, rounds: 1, reviewFindings: 0, reviewerModel: "rev", evaluator: { ...evaluator, fallbackUsed: false } }; },
			grade: () => green, prepare: (i: { dest: string }) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x", preflight,
		});
		const opts = { campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), parallelSolo: 1 };
		await expect(cmdSlice(opts, deps(() => { throw new Error("no login"); }))).rejects.toThrow(/no login/);
		expect(runs).toBe(0);
		await cmdSlice({ ...opts, arms: ["A"] }, deps((i) => seen.push(i.billing)));
		expect(seen).toEqual(["subscription"]);
		await cmdRun({ ...opts, key: runKey(m.runs.find((r) => r.arm === "B")!) }, deps((i) => seen.push(i.billing)));
		expect(seen).toEqual(["subscription", "subscription"]);
		const dry = { env: {}, claudeCommand: "fake" };
		await cmdRun({ ...opts, key: runKey(m.runs.find((r) => r.arm === "C")!), dryRun: dry }, deps(() => { throw new Error("must not run"); }));
		expect(runs).toBe(3);
	});

	it("a quota hit stops the slice: no new runs start, in-flight runs finish, the rest stay pending", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const campaignDir = join(root, "results", "c");
		cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 9, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator });
		let started = 0;
		const run = cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), arms: ["A", "B"], parallelSolo: 2 }, {
			runSolo: async () => { started++; const n = started; await new Promise((r) => setTimeout(r, 10)); if (n === 2) throw new QuotaExhaustedError("claude", "You've hit your limit"); return ok; },
			grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x", preflight: () => {},
		});
		await expect(run).rejects.toBeInstanceOf(QuotaExhaustedError);
		expect(started).toBeLessThanOrEqual(3);
		const runs = loadManifest(campaignDir).runs.filter((r) => r.arm !== "C");
		expect(runs.filter((r) => r.status === "running")).toEqual([]);
		expect(runs.filter((r) => r.status === "pending").length).toBeGreaterThanOrEqual(5);
	});

	it("a NaN parallelSolo still caps in-flight solo runs at 1", async () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "t1", "feature", "quick-task"); writeTask(tasksRoot, "t2", "bugfix", "quick-task");
		const campaignDir = join(root, "results", "c");
		cmdInit({ campaignDir, tasksRoot, trials: 2, seed: 9, implementerModel: "impl", reviewerModel: "rev", billing: "api", sourceStateRoot: root, cliVersions, evaluator });
		let inFlight = 0, maxInFlight = 0;
		const track = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; };
		const res = await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: root, whisperCli: "x", workspaceRoot: join(root, "ws"), arms: ["A", "B"], parallelSolo: Number.NaN }, {
			runSolo: async () => { await track(); return ok; },
			grade: () => green, prepare: (i) => ({ workspaceDir: i.dest, baselineSha: "0".repeat(40) }),
			liveReviewerModel: () => "rev", liveEvaluator: () => evaluator, liveCliVersions: () => cliVersions, now: () => "x", preflight: () => {},
		});
		expect(res.done).toBe(8);
		expect(maxInFlight).toBe(1);
	});

	it("parses numeric and arm flags strictly", () => {
		expect(parsePositiveInt("--trials", "3")).toBe(3);
		expect(parsePositiveInt("--trials", undefined, 2)).toBe(2);
		expect(() => parsePositiveInt("--trials", "abc")).toThrow(UsageError);
		expect(() => parsePositiveInt("--trials", "0")).toThrow(/--trials must be a positive integer, got 0/);
		expect(() => parsePositiveInt("--trials", "-1")).toThrow(UsageError);
		expect(parseNonNegativeInt("--seed", "0")).toBe(0);
		expect(() => parseNonNegativeInt("--seed", "x")).toThrow(UsageError);
		expect(parseArms(undefined)).toBeUndefined();
		expect(parseBilling(undefined)).toBe("subscription");
		expect(parseBilling("api")).toBe("api");
		expect(() => parseBilling("free")).toThrow(/--billing must be one of subscription, api, got free/);
		// --billing is a pin: accepted on init only, so a slice cannot silently run on the manifest's mode
		expect(() => assertBillingFlagScope("init", "api")).not.toThrow();
		expect(() => assertBillingFlagScope("slice", undefined)).not.toThrow();
		expect(() => assertBillingFlagScope("slice", "api")).toThrow(/--billing is pinned at init/);
		expect(parseArms(["A", "C"])).toEqual(["A", "C"]);
		expect(() => parseArms(["D"])).toThrow("--arm must be one of A, B, C");
	});

	it("validate-tasks reports suite-count violations", () => {
		root = mkdtempSync(join(tmpdir(), "eval-cli-"));
		const tasksRoot = join(root, "tasks"); writeTask(tasksRoot, "only", "feature", "quick-task");
		const v = cmdValidateTasks({ tasksRoot, toolchainNodeModules: root });
		expect(v.join("\n")).toMatch(/expected 15 tasks/);
		expect(v.join("\n")).toMatch(/8 feature/);
	});
});
