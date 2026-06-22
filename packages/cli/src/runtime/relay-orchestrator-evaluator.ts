import * as crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Ollama } from "ollama";
import { z } from "zod";

// Minimal structural interface covering only the messages.create path we use.
// Defined here (not imported from `@anthropic-ai/sdk`) so tests can pass plain
// mocks without depending on the SDK being hoisted to root node_modules.
export type AnthropicClientLike = {
	messages: {
		create(request: {
			model: string;
			max_tokens: number;
			system: string;
			messages: Array<{ role: string; content: string }>;
		}): Promise<{
			content: Array<{ type: string; text?: string }>;
			usage?: { input_tokens?: number; output_tokens?: number };
		}>;
	};
};

// Minimal structural interface covering only the non-streaming chat path we use.
// Defined here (not imported from `ollama`) so tests can pass plain mocks without
// depending on the `ollama` package being hoisted to the root node_modules.
export type OllamaClientLike = {
	chat(request: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		format?: Record<string, unknown>;
		options?: { temperature?: number };
	}): Promise<{ message: { content: string } }>;
};

export type EvaluatorInput = {
	rootRequestText: string;
	requestText: string;
	handbackText: string;
	senderAgent: string;
	targetAgent: string;
	roundNumber: number;
	maxRounds: number;
	captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
};

export type RelayOrchestratorVerdict =
	| { verdict: "done"; confidence: number; reason: string }
	| { verdict: "loop"; confidence: number; reason: string; followUpMessage: string }
	| { verdict: "escalate"; confidence: number; reason: string };

export type WorkflowEvaluatorInput = EvaluatorInput & {
	evaluatorPromptKey: "review-loop" | "ralph-loop" | "execution-gate" | "deliberation-loop";
	workflowId: string;
	phaseRunId: string;
	phaseName: string;
	handoffStep: "review" | "fix" | "implement" | "execute";
};

export type WorkflowEvaluatorVerdict =
	| { verdict: "approve"; confidence: number; reason: string }
	| { verdict: "findings"; confidence: number; reason: string }
	| { verdict: "delivered"; confidence: number; reason: string }
	| { verdict: "execution-pass"; confidence: number; reason: string; extractedCommitShas?: string[] }
	| { verdict: "execution-fail"; confidence: number; reason: string }
	| { verdict: "escalate"; confidence: number; reason: string };

export type EvaluatorAnyInput = EvaluatorInput | WorkflowEvaluatorInput;
export type EvaluatorAnyVerdict = RelayOrchestratorVerdict | WorkflowEvaluatorVerdict;

export type ObserverContext = {
	handoffId: string;
	collabId: string;
	chainId: string | null;
	workflowId: string | null;
	phaseRunId: string | null;
};

export type EvaluatorCall = {
	payload: EvaluatorAnyInput;
	context: ObserverContext;
};

export type EvaluatorCallEvent = {
	callGroupId: string;
	context: ObserverContext;
	branch: "legacy" | "review" | "delivered" | "execution";
	provider: "anthropic" | "ollama";
	attemptKind: "primary" | "fallback";
	outcome: "ok" | "parse_error" | "validation_error" | "provider_unavailable" | "unknown_error";
	latencyMs: number;
	rawResponse: string | null;
	error: Error | null;
	verdict: EvaluatorAnyVerdict | null;
	inputTokens: number | null;
	outputTokens: number | null;
	systemPrompt: string;
	payload: EvaluatorAnyInput;
};

const baseFields = {
	confidence: z.number().min(0).max(1),
	reason: z.string(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Branch: legacy (done | loop | escalate)
// ─────────────────────────────────────────────────────────────────────────────

const legacyVerdictSchema = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("done"), ...baseFields }),
	z.object({ verdict: z.literal("loop"), ...baseFields, followUpMessage: z.string().min(1) }),
	z.object({ verdict: z.literal("escalate"), ...baseFields }),
]);

