import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as pty from "node-pty";
import { assertOutsideRepo, physicalPath } from "../paths.ts";
import { DEFAULT_TRUST_CONFIG, trustWorkspace, type TrustConfig, type TrustGrant } from "./agent-trust.ts";
import { costFor, loadPricing, type PricingTable } from "../pricing.ts";
import { QuotaExhaustedError, UsageLimitWatcher } from "../quota.ts";
import { HarnessFailure, ZERO_USAGE, addUsage, estimateTokensFromChars, type EvaluatorSnapshot, type RunOutcome, type TaskMeta, type UsageTotals, type BillingMode } from "../types.ts";
import { DEFAULT_REPO_ROOT } from "../workspace.ts";
import { scrubAgentEnv } from "./agent-env.ts";
import { writePairArtifact } from "./pair-brief.ts";
import { readBoundAgents, readCollabForWorkspace, readDaemonHeartbeat, readEvaluatorUsage, readWorkflow, readWorkflowProgress } from "./pair-state.ts";
import { harvestClaudeUsage, harvestCodexUsage } from "./session-usage.ts";

export const PRODUCT_FAILURE_MODES = ["mount_bind_timeout", "mount_exited", "workflow_start_error", "daemon_dead", "workflow_halted", "collab_missing"] as const;

/** macOS sun_path is 104 bytes including the NUL; the mount listens on `<stateRoot>/sockets/<16 hex>-<agent>.sock`. */
export const MAX_SOCKET_PATH = 103;
export function turnEventSocketPathLength(stateRoot: string): number {
	return join(stateRoot, "sockets", `${"0".repeat(16)}-claude.sock`).length;
}
export type ProductFailureMode = (typeof PRODUCT_FAILURE_MODES)[number];

/** The CLI's own default evaluator model when none is configured (relay-orchestrator-evaluator.ts); other providers have no priceable default. */
export function defaultEvaluatorModel(provider: string | null): string | null {
	return provider === "anthropic" ? "claude-haiku-4-5-20251001" : null;
}

const isZero = (u: UsageTotals): boolean => u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens === 0;

/** Price every metered component at the model that actually served it; withhold cost (null) when any model is unknown. */
export function computePairCost(input: { claude: UsageTotals; codex: UsageTotals; evaluatorPrimary: UsageTotals; evaluatorFallback: UsageTotals; implementerModel: string; reviewerModel: string; evaluator: EvaluatorSnapshot; pricing: PricingTable }): number | null {
	const parts: Array<number | null> = [
		costFor(input.claude, input.implementerModel, input.pricing),
		costFor(input.codex, input.reviewerModel, input.pricing),
	];
	const primaryModel = input.evaluator.model ?? defaultEvaluatorModel(input.evaluator.provider);
	parts.push(primaryModel === null ? null : costFor(input.evaluatorPrimary, primaryModel, input.pricing));
	if (!isZero(input.evaluatorFallback)) {
		const fallbackModel = input.evaluator.fallbackModel ?? defaultEvaluatorModel(input.evaluator.fallbackProvider);
		parts.push(fallbackModel === null ? null : costFor(input.evaluatorFallback, fallbackModel, input.pricing));
	}
	return parts.some((c) => c === null) ? null : parts.reduce((a, b) => (a as number) + (b as number), 0);
}

