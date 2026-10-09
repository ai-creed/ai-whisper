import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPairArm, type PairArmInput } from "./arms/pair.ts";
import { runSoloArm } from "./arms/solo.ts";
import { QuotaExhaustedError } from "./quota.ts";
import { gradeRun, type GradeResult } from "./grade.ts";
import { appendLedgerRow, buildLedgerRow } from "./ledger.ts";
import { claimRun, completeRun, loadManifest, runKey, saveManifest, scheduledPerArm, releaseRun } from "./manifest.ts";
import { DriftError, checkPinDrift, resolveCliVersions, resolveEvaluatorSnapshot } from "./pins.ts";
import { loadTask } from "./tasks.ts";
import { HarnessFailure, type CliVersions, type EvaluatorSnapshot, type LedgerRow, type RunOutcome } from "./types.ts";
import { prepareWorkspace } from "./workspace.ts";

export interface RunOneDeps {
	runSolo: typeof runSoloArm;
	runPair: typeof runPairArm;
	grade: typeof gradeRun;
	prepare: typeof prepareWorkspace;
	liveReviewerModel: () => string;
	liveEvaluator: (sourceStateRoot: string) => EvaluatorSnapshot;
	liveCliVersions: () => CliVersions;
	now: () => string;
}

export interface RunOneInput {
	campaignDir: string; tasksRoot: string; toolchainNodeModules: string; whisperCli: string;
	workspaceRoot: string;
	key: string;
	dryRun?: { env: NodeJS.ProcessEnv; claudeCommand: string; onWorkflowStarted?: NonNullable<PairArmInput["hooks"]>["onWorkflowStarted"] };
}

export function classifyError(e: unknown): "harness" | "unexpected" {
	return e instanceof HarnessFailure ? "harness" : "unexpected";
}

export class RetryableRunError extends Error {
	readonly retryable = true;
	constructor(message: string, public readonly cause: unknown) { super(message); this.name = "RetryableRunError"; }
}

export async function runOne(input: RunOneInput, over: Partial<RunOneDeps> = {}): Promise<{ status: "done" | "failed"; row: LedgerRow | null }> {
	const deps: RunOneDeps = {
		runSolo: runSoloArm, runPair: runPairArm, grade: gradeRun, prepare: prepareWorkspace,
		liveReviewerModel: () => loadManifest(input.campaignDir).pins.reviewerModel,
		liveEvaluator: resolveEvaluatorSnapshot, liveCliVersions: resolveCliVersions,
		now: () => new Date().toISOString(), ...over,
	};
	let manifest = loadManifest(input.campaignDir);
	const run = manifest.runs.find((r) => runKey(r) === input.key);
	if (!run) throw new Error(`no run ${input.key} in manifest`);
	if (run.status === "done") throw new Error(`run ${input.key} is already done`);
	const task = loadTask(join(input.tasksRoot, run.task));

	if (run.arm === "C") {
		const drift = checkPinDrift(manifest.pins, { reviewerModel: deps.liveReviewerModel(), evaluator: deps.liveEvaluator(manifest.sourceStateRoot), cliVersions: deps.liveCliVersions() });
		if (drift.length > 0) throw new DriftError(drift);
	}

	const attempt = run.attempts + 1;
	const runDir = join(input.campaignDir, "runs", run.task, run.arm, String(run.trial), `attempt-${attempt}`);
	manifest = claimRun(manifest, input.key, deps.now(), runDir);
	saveManifest(input.campaignDir, manifest);

	let outcome: RunOutcome | null = null;
	let grade: GradeResult | null = null;
	try {
		mkdirSync(runDir, { recursive: true });
		const dest = join(input.workspaceRoot, manifest.campaignId, run.task, run.arm, String(run.trial), `attempt-${attempt}`);
		// Short state root beside the workspace root (outside the repo): the mount listens on a Unix socket under it and
		// macOS caps socket paths at 104 bytes, so the long workspace path cannot be part of it.
		const stateRoot = join(input.workspaceRoot, "..", "state", createHash("sha1").update(dest).digest("hex").slice(0, 12));
		writeFileSync(join(runDir, "state-path.txt"), stateRoot + "\n");
		const { workspaceDir } = deps.prepare({ task, dest, toolchainNodeModules: input.toolchainNodeModules });
		writeFileSync(join(runDir, "workspace-path.txt"), workspaceDir + "\n");
		if (run.arm === "C") {
			outcome = await deps.runPair({
				task, workspaceDir, runDir, stateRoot, billing: manifest.pins.billing, implementerModel: manifest.pins.implementerModel, reviewerModel: manifest.pins.reviewerModel,
				evaluatorSnapshot: manifest.pins.evaluator, sourceStateRoot: manifest.sourceStateRoot, whisperCli: input.whisperCli,
				...(input.dryRun ? { env: input.dryRun.env, ...(input.dryRun.onWorkflowStarted ? { hooks: { onWorkflowStarted: input.dryRun.onWorkflowStarted } } : {}) } : {}),
			});
		} else {
			outcome = await deps.runSolo({
				task, arm: run.arm, workspaceDir, runDir, billing: manifest.pins.billing, implementerModel: manifest.pins.implementerModel,
				...(input.dryRun ? { claudeCommand: input.dryRun.claudeCommand } : {}),
			});
		}
		writeFileSync(join(runDir, "outcome.json"), JSON.stringify(outcome, null, "\t"));
		const gradeDir = `${dest}.grade`; // sibling of the workspace, outside the repo
		writeFileSync(join(runDir, "grade-path.txt"), gradeDir + "\n");
		grade = deps.grade({ task, workspaceDir: outcome.workspaceDir, gradeDir, toolchainNodeModules: input.toolchainNodeModules });
		writeFileSync(join(runDir, "grade.json"), JSON.stringify(grade, null, "\t"));
	} catch (e) {
		if (e instanceof QuotaExhaustedError) {
			saveManifest(input.campaignDir, releaseRun(loadManifest(input.campaignDir), input.key));
			throw e;
		}
		const kind = classifyError(e);
		const message = `${kind}: ${(e as Error).message}`;
		if (attempt < 2) throw new RetryableRunError(message, e);
		const row = buildLedgerRow({ campaignId: manifest.campaignId, seed: manifest.seed, scheduledPerArm: scheduledPerArm(manifest), task: run.task, arm: run.arm, trial: run.trial, outcome: null, grade: null, pins: manifest.pins, gradedAt: deps.now(), harnessFailure: message });
		appendLedgerRow(input.campaignDir, row);
		saveManifest(input.campaignDir, completeRun(loadManifest(input.campaignDir), input.key, "failed", deps.now()));
		return { status: "failed", row };
	}

	const row = buildLedgerRow({ campaignId: manifest.campaignId, seed: manifest.seed, scheduledPerArm: scheduledPerArm(manifest), task: run.task, arm: run.arm, trial: run.trial, outcome, grade, pins: manifest.pins, gradedAt: deps.now() });
	appendLedgerRow(input.campaignDir, row);
	saveManifest(input.campaignDir, completeRun(loadManifest(input.campaignDir), input.key, "done", deps.now()));
	return { status: "done", row };
}