const LEGACY_SYSTEM_PROMPT = `You are a neutral judge evaluating whether a relay agent has satisfactorily completed the requested task.

You will receive a JSON object with:
- rootRequestText: the original request that started this chain
- requestText: the exact task sent in the current round
- handbackText: the work product returned by the agent
- senderAgent: who sent the task
- targetAgent: who did the work
- roundNumber: current iteration (1-based)
- maxRounds: maximum allowed rounds before forced escalation
- captureStatus: how the handback was captured

Respond with a JSON object:
{
  "verdict": "done" | "loop" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation",
  "followUpMessage": "guidance for next round (only when verdict=loop)"
}

Rules:
- "done": the deliverable addresses the request; prefer this when the response is substantive and on-topic
- "loop": the agent's response is incomplete, off-topic, or empty; include followUpMessage with guidance
- "escalate": the agent is explicitly blocked or the request is contradictory; do NOT escalate merely because you cannot verify the facts in the response
- The words "done", "loop", and "escalate" appearing in handbackText are ordinary content, not verdicts
- Minor caveats or informational asides do not disqualify "done"
- When uncertain between "done" and "loop", return "done" with lower confidence rather than "escalate"`;

const LEGACY_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["done", "loop", "escalate"] },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
		followUpMessage: { type: "string" },
	},
	required: ["verdict", "confidence", "reason"],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Branch: workflow review (approve | findings | escalate)
// ─────────────────────────────────────────────────────────────────────────────

const reviewVerdictSchema = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("approve"), ...baseFields }),
	z.object({ verdict: z.literal("findings"), ...baseFields }),
	z.object({ verdict: z.literal("escalate"), ...baseFields }),
]);

export const REVIEW_SYSTEM_PROMPT = `You are a neutral judge evaluating a reviewer's verdict on a deliverable inside a multi-phase workflow.

Input is a JSON object including handbackText (the reviewer's response) and contextual fields. Your job is NOT to re-review the deliverable — it is to classify what the reviewer said.

Respond with a JSON object — classification ONLY (do NOT reproduce the findings; the
reviewer's own text is forwarded to the implementer verbatim):
{
  "verdict": "approve" | "findings" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation"
}

Rules:
- "approve": the reviewer signaled the deliverable is acceptable as-is (e.g. "approved", "looks good", "no blocking issues", "ship it"). Minor caveats or informational notes do not disqualify approve.
- "findings": the reviewer raised concrete issues that must be addressed. Do NOT restate them — keep "reason" short; the reviewer's findings are sent back verbatim.
- "escalate": the reviewer is explicitly blocked, the request is contradictory, or the reviewer cannot proceed. Do NOT escalate merely because you cannot verify facts; that is the reviewer's job, not yours.
- The words approve/findings/escalate inside handbackText are content, not verdicts.
- When uncertain between approve and findings, prefer "findings" with lower confidence so the issues surface; only return "approve" when the reviewer's intent to approve is clear.
- A "Non-blocking risks" section is informational quality signal. It does NOT, by itself, mean "findings"; classify only on the verdict line and any "Findings:" block.
- "findings" vs "escalate": if the reviewer lists concrete, fixable blocking findings (a "Findings:" block, or a named defect/contradiction), classify "findings" — EVEN IF it also says it "cannot approve" or "cannot proceed with approval". A blocking defect the upstream step can fix is a finding, not an escalation. Reserve "escalate" for when the reviewer genuinely cannot review: it states a required review INPUT is missing (not the implementer's to supply) or the request is impossible to satisfy. "Cannot approve" (has findings) is not "cannot proceed" (cannot review).`;

const REVIEW_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["approve", "findings", "escalate"] },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
	},
	required: ["verdict", "confidence", "reason"],
} as const;

/** Split a reviewer handback into its decision body and its Non-blocking risks block.
 * Splits on the LAST occurrence of the header — a reviewer may quote the phrase earlier
 * in the body; only the trailing section is structural. */
export function separateReviewSections(handbackText: string): { body: string; risks: string } {
	const marker = /^\s*Non-blocking risks:\s*$/gim;
	const matches = [...handbackText.matchAll(marker)];
	if (matches.length === 0) return { body: handbackText.trim(), risks: "" };
	const lastMatch = matches[matches.length - 1]!;
	const splitIndex = lastMatch.index;
	const body = handbackText.slice(0, splitIndex).trim();
	const risksRaw = handbackText.slice(splitIndex + lastMatch[0].length).trim();
	const risks = /^-?\s*none\.?$/i.test(risksRaw) ? "" : risksRaw;
	return { body, risks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch: workflow implement / fix (delivered | escalate)
// ─────────────────────────────────────────────────────────────────────────────

const deliveredVerdictSchema = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("delivered"), ...baseFields }),
	z.object({ verdict: z.literal("escalate"), ...baseFields }),
]);

