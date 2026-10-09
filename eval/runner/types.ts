import { z } from "zod";

export const ARMS = ["A", "B", "C"] as const;
export type Arm = (typeof ARMS)[number];
export const armSchema = z.enum(ARMS);

/**
 * Who pays for the claude agent seats (solo arms, Arm C claude mount). `subscription` strips the Anthropic API
 * credentials from the agent env so `claude` falls back to its claude.ai login; `api` leaves them in place.
 * The evaluator always bills the API via the run state root's auth.json and is unaffected.
 */
export const BILLING_MODES = ["subscription", "api"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const billingModeSchema = z.enum(BILLING_MODES);
export const DEFAULT_BILLING_MODE: BillingMode = "subscription";

export const taskShapeSchema = z.enum(["quick-task", "spec-driven-development"]);
export type TaskShape = z.infer<typeof taskShapeSchema>;
export const taskCategorySchema = z.enum(["feature", "bugfix", "refactor"]);
export type TaskCategory = z.infer<typeof taskCategorySchema>;

export const budgetSchema = z.object({
	wallClockSeconds: z.number().int().positive(),
	tokenCap: z.number().int().positive(),
});
export type Budget = z.infer<typeof budgetSchema>;

export const taskMetaSchema = z.object({
	slug: z.string().regex(/^[a-z0-9-]+$/),
	category: taskCategorySchema,
	shape: taskShapeSchema,
	dir: z.string(),
	title: z.string().min(1),
	taskSection: z.string().min(1),
	scopeBullets: z.array(z.string().min(1)).min(1),
	acceptanceSection: z.string().min(1),
	approach: z.string().min(1).nullable(),
	budget: budgetSchema,
});
export type TaskMeta = z.infer<typeof taskMetaSchema>;

export const stopReasonSchema = z.enum(["completed", "wall_clock_cap", "token_cap", "agent_failure", "escalated", "harness_failure"]);
export type StopReason = z.infer<typeof stopReasonSchema>;
export const stopSourceSchema = z.enum(["metered", "estimated"]).nullable();
export type StopSource = z.infer<typeof stopSourceSchema>;
export const tokenSourceSchema = z.enum(["metered", "estimated"]);
export type TokenSource = z.infer<typeof tokenSourceSchema>;
export const gateResultSchema = z.enum(["pass", "fail", "skipped"]);
export type GateResult = z.infer<typeof gateResultSchema>;

export interface UsageTotals { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }
export const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
	};
}

/** Parity with `estimateTokens` in packages/cli/src/runtime/dashboard-state.ts (ceil(chars/4)). */
export function estimateTokensFromChars(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.ceil(chars / 4);
}

export const evaluatorSnapshotSchema = z.object({
	provider: z.string(),
	model: z.string().nullable(),
	fallbackProvider: z.string().nullable(),
	fallbackModel: z.string().nullable(),
});
export type EvaluatorSnapshot = z.infer<typeof evaluatorSnapshotSchema>;

export const cliVersionsSchema = z.object({ whisper: z.string(), claude: z.string(), codex: z.string() });
export type CliVersions = z.infer<typeof cliVersionsSchema>;

export const pinsSchema = z.object({
	implementerModel: z.string().min(1),
	reviewerModel: z.string().min(1),
	evaluator: evaluatorSnapshotSchema,
	cliVersions: cliVersionsSchema,
});
export type Pins = z.infer<typeof pinsSchema>;

export const manifestRunStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export const manifestRunSchema = z.object({
	task: z.string(),
	arm: armSchema,
	trial: z.number().int().positive(),
	status: manifestRunStatusSchema,
	attempts: z.number().int().nonnegative(),
	runDir: z.string().nullable(),
	startedAt: z.string().nullable(),
	endedAt: z.string().nullable(),
});
export type ManifestRun = z.infer<typeof manifestRunSchema>;

export const manifestSchema = z.object({
	campaignId: z.string().min(1),
	createdAt: z.string(),
	seed: z.number().int(),
	sourceStateRoot: z.string(),
	pins: pinsSchema,
	runs: z.array(manifestRunSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

const ledgerRowBase = z.object({
	campaign_id: z.string().min(1),
	seed: z.number().int(),
	scheduled_per_arm: z.number().int().positive(),
	task: z.string(),
	arm: armSchema,
	trial: z.number().int().positive(),
	task_success: z.boolean(),
	grade_tests_passed: z.number().int().nonnegative(),
	grade_tests_total: z.number().int().nonnegative(),
	hygiene: z.object({ typecheck: gateResultSchema, lint: gateResultSchema, tests: gateResultSchema }),
	tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cache_write: z.number().int().nonnegative(), cache_read: z.number().int().nonnegative() }),
	token_source: tokenSourceSchema,
	cost_usd: z.number().nonnegative().nullable(),
	seconds: z.number().nonnegative(),
	rounds: z.number().int().nonnegative().nullable(),
	escalated: z.boolean(),
	review_findings: z.number().int().nonnegative().nullable(),
	implementer_model: z.string(),
	reviewer_model: z.string().nullable(),
	evaluator_provider: z.string().nullable(),
	evaluator_model: z.string().nullable(),
	evaluator_fallback_provider: z.string().nullable(),
	evaluator_fallback_model: z.string().nullable(),
	evaluator_fallback_used: z.boolean().nullable(),
	cli_versions: cliVersionsSchema,
	stop_reason: stopReasonSchema,
	stop_source: stopSourceSchema,
	failure_mode: z.string().nullable(),
	graded_at: z.string(),
});

export const ledgerRowSchema = ledgerRowBase.superRefine((row, ctx) => {
	if (row.arm === "C") {
		if (row.evaluator_provider === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluator_provider"], message: "Arm C rows must carry evaluator_provider" });
		if (row.evaluator_fallback_used === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluator_fallback_used"], message: "Arm C rows must carry evaluator_fallback_used" });
		if (row.reviewer_model === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewer_model"], message: "Arm C rows must carry reviewer_model" });
	}
	if ((row.stop_reason === "wall_clock_cap" || row.stop_reason === "token_cap") && row.stop_source === null) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stop_source"], message: "cap stops must record stop_source" });
	}
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;

export interface RunOutcome {
	stopReason: Exclude<StopReason, "harness_failure">;
	stopSource: StopSource;
	usage: UsageTotals;
	tokenSource: TokenSource;
	costUsd: number | null;
	seconds: number;
	rounds: number | null;
	escalated: boolean;
	reviewFindings: number | null;
	failureMode: string | null;
	reviewerModel: string | null;
	evaluator: (EvaluatorSnapshot & { fallbackUsed: boolean }) | null;
	workspaceDir: string;
}

/** Thrown by drivers/grader for faults OUTSIDE the system under test (spec: harness failures). */
export class HarnessFailure extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = "HarnessFailure";
	}
}