export interface PairArmInput {
	task: TaskMeta;
	workspaceDir: string;
	/** Campaign billing pin for the claude mount; codex and the evaluator are unaffected. */
	billing: BillingMode;
	/** Mount logs live here (inside eval/results; agents never see this path). */
	runDir: string;
	/** AI_WHISPER_STATE_ROOT for this run — must be outside the repo. */
	stateRoot: string;
	implementerModel: string;
	reviewerModel: string;
	evaluatorSnapshot: EvaluatorSnapshot;
	/** auth.json/config.json/.env are copied from here into the run state root. */
	sourceStateRoot: string;
	whisperCli: string;
	env?: NodeJS.ProcessEnv;
	pricing?: PricingTable;
	pollMs?: number;
	bindTimeoutMs?: number;
	hooks?: { onWorkflowStarted?: (ctx: { workflowId: string; stateRoot: string; collabId: string }) => void };
	homeDir?: string;
	trustConfig?: TrustConfig;          // where the CLIs keep folder-trust state (tests point this at temp files)
	now?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnMount(input: PairArmInput, agent: "claude" | "codex", model: string, env: NodeJS.ProcessEnv, onExit: () => void, limit: UsageLimitWatcher): pty.IPty {
	const log = createWriteStream(join(input.runDir, `mount-${agent}.log`));
	log.on("error", (err) => process.stderr.write(`eval pair: mount log stream error ignored: ${err.message}\n`));
	const p = pty.spawn(process.execPath, [input.whisperCli, "collab", "mount", agent, "--workspace", input.workspaceDir, "--", "--model", model], {
		name: "xterm-color", cols: 120, rows: 40, cwd: input.workspaceDir, env: env as Record<string, string>,
	});
	p.onData((d) => { log.write(d); limit.feed(d); });
	p.onExit(() => { log.end(); onExit(); });
	return p;
}

export async function runPairArm(input: PairArmInput): Promise<RunOutcome> {
	const now = input.now ?? (() => Date.now());
	const pollMs = input.pollMs ?? 2000;
	const bindTimeoutMs = input.bindTimeoutMs ?? 60_000;
	const pricing = input.pricing ?? loadPricing();
	const stateRoot = resolve(input.stateRoot); // as given; the guard below compares physical paths
	try {
		assertOutsideRepo("Arm C state root", stateRoot, DEFAULT_REPO_ROOT);
		if (turnEventSocketPathLength(stateRoot) > MAX_SOCKET_PATH) {
			throw new Error(`Arm C state root is too long: the mount's turn-event socket path would exceed ${MAX_SOCKET_PATH} bytes (macOS sun_path); use a shorter --workspace-root. Got ${stateRoot}`);
		}
	} catch (e) {
		throw new HarnessFailure((e as Error).message, e);
	}
	try {
		mkdirSync(input.runDir, { recursive: true });
		mkdirSync(stateRoot, { recursive: true });
		for (const f of ["auth.json", "config.json", ".env"]) {
			const src = join(input.sourceStateRoot, f);
			if (existsSync(src)) { copyFileSync(src, join(stateRoot, f)); chmodSync(join(stateRoot, f), 0o600); }
		}
	} catch (e) {
		throw new HarnessFailure(`could not prepare run state root: ${(e as Error).message}`, e);
	}
	const env: NodeJS.ProcessEnv = {
		...scrubAgentEnv(process.env, DEFAULT_REPO_ROOT, input.billing), ...input.env,
		AI_WHISPER_STATE_ROOT: stateRoot,
		AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED: "1",
		AI_WHISPER_IDLE_THRESHOLD_MS: input.env?.AI_WHISPER_IDLE_THRESHOLD_MS ?? "15000",
		AI_WHISPER_DUO: "0",
	};

	const startedAt = now();
	const deadline = startedAt + input.task.budget.wallClockSeconds * 1000;
	const ptys: pty.IPty[] = [];
	const exited = new Set<string>(); // mount processes that died while the run was live
	let trust: TrustGrant | null = null;
	let failureMode: ProductFailureMode | null = null;
	let stopReason: RunOutcome["stopReason"] = "agent_failure";
	let stopSource: RunOutcome["stopSource"] = null;
	let escalated = false;
	let workflowId: string | null = null;
	let collabId: string | null = null;
	const limits = { claude: new UsageLimitWatcher(), codex: new UsageLimitWatcher() };
	const quotaHit = (): { agent: "claude" | "codex"; detail: string } | null => {
		for (const agent of ["claude", "codex"] as const) { const detail = limits[agent].hit; if (detail !== null) return { agent, detail }; }
		return null;
	};

	// The real mount stores the realpath as collab.workspace_root; everything else keeps the path as given.
	const physicalWorkspace = physicalPath(input.workspaceDir);
	const waitBound = async (agent: string): Promise<"bound" | "exited" | "timeout"> => {
		const until = Math.min(now() + bindTimeoutMs, deadline);
		while (now() < until) {
			if (exited.has(agent)) return "exited";
			try {
				const collab = readCollabForWorkspace(stateRoot, physicalWorkspace);
				if (collab) { collabId = collab.collabId; if (readBoundAgents(stateRoot, collab.collabId).includes(agent)) return "bound"; }
			} catch { /* DB not created yet */ }
			await sleep(Math.min(pollMs, 500));
		}
		return exited.has(agent) ? "exited" : "timeout";
	};

	try {
		// Both CLIs block on a first-run "trust this folder?" dialog for a never-seen directory; grant it up front.
		trust = trustWorkspace([input.workspaceDir, physicalWorkspace], input.trustConfig ?? DEFAULT_TRUST_CONFIG);
		ptys.push(spawnMount(input, "claude", input.implementerModel, env, () => exited.add("claude"), limits.claude));
		const claudeBind = await waitBound("claude");
		if (claudeBind !== "bound") failureMode = claudeBind === "exited" ? "mount_exited" : "mount_bind_timeout";
		if (!failureMode) {
			ptys.push(spawnMount(input, "codex", input.reviewerModel, env, () => exited.add("codex"), limits.codex));
			const codexBind = await waitBound("codex");
			if (codexBind !== "bound") failureMode = codexBind === "exited" ? "mount_exited" : "mount_bind_timeout";
		}
		if (!failureMode) {
			let artifact: string;
			try {
				artifact = writePairArtifact(input.task, input.workspaceDir);
			} catch (e) {
				throw new HarnessFailure(`could not write pair artifact: ${(e as Error).message}`, e);
			}
			try {
				const out = execFileSync(process.execPath, [input.whisperCli, "workflow", "start", "--type", input.task.shape, "--spec", artifact, "--implementer", "claude", "--reviewer", "codex"], { cwd: input.workspaceDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
				workflowId = /Workflow started: (wf_[a-z0-9]+)/.exec(out)?.[1] ?? null;
				if (!workflowId) failureMode = "workflow_start_error";
			} catch { failureMode = "workflow_start_error"; /* non-zero exit or the 60 s timeout */ }
		}
		if (!failureMode && workflowId && !collabId) failureMode = "collab_missing";
		if (!failureMode && workflowId && collabId) {
			try {
				input.hooks?.onWorkflowStarted?.({ workflowId, stateRoot, collabId });
			} catch (e) {
				throw new HarnessFailure(`onWorkflowStarted hook failed: ${(e as Error).message}`, e);
			}
			// Consecutive polls with no workflow row, no heartbeat row, or an unreadable DB: an ambiguous state, not a wait.
			let anomalies = 0;
			for (;;) {
				if (quotaHit()) break; // torn down below, then thrown: not an outcome of the system under test
				if (exited.size > 0) { failureMode = "mount_exited"; break; }
				if (now() >= deadline) { stopReason = "wall_clock_cap"; stopSource = "estimated"; break; }
				let anomalous = false;
				try {
					const wf = readWorkflow(stateRoot, workflowId);
					if (wf === null) anomalous = true;
					if (wf?.status === "done") { stopReason = "completed"; break; }
					if (wf?.status === "halted") {
						if (readWorkflowProgress(stateRoot, workflowId).escalated || /max-rounds|escalat/i.test(wf.haltReason ?? "")) { stopReason = "escalated"; escalated = true; }
						else failureMode = "workflow_halted";
						break;
					}
					if (wf?.status === "canceled") { failureMode = "workflow_halted"; break; }
					const hb = readDaemonHeartbeat(stateRoot, collabId);
					if (hb === null) anomalous = true;
					if (hb && now() - Date.parse(hb) > 30_000) { failureMode = "daemon_dead"; break; }
					const progress = readWorkflowProgress(stateRoot, workflowId);
					if (estimateTokensFromChars(progress.estimatedChars) > input.task.budget.tokenCap) { stopReason = "token_cap"; stopSource = "estimated"; break; }
				} catch { anomalous = true; /* e.g. busy DB; tolerated unless it persists */ }
				anomalies = anomalous ? anomalies + 1 : 0;
				if (anomalies >= 10) {
					let collabGone: boolean;
					try {
						collabGone = readCollabForWorkspace(stateRoot, physicalWorkspace) === null || readWorkflow(stateRoot, workflowId) === null;
					} catch { collabGone = false; /* state unreadable: the daemon side is what is broken */ }
					failureMode = collabGone ? "collab_missing" : "daemon_dead";
					break;
				}
				await sleep(pollMs);
			}
		}
	} finally {
		try { execFileSync(process.execPath, [input.whisperCli, "collab", "stop"], { cwd: input.workspaceDir, env, stdio: "ignore", timeout: 20_000 }); } catch { /* best effort */ }
		for (const p of ptys) { try { p.kill(); } catch { /* already gone */ } }
		// Release trust only after the mounts have actually exited: claude rewrites ~/.claude.json on shutdown and would
		// otherwise re-add the project entry after we removed it.
		const exitDeadline = Date.now() + 10_000;
		while (exited.size < ptys.length && Date.now() < exitDeadline) await sleep(200);
		if (exited.size < ptys.length) {
			// A mount that ignores the pty hang-up (claude keeps running and flushes its config late) is force-killed.
			for (const p of ptys) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
			const killDeadline = Date.now() + 5_000;
			while (exited.size < ptys.length && Date.now() < killDeadline) await sleep(200);
		}
		await sleep(1000);
		trust?.release();
	}
	const quota = quotaHit();
	if (quota) throw new QuotaExhaustedError(quota.agent, quota.detail);
	const endedAt = now();

	let rounds: number | null = null, reviewFindings: number | null = null, estimatedChars = 0;
	let fallbackUsed = false, evaluatorPrimary: UsageTotals | null = null, evaluatorFallback: UsageTotals | null = null;
	if (workflowId) {
		try {
			const p = readWorkflowProgress(stateRoot, workflowId);
			rounds = p.rounds; reviewFindings = p.reviewFindings; estimatedChars = p.estimatedChars;
			const ev = readEvaluatorUsage(stateRoot, workflowId);
			fallbackUsed = ev.fallbackUsed; evaluatorPrimary = ev.primary; evaluatorFallback = ev.fallback;
		} catch { /* leave nulls */ }
	}
	const home = input.homeDir ? { home: input.homeDir } : {};
	// Sessions record whichever spelling of the workspace they were started with: match both.
	const cwds = [...new Set([input.workspaceDir, physicalWorkspace])];
	const claudeUsage = harvestClaudeUsage({ ...home, cwds, since: startedAt, until: endedAt });
	const codexUsage = harvestCodexUsage({ ...home, cwds, since: startedAt, until: endedAt });
	let usage: UsageTotals;
	let costUsd: number | null;
	let metered = false;
	if (claudeUsage !== null && codexUsage !== null && evaluatorPrimary !== null && evaluatorFallback !== null) {
		metered = true;
		usage = addUsage(addUsage(claudeUsage, codexUsage), addUsage(evaluatorPrimary, evaluatorFallback));
		costUsd = computePairCost({ claude: claudeUsage, codex: codexUsage, evaluatorPrimary, evaluatorFallback, implementerModel: input.implementerModel, reviewerModel: input.reviewerModel, evaluator: input.evaluatorSnapshot, pricing });
	} else {
		usage = { ...ZERO_USAGE, inputTokens: estimateTokensFromChars(estimatedChars) };
		costUsd = null;
	}

	return {
		stopReason: failureMode ? "agent_failure" : stopReason,
		stopSource,
		usage,
		tokenSource: metered ? "metered" : "estimated",
		costUsd,
		seconds: (endedAt - startedAt) / 1000,
		rounds,
		escalated,
		reviewFindings,
		failureMode,
		reviewerModel: input.reviewerModel,
		evaluator: { ...input.evaluatorSnapshot, fallbackUsed },
		workspaceDir: input.workspaceDir,
	};
}
