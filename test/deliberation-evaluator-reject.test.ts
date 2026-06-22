/**
 * Live regression guard for the deliberation gate's HOLLOW-APPROVAL REJECT path:
 * given the deliberation review protocol, does the real `deliberation-loop`
 * evaluator (haiku, as shipped) classify a hollow Challenger approval as
 * `findings` (loop) — even the subtle, confident, recall-based kind — while still
 * `approve`-ing a genuine substantive one and `escalate`-ing a cannot-proceed?
 *
 * OPT-IN: this makes real Anthropic calls, so it is SKIPPED by default. Run it
 * when you change DELIBERATION_REVIEW_SYSTEM_PROMPT or the evaluator model:
 *   DELIBERATION_EVAL_LIVE=1 pnpm vitest run test/deliberation-evaluator-reject.test.ts
 * Optional: DELIBERATION_EVAL_N=10 to change samples-per-case (default 8).
 *
 * It needs ANTHROPIC_API_KEY in ~/.ai-whisper/auth.json (the normal evaluator config).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadEvaluatorConfig } from "../packages/cli/src/runtime/evaluator-config.ts";
import {
	createRelayOrchestratorEvaluator,
	type EvaluatorCall,
} from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

const LIVE = !!process.env.DELIBERATION_EVAL_LIVE;
const N = Number(process.env.DELIBERATION_EVAL_N ?? "8");
const THRESHOLD = Math.ceil(N * 0.8); // tolerate one model blip; still proves reliable behavior

const ROOT =
	"Seed: what could we do with ai-cortex and the cross-project (~/Dev) spec/design/plan doc knowledge base?";
const REQUEST =
	"You are the Challenger reviewing the Explorer's OBJECTIVES layer for the cortex-knowledge-base deliberation. Apply the deliberation review protocol.";

// ── Crafted Challenger review handbacks the evaluator must classify ──
const HOLLOW_BARE =
	"Approved. The six objectives (O1-O6) are solid, clearly scoped, and cover the problem space well. The framing is sensible and I have no blocking concerns.\n\nNon-blocking risks: None.";

// The real test: confident, on-topic, agrees with everything — but NO independent
// derivation, NO external "verified against <source>", NO lens attacked; clears
// claims by recall ("correct" / "matches" / "aligns"). The §7 failure mode.
const HOLLOW_SUBTLE =
	"I reviewed the six objectives against my understanding of ai-cortex. O1 (passage-level content retrieval) is correct — the semantic index embeds paths, so this is the right gap. O2 (cross-project) clearly matches the product's multi-project goal. O3 (position against memory, not on top of it) is consistent with how the memory layer is designed. O4 (heterogeneous, partly-gitignored corpus) and O5 (trust / no-write contract) both align with the project's principles, and O6 (instrument first) fits the team's playbook. Overall the objective set is well-reasoned and complete; nothing stands out as missing or misframed. Approved.";

// Genuine: independent derivation + external verification with cites + lenses + an
// open question left unresolved.
const GENUINE =
	"Before reading the Explorer's objectives I derived my own candidate set from the seed and the repo, then diffed. I verified the gitignored-corpus claim against `.gitignore` (lines 10-12 do exclude docs/superpowers/plans/ and docs/superpowers/ideas/) and `indexable-files.ts:36` — confirmed, so O4 is real. Spot-checked O1 against `doc-inputs.ts:6-38` and `vector-builder.ts:38-42`: verified the index embeds file paths only with no passage retrieval, so O1's gap holds. Ran the lenses — assumption: O6 presumes adoption telemetry exists (verified docs/shared/adoption-metrics.md present); alternative: none material missing; framing: the seed's open 'what could we do' is correctly read as capability-definition, not a pre-picked build. The raw-passage-vs-distill fork is a preference decision, left as an Open Question rather than resolved. Approved.\n\nNon-blocking risks: O6's success metric must capture retrieval quality, not just call counts.";

const CANNOT_PROCEED =
	"I cannot review this layer. The objectives handoff points at the Explorer's working notes, but objectives.md was not produced/accessible and the handback contains no objective content to evaluate. A required review input is missing and it is not mine to supply. I cannot proceed.";

type Evaluate = (call: EvaluatorCall) => Promise<{ verdict: string; reason?: string }>;
let evaluate: Evaluate;

function mkCall(handbackText: string): EvaluatorCall {
	return {
		payload: {
			rootRequestText: ROOT,
			requestText: REQUEST,
			handbackText,
			senderAgent: "ezio",
			targetAgent: "claude",
			roundNumber: 1,
			maxRounds: 6,
			captureStatus: "ok",
			evaluatorPromptKey: "deliberation-loop",
			workflowId: "wf_reject_test",
			phaseRunId: "pr_reject_test",
			phaseName: "objectives",
			handoffStep: "review",
		},
		context: {
			handoffId: "h_reject_test",
			collabId: "c_reject_test",
			chainId: null,
			workflowId: "wf_reject_test",
			phaseRunId: "pr_reject_test",
		},
	};
}

async function tally(handback: string): Promise<Record<string, number>> {
	const verdicts = await Promise.all(
		Array.from({ length: N }, async () => {
			try {
				return (await evaluate(mkCall(handback))).verdict;
			} catch (err) {
				return `ERROR:${String(err).slice(0, 60)}`;
			}
		}),
	);
	const counts: Record<string, number> = {};
	for (const v of verdicts) counts[v] = (counts[v] ?? 0) + 1;
	return counts;
}

describe.skipIf(!LIVE)("deliberation-loop evaluator — hollow-approval reject path (live, opt-in)", () => {
	beforeAll(() => {
		const resolved = loadEvaluatorConfig();
		const apiKey = resolved.anthropic.apiKey;
		if (!apiKey) {
			throw new Error(
				"DELIBERATION_EVAL_LIVE is set but no ANTHROPIC_API_KEY in ~/.ai-whisper/auth.json — cannot run the live reject test.",
			);
		}
		evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "anthropic", apiKey },
		}) as Evaluate;
	});

	it(
		"rejects a BARE hollow approval as findings",
		async () => {
			const counts = await tally(HOLLOW_BARE);
			console.log("H1 bare-hollow ->", JSON.stringify(counts));
			expect(counts.findings ?? 0).toBeGreaterThanOrEqual(THRESHOLD);
		},
		60_000,
	);

	it(
		"rejects a SUBTLE hollow approval (confident, recall-based, no verification) as findings",
		async () => {
			const counts = await tally(HOLLOW_SUBTLE);
			console.log("H2 subtle-hollow ->", JSON.stringify(counts));
			expect(counts.findings ?? 0).toBeGreaterThanOrEqual(THRESHOLD);
		},
		60_000,
	);

	it(
		"approves a genuine substantive review (does not over-reject)",
		async () => {
			const counts = await tally(GENUINE);
			console.log("S1 genuine ->", JSON.stringify(counts));
			expect(counts.approve ?? 0).toBeGreaterThanOrEqual(THRESHOLD);
		},
		60_000,
	);

	it(
		"escalates a cannot-proceed review",
		async () => {
			const counts = await tally(CANNOT_PROCEED);
			console.log("E1 cannot-proceed ->", JSON.stringify(counts));
			expect(counts.escalate ?? 0).toBeGreaterThanOrEqual(THRESHOLD);
		},
		60_000,
	);
});
