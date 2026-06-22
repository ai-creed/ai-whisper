import { getWorkflowDefinition } from "@ai-whisper/broker";
import type {
	EvaluatorCall,
	EvaluatorInput,
	ObserverContext,
	RelayOrchestratorVerdict,
	WorkflowEvaluatorInput,
	WorkflowEvaluatorVerdict,
} from "./relay-orchestrator-evaluator.ts";
import { separateReviewSections } from "./relay-orchestrator-evaluator.js";

/** Fallback evaluator-key derivation, used only when the handoff metadata carries
 * no configured `evaluatorPromptKey` (e.g. legacy/unconfigured phases). The
 * configured key now travels through `getHandoffWithWorkflowMeta` (spec §5.3);
 * this preserves the pre-existing SDD behavior for the absent-metadata case. */
export function deriveDefaultEvaluatorKey(
	handoffStep: "review" | "fix" | "implement" | "execute",
): "review-loop" | "execution-gate" {
	return handoffStep === "execute" ? "execution-gate" : "review-loop";
}

/** Resolve the evaluator prompt key from the registry by workflow type + phase.
 * Retained for direct resolution/tests; the orchestrator runtime consumes the
 * key from handoff metadata (spec §5.3) and only falls back to
 * {@link deriveDefaultEvaluatorKey} when that metadata key is absent. */
export function resolveEvaluatorPromptKey(input: {
	workflowType: string;
	phaseName: string | null;
	handoffStep: "review" | "fix" | "implement" | "execute";
}): "review-loop" | "execution-gate" | "ralph-loop" | "deliberation-loop" {
	const def = getWorkflowDefinition(input.workflowType);
	const phase = def?.phases.find((p) => p.name === input.phaseName);
	if (phase?.evaluatorPromptKey) return phase.evaluatorPromptKey;
	return deriveDefaultEvaluatorKey(input.handoffStep);
}

type BrokerLike = {
	control: {
		listRelayHandoffsPendingOrchestration: (collabId: string) => Array<{
			handoffId: string;
			chainId: string | null;
			requestText: string;
			captureStatus: string | null;
			roundNumber: number | null;
			maxRounds: number;
			rootRequestText: string | null;
			handbackText: string | null;
			senderAgent: string;
			targetAgent: string;
		}>;
		claimRelayHandoffForOrchestration: (input: {
			handoffId: string;
			claimedAt: string;
		}) => {
			handoffId: string;
			chainId: string | null;
			captureStatus: string | null;
			roundNumber: number | null;
			maxRounds: number;
			requestText: string;
			rootRequestText: string | null;
			handbackText: string | null;
			senderAgent: string;
			targetAgent: string;
		} | null;
		createLoopRelayHandoff: (input: {
			handoffId: string;
			nextHandoffId: string;
			requestText: string;
			reason: string;
			now: string;
		}) => unknown;
		resolveRelayChain: (input: {
			handoffId: string;
			reason: string;
			evaluatedAt: string;
		}) => void;
		markRelayChainEscalated: (input: {
			handoffId: string;
			reason: string;
			evaluatedAt: string;
		}) => void;
		cleanupOrchestration: (input: {
			collabId: string;
			reason: string;
			now: string;
		}) => void;
		applyOrchestratorVerdict: (input: {
			handoffId: string;
			verdict:
				| "approve"
				| "findings"
				| "delivered"
				| "execution-pass"
				| "execution-fail"
				| "escalate";
			confidence: number;
			reason: string;
			followUpMessage?: string;
			extractedCommitShas?: string[];
			workspaceHeadSha?: string;
			now: string;
		}) => { action: string; chainId: string; nextHandoffId?: string; nextPhaseRunId?: string };
		getHandoffWithWorkflowMeta: (handoffId: string) => {
			workflowId: string | null;
			handoffStep: string | null;
			phaseRunId: string | null;
			phaseName: string | null;
			roundNumber: number | null;
			maxRounds: number;
			handbackText: string | null;
			senderAgent: string;
			targetAgent: string;
			requestText: string;
			rootRequestText: string | null;
			evaluatorPromptKey: "review-loop" | "execution-gate" | "ralph-loop" | "deliberation-loop" | null;
		} | null;
		getWorkflow: (id: string) => { workflowType: string } | null | undefined;
	};
};

function composeLoopRequest(input: {
	rootRequestText: string;
	handbackText: string;
	followUpMessage: string;
}): string {
	return `Original request:\n${input.rootRequestText}\n\nLatest result:\n${input.handbackText}\n\nFollow-up:\n${input.followUpMessage}`;
}

type ClaimedHandoff = NonNullable<
	ReturnType<BrokerLike["control"]["claimRelayHandoffForOrchestration"]>
>;

function buildEvaluatorInput(claimed: ClaimedHandoff): EvaluatorInput {
	return {
		rootRequestText: claimed.rootRequestText ?? claimed.requestText,
		requestText: claimed.requestText,
		handbackText: claimed.handbackText ?? "",
		senderAgent: claimed.senderAgent,
		targetAgent: claimed.targetAgent,
		roundNumber: claimed.roundNumber ?? 1,
		maxRounds: claimed.maxRounds,
		captureStatus: claimed.captureStatus as EvaluatorInput["captureStatus"],
	};
}

