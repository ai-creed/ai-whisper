import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { cmdInit, cmdReport, cmdSlice } from "./commands.ts";
import { readLedger } from "./ledger.ts";
import type { RunOneInput } from "./run-one.ts";
import { DEFAULT_TOOLCHAIN_ROOT, ensureToolchain } from "./toolchain.ts";

type Verdict = "approve" | "delivered" | "execution-pass";

/**
 * Same default root as the CLI. The macOS temp dir is ~50 chars deep, and the Arm C state root derived from the
 * workspace root must keep the mount's Unix socket path under the 104-byte sun_path limit.
 */
export const DRY_RUN_WORKSPACE_ROOT = join(homedir(), ".ai-whisper-eval", "workspaces");

const DRY_MODEL = "fake-model";
const DRY_CLI_VERSIONS = { whisper: "dry", claude: "0.0.0-dry", codex: "0.0.0-dry" };
const DRY_EVALUATOR = { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null };

const STEP_VERDICT: Record<string, Verdict> = { implement: "delivered", review: "approve", fix: "delivered", execute: "execution-pass" };

function injectVerdicts(ctx: { workflowId: string; stateRoot: string; collabId: string }): void {
	const sqlitePath = join(ctx.stateRoot, "state.db");
	const ro = new Database(sqlitePath, { readonly: true });
	const daemon = ro.prepare("SELECT host, port FROM broker_daemon WHERE collab_id = ?").get(ctx.collabId) as { host: string; port: number } | undefined;
	ro.close();
	if (!daemon) throw new Error(`dry-run: no broker_daemon row for collab ${ctx.collabId}`);
	const broker = createBrokerRuntime({ sqlitePath, host: daemon.host, port: daemon.port, runWorkflowDriver: false, runDiagnosticsSweep: false, runDaemonHeartbeat: false, runBrokerDaemonSweep: false });
	const applied = new Set<string>();
	const timer = setInterval(() => {
		try {
			const wf = broker.control.getWorkflow(ctx.workflowId);
			if (!wf || wf.status !== "running") {
				clearInterval(timer);
				try { void broker.stop(); } catch { /* best effort */ }
				return;
			}
			const row = broker.db.prepare("SELECT handoff_id, handoff_step FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1").get(ctx.workflowId) as { handoff_id: string; handoff_step: string } | undefined;
			if (!row || applied.has(row.handoff_id)) return;
			const verdict = STEP_VERDICT[row.handoff_step];
			if (!verdict) return;
			broker.control.applyOrchestratorVerdict({ handoffId: row.handoff_id, verdict, confidence: 0.9, reason: "eval-dry-run-injected", workspaceHeadSha: "0000000000000000000000000000000000000000", now: new Date().toISOString() });
			applied.add(row.handoff_id);
		} catch (e) {
			console.error(`dry-run injector: ${e instanceof Error ? e.message : String(e)}; retrying`);
		}
	}, 300);
	timer.unref();
}

function prepareSliceDryRun(repoRoot: string): Promise<NonNullable<RunOneInput["dryRun"]>> {
	const fakes = join(repoRoot, "eval", "runner", "fakes");
	for (const f of ["fake-claude-headless.mjs", "fake-pair-agent.mjs"]) chmodSync(join(fakes, f), 0o755);
	const agent = join(fakes, "fake-pair-agent.mjs");
	return Promise.resolve({
		env: { AI_WHISPER_CLAUDE_CMD: agent, AI_WHISPER_CODEX_CMD: agent, ANTHROPIC_API_KEY: "sk-ant-dry-run-unused", AI_WHISPER_IDLE_THRESHOLD_MS: "600000" },
		claudeCommand: join(fakes, "fake-claude-headless.mjs"),
		onWorkflowStarted: injectVerdicts,
	});
}

async function full(repoRoot: string): Promise<boolean> {
	const campaignDir = join(repoRoot, "eval", "results", `dry-run-${Date.now()}`);
	mkdirSync(campaignDir, { recursive: true });
	const tasksRoot = join(repoRoot, "eval", "tasks");
	cmdInit({
		campaignDir, tasksRoot, trials: 1, seed: 1, implementerModel: DRY_MODEL, reviewerModel: DRY_MODEL, sourceStateRoot: campaignDir,
		cliVersions: DRY_CLI_VERSIONS, evaluator: DRY_EVALUATOR, tasks: ["csv-parse-quoted"],
	});
	const dry = await prepareSliceDryRun(repoRoot);
	const r = await cmdSlice({ campaignDir, tasksRoot, toolchainNodeModules: ensureToolchain({ repoRoot, toolchainRoot: DEFAULT_TOOLCHAIN_ROOT }), whisperCli: join(repoRoot, "packages", "cli", "dist", "bin", "whisper.js"), workspaceRoot: DRY_RUN_WORKSPACE_ROOT, tasks: ["csv-parse-quoted"], parallelSolo: 2, dryRun: dry }, {
		liveReviewerModel: () => DRY_MODEL, liveEvaluator: () => DRY_EVALUATOR, liveCliVersions: () => DRY_CLI_VERSIONS,
	});
	const rows = readLedger(campaignDir);
	const problems: string[] = [];
	if (r.failed !== 0) problems.push(`${r.failed} run(s) failed`);
	if (rows.length !== 3) problems.push(`expected 3 ledger rows, got ${rows.length}`);
	for (const x of rows) {
		const id = `${x.arm}/${x.trial}`;
		if (x.stop_reason !== "completed") problems.push(`${id}: stop_reason ${x.stop_reason} (${x.failure_mode ?? ""})`);
		if (x.failure_mode !== null) problems.push(`${id}: failure_mode ${x.failure_mode}`);
		if (x.arm !== "C" && (x.token_source !== "metered" || x.tokens.input + x.tokens.output === 0)) problems.push(`${id}: expected metered non-zero usage`);
		if (x.arm === "C" && x.token_source !== "estimated") problems.push(`${id}: expected estimated usage for stubbed pair`);
		if (x.hygiene.typecheck !== "pass" || x.hygiene.lint !== "pass" || x.hygiene.tests !== "pass") problems.push(`${id}: hygiene ${JSON.stringify(x.hygiene)}`);
		if (x.grade_tests_total !== 9) problems.push(`${id}: grade_tests_total ${x.grade_tests_total}, expected 9`);
		if (x.grade_tests_passed >= x.grade_tests_total || x.task_success) problems.push(`${id}: fake model must not satisfy held-out tests`);
	}
	const ok = problems.length === 0;
	cmdReport({ campaignDir });
	console.log(`${ok ? "DRY RUN OK" : "DRY RUN FAILED"} — ${campaignDir}`);
	for (const x of rows) console.log(`  ${x.task}/${x.arm}/${x.trial}: ${x.stop_reason} hygiene=${Object.values(x.hygiene).join("/")} grade=${x.grade_tests_passed}/${x.grade_tests_total} token_source=${x.token_source}`);
	for (const p of problems) console.log(`  ✗ ${p}`);
	return ok;
}

export const runDryRun = { prepareSliceDryRun, full };
