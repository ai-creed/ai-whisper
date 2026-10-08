import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedgerRow, buildLedgerRow, ledgerPath, readLedger } from "../eval/runner/ledger.ts";
import type { Pins, RunOutcome } from "../eval/runner/types.ts";
import type { GradeResult } from "../eval/runner/grade.ts";

const pins: Pins = { implementerModel: "impl", reviewerModel: "rev", evaluator: { provider: "anthropic", model: null, fallbackProvider: "openai", fallbackModel: "gpt-5-mini" }, cliVersions: { whisper: "0.16.0+a", claude: "2.0.0", codex: "0.50.0" } };
const outcome: RunOutcome = { stopReason: "completed", stopSource: null, usage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 1 }, tokenSource: "metered", costUsd: 0.1, seconds: 3, rounds: 2, escalated: false, reviewFindings: 1, failureMode: null, reviewerModel: "rev", evaluator: { provider: "anthropic", model: null, fallbackProvider: "openai", fallbackModel: "gpt-5-mini", fallbackUsed: true }, workspaceDir: "/ws" };
const grade: GradeResult = { hygiene: { typecheck: "pass", lint: "pass", tests: "pass" }, gradeTestsPassed: 4, gradeTestsTotal: 4, taskSuccess: true, logs: { typecheck: "", lint: "", tests: "", grade: "" } };

describe("buildLedgerRow", () => {
	it("maps an Arm C outcome + grade into the row shape", () => {
		const row = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "C", trial: 1, outcome, grade, pins, gradedAt: "2026-08-19T00:00:00.000Z" });
		expect(row).toMatchObject({ campaign_id: "c1", seed: 42, scheduled_per_arm: 30, task: "t", arm: "C", trial: 1, task_success: true, grade_tests_passed: 4, grade_tests_total: 4, tokens: { input: 10, output: 2, cache_write: 0, cache_read: 1 }, token_source: "metered", cost_usd: 0.1, rounds: 2, review_findings: 1, reviewer_model: "rev", evaluator_provider: "anthropic", evaluator_fallback_provider: "openai", evaluator_fallback_model: "gpt-5-mini", evaluator_fallback_used: true, implementer_model: "impl", stop_reason: "completed", stop_source: null, failure_mode: null });
	});
	it("forces task_success false on agent-caused and product-stack failures even when the workspace grades green", () => {
		const pairFault = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "C", trial: 1, outcome: { ...outcome, stopReason: "agent_failure", failureMode: "mount_bind_timeout" }, grade, pins, gradedAt: "x" });
		expect(pairFault).toMatchObject({ task_success: false, stop_reason: "agent_failure", failure_mode: "mount_bind_timeout", grade_tests_passed: 4 });
		const soloFault = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "A", trial: 1, outcome: { ...outcome, stopReason: "agent_failure", failureMode: "error_max_turns", reviewerModel: null, evaluator: null, rounds: null, reviewFindings: null }, grade, pins, gradedAt: "x" });
		expect(soloFault.task_success).toBe(false);
		const capped = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "C", trial: 1, outcome: { ...outcome, stopReason: "wall_clock_cap", stopSource: "estimated" }, grade, pins, gradedAt: "x" });
		expect(capped.task_success).toBe(true); // graded as delivered
	});
	it("builds a harness-failure row with no outcome or grade", () => {
		const row = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "A", trial: 2, outcome: null, grade: null, pins, gradedAt: "x", harnessFailure: "runner crashed: ENOSPC" });
		expect(row).toMatchObject({ task_success: false, stop_reason: "harness_failure", failure_mode: "runner crashed: ENOSPC", grade_tests_total: 0, hygiene: { typecheck: "skipped", lint: "skipped", tests: "skipped" } });
	});
});

describe("append / read", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("round-trips rows and rejects a corrupt line by number", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-ledger-"));
		const row = buildLedgerRow({ campaignId: "c1", seed: 42, scheduledPerArm: 30, task: "t", arm: "C", trial: 1, outcome, grade, pins, gradedAt: "x" });
		appendLedgerRow(dir, row); appendLedgerRow(dir, { ...row, trial: 2 });
		expect(readLedger(dir)).toHaveLength(2);
		writeFileSync(ledgerPath(dir), "{\"task\":\"bad\"}\n", { flag: "a" });
		expect(() => readLedger(dir)).toThrow(/line 3/);
	});
});