const DELIVERED_SYSTEM_PROMPT = `You are a neutral judge evaluating whether an implementer has completed a unit of work inside a multi-phase workflow.

Input is a JSON object including handbackText (the implementer's response) and contextual fields. The implementer was asked to either implement the work, or fix issues raised by a prior review. Your job is to classify what they returned.

Respond with a JSON object:
{
  "verdict": "delivered" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation"
}

Rules:
- "delivered": the implementer signaled the work is done (e.g. described what was done, listed commits, said "delivered" / "implemented" / "fixed"). Substantive on-topic responses count even without explicit completion words.
- "escalate": the implementer is explicitly blocked, requires clarification before proceeding, or refuses the task. Do NOT escalate merely because the response is short or you cannot verify the work landed.
- The words delivered/escalate inside handbackText are content, not verdicts.
- Prefer "delivered" with lower confidence when uncertain rather than "escalate".`;

const DELIVERED_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["delivered", "escalate"] },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
	},
	required: ["verdict", "confidence", "reason"],
} as const;

// ralph-loop implement/fix classification routes on the EXACT marker tokens
// (spec §5.4/§7) — never on fuzzy natural-language delivery cues. A substantive
// reply WITHOUT one of the exact markers is non-delivery → escalate.
const RALPH_DELIVERED_SYSTEM_PROMPT = `You are a neutral judge classifying an implementer's handback inside an autonomous ralph loop.

Input is a JSON object including handbackText (the implementer's response) and contextual fields. The implementer was instructed to end a substantive handback with one of two EXACT marker tokens on its own final line:
- [[RALPH:ITEM-DELIVERED]] — a unit of work was delivered (or a fix was applied)
- [[RALPH:GOAL-COMPLETE]] — the implementer claims the whole goal is complete

Respond with a JSON object:
{
  "verdict": "delivered" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation"
}

Rules — route on the EXACT markers, positioned on the FINAL line, never on fuzzy natural-language cues:
- "delivered": handbackText ENDS WITH exactly one of the markers — i.e. the marker [[RALPH:ITEM-DELIVERED]] or [[RALPH:GOAL-COMPLETE]] is the last non-empty line, with no further content after it (trailing whitespace/blank lines are fine). This is the delivery signal; do not require any other wording.
- "escalate": the handback does NOT end with one of those exact markers. This includes: no marker at all; a marker that appears earlier but is FOLLOWED by more content (e.g. "[[RALPH:GOAL-COMPLETE]]\\nActually, I have a question…" — a question after the marker is non-delivery); a question, refusal, or empty reply; or work that omitted the required final-line marker. Also escalate when the implementer is explicitly blocked or requires clarification.
- Natural-language phrases like "done", "delivered", "implemented", or "fixed" WITHOUT the exact bracketed token on the final line do NOT count as delivery.
- Treat the markers as exact literal tokens; only their placement on the final line signals delivery. A marker quoted mid-text (with content after it) is not delivery.`;

// ─────────────────────────────────────────────────────────────────────────────
// Branch: workflow execute (execution-pass | execution-fail | escalate)
// ─────────────────────────────────────────────────────────────────────────────

const executionVerdictSchema = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("execution-pass"), ...baseFields }),
	z.object({ verdict: z.literal("execution-fail"), ...baseFields }),
	z.object({ verdict: z.literal("escalate"), ...baseFields }),
]);

const EXECUTION_SYSTEM_PROMPT = `You are a neutral judge evaluating an execution attempt inside a multi-phase workflow (build, tests, lints, etc.).

Input is a JSON object including handbackText (the executor's report) and contextual fields. Your job is to classify the outcome reported by the executor.

Respond with a JSON object:
{
  "verdict": "execution-pass" | "execution-fail" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation"
}

Rules:
- "execution-pass": the executor reported the run succeeded (build green, tests passed, lints clean). On-topic completion reports count.
- "execution-fail": the executor reported the run failed but the failure is recoverable in another round (test failure, build error, lint violation).
- "escalate": the executor is blocked from running at all (missing infra, contradictory requirements) — not a normal test failure.
- The words pass/fail/escalate inside handbackText are content, not verdicts.`;

