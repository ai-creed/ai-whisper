import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTaskBrief } from "@ai-whisper/broker";
import { composeQuickTaskBrief } from "./arms/pair-brief.ts";
import { gradeRun } from "./grade.ts";
import { appendLedgerRow, buildLedgerRow, readLedger } from "./ledger.ts";
import { buildManifest, loadManifest, manifestPath, runKey, saveManifest, scheduledPerArm, selectSlice, summarize } from "./manifest.ts";
import { resolveCliVersions, resolveEvaluatorSnapshot } from "./pins.ts";
import { renderReport } from "./report.ts";
import { RetryableRunError, runOne, type RunOneDeps, type RunOneInput } from "./run-one.ts";
import { discoverTasks, loadTask } from "./tasks.ts";
import type { Arm, CliVersions, EvaluatorSnapshot, Manifest, RunOutcome } from "./types.ts";
import { prepareWorkspace } from "./workspace.ts";

export function cmdInit(o: { campaignDir: string; tasksRoot: string; trials: number; seed: number; implementerModel: string; reviewerModel: string; sourceStateRoot: string; cliVersions?: CliVersions; evaluator?: EvaluatorSnapshot; tasks?: string[] }): Manifest {
	if (existsSync(manifestPath(o.campaignDir))) throw new Error(`${manifestPath(o.campaignDir)} already exists; pick another --campaign id`);
	mkdirSync(o.campaignDir, { recursive: true });
	let tasks = discoverTasks(o.tasksRoot);
	if (o.tasks) {
		const missing = o.tasks.filter((slug) => !tasks.some((t) => t.slug === slug));
		if (missing.length > 0) throw new Error(`unknown task slug(s): ${missing.join(", ")}`);
		tasks = tasks.filter((t) => o.tasks?.includes(t.slug));
	}
	const m = buildManifest({
		campaignId: o.campaignDir.split("/").pop() ?? "campaign", taskSlugs: tasks.map((t) => t.slug), trials: o.trials, seed: o.seed,
		pins: { implementerModel: o.implementerModel, reviewerModel: o.reviewerModel, evaluator: o.evaluator ?? resolveEvaluatorSnapshot(o.sourceStateRoot), cliVersions: o.cliVersions ?? resolveCliVersions() },
		sourceStateRoot: o.sourceStateRoot, now: new Date().toISOString(),
	});
	saveManifest(o.campaignDir, m);
	return m;
}

export function cmdStatus(o: { campaignDir: string }): string {
	const m = loadManifest(o.campaignDir);
	const s = summarize(m);
	const lines = [`campaign ${m.campaignId}  seed ${m.seed}`, `pending  ${s.pending}`, `running  ${s.running}`, `done     ${s.done}`, `failed   ${s.failed}`];
	for (const a of ["A", "B", "C"] as const) lines.push(`arm ${a}: ${s.byArm[a].done} done, ${s.byArm[a].failed} failed, ${s.byArm[a].total} total`);
	return lines.join("\n");
}

type SliceOpts = { campaignDir: string; tasksRoot: string; toolchainNodeModules: string; whisperCli: string; workspaceRoot: string; arms?: Arm[]; tasks?: string[]; limit?: number; parallelSolo: number; dryRun?: RunOneInput["dryRun"] };

async function runWithRetry(o: SliceOpts, key: string, deps: Partial<RunOneDeps>): Promise<"done" | "failed"> {
	const input: RunOneInput = { campaignDir: o.campaignDir, tasksRoot: o.tasksRoot, toolchainNodeModules: o.toolchainNodeModules, whisperCli: o.whisperCli, workspaceRoot: o.workspaceRoot, key, ...(o.dryRun ? { dryRun: o.dryRun } : {}) };
	try {
		return (await runOne(input, deps)).status;
	} catch (e) {
		if (e instanceof RetryableRunError) return (await runOne(input, deps)).status;
		throw e;
	}
}

export async function cmdSlice(o: SliceOpts, deps: Partial<RunOneDeps> = {}): Promise<{ done: number; failed: number }> {
	const m = loadManifest(o.campaignDir);
	const selected = selectSlice(m, { ...(o.arms ? { arms: o.arms } : {}), ...(o.tasks ? { tasks: o.tasks } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) });
	let done = 0, failed = 0;
	const tally = (s: "done" | "failed"): void => { if (s === "done") done++; else failed++; };
	// Manifest order is the experimental control: walk it in order. Consecutive
	// solo runs may overlap (bounded pool); a pair run drains the pool first,
	// runs alone, and only then do later runs start — so Arm C keeps its seeded
	// position and never clusters at the end.
	const limit = Number.isFinite(o.parallelSolo) && o.parallelSolo >= 1 ? Math.floor(o.parallelSolo) : 1;
	let pool: Promise<void>[] = [];
	const drain = async (): Promise<void> => { await Promise.all(pool); pool = []; };
	for (const r of selected) {
		const key = runKey(r);
		if (r.arm === "C") {
			await drain();
			tally(await runWithRetry(o, key, deps));
			continue;
		}
		if (pool.length >= limit) await Promise.race(pool);
		const task = runWithRetry(o, key, deps).then((s) => { tally(s); pool = pool.filter((p) => p !== task); });
		pool.push(task);
	}
	await drain();
	return { done, failed };
}

