import { describe, expect, it } from "vitest";
import { estimateTokens } from "../packages/cli/src/runtime/dashboard-state.ts";
import {
	ARMS,
	budgetSchema,
	estimateTokensFromChars,
	ledgerRowSchema,
	manifestSchema,
} from "../eval/runner/types.ts";

const baseRow = {
	campaign_id: "c1", seed: 42, scheduled_per_arm: 30,
	task: "csv-parse-quoted", arm: "A", trial: 1,
	task_success: true, grade_tests_passed: 7, grade_tests_total: 7,
	hygiene: { typecheck: "pass", lint: "pass", tests: "pass" },
	tokens: { input: 10, output: 5, cache_write: 0, cache_read: 0 },
	token_source: "metered", cost_usd: 0.01, seconds: 12.5,
	rounds: null, escalated: false, review_findings: null,
	implementer_model: "claude-sonnet-4-5", billing: "api", reviewer_model: null,
	evaluator_provider: null, evaluator_model: null,
	evaluator_fallback_provider: null, evaluator_fallback_model: null, evaluator_fallback_used: null,
	cli_versions: { whisper: "0.16.0+abc1234", claude: "2.0.0", codex: "0.50.0" },
	stop_reason: "completed", stop_source: null, failure_mode: null,
	graded_at: "2026-08-19T00:00:00.000Z",
};

describe("ledger row schema", () => {
	it("accepts a complete solo row", () => {
		expect(ledgerRowSchema.parse(baseRow)).toEqual(baseRow);
	});
	it("rejects an unknown stop_reason", () => {
		expect(() => ledgerRowSchema.parse({ ...baseRow, stop_reason: "timeout" })).toThrow();
	});
	it("requires the evaluator snapshot fields on Arm C rows", () => {
		expect(() => ledgerRowSchema.parse({ ...baseRow, arm: "C" })).toThrow(/evaluator_provider/);
		const c = { ...baseRow, arm: "C", reviewer_model: "gpt-5", evaluator_provider: "anthropic", evaluator_model: null, evaluator_fallback_provider: "openai", evaluator_fallback_model: "gpt-5-mini", evaluator_fallback_used: false, rounds: 2, review_findings: 1 };
		expect(ledgerRowSchema.parse(c).arm).toBe("C");
	});
	it("requires stop_source when stopped at a cap", () => {
		expect(() => ledgerRowSchema.parse({ ...baseRow, stop_reason: "token_cap", stop_source: null })).toThrow(/stop_source/);
	});
});

describe("budget + manifest schemas", () => {
	it("budget requires positive integers", () => {
		expect(budgetSchema.parse({ wallClockSeconds: 900, tokenCap: 400000 })).toEqual({ wallClockSeconds: 900, tokenCap: 400000 });
		expect(() => budgetSchema.parse({ wallClockSeconds: 0, tokenCap: 1 })).toThrow();
	});
	it("pins.billing defaults to api for manifests written before the field existed, and keeps an explicit value", () => {
		const base = { campaignId: "c", createdAt: "x", seed: 1, sourceStateRoot: "/s", runs: [] };
		const pins = { implementerModel: "claude-sonnet-4-5", reviewerModel: "gpt-5", evaluator: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, cliVersions: { whisper: "0.16.0+abc", claude: "2.0.0", codex: "0.50.0" } };
		expect(manifestSchema.parse({ ...base, pins }).pins.billing).toBe("api");
		expect(manifestSchema.parse({ ...base, pins: { ...pins, billing: "subscription" } }).pins.billing).toBe("subscription");
		expect(() => manifestSchema.parse({ ...base, pins: { ...pins, billing: "free" } })).toThrow();
	});
	it("manifest run statuses are the four spec states", () => {
		const m = manifestSchema.parse({
			campaignId: "c1", createdAt: "2026-08-19T00:00:00.000Z", seed: 42,
			sourceStateRoot: "/Users/me/.ai-whisper",
			pins: { implementerModel: "claude-sonnet-4-5", reviewerModel: "gpt-5", evaluator: { provider: "anthropic", model: null, fallbackProvider: null, fallbackModel: null }, cliVersions: { whisper: "0.16.0+abc", claude: "2.0.0", codex: "0.50.0" } },
			runs: [{ task: "t", arm: "A", trial: 1, status: "pending", attempts: 0, quotaAborts: 0, runDir: null, startedAt: null, endedAt: null }],
		});
		expect(m.runs[0]?.status).toBe("pending");
		expect(() => manifestSchema.parse({ ...m, runs: [{ ...m.runs[0], status: "skipped" }] })).toThrow();
	});
	it("ARMS is A, B, C in order", () => {
		expect(ARMS).toEqual(["A", "B", "C"]);
	});
});

describe("estimateTokensFromChars", () => {
	it("matches the CLI's character-based estimate", () => {
		for (const n of [0, 1, 3, 4, 5, 1000, 123457]) expect(estimateTokensFromChars(n)).toBe(estimateTokens(n));
	});
});