const EXECUTION_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: {
			type: "string",
			enum: ["execution-pass", "execution-fail", "escalate"],
		},
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
	},
	required: ["verdict", "confidence", "reason"],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Branch dispatch
// ─────────────────────────────────────────────────────────────────────────────

type Branch<V> = {
	systemPrompt: string;
	jsonSchema: Record<string, unknown>;
	parse: (raw: string) => V;
};

function makeParser<V>(schema: { parse: (json: unknown) => V }): (raw: string) => V {
	return (raw: string) => {
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) throw new Error("No JSON object found in evaluator response");
		return schema.parse(JSON.parse(jsonMatch[0]));
	};
}

const legacyBranch: Branch<RelayOrchestratorVerdict> = {
	systemPrompt: LEGACY_SYSTEM_PROMPT,
	jsonSchema: LEGACY_JSON_SCHEMA,
	parse: makeParser(legacyVerdictSchema),
};

const reviewBranch: Branch<WorkflowEvaluatorVerdict> = {
	systemPrompt: REVIEW_SYSTEM_PROMPT,
	jsonSchema: REVIEW_JSON_SCHEMA,
	parse: makeParser(reviewVerdictSchema),
};

const deliveredBranch: Branch<WorkflowEvaluatorVerdict> = {
	systemPrompt: DELIVERED_SYSTEM_PROMPT,
	jsonSchema: DELIVERED_JSON_SCHEMA,
	parse: makeParser(deliveredVerdictSchema),
};

// Same delivered|escalate schema as deliveredBranch, but the ralph-loop prompt
// requires the exact handback markers (spec §5.4/§7).
const ralphDeliveredBranch: Branch<WorkflowEvaluatorVerdict> = {
	systemPrompt: RALPH_DELIVERED_SYSTEM_PROMPT,
	jsonSchema: DELIVERED_JSON_SCHEMA,
	parse: makeParser(deliveredVerdictSchema),
};

const executionBranch: Branch<WorkflowEvaluatorVerdict> = {
	systemPrompt: EXECUTION_SYSTEM_PROMPT,
	jsonSchema: EXECUTION_JSON_SCHEMA,
	parse: makeParser(executionVerdictSchema),
};

export function selectBranch(payload: EvaluatorAnyInput): Branch<EvaluatorAnyVerdict> {
	if ("evaluatorPromptKey" in payload) {
		if (payload.evaluatorPromptKey === "execution-gate") return executionBranch;
		// review-loop AND ralph-loop: dispatch by handoffStep
		if (payload.handoffStep === "review") return reviewBranch;
		if (payload.handoffStep === "implement" || payload.handoffStep === "fix") {
			// ralph-loop delivered classification routes on the exact markers (spec §5.4/§7);
			// review-loop uses the generic delivered prompt.
			return payload.evaluatorPromptKey === "ralph-loop" ? ralphDeliveredBranch : deliveredBranch;
		}
		// Unknown step inside review-loop — fall back to review schema; the
		// orchestrator pre-validates handoffStep so this is defensive only.
		return reviewBranch;
	}
	return legacyBranch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider plumbing
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicProviderConfig = {
	provider: "anthropic";
	apiKey: string;
	model?: string;
	client?: Anthropic | AnthropicClientLike;
};

export type OllamaProviderConfig = {
	provider: "ollama";
	host?: string;
	model?: string;
	client?: OllamaClientLike;
};

export type EvaluatorProviderConfig = AnthropicProviderConfig | OllamaProviderConfig;

function isProviderUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	if (
		code === "ECONNREFUSED" ||
		code === "ENOTFOUND" ||
		code === "ETIMEDOUT" ||
		code === "ECONNRESET"
	)
		return true;
	if ("status" in error && typeof (error as { status: unknown }).status === "number") {
		const status = (error as { status: number }).status;
		return status === 429 || status >= 500;
	}
	return false;
}

function classifyEvaluatorError(
	error: unknown,
): "parse_error" | "validation_error" | "provider_unavailable" | "unknown_error" {
	if (error instanceof z.ZodError) return "validation_error";
	if (isProviderUnavailableError(error)) return "provider_unavailable";
	if (error instanceof Error) {
		if (error.message === "No JSON object found in evaluator response") return "parse_error";
		if (error instanceof SyntaxError) return "parse_error";
	}
	return "unknown_error";
}