export function createRelayOrchestrator(input: {
	broker: BrokerLike;
	collabId: string;
	evaluate: (call: EvaluatorCall) => Promise<RelayOrchestratorVerdict | WorkflowEvaluatorVerdict>;
	pollIntervalMs?: number;
	clock?: () => string;
	createHandoffId?: () => string;
	readWorkspaceHead?: (collabId: string) => Promise<string>;
	logger?: Pick<Console, "error" | "warn">;
}) {
	const now = input.clock ?? (() => new Date().toISOString());
	const createHandoffId = input.createHandoffId ?? (() => crypto.randomUUID());

	let intervalHandle: ReturnType<typeof setInterval> | null = null;

	async function evaluateWithRetry(call: EvaluatorCall): Promise<RelayOrchestratorVerdict | WorkflowEvaluatorVerdict> {
		try {
			return await input.evaluate(call);
		} catch (firstError) {
			input.logger?.warn?.("relay orchestrator evaluator failed; retrying once", firstError);
			return await input.evaluate(call);
		}
	}

	async function pollOnce(): Promise<void> {
		const handoffs = input.broker.control.listRelayHandoffsPendingOrchestration(input.collabId);
		for (const handoff of handoffs) {
			const claimed = input.broker.control.claimRelayHandoffForOrchestration({
				handoffId: handoff.handoffId,
				claimedAt: now(),
			});
			if (!claimed) continue;

			// Fetch workflow metadata to branch on legacy vs. workflow path
			const meta = input.broker.control.getHandoffWithWorkflowMeta(claimed.handoffId);

			if (meta?.workflowId) {
				// ── Workflow path ──────────────────────────────────────────────────────
				const VALID_STEPS = ["review", "fix", "implement", "execute"] as const;
				type HandoffStep = typeof VALID_STEPS[number];
				const rawStep = meta.handoffStep;
				if (!VALID_STEPS.includes(rawStep as HandoffStep)) {
					input.logger?.warn?.(`unexpected handoffStep value: ${rawStep}; defaulting to 'review'`);
				}
				const handoffStep: HandoffStep = VALID_STEPS.includes(rawStep as HandoffStep)
					? (rawStep as HandoffStep)
					: "review";
				// Consume the configured key plumbed through the handoff metadata
				// (spec §5.3); fall back to the handoffStep derivation only when absent.
				const evaluatorPromptKey = meta.evaluatorPromptKey ?? deriveDefaultEvaluatorKey(handoffStep);

				const wfPayload: WorkflowEvaluatorInput = {
					...buildEvaluatorInput(claimed),
					evaluatorPromptKey,
					workflowId: meta.workflowId,
					phaseRunId: meta.phaseRunId ?? "",
					phaseName: meta.phaseName ?? "",
					handoffStep,
				};

				const wfContext: ObserverContext = {
					handoffId: claimed.handoffId,
					collabId: input.collabId,
					chainId: claimed.chainId ?? null,
					workflowId: meta.workflowId ?? null,
					phaseRunId: meta.phaseRunId ?? null,
				};

				let wfVerdict: WorkflowEvaluatorVerdict;
				try {
					wfVerdict = (await evaluateWithRetry({ payload: wfPayload, context: wfContext })) as WorkflowEvaluatorVerdict;
				} catch (error) {
					input.logger?.error?.("relay orchestrator evaluator failed after retry", error);
					input.broker.control.applyOrchestratorVerdict({
						handoffId: claimed.handoffId,
						verdict: "escalate",
						confidence: 1,
						reason: "LLM evaluation failed after retry",
						now: now(),
					});
					continue;
				}

				// Resolve workspaceHeadSha for review-loop approve transitions
				let workspaceHeadSha: string | undefined;
				if (
					evaluatorPromptKey === "review-loop" &&
					wfVerdict.verdict === "approve" &&
					input.readWorkspaceHead
				) {
					try {
						workspaceHeadSha = await input.readWorkspaceHead(input.collabId);
					} catch (headErr) {
						input.logger?.error?.("readWorkspaceHead failed; escalating workflow handoff", headErr);
						try {
							input.broker.control.applyOrchestratorVerdict({
								handoffId: claimed.handoffId,
								verdict: "escalate",
								confidence: 0,
								reason: `readWorkspaceHead failed: ${headErr instanceof Error ? headErr.message : String(headErr)}`,
								now: now(),
							});
						} catch { /* already terminal */ }
						continue;
					}
				}

				// Extract commit SHAs from handback for execution verdicts
				let extractedCommitShas: string[] | undefined;
				if (wfVerdict.verdict === "execution-pass" || wfVerdict.verdict === "delivered") {
					const shas = [...new Set((claimed.handbackText ?? "").match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
					if (shas.length > 0) extractedCommitShas = shas;
				}

				try {
					input.broker.control.applyOrchestratorVerdict({
						handoffId: claimed.handoffId,
						verdict: wfVerdict.verdict,
						confidence: wfVerdict.confidence,
						reason: wfVerdict.reason,
						// Fix #2: forward the reviewer's OWN findings (handback body, minus the
						// non-blocking risks section) — not an evaluator reproduction. The
						// evaluator only classifies, so its output stays small (no truncation).
						...(wfVerdict.verdict === "findings"
							? { followUpMessage: separateReviewSections(claimed.handbackText ?? "").body }
							: {}),
						...(extractedCommitShas !== undefined ? { extractedCommitShas } : {}),
						...(workspaceHeadSha !== undefined ? { workspaceHeadSha } : {}),
						now: now(),
					});
				} catch (verdictError) {
					input.logger?.error?.("applyOrchestratorVerdict failed; attempting escalation", verdictError);
					try {
						input.broker.control.applyOrchestratorVerdict({
							handoffId: claimed.handoffId,
							verdict: "escalate",
							confidence: 0,
							reason: `orchestrator error: ${verdictError instanceof Error ? verdictError.message : String(verdictError)}`,
							now: now(),
						});
					} catch {
						// Already escalated or terminal — safe to ignore
					}
				}

				continue;
			}

			// ── Legacy path ────────────────────────────────────────────────────────

			const roundNumber = claimed.roundNumber ?? 1;

			// Pre-LLM max-round enforcement. Must run before the forced-reissue
			// branch below — otherwise an agent that never produces a capturable
			// handback (manual chats with no /copy) loops indefinitely because
			// each round emits captureStatus=no_response_captured_confidently and
			// the forced re-issue path skips this check.
			if (roundNumber >= claimed.maxRounds) {
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: `max rounds reached (${roundNumber}/${claimed.maxRounds})`,
					evaluatedAt: now(),
				});
				continue;
			}

			// Forced re-issue: no usable handback — skip LLM
			if (
				claimed.captureStatus === "no_response_captured" ||
				claimed.captureStatus === "no_response_captured_confidently"
			) {
				input.broker.control.createLoopRelayHandoff({
					handoffId: claimed.handoffId,
					nextHandoffId: createHandoffId(),
					requestText: claimed.requestText,
					reason: `forced re-issue: ${claimed.captureStatus}`,
					now: now(),
				});
				continue;
			}

			// LLM evaluation with one retry
			const legacyPayload = buildEvaluatorInput(claimed);
			const legacyContext: ObserverContext = {
				handoffId: claimed.handoffId,
				collabId: input.collabId,
				chainId: claimed.chainId ?? null,
				workflowId: null,
				phaseRunId: null,
			};
			let verdict: RelayOrchestratorVerdict;
			try {
				verdict = (await evaluateWithRetry({ payload: legacyPayload, context: legacyContext })) as RelayOrchestratorVerdict;
			} catch (error) {
				input.logger?.error?.("relay orchestrator evaluator failed after retry", error);
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: "LLM evaluation failed after retry",
					evaluatedAt: now(),
				});
				continue;
			}

			// Low-confidence escalation
			if (verdict.confidence < 0.5) {
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: verdict.reason,
					evaluatedAt: now(),
				});
				continue;
			}

			if (verdict.verdict === "done") {
				input.broker.control.resolveRelayChain({
					handoffId: claimed.handoffId,
					reason: verdict.reason,
					evaluatedAt: now(),
				});
				continue;
			}

			if (verdict.verdict === "loop") {
				const followUpMessage = "followUpMessage" in verdict ? verdict.followUpMessage : undefined;
				if (!followUpMessage) {
					// followUpMessage is required for loop — schema should enforce this,
					// but escalate defensively if it's absent
					input.broker.control.markRelayChainEscalated({
						handoffId: claimed.handoffId,
						reason: "loop verdict missing followUpMessage",
						evaluatedAt: now(),
					});
					continue;
				}
				input.broker.control.createLoopRelayHandoff({
					handoffId: claimed.handoffId,
					nextHandoffId: createHandoffId(),
					requestText: composeLoopRequest({
						rootRequestText: claimed.rootRequestText ?? claimed.requestText,
						handbackText: claimed.handbackText ?? "",
						followUpMessage,
					}),
					reason: verdict.reason,
					now: now(),
				});
				continue;
			}

			// verdict === "escalate" or any unrecognized verdict
			input.broker.control.markRelayChainEscalated({
				handoffId: claimed.handoffId,
				reason: verdict.reason,
				evaluatedAt: now(),
			});
		}
	}

	function start(): void {
		const intervalMs = input.pollIntervalMs ?? 1000;
		intervalHandle = setInterval(() => {
			pollOnce().catch((err) => {
				input.logger?.error?.("relay orchestrator poll error", err);
			});
		}, intervalMs);
	}

	function stop(): void {
		if (intervalHandle !== null) {
			clearInterval(intervalHandle);
			intervalHandle = null;
		}
		input.broker.control.cleanupOrchestration({
			collabId: input.collabId,
			reason: "collab ended before orchestration finished",
			now: now(),
		});
	}

	return { pollOnce, start, stop };
}
