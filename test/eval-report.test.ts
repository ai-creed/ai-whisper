import { describe, expect, it } from "vitest";
import { computeArmStats, renderReport } from "../eval/runner/report.ts";
import type { LedgerRow } from "../eval/runner/types.ts";

const base: LedgerRow = { campaign_id: "camp", seed: 1, scheduled_per_arm: 4, task: "t1", arm: "A", trial: 1, task_success: true, grade_tests_passed: 5, grade_tests_total: 5, hygiene: { typecheck: "pass", lint: "pass", tests: "pass" }, tokens: { input: 100, output: 10, cache_write: 0, cache_read: 0 }, token_source: "metered", cost_usd: 0.5, seconds: 10, rounds: null, escalated: false, review_findings: null, implementer_model: "impl", billing: "api", reviewer_model: null, evaluator_provider: null, evaluator_model: null, evaluator_fallback_provider: null, evaluator_fallback_model: null, evaluator_fallback_used: null, cli_versions: { whisper: "0.16.0+a", claude: "2", codex: "0.5" }, stop_reason: "completed", stop_source: null, failure_mode: null, graded_at: "x" };
const rows: LedgerRow[] = [
	base,
	{ ...base, trial: 2, task_success: false, grade_tests_passed: 2 },
	{ ...base, task: "t2", stop_reason: "harness_failure", task_success: false, grade_tests_passed: 0, grade_tests_total: 0, failure_mode: "runner crashed" },
	{ ...base, arm: "C", reviewer_model: "rev", evaluator_provider: "anthropic", evaluator_fallback_used: false, rounds: 3, review_findings: 2, token_source: "estimated", cost_usd: null, tokens: { input: 5000, output: 0, cache_write: 0, cache_read: 0 } },
];
describe("computeArmStats", () => {
	it("keeps the fixed scheduled denominator minus unrecovered harness failures, and reports the graded-only rate as interim", () => {
		const s = computeArmStats(rows);
		expect(s.A).toMatchObject({ scheduled: 4, graded: 2, unrecoveredHarnessFailures: 1, successes: 1, complete: false });
		expect(s.A.successRate).toBeCloseTo(1 / 3, 6); // 1 ÷ (4 − 1), NOT 1 ÷ 2
		expect(s.A.interimGradedRate).toBeCloseTo(1 / 2, 6);
		expect(s.B).toMatchObject({ scheduled: 4, graded: 0, successes: 0, successRate: 0, interimGradedRate: null });
		expect(s.A.microPassFraction).toBeCloseTo(7 / 10, 6);
		expect(s.A.metered.n).toBe(2);
		expect(s.C.estimated.n).toBe(1);
		expect(s.C.metered.meanCostUsd).toBeNull();
	});
});

describe("renderReport", () => {
	it("renders from ledger rows alone with the required sections, the estimate column label and the n=2 caveat", () => {
		const md = renderReport({ rows });
		expect(md).toContain("campaign `camp`");
		expect(md).toContain("| run-order seed | 1 |");
		expect(md).toContain("| implementer model | impl |");
		for (const h of ["## Primary metric", "## Per-task breakdown", "## Secondary metrics", "## Tokens & cost", "## Harness failures", "## Residual confounds", "## Caveat"]) expect(md).toContain(h);
		expect(md).toContain("| billing (claude seats) | api |");
		expect(md).not.toContain("notional");
	});
	it("labels cost as notional when the claude seats ran on the subscription", () => {
		const md = renderReport({ rows: rows.map((r) => ({ ...r, billing: "subscription" as const })) });
		expect(md).toContain("| billing (claude seats) | subscription |");
		expect(md).toMatch(/notional.*pricing\.json.*nothing was billed per token/s);
		expect(md).toContain("sessions are not clean-room isolated");
		expect(md).toContain("character-based estimate — not comparable across arms");
		expect(md).toMatch(/graded 2\/4 scheduled/);
		expect(md).toContain("**INTERIM REPORT**");
		expect(md).toContain("Rate (interim)");
		expect(md).toContain("t2 / A / 1 — runner crashed");
		expect(md).toMatch(/n ?= ?2/);
		expect(md).toContain("token-budget parity");
	});
	it("refuses rows from different campaigns or with inconsistent scheduled counts", () => {
		expect(() => renderReport({ rows: [base, { ...base, campaign_id: "other" }] })).toThrow(/campaign_id/);
		expect(() => renderReport({ rows: [base, { ...base, trial: 2, scheduled_per_arm: 30 }] })).toThrow(/scheduled_per_arm/);
	});
	it("omits the interim banner when every arm is complete", () => {
		const full = ["A", "B", "C"].flatMap((arm) => [1].map((trial) => ({ ...base, arm: arm as LedgerRow["arm"], trial, scheduled_per_arm: 1, reviewer_model: arm === "C" ? "rev" : null, evaluator_provider: arm === "C" ? "anthropic" : null, evaluator_fallback_used: arm === "C" ? false : null })));
		expect(renderReport({ rows: full })).not.toContain("INTERIM");
	});
});