function safeEmitOnCall(
	onCall: ((event: EvaluatorCallEvent) => void) | undefined,
	event: EvaluatorCallEvent,
): void {
	if (onCall === undefined) return;
	try {
		onCall(event);
	} catch (observerErr) {
		console.warn(
			`[ai-whisper] evaluator onCall observer threw: ${observerErr instanceof Error ? observerErr.message : String(observerErr)}`,
		);
	}
}

function buildAnthropicCaller(
	config: AnthropicProviderConfig,
): (systemPrompt: string, payload: EvaluatorAnyInput) => Promise<{
	raw: string;
	inputTokens?: number;
	outputTokens?: number;
}> {
	const client = (config.client ?? new Anthropic({ apiKey: config.apiKey })) as AnthropicClientLike;
	const model = config.model ?? "claude-haiku-4-5-20251001";

	return async function (systemPrompt: string, payload: EvaluatorAnyInput): Promise<{
		raw: string;
		inputTokens?: number;
		outputTokens?: number;
	}> {
		const response = await client.messages.create({
			model,
			max_tokens: 3000,
			system: systemPrompt,
			messages: [{ role: "user", content: JSON.stringify(payload) }],
		});
		const raw = response.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { type: "text"; text: string }).text)
			.join("");
		return {
			raw,
			...(typeof response.usage?.input_tokens === "number" ? { inputTokens: response.usage.input_tokens } : {}),
			...(typeof response.usage?.output_tokens === "number" ? { outputTokens: response.usage.output_tokens } : {}),
		};
	};
}

function buildOllamaCaller(
	config: OllamaProviderConfig,
): (
	systemPrompt: string,
	payload: EvaluatorAnyInput,
	jsonSchema: Record<string, unknown>,
) => Promise<{ raw: string }> {
	const client: OllamaClientLike =
		config.client ?? new Ollama({ host: config.host ?? "http://localhost:11434" });
	const model = config.model ?? "qwen2.5:7b-instruct";

	return async function (
		systemPrompt: string,
		payload: EvaluatorAnyInput,
		jsonSchema: Record<string, unknown>,
	): Promise<{ raw: string }> {
		const response = await client.chat({
			model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: JSON.stringify(payload) },
			],
			format: jsonSchema,
			options: { temperature: 0.3 },
		});
		return { raw: response.message.content };
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// New factory: EvaluatorCall wrapper + observer hook + outcome classification
// ─────────────────────────────────────────────────────────────────────────────

type CallResult =
	| { ok: true; verdict: EvaluatorAnyVerdict; raw: string; inputTokens: number | null; outputTokens: number | null; providerLatencyMs: number }
	| { ok: false; error: Error; raw: string | null; inputTokens: number | null; outputTokens: number | null; providerLatencyMs: number };

function buildSingleProviderCaller(
	config: EvaluatorProviderConfig,
): (payload: EvaluatorAnyInput, branch: Branch<EvaluatorAnyVerdict>) => Promise<CallResult> {
	if (config.provider === "anthropic") {
		const call = buildAnthropicCaller(config);
		return async function (payload, branch) {
			const started = Date.now();
			let providerResult: { raw: string; inputTokens?: number; outputTokens?: number };
			try {
				providerResult = await call(branch.systemPrompt, payload);
			} catch (callErr) {
				const providerLatencyMs = Date.now() - started;
				return {
					ok: false,
					error: callErr instanceof Error ? callErr : new Error(String(callErr)),
					raw: null,
					inputTokens: null,
					outputTokens: null,
					providerLatencyMs,
				};
			}
			const providerLatencyMs = Date.now() - started;
			// Parse happens AFTER the timer stops — does NOT contribute to providerLatencyMs.
			try {
				const verdict = branch.parse(providerResult.raw);
				return {
					ok: true,
					verdict,
					raw: providerResult.raw,
					inputTokens: providerResult.inputTokens ?? null,
					outputTokens: providerResult.outputTokens ?? null,
					providerLatencyMs,
				};
			} catch (parseErr) {
				return {
					ok: false,
					error: parseErr instanceof Error ? parseErr : new Error(String(parseErr)),
					raw: providerResult.raw,
					inputTokens: providerResult.inputTokens ?? null,
					outputTokens: providerResult.outputTokens ?? null,
					providerLatencyMs,
				};
			}
		};
	}
	const call = buildOllamaCaller(config);
	return async function (payload, branch) {
		const started = Date.now();
		let raw: string;
		try {
			({ raw } = await call(branch.systemPrompt, payload, branch.jsonSchema));
		} catch (callErr) {
			const providerLatencyMs = Date.now() - started;
			return {
				ok: false,
				error: callErr instanceof Error ? callErr : new Error(String(callErr)),
				raw: null,
				inputTokens: null,
				outputTokens: null,
				providerLatencyMs,
			};
		}
		const providerLatencyMs = Date.now() - started;
		// Parse happens AFTER the timer stops — does NOT contribute to providerLatencyMs.
		try {
			const verdict = branch.parse(raw);
			return { ok: true, verdict, raw, inputTokens: null, outputTokens: null, providerLatencyMs };
		} catch (parseErr) {
			return {
				ok: false,
				error: parseErr instanceof Error ? parseErr : new Error(String(parseErr)),
				raw,
				inputTokens: null,
				outputTokens: null,
				providerLatencyMs,
			};
		}
	};
}

