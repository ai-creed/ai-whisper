import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GradeResult } from "./grade.ts";
import { ledgerRowSchema, type Arm, type LedgerRow, type Pins, type RunOutcome } from "./types.ts";

export function ledgerPath(campaignDir: string): string {
	return join(campaignDir, "ledger.jsonl");
}

export function appendLedgerRow(campaignDir: string, row: LedgerRow): void {
	appendFileSync(ledgerPath(campaignDir), JSON.stringify(ledgerRowSchema.parse(row)) + "\n");
}

export function readLedger(campaignDir: string): LedgerRow[] {
	const p = ledgerPath(campaignDir);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((line, i) => {
		try { return ledgerRowSchema.parse(JSON.parse(line)); } catch (e) { throw new Error(`ledger line ${i + 1} is invalid: ${(e as Error).message}`); }
	});
}

export function buildLedgerRow(input: { campaignId: string; seed: number; scheduledPerArm: number; task: string; arm: Arm; trial: number; outcome: RunOutcome | null; grade: GradeResult | null; pins: Pins; gradedAt: string; harnessFailure?: string }): LedgerRow {
	const { outcome, grade, pins } = input;
	const stopReason = input.harnessFailure !== undefined ? ("harness_failure" as const) : (outcome?.stopReason ?? ("harness_failure" as const));
	const deliveredForScoring = stopReason !== "agent_failure" && stopReason !== "harness_failure";
	const row = {
		campaign_id: input.campaignId, seed: input.seed, scheduled_per_arm: input.scheduledPerArm,
		task: input.task, arm: input.arm, trial: input.trial,
		task_success: deliveredForScoring && (grade?.taskSuccess ?? false),
		grade_tests_passed: grade?.gradeTestsPassed ?? 0,
		grade_tests_total: grade?.gradeTestsTotal ?? 0,
		hygiene: grade?.hygiene ?? { typecheck: "skipped" as const, lint: "skipped" as const, tests: "skipped" as const },
		tokens: { input: outcome?.usage.inputTokens ?? 0, output: outcome?.usage.outputTokens ?? 0, cache_write: outcome?.usage.cacheWriteTokens ?? 0, cache_read: outcome?.usage.cacheReadTokens ?? 0 },
		token_source: outcome?.tokenSource ?? ("estimated" as const),
		cost_usd: outcome?.costUsd ?? null,
		seconds: outcome?.seconds ?? 0,
		rounds: outcome?.rounds ?? null,
		escalated: outcome?.escalated ?? false,
		review_findings: outcome?.reviewFindings ?? null,
		implementer_model: pins.implementerModel,
		billing: pins.billing,
		reviewer_model: outcome?.reviewerModel ?? (input.arm === "C" ? pins.reviewerModel : null),
		evaluator_provider: outcome?.evaluator?.provider ?? (input.arm === "C" ? pins.evaluator.provider : null),
		evaluator_model: outcome?.evaluator?.model ?? (input.arm === "C" ? pins.evaluator.model : null),
		evaluator_fallback_provider: outcome?.evaluator?.fallbackProvider ?? (input.arm === "C" ? pins.evaluator.fallbackProvider : null),
		evaluator_fallback_model: outcome?.evaluator?.fallbackModel ?? (input.arm === "C" ? pins.evaluator.fallbackModel : null),
		evaluator_fallback_used: outcome?.evaluator?.fallbackUsed ?? (input.arm === "C" ? false : null),
		cli_versions: pins.cliVersions,
		stop_reason: stopReason,
		stop_source: outcome?.stopSource ?? null,
		failure_mode: input.harnessFailure ?? outcome?.failureMode ?? null,
		graded_at: input.gradedAt,
	};
	return ledgerRowSchema.parse(row);
}
