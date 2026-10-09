import { ARMS, type Arm, type LedgerRow } from "./types.ts";

export interface ArmStats {
	scheduled: number; graded: number; unrecoveredHarnessFailures: number;
	successes: number; successRate: number | null;
	interimGradedRate: number | null;
	complete: boolean;
	microPassFraction: number | null;
	escalations: number; meanRounds: number | null; meanReviewFindings: number | null; meanSeconds: number | null;
	metered: { n: number; meanTokens: number | null; meanCostUsd: number | null };
	estimated: { n: number; meanEstimatedTokens: number | null };
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const tok = (r: LedgerRow): number => r.tokens.input + r.tokens.output + r.tokens.cache_write + r.tokens.cache_read;
const fmt = (n: number | null, digits = 2): string => (n === null ? "—" : n.toFixed(digits));
const pct = (n: number | null): string => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

export function fixedScheduledPerArm(rows: LedgerRow[]): number {
	const set = new Set(rows.map((r) => r.scheduled_per_arm));
	if (set.size !== 1) throw new Error(`ledger rows disagree on scheduled_per_arm: ${[...set].join(", ")}`);
	return rows[0]?.scheduled_per_arm as number;
}

export function computeArmStats(rows: LedgerRow[]): Record<Arm, ArmStats> {
	const out = {} as Record<Arm, ArmStats>;
	const scheduledPerArm = fixedScheduledPerArm(rows);
	for (const arm of ARMS) {
		const all = rows.filter((r) => r.arm === arm);
		const harness = all.filter((r) => r.stop_reason === "harness_failure");
		const graded = all.filter((r) => r.stop_reason !== "harness_failure");
		const denom = scheduledPerArm - harness.length;
		const successes = graded.filter((r) => r.task_success).length;
		const passed = graded.reduce((a, r) => a + r.grade_tests_passed, 0);
		const total = graded.reduce((a, r) => a + r.grade_tests_total, 0);
		const metered = graded.filter((r) => r.token_source === "metered");
		const estimated = graded.filter((r) => r.token_source === "estimated");
		const costs = metered.map((r) => r.cost_usd).filter((c): c is number => c !== null);
		out[arm] = {
			scheduled: scheduledPerArm, graded: graded.length, unrecoveredHarnessFailures: harness.length,
			successes, successRate: denom > 0 ? successes / denom : null,
			interimGradedRate: graded.length > 0 ? successes / graded.length : null,
			complete: graded.length + harness.length === scheduledPerArm,
			microPassFraction: total > 0 ? passed / total : null,
			escalations: graded.filter((r) => r.escalated).length,
			meanRounds: mean(graded.map((r) => r.rounds).filter((x): x is number => x !== null)),
			meanReviewFindings: mean(graded.map((r) => r.review_findings).filter((x): x is number => x !== null)),
			meanSeconds: mean(graded.map((r) => r.seconds)),
			metered: { n: metered.length, meanTokens: mean(metered.map(tok)), meanCostUsd: costs.length === metered.length && metered.length > 0 ? mean(costs) : null },
			estimated: { n: estimated.length, meanEstimatedTokens: mean(estimated.map(tok)) },
		};
	}
	return out;
}

export const RESIDUAL_CONFOUNDS: readonly string[] = [
	"Workflow prompts and generated artifacts (brief/spec, kickoff templates) exist only in Arm C.",
	"A second model (codex) occupies the reviewer seat in Arm C; Arms A/B have no second model.",
	"The evaluator (a third model call per handoff) exists only in Arm C.",
	"Arm C runs mounted interactive sessions; Arms A/B run headless `claude -p`.",
	"Arms are matched on token-budget parity only nominally: enforced from metered usage in A/B but from a character-based estimate in C.",
	"Fixture-authorship bias: the task author also tuned the system under test.",
	"Agents inherit the operator's claude/codex user configuration (global instructions, plugins, MCP servers, memory); sessions are not clean-room isolated.",
];

function distinct(values: Array<string | number | null>): string {
	const set = [...new Set(values.filter((v) => v !== null).map(String))];
	if (set.length === 0) return "—";
	return set.length === 1 ? (set[0] as string) : `${set.join(", ")} ⚠ mixed`;
}

export function renderReport(input: { rows: LedgerRow[] }): string {
	const { rows } = input;
	if (rows.length === 0) throw new Error("ledger has no rows");
	const campaignIds = new Set(rows.map((r) => r.campaign_id));
	if (campaignIds.size !== 1) throw new Error(`ledger mixes campaign_id values: ${[...campaignIds].join(", ")}`);
	const seeds = new Set(rows.map((r) => r.seed));
	if (seeds.size !== 1) throw new Error(`ledger mixes seed values: ${[...seeds].join(", ")}`);
	const campaignId = rows[0]?.campaign_id as string;
	const seed = rows[0]?.seed as number;
	const tasks = [...new Set(rows.map((r) => r.task))].sort();
	const s = computeArmStats(rows);
	const cRows = rows.filter((r) => r.arm === "C");
	const L: string[] = [];
	L.push(`# Pair-vs-Solo evaluation — campaign \`${campaignId}\``, "");
	L.push("| Pin | Value |", "|---|---|");
	L.push(`| implementer model | ${distinct(rows.map((r) => r.implementer_model))} |`, `| reviewer model (Arm C) | ${distinct(cRows.map((r) => r.reviewer_model))} |`);
	L.push(`| evaluator | ${distinct(cRows.map((r) => r.evaluator_provider))} / ${distinct(cRows.map((r) => r.evaluator_model))} (fallback: ${distinct(cRows.map((r) => r.evaluator_fallback_provider))} / ${distinct(cRows.map((r) => r.evaluator_fallback_model))}) |`);
	L.push(`| billing (claude seats) | ${distinct(rows.map((r) => r.billing))} |`);
	L.push(`| CLI versions | whisper ${distinct(rows.map((r) => r.cli_versions.whisper))}, claude ${distinct(rows.map((r) => r.cli_versions.claude))}, codex ${distinct(rows.map((r) => r.cli_versions.codex))} |`, `| run-order seed | ${seed} |`, "");
	const scheduled = fixedScheduledPerArm(rows);
	const incomplete = ARMS.some((a) => !s[a].complete);
	L.push("## Primary metric", "", "Task success rate = successful runs ÷ (scheduled − unrecovered harness failures). A run succeeds iff the hygiene gate is fully green and 100% of held-out grade tests pass.", "");
	if (incomplete) L.push(`**INTERIM REPORT** — ${rows.length} of ${scheduled * ARMS.length} scheduled runs have a ledger row; success rates use the fixed campaign denominator (ungraded runs count as not yet successful).`, "");
	L.push("| Arm | Scheduled | Graded | Unrecovered harness failures | Successes | Success rate |", "|---|---|---|---|---|---|");
	for (const a of ARMS) L.push(`| ${a} | ${s[a].scheduled} | ${s[a].graded} | ${s[a].unrecoveredHarnessFailures} | ${s[a].successes} | ${pct(s[a].successRate)} |`);
	if (incomplete) {
		L.push("", "Interim graded-only rate (not the primary metric):", "", "| Arm | Graded | Successes | Rate (interim) |", "|---|---|---|---|");
		for (const a of ARMS) L.push(`| ${a} | ${s[a].graded} | ${s[a].successes} | ${pct(s[a].interimGradedRate)} |`);
	}
	L.push("", "## Per-task breakdown", "", "| Task | A | B | C |", "|---|---|---|---|");
	for (const t of tasks) {
		const cell = (a: Arm): string => { const g = rows.filter((r) => r.task === t && r.arm === a && r.stop_reason !== "harness_failure"); return `${g.filter((r) => r.task_success).length}/${g.length}`; };
		L.push(`| ${t} | ${cell("A")} | ${cell("B")} | ${cell("C")} |`);
	}
	L.push("", "## Secondary metrics", "", "| Arm | Micro pass fraction | Escalations | Mean rounds | Mean review findings | Mean seconds |", "|---|---|---|---|---|---|");
	for (const a of ARMS) L.push(`| ${a} | ${pct(s[a].microPassFraction)} | ${s[a].escalations} | ${fmt(s[a].meanRounds)} | ${fmt(s[a].meanReviewFindings)} | ${fmt(s[a].meanSeconds, 0)} |`);
	L.push("", "## Tokens & cost", "", "Metered columns are computed over metered runs only.", "");
	if (rows.some((r) => r.billing === "subscription")) {
		L.push("Cost USD is **notional** for subscription-billed rows: metered tokens priced at the API rates in `pricing.json`, nothing was billed per token for the claude seats. The Arm C evaluator bills its own configured provider (the Anthropic API key in the state root's auth.json for `anthropic`), so that share of an Arm C row is real spend.", "");
	}
	L.push("| Arm | Metered runs | Mean tokens (metered) | Mean cost USD (metered) | Estimated runs | character-based estimate — not comparable across arms |", "|---|---|---|---|---|---|");
	for (const a of ARMS) L.push(`| ${a} | ${s[a].metered.n} | ${fmt(s[a].metered.meanTokens, 0)} | ${fmt(s[a].metered.meanCostUsd, 4)} | ${s[a].estimated.n} | ${fmt(s[a].estimated.meanEstimatedTokens, 0)} |`);
	L.push("", "## Harness failures", "");
	const hf = rows.filter((r) => r.stop_reason === "harness_failure");
	if (hf.length === 0) L.push("None.");
	for (const r of hf) L.push(`- ${r.task} / ${r.arm} / ${r.trial} — ${r.failure_mode ?? "unknown"}`);
	L.push("");
	for (const a of ARMS) L.push(`- Arm ${a}: graded ${s[a].graded}/${s[a].scheduled} scheduled`);
	L.push("", "## Residual confounds", "");
	for (const c of RESIDUAL_CONFOUNDS) L.push(`- ${c}`);
	L.push("", "## Caveat", "", "Two trials per task per arm (n = 2) is directional evidence, not statistical proof. Differences between arms should be read as signals to investigate, not as significant effects.", "", `Rows in ledger: ${rows.length} of ${scheduled * ARMS.length} scheduled. This report is derived from ledger.jsonl alone.`, "");
	return L.join("\n");
}
