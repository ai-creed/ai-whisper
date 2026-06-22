import type { BrokerRuntime } from "@ai-whisper/broker";
import type { EvaluatorCallEvent } from "./relay-orchestrator-evaluator.js";

const SAMPLE_MAX_CHARS = 500;

function truncate(text: string | null, max: number): string | null {
	if (text === null) return null;
	if (text.length <= max) return text;
	return text.slice(0, max);
}

function followUpLen(verdict: EvaluatorCallEvent["verdict"]): number | null {
	if (verdict === null) return null;
	if (
		(verdict.verdict === "loop" || verdict.verdict === "findings") &&
		typeof (verdict as { followUpMessage?: string }).followUpMessage === "string"
	) {
		return (verdict as { followUpMessage: string }).followUpMessage.length;
	}
	return 0;
}

type WorkflowPayloadFields = {
	evaluatorPromptKey?: "review-loop" | "ralph-loop" | "execution-gate" | "deliberation-loop";
	handoffStep?: "review" | "fix" | "implement" | "execute";
};

function extractWorkflowFields(payload: unknown): {
	evaluatorPromptKey: "review-loop" | "ralph-loop" | "execution-gate" | "deliberation-loop" | null;
	handoffStep: "review" | "fix" | "implement" | "execute" | null;
} {
	if (typeof payload !== "object" || payload === null) {
		return { evaluatorPromptKey: null, handoffStep: null };
	}
	const p = payload as WorkflowPayloadFields;
	return {
		evaluatorPromptKey: p.evaluatorPromptKey ?? null,
		handoffStep: p.handoffStep ?? null,
	};
}

export type BuildEvaluatorObserverCallbackInput = {
	broker: Pick<BrokerRuntime, "control">;
	now?: () => string;
};

export function buildEvaluatorObserverCallback(
	input: BuildEvaluatorObserverCallbackInput,
): (event: EvaluatorCallEvent) => void {
	const now = input.now ?? (() => new Date().toISOString());

	return (event: EvaluatorCallEvent) => {
		const samplesAllowed = process.env["AI_WHISPER_NO_EVAL_SAMPLES"] !== "1";
		const promptComposed = `${event.systemPrompt}\n---\n${JSON.stringify(event.payload)}`;
		const promptSample = samplesAllowed ? truncate(promptComposed, SAMPLE_MAX_CHARS) : null;
		const responseSample = samplesAllowed
			? truncate(event.rawResponse, SAMPLE_MAX_CHARS)
			: null;
		const { evaluatorPromptKey, handoffStep } = extractWorkflowFields(event.payload);

		try {
			input.broker.control.recordEvaluatorDiagnostic({
				handoffId: event.context.handoffId,
				collabId: event.context.collabId,
				chainId: event.context.chainId,
				workflowId: event.context.workflowId,
				phaseRunId: event.context.phaseRunId,
				evaluatorBranch: event.branch,
				evaluatorPromptKey,
				handoffStep,
				attemptKind: event.attemptKind,
				callGroupId: event.callGroupId,
				provider: event.provider,
				outcome: event.outcome,
				verdict: event.verdict?.verdict ?? null,
				confidence: event.verdict?.confidence ?? null,
				reason: event.verdict?.reason ?? null,
				followUpMessageLen: followUpLen(event.verdict),
				latencyMs: event.latencyMs,
				errorMessage: event.error ? truncate(event.error.message, 500) : null,
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				promptSample,
				responseSample,
				now: now(),
			});
		} catch (err) {
			console.warn(
				`[ai-whisper] evaluator diagnostic write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
}