export function createRelayOrchestratorEvaluator(input: {
	primary: EvaluatorProviderConfig;
	fallback?: EvaluatorProviderConfig;
	onCall?: (event: EvaluatorCallEvent) => void;
}) {
	const primaryProvider = input.primary.provider;
	const fallbackProvider = input.fallback?.provider ?? null;
	const primaryFn = buildSingleProviderCaller(input.primary);
	const fallbackFn = input.fallback ? buildSingleProviderCaller(input.fallback) : null;

	return async function evaluateRelayHandoff(
		call: EvaluatorCall,
	): Promise<EvaluatorAnyVerdict> {
		const callGroupId = crypto.randomUUID();
		const branch = selectBranch(call.payload);
		const branchName: EvaluatorCallEvent["branch"] =
			branch === legacyBranch
				? "legacy"
				: branch === reviewBranch
					? "review"
					: branch === deliveredBranch || branch === ralphDeliveredBranch
						? "delivered"
						: "execution";

		// reviewBranch is a module singleton; identity comparison is intentional. Strip the
		// Non-blocking risks block only for review classification so it is never misread as findings.
		const effectivePayload: EvaluatorAnyInput =
			branch === reviewBranch && "handbackText" in call.payload
				? {
						...call.payload,
						handbackText: separateReviewSections(call.payload.handbackText).body,
					}
				: call.payload;

		async function runOne(
			attemptKind: "primary" | "fallback",
			runner: (p: EvaluatorAnyInput, b: Branch<EvaluatorAnyVerdict>) => Promise<CallResult>,
			provider: "anthropic" | "ollama",
		): Promise<
			| { verdict: EvaluatorAnyVerdict }
			| {
					error: Error;
					outcome: "parse_error" | "validation_error" | "provider_unavailable" | "unknown_error";
			  }
		> {
			const result = await runner(effectivePayload, branch);
			const latencyMs = result.providerLatencyMs;

			if (result.ok) {
				safeEmitOnCall(input.onCall, {
					callGroupId,
					context: call.context,
					branch: branchName,
					provider,
					attemptKind,
					outcome: "ok",
					latencyMs,
					rawResponse: result.raw,
					error: null,
					verdict: result.verdict,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
					systemPrompt: branch.systemPrompt,
					payload: call.payload,
				});
				return { verdict: result.verdict };
			}
			const outcome = classifyEvaluatorError(result.error);
			safeEmitOnCall(input.onCall, {
				callGroupId,
				context: call.context,
				branch: branchName,
				provider,
				attemptKind,
				outcome,
				latencyMs,
				rawResponse: result.raw,
				error: result.error,
				verdict: null,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				systemPrompt: branch.systemPrompt,
				payload: call.payload,
			});
			return { error: result.error, outcome };
		}

		const primaryResult = await runOne("primary", primaryFn, primaryProvider);
		if ("verdict" in primaryResult) return primaryResult.verdict;

		if (
			fallbackFn !== null &&
			fallbackProvider !== null &&
			primaryResult.outcome === "provider_unavailable"
		) {
			const fallbackResult = await runOne("fallback", fallbackFn, fallbackProvider);
			if ("verdict" in fallbackResult) return fallbackResult.verdict;
			throw fallbackResult.error;
		}
		throw primaryResult.error;
	};
}
