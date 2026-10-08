// eval/runner/arms/solo.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { costFor, loadPricing, type PricingTable } from "../pricing.ts";
import { HarnessFailure, type RunOutcome, type TaskMeta } from "../types.ts";
import { DEFAULT_REPO_ROOT } from "../workspace.ts";
import { scrubAgentEnv } from "./agent-env.ts";
import { parseSelfReviewFindings } from "./self-review.ts";
import { composeSoloPrompt } from "./solo-prompt.ts";
import { StreamUsageAccumulator } from "./stream-usage.ts";

export interface SoloArmInput {
	task: TaskMeta;
	arm: "A" | "B";
	workspaceDir: string;
	runDir: string;
	implementerModel: string;
	claudeCommand?: string;
	pricing?: PricingTable;
	now?: () => number;
	maxTurns?: number;
}

export function soloClaudeArgs(model: string, maxTurns: number): string[] {
	return ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", String(maxTurns), "--dangerously-skip-permissions"];
}

export async function runSoloArm(input: SoloArmInput): Promise<RunOutcome> {
	const now = input.now ?? (() => Date.now());
	const pricing = input.pricing ?? loadPricing();
	mkdirSync(input.runDir, { recursive: true });
	// Log streams open asynchronously; a write/open failure (disk error, run dir removed) must not crash the runner.
	const transcript = createWriteStream(join(input.runDir, "transcript.jsonl"));
	const stderrLog = createWriteStream(join(input.runDir, "stderr.log"));
	for (const stream of [transcript, stderrLog]) stream.on("error", (err) => process.stderr.write(`eval solo: log stream error ignored: ${err.message}\n`));
	const acc = new StreamUsageAccumulator();
	const startedAt = now();
	let capHit: "token_cap" | "wall_clock_cap" | null = null;

	const child = spawn(input.claudeCommand ?? "claude", soloClaudeArgs(input.implementerModel, input.maxTurns ?? 400), {
		cwd: input.workspaceDir,
		stdio: ["pipe", "pipe", "pipe"],
		env: scrubAgentEnv(process.env, DEFAULT_REPO_ROOT),
	});

	const terminate = (reason: "token_cap" | "wall_clock_cap"): void => {
		if (capHit !== null) return;
		capHit = reason;
		child.kill("SIGTERM");
		setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 10_000).unref();
	};
	const wallTimer = setTimeout(() => terminate("wall_clock_cap"), input.task.budget.wallClockSeconds * 1000);

	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (err) => reject(new HarnessFailure(`failed to spawn ${input.claudeCommand ?? "claude"}: ${err.message}`, err)));
	});
	try {
		await spawned;
	} catch (e) {
		clearTimeout(wallTimer);
		transcript.end(); stderrLog.end();
		throw e;
	}

	child.stderr.pipe(stderrLog);
	const rl = createInterface({ input: child.stdout });
	const linesDrained = new Promise<void>((resolve) => rl.once("close", () => resolve()));
	rl.on("line", (line) => {
		transcript.write(line + "\n");
		acc.feed(line);
		const u = acc.usage;
		// The whole-run ceiling counts every metered component, cache reads/writes included (spec: budget parity).
		if (u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens > input.task.budget.tokenCap) terminate("token_cap");
	});

	child.stdin.end(composeSoloPrompt(input.task, input.arm));

	const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	clearTimeout(wallTimer);
	await linesDrained;
	transcript.end(); stderrLog.end();

	const seconds = (now() - startedAt) / 1000;
	const usage = acc.finalUsage();
	const costUsd = acc.resultCostUsd ?? costFor(usage, input.implementerModel, pricing);
	const selfReview = input.arm === "B" ? parseSelfReviewFindings(acc.texts) : null;

	let stopReason: RunOutcome["stopReason"];
	let failureMode: string | null = null;
	if (capHit !== null) stopReason = capHit;
	else if (acc.sawResult && acc.resultSubtype === "success") stopReason = "completed";
	else { stopReason = "agent_failure"; failureMode = acc.resultSubtype ?? `exit_${exitCode ?? "signal"}`; }

	return {
		stopReason,
		stopSource: capHit !== null ? "metered" : null,
		usage,
		tokenSource: "metered",
		costUsd,
		seconds,
		rounds: selfReview?.cycles ?? null,
		escalated: false,
		reviewFindings: selfReview?.findings ?? null,
		failureMode,
		reviewerModel: null,
		evaluator: null,
		workspaceDir: input.workspaceDir,
	};
}