export async function cmdRun(o: SliceOpts & { key: string }, deps: Partial<RunOneDeps> = {}): Promise<"done" | "failed"> {
	return runWithRetry(o, o.key, deps);
}

export function cmdGrade(o: { campaignDir: string; tasksRoot: string; toolchainNodeModules: string; key: string }): void {
	const m = loadManifest(o.campaignDir);
	const run = m.runs.find((r) => runKey(r) === o.key);
	if (!run || !run.runDir) throw new Error(`run ${o.key} has no recorded runDir`);
	const task = loadTask(join(o.tasksRoot, run.task));
	const outcome = JSON.parse(readFileSync(join(run.runDir, "outcome.json"), "utf8")) as RunOutcome;
	const workspaceDir = readFileSync(join(run.runDir, "workspace-path.txt"), "utf8").trim();
	const grade = gradeRun({ task, workspaceDir, gradeDir: join(run.runDir, `grade-regrade-${Date.now()}`), toolchainNodeModules: o.toolchainNodeModules });
	writeFileSync(join(run.runDir, "grade.json"), JSON.stringify({ ...grade, regraded: true }, null, "\t"));
	appendLedgerRow(o.campaignDir, buildLedgerRow({ campaignId: m.campaignId, seed: m.seed, scheduledPerArm: scheduledPerArm(m), task: run.task, arm: run.arm, trial: run.trial, outcome, grade, pins: m.pins, gradedAt: new Date().toISOString() }));
}

export function cmdReport(o: { campaignDir: string }): string {
	// Ledger only — never the manifest — so anyone with the committed ledger.jsonl reproduces this file.
	const md = renderReport({ rows: dedupeLatest(readLedger(o.campaignDir)) });
	writeFileSync(join(o.campaignDir, "report.md"), md);
	return md;
}

/** A re-grade appends a newer row for the same key; the report uses the latest row per key. */
export function dedupeLatest<T extends { task: string; arm: Arm; trial: number }>(rows: T[]): T[] {
	const byKey = new Map<string, T>();
	for (const r of rows) byKey.set(runKey(r), r);
	return [...byKey.values()];
}

export function cmdValidateTasks(o: { tasksRoot: string; toolchainNodeModules: string; green?: boolean }): string[] {
	const violations: string[] = [];
	const tasks: ReturnType<typeof discoverTasks> = [];
	for (const name of readdirSync(o.tasksRoot)) {
		try { tasks.push(loadTask(join(o.tasksRoot, name))); } catch (e) { violations.push((e as Error).message); }
	}
	const count = (pred: (t: (typeof tasks)[number]) => boolean): number => tasks.filter(pred).length;
	if (tasks.length !== 15) violations.push(`expected 15 tasks, found ${tasks.length}`);
	if (count((t) => t.category === "feature") !== 8 || count((t) => t.category === "bugfix") !== 4 || count((t) => t.category === "refactor") !== 3) violations.push(`expected 8 feature / 4 bugfix / 3 refactor, found ${count((t) => t.category === "feature")}/${count((t) => t.category === "bugfix")}/${count((t) => t.category === "refactor")}`);
	if (count((t) => t.shape === "quick-task") !== 12 || count((t) => t.shape === "spec-driven-development") !== 3) violations.push(`expected 12 quick-task / 3 spec-driven-development, found ${count((t) => t.shape === "quick-task")}/${count((t) => t.shape === "spec-driven-development")}`);
	for (const t of tasks) {
		if (t.shape === "quick-task") {
			const v = validateTaskBrief(composeQuickTaskBrief(t));
			if (!v.ok) violations.push(`${t.slug}: generated brief fails the quick-task gate: ${v.violations.join("; ")}`);
		}
		if (o.green) {
			const dest = join(tmpdir(), "ai-whisper-eval-validate", t.slug); // outside the repo, like real workspaces
			rmSync(dest, { recursive: true, force: true });
			const { workspaceDir } = prepareWorkspace({ task: t, dest, toolchainNodeModules: o.toolchainNodeModules });
			const g = gradeRun({ task: t, workspaceDir, gradeDir: join(dest, "..", `${t.slug}-grade`), toolchainNodeModules: o.toolchainNodeModules });
			if (g.hygiene.typecheck !== "pass" || g.hygiene.lint !== "pass" || g.hygiene.tests !== "pass") violations.push(`${t.slug}: fixture is not green (${JSON.stringify(g.hygiene)})`);
			if (g.gradeTestsTotal === 0) violations.push(`${t.slug}: grade/ has no tests`);
			if (g.gradeTestsPassed === g.gradeTestsTotal) violations.push(`${t.slug}: held-out tests already pass on the untouched fixture`);
		}
	}
	return violations;
}
