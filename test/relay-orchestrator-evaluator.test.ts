import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
	createRelayOrchestratorEvaluator,
	DELIBERATION_REVIEW_SYSTEM_PROMPT,
	REVIEW_SYSTEM_PROMPT,
	selectBranch,
	type AnthropicClientLike,
	type EvaluatorCallEvent,
	type EvaluatorInput,
	type ObserverContext,
	type OllamaClientLike,
	type WorkflowEvaluatorInput,
} from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";
import type { OpenAIClientFactory } from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";
import type { SpawnLike, ChildProcessLike } from "../packages/cli/src/runtime/agent-cli-presets.ts";

function makeFakeSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number; spawnError?: Error }): {
	spawn: SpawnLike;
	calls: Array<{ command: string; args: readonly string[] }>;
	stdin: { chunks: string[]; ended: boolean; endedAfterWrite: boolean };
} {
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	const stdin = { chunks: [] as string[], ended: false, endedAfterWrite: false };
	const spawn: SpawnLike = (command, args) => {
		calls.push({ command, args });
		const dataCbs: Record<"out" | "err", Array<(c: unknown) => void>> = { out: [], err: [] };
		let closeCb: ((code: number | null) => void) | undefined;
		let errorCb: ((e: Error) => void) | undefined;
		const child: ChildProcessLike = {
			stdout: { on: (_e, cb) => dataCbs.out.push(cb) },
			stderr: { on: (_e, cb) => dataCbs.err.push(cb) },
			stdin: {
				write: (d) => { stdin.chunks.push(String(d)); },
				// Record close + that it happened AFTER a write, so a regression that never
				// ends stdin (or ends it before writing) is caught.
				end: () => { stdin.ended = true; stdin.endedAfterWrite = stdin.chunks.length > 0; },
			},
			on: (e, cb) => { if (e === "close") closeCb = cb as (code: number | null) => void; else errorCb = cb as (err: Error) => void; },
		};
		// Drive callbacks on the next microtask so listeners are registered first.
		queueMicrotask(() => {
			if (opts.spawnError) { errorCb?.(opts.spawnError); return; }
			if (opts.stdout) dataCbs.out.forEach((cb) => cb(Buffer.from(opts.stdout!)));
			if (opts.stderr) dataCbs.err.forEach((cb) => cb(Buffer.from(opts.stderr!)));
			closeCb?.(opts.exitCode ?? 0);
		});
		return child;
	};
	return { spawn, calls, stdin };
}

function makePayload(overrides: Partial<EvaluatorInput> = {}): EvaluatorInput {
	return {
		rootRequestText: "Write a report",
		requestText: "Write a report",
		handbackText: "Here is the report: all done.",
		senderAgent: "codex",
		targetAgent: "claude",
		roundNumber: 1,
		maxRounds: 3,
		captureStatus: "ok",
		...overrides,
	};
}

function makeWorkflowPayload(
	overrides: Partial<WorkflowEvaluatorInput> = {},
): WorkflowEvaluatorInput {
	return {
		...makePayload(),
		evaluatorPromptKey: "review-loop",
		workflowId: "wf_1",
		phaseRunId: "pr_1",
		phaseName: "spec-refining",
		handoffStep: "review",
		...overrides,
	};
}

function makeOllamaClient(content: string): OllamaClientLike {
	return {
		chat: vi.fn(() => Promise.resolve({ message: { content } })),
	} as OllamaClientLike;
}

function makeOpenAIFactory(
	impl: (req: { model: string; messages: Array<{ role: string; content: string }>; response_format?: Record<string, unknown>; temperature?: number }) => Promise<{
		choices: Array<{ message: { content: string | null } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	}>,
): { factory: OpenAIClientFactory; seen: Array<{ apiKey: string; baseURL?: string }> } {
	const seen: Array<{ apiKey: string; baseURL?: string }> = [];
	const factory: OpenAIClientFactory = (opts) => {
		seen.push(opts);
		return { chat: { completions: { create: vi.fn(impl) } } };
	};
	return { factory, seen };
}

function makeContext(overrides: Partial<ObserverContext> = {}): ObserverContext {
	return {
		handoffId: "handoff_test_1",
		collabId: "collab_test_1",
		chainId: "chain_test_1",
		workflowId: null,
		phaseRunId: null,
		...overrides,
	};
}

describe("createRelayOrchestratorEvaluator — Ollama provider", () => {
	it("parses a done verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.95, reason: "fully complete" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		const result = await evaluate({ payload: makePayload(), context: makeContext() });

		expect(result.verdict).toBe("done");
		expect(result.confidence).toBe(0.95);
	});

	it("parses a loop verdict with followUpMessage", async () => {
		const client = makeOllamaClient(
			JSON.stringify({
				verdict: "loop",
				confidence: 0.8,
				reason: "missing conclusion",
				followUpMessage: "add a conclusion paragraph",
			}),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		const result = await evaluate({ payload: makePayload(), context: makeContext() });

		expect(result.verdict).toBe("loop");
		if (result.verdict === "loop") {
			expect(result.followUpMessage).toBe("add a conclusion paragraph");
		}
	});

	it("sends the system prompt and payload as separate messages", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 0.9, reason: "ambiguous" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client, model: "qwen2.5:7b-instruct" },
		});
		const payload = makePayload();

		await evaluate({ payload, context: makeContext() });

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(callArg.messages[0]?.role).toBe("system");
		expect(callArg.messages[1]?.role).toBe("user");
		expect(callArg.messages[1]?.content).toBe(JSON.stringify(payload));
	});

	it("uses qwen2.5:7b-instruct when no model is configured", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		await evaluate({ payload: makePayload(), context: makeContext() });

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			model: string;
		};
		expect(callArg.model).toBe("qwen2.5:7b-instruct");
	});

	it("throws on invalid verdict schema", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "unknown", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
	});
});

describe("createRelayOrchestratorEvaluator — fallback", () => {
	it("falls back to secondary provider on ECONNREFUSED", async () => {
		const networkError = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(networkError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		const result = await evaluate({ payload: makePayload(), context: makeContext() });

		expect(result.verdict).toBe("done");
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it("does not fall back on Zod parse errors", async () => {
		const badClient = makeOllamaClient(
			JSON.stringify({ verdict: "not-a-real-verdict", confidence: 0.9, reason: "ok" }),
		);
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: badClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("does not fall back on HTTP 401 auth errors", async () => {
		const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(authError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("falls back on HTTP 429 rate limit", async () => {
		const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(rateLimitError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		const result = await evaluate({ payload: makePayload(), context: makeContext() });

		expect(result.verdict).toBe("done");
	});
});

// ---------------------------------------------------------------------------
// Workflow path: review step (review-loop, handoffStep="review")
// Allowed verdicts: approve | findings | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow review step", () => {
	it("parses an approve verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "approve", confidence: 0.9, reason: "spec is clear" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "review" }), context: makeContext() });
		expect(result.verdict).toBe("approve");
	});

	it("parses a findings verdict with classification only (no followUpMessage required)", async () => {
		// Fix #2: the review evaluator returns only verdict/confidence/reason; it is NOT
		// required to reproduce the findings (the orchestrator forwards the reviewer's
		// own handback instead). A findings verdict WITHOUT followUpMessage must parse —
		// previously the schema required it, forcing a long output that truncated at
		// max_tokens and failed to parse ("No JSON object found").
		const client = makeOllamaClient(
			JSON.stringify({
				verdict: "findings",
				confidence: 0.85,
				reason: "missing acceptance criteria",
			}),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "review" }), context: makeContext() });
		expect(result.verdict).toBe("findings");
	});

	it("parses an escalate verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "contradictory spec" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "review" }), context: makeContext() });
		expect(result.verdict).toBe("escalate");
	});

	it("rejects a legacy `done` verdict for review step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(evaluate({ payload: makeWorkflowPayload({ handoffStep: "review" }), context: makeContext() })).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Workflow path: implement / fix step (review-loop, handoffStep="implement"|"fix")
// Allowed verdicts: delivered | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow implement/fix step", () => {
	it("parses a delivered verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.9, reason: "commits made" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "implement" }), context: makeContext() });
		expect(result.verdict).toBe("delivered");
	});

	it("parses a delivered verdict for fix step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.85, reason: "fix landed" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "fix" }), context: makeContext() });
		expect(result.verdict).toBe("delivered");
	});

	it("parses an escalate verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "blocked on missing dep" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({ payload: makeWorkflowPayload({ handoffStep: "implement" }), context: makeContext() });
		expect(result.verdict).toBe("escalate");
	});

	it("rejects an approve verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "approve", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(evaluate({ payload: makeWorkflowPayload({ handoffStep: "implement" }), context: makeContext() })).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Workflow path: execute step (execution-gate, handoffStep="execute")
// Allowed verdicts: execution-pass | execution-fail | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow execute step", () => {
	it("parses an execution-pass verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "execution-pass", confidence: 0.95, reason: "tests pass" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({
			payload: makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
			context: makeContext(),
		});
		expect(result.verdict).toBe("execution-pass");
	});

	it("parses an execution-fail verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "execution-fail", confidence: 0.9, reason: "tests failed" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({
			payload: makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
			context: makeContext(),
		});
		expect(result.verdict).toBe("execution-fail");
	});

	it("parses an escalate verdict for execute step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "infra missing" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({
			payload: makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
			context: makeContext(),
		});
		expect(result.verdict).toBe("escalate");
	});

	it("rejects a delivered verdict for execute step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(
			evaluate({
				payload: makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
				context: makeContext(),
			}),
		).rejects.toThrow();
	});
});

describe("createRelayOrchestratorEvaluator — observer hook", () => {
	it("fires onCall once on success with outcome=ok and a callGroupId", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});

		await evaluate({ payload: makePayload(), context: makeContext() });

		expect(events).toHaveLength(1);
		expect(events[0]?.outcome).toBe("ok");
		expect(events[0]?.attemptKind).toBe("primary");
		expect(events[0]?.provider).toBe("ollama");
		expect(events[0]?.verdict?.verdict).toBe("done");
		expect(typeof events[0]?.callGroupId).toBe("string");
		expect(events[0]?.callGroupId.length).toBeGreaterThan(0);
		expect(typeof events[0]?.latencyMs).toBe("number");
	});

	it("fires onCall twice on fallback with shared callGroupId", async () => {
		const primaryClient: OllamaClientLike = {
			chat: vi.fn(() => Promise.reject(Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" }))),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.7, reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
			onCall: (e) => events.push(e),
		});

		await evaluate({ payload: makePayload(), context: makeContext() });

		expect(events).toHaveLength(2);
		expect(events[0]?.attemptKind).toBe("primary");
		expect(events[0]?.outcome).toBe("provider_unavailable");
		expect(events[1]?.attemptKind).toBe("fallback");
		expect(events[1]?.outcome).toBe("ok");
		expect(events[0]?.callGroupId).toBe(events[1]?.callGroupId);
	});

	it("threads context through to the observer (not via payload)", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});

		await evaluate({
			payload: makePayload(),
			context: makeContext({ handoffId: "h_special", collabId: "c_special" }),
		});

		expect(events[0]?.context.handoffId).toBe("h_special");
		expect(events[0]?.context.collabId).toBe("c_special");
	});

	it("payload sent to the LLM does NOT contain context IDs", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		await evaluate({
			payload: makePayload(),
			context: makeContext({ handoffId: "h_secret", collabId: "c_secret" }),
		});

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		const userMessage = callArg?.messages?.[1];
		expect(typeof userMessage?.content).toBe("string");
		expect(userMessage?.content).not.toContain("h_secret");
		expect(userMessage?.content).not.toContain("c_secret");
		expect(userMessage?.content).not.toContain("handoffId");
		expect(userMessage?.content).not.toContain("collabId");
	});
});

describe("createRelayOrchestratorEvaluator — outcome classification", () => {
	it("classifies a response with no JSON object as parse_error", async () => {
		const client = makeOllamaClient("just plain text, no JSON anywhere");
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("parse_error");
	});

	it("classifies malformed JSON as parse_error", async () => {
		const client = makeOllamaClient("{ this is { not valid JSON");
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("parse_error");
	});

	it("classifies invalid verdict enum as validation_error", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "not_a_real_verdict", confidence: 0.9, reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toBeInstanceOf(ZodError);
		expect(events[0]?.outcome).toBe("validation_error");
	});

	it("classifies wrong-typed confidence as validation_error", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: "high", reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toBeInstanceOf(ZodError);
		expect(events[0]?.outcome).toBe("validation_error");
	});

	it("classifies ECONNREFUSED as provider_unavailable", async () => {
		const client: OllamaClientLike = {
			chat: vi.fn(() => Promise.reject(Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" }))),
		} as OllamaClientLike;
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("provider_unavailable");
	});

	it("classifies HTTP 429 as provider_unavailable", async () => {
		const client: OllamaClientLike = {
			chat: vi.fn(() => Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }))),
		} as OllamaClientLike;
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("provider_unavailable");
	});

	it("classifies plain Error as unknown_error", async () => {
		const client: OllamaClientLike = {
			chat: vi.fn(() => Promise.reject(new Error("something completely different"))),
		} as OllamaClientLike;
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("unknown_error");
	});
});

describe("createRelayOrchestratorEvaluator — outer-retry semantics", () => {
	it("generates a fresh callGroupId per invocation (supports orchestrator's evaluateWithRetry)", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});

		await evaluate({ payload: makePayload(), context: makeContext() });
		await evaluate({ payload: makePayload(), context: makeContext() });

		expect(events).toHaveLength(2);
		expect(typeof events[0]?.callGroupId).toBe("string");
		expect(typeof events[1]?.callGroupId).toBe("string");
		expect(events[0]?.callGroupId).not.toBe(events[1]?.callGroupId);
	});
});

describe("createRelayOrchestratorEvaluator — observer error isolation", () => {
	it("does NOT propagate observer exceptions to the caller (success path)", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const evaluate = createRelayOrchestratorEvaluator({
				primary: { provider: "ollama", client },
				onCall: () => { throw new Error("observer blew up"); },
			});

			const verdict = await evaluate({ payload: makePayload(), context: makeContext() });
			expect(verdict).toMatchObject({ verdict: "done" });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("evaluator onCall observer threw"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does NOT swallow the underlying provider error when the observer also throws (failure path)", async () => {
		const client: OllamaClientLike = {
			chat: vi.fn(() => Promise.reject(Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" }))),
		} as OllamaClientLike;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const evaluate = createRelayOrchestratorEvaluator({
				primary: { provider: "ollama", client },
				onCall: () => { throw new Error("observer blew up too"); },
			});

			await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow(/conn refused/);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("evaluator onCall observer threw"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("createRelayOrchestratorEvaluator — token usage", () => {
	it("populates inputTokens/outputTokens from Anthropic response.usage", async () => {
		const captured: Partial<EvaluatorCallEvent>[] = [];
		const fakeClient: AnthropicClientLike = {
			messages: {
				create: vi.fn(async () => ({
					content: [{ type: "text" as const, text: JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }) }],
					usage: { input_tokens: 412, output_tokens: 64 },
				})),
			},
		};

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "anthropic", apiKey: "test", client: fakeClient },
			onCall: (e) => captured.push(e),
		});

		await evaluate({ payload: makePayload(), context: makeContext() });
		expect(captured[0]?.inputTokens).toBe(412);
		expect(captured[0]?.outputTokens).toBe(64);
	});

	it("leaves inputTokens/outputTokens NULL for Ollama (no usage surface)", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const captured: Partial<EvaluatorCallEvent>[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => captured.push(e),
		});
		await evaluate({ payload: makePayload(), context: makeContext() });
		expect(captured[0]?.inputTokens).toBeNull();
		expect(captured[0]?.outputTokens).toBeNull();
	});
});

describe("createRelayOrchestratorEvaluator — latencyMs boundary", () => {
	it("latencyMs measures the provider call only (excludes parse/zod overhead)", async () => {
		const client: OllamaClientLike = {
			chat: vi.fn(() =>
				Promise.resolve({
					message: {
						content: JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
					},
				}),
			),
		} as OllamaClientLike;
		const events: EvaluatorCallEvent[] = [];
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
			onCall: (e) => events.push(e),
		});
		await evaluate({ payload: makePayload(), context: makeContext() });

		expect(events[0]?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(events[0]?.latencyMs ?? NaN)).toBe(true);
		expect((client.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});
});

describe("createRelayOrchestratorEvaluator — non-review branches not stripped", () => {
	it("implement handoff with a Non-blocking risks section is sent to provider unstripped", async () => {
		const handback = [
			"Implemented the feature.",
			"",
			"Non-blocking risks:",
			"- concurrent writes may cause issues",
		].join("\n");
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.9, reason: "done" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
		});

		await evaluate({
			payload: makeWorkflowPayload({ handoffStep: "implement", handbackText: handback }),
			context: makeContext(),
		});

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		// messages[1] is the user/payload message — must NOT be stripped for non-review branches
		const userContent = callArg.messages[1]?.content ?? "";
		expect(userContent).toContain("concurrent writes");
	});
});

describe("review classification strips the risks block before the provider call", () => {
	it("sends the stripped body to the classifier payload (not the risks)", async () => {
		const handback = [
			"Review matrix:",
			"| R | E | T | Pass |",
			"",
			"Approved. Every criterion met.",
			"",
			"Non-blocking risks:",
			"- may break under concurrent writes",
		].join("\n");
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "approve", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client },
		});

		await evaluate({
			payload: makeWorkflowPayload({ handoffStep: "review", handbackText: handback }),
			context: makeContext(),
		});

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		// Assert ONLY on the user/payload message (messages[1]). messages[0] is the
		// system prompt, which legitimately contains "Non-blocking risks" (a rule).
		const userContent = callArg.messages[1]?.content ?? "";
		expect(userContent).toContain("Approved.");
		expect(userContent).not.toContain("concurrent writes");
		expect(userContent).not.toMatch(/Non-blocking risks/);
	});
});

// ---------------------------------------------------------------------------
// deliberation-loop key
// ---------------------------------------------------------------------------

describe("deliberation-loop key", () => {
	// Wiring: a deliberation-loop review routes to the deliberation branch and its
	// verdict parses. The mock supplies the verdict, so this guards routing + schema,
	// NOT the model's runtime judgement (that is the v1 experiment's job, spec §13).
	it("routes a deliberation-loop review to the deliberation branch and parses its verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "findings", confidence: 0.8, reason: "hollow approval — no adversarial work shown" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate({
			payload: makeWorkflowPayload({
				evaluatorPromptKey: "deliberation-loop",
				handoffStep: "review",
				workflowId: "wf_d", phaseRunId: "pr_1", phaseName: "objectives",
				handbackText: "Approved. Looks good to me.",
			}),
			context: makeContext(),
		});
		expect(result.verdict).toBe("findings");
	});

	it("selects the deliberation prompt (not the generic review prompt) for review steps", () => {
		const branch = selectBranch(
			makeWorkflowPayload({ evaluatorPromptKey: "deliberation-loop", handoffStep: "review",
				workflowId: "wf_d", phaseRunId: "pr_1", phaseName: "objectives" }),
		);
		expect(branch.systemPrompt).toBe(DELIBERATION_REVIEW_SYSTEM_PROMPT);
		expect(branch.systemPrompt).not.toBe(REVIEW_SYSTEM_PROMPT);
	});

	// The reviewer-flagged guard: the deliberation prompt must INSTRUCT the full §7
	// hollow-approval audit, not merely carry the catchphrase. An implementation that
	// kept the word "HOLLOW" but dropped the audit dimensions must fail here.
	it("the deliberation prompt audits the §7 rigor artifacts before accepting an approval", () => {
		const p = DELIBERATION_REVIEW_SYSTEM_PROMPT;
		expect(p).toMatch(/derived its own candidate independently/i); // independent derivation
		expect(p).toMatch(/ran the named lenses/i);                    // lens coverage
		expect(p).toMatch(/verified against/i);                        // external verification
		// the audit must DRIVE the verdict: a bare approval with none of these -> findings
		expect(p).toMatch(/NONE of the required (adversarial )?artifacts/i);
		expect(p).toMatch(/classify it "findings"/i);
	});

	it("routes deliberation implement/fix steps to the delivered branch (Explorer propose/refine)", () => {
		for (const step of ["implement", "fix"] as const) {
			const branch = selectBranch(
				makeWorkflowPayload({ evaluatorPromptKey: "deliberation-loop", handoffStep: step,
					workflowId: "wf_d", phaseRunId: "pr_1", phaseName: "objectives" }),
			);
			expect(branch.systemPrompt).not.toBe(DELIBERATION_REVIEW_SYSTEM_PROMPT);
		}
	});
});

describe("createRelayOrchestratorEvaluator — agent-cli provider", () => {
	const okJson = JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" });

	it("arg delivery appends the prompt as the last arg", async () => {
		const fake = makeFakeSpawn({ stdout: okJson });
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "agent-cli", agent: "claude", spawnImpl: fake.spawn } });
		const result = await evaluate({ payload: makePayload(), context: makeContext() });
		expect(result.verdict).toBe("done");
		expect(fake.calls[0]?.command).toBe("claude");
		expect(fake.calls[0]?.args.slice(0, 1)).toEqual(["-p"]);
		expect(typeof fake.calls[0]?.args.at(-1)).toBe("string"); // prompt appended as last arg
	});

	it("stdin delivery writes the prompt to stdin AND closes it (write then end)", async () => {
		const fake = makeFakeSpawn({ stdout: okJson });
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "agent-cli", agent: "agy", promptVia: "stdin", executable: "agy", execArgs: [], spawnImpl: fake.spawn } });
		await evaluate({ payload: makePayload(), context: makeContext() });
		expect(fake.stdin.chunks.join("")).toContain("handbackText");
		expect(fake.stdin.ended).toBe(true);            // stdin.end() was called — a never-closed-stdin regression fails here
		expect(fake.stdin.endedAfterWrite).toBe(true);  // end() came AFTER write(), matching the caller's write→end order
	});

	it("extracts a verdict from chatter/markdown-fenced stdout", async () => {
		const fake = makeFakeSpawn({ stdout: "Sure! Here you go:\n```json\n" + okJson + "\n```\n" });
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "agent-cli", agent: "claude", spawnImpl: fake.spawn } });
		const result = await evaluate({ payload: makePayload(), context: makeContext() });
		expect(result.verdict).toBe("done");
	});

	it("non-zero exit → provider_unavailable carrying stderr", async () => {
		const events: EvaluatorCallEvent[] = [];
		const fake = makeFakeSpawn({ stdout: "", stderr: "boom", exitCode: 2 });
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "agent-cli", agent: "claude", spawnImpl: fake.spawn }, onCall: (e) => events.push(e) });
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow(/boom/);
		expect(events[0]?.outcome).toBe("provider_unavailable");
	});

	it("ENOENT spawn error → provider_unavailable", async () => {
		const events: EvaluatorCallEvent[] = [];
		const fake = makeFakeSpawn({ spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) });
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "agent-cli", agent: "claude", spawnImpl: fake.spawn }, onCall: (e) => events.push(e) });
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("provider_unavailable");
	});

	it("agent-cli unavailable → engages a configured ollama fallback", async () => {
		const fake = makeFakeSpawn({ stdout: "", stderr: "down", exitCode: 1 });
		const fallbackClient = makeOllamaClient(okJson);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "agent-cli", agent: "claude", spawnImpl: fake.spawn },
			fallback: { provider: "ollama", client: fallbackClient },
		});
		const result = await evaluate({ payload: makePayload(), context: makeContext() });
		expect(result.verdict).toBe("done");
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});
});

describe("createRelayOrchestratorEvaluator — OpenAI provider", () => {
	it("parses a done verdict from chat.completions", async () => {
		const { factory } = makeOpenAIFactory(() =>
			Promise.resolve({ choices: [{ message: { content: JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }) } }] }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini", createClient: factory },
		});
		const result = await evaluate({ payload: makePayload(), context: makeContext() });
		expect(result.verdict).toBe("done");
	});

	it("threads apiKey and baseURL into the factory (construction seam)", async () => {
		const { factory, seen } = makeOpenAIFactory(() =>
			Promise.resolve({ choices: [{ message: { content: JSON.stringify({ verdict: "done", confidence: 1, reason: "ok" }) } }] }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "sk-xyz", model: "m", baseURL: "https://router.example/v1", createClient: factory },
		});
		await evaluate({ payload: makePayload(), context: makeContext() });
		expect(seen[0]).toEqual({ apiKey: "sk-xyz", baseURL: "https://router.example/v1" });
	});

	it("sends non-strict json_schema response_format carrying branch.jsonSchema UNCHANGED", async () => {
		const create = vi.fn(() =>
			Promise.resolve({ choices: [{ message: { content: JSON.stringify({ verdict: "done", confidence: 1, reason: "ok" }) } }] }),
		);
		const factory: OpenAIClientFactory = () => ({ chat: { completions: { create } } });
		const payload = makePayload(); // plain EvaluatorInput → selectBranch returns the legacy branch
		// The EXACT object the caller must forward, fetched via the already-imported selectBranch.
		const expectedSchema = selectBranch(payload).jsonSchema;
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "k", model: "m", createClient: factory },
		});
		await evaluate({ payload, context: makeContext() });
		const req = (create.mock.calls as unknown[][])[0]![0] as { response_format: { type: string; json_schema: { name: string; schema: unknown; strict?: unknown } }; temperature: number };
		expect(req.response_format.type).toBe("json_schema");
		expect(req.response_format.json_schema.name).toBe("verdict");
		// Deep-equals the selected branch schema — fails if the impl sends {} or a DIFFERENT
		// branch's schema (e.g. EXECUTION_JSON_SCHEMA), proving branch.jsonSchema is forwarded unchanged.
		expect(req.response_format.json_schema.schema).toEqual(expectedSchema);
		// And it must be the legacy schema specifically (guards against a hardcoded look-alike).
		expect((req.response_format.json_schema.schema as { properties: { verdict: { enum: string[] } } }).properties.verdict.enum)
			.toEqual(["done", "loop", "escalate"]);
		expect("strict" in req.response_format.json_schema).toBe(false);
		expect(req.temperature).toBe(0.3);
	});

	it("maps prompt_tokens/completion_tokens onto telemetry", async () => {
		const events: EvaluatorCallEvent[] = [];
		const { factory } = makeOpenAIFactory(() =>
			Promise.resolve({
				choices: [{ message: { content: JSON.stringify({ verdict: "done", confidence: 1, reason: "ok" }) } }],
				usage: { prompt_tokens: 11, completion_tokens: 7 },
			}),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "k", model: "m", createClient: factory },
			onCall: (e) => events.push(e),
		});
		await evaluate({ payload: makePayload(), context: makeContext() });
		expect(events[0]?.inputTokens).toBe(11);
		expect(events[0]?.outputTokens).toBe(7);
	});

	it("classifies malformed content as parse_error (no fallback)", async () => {
		const events: EvaluatorCallEvent[] = [];
		const { factory } = makeOpenAIFactory(() => Promise.resolve({ choices: [{ message: { content: "not json at all" } }] }));
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "k", model: "m", createClient: factory },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("parse_error");
	});

	it("classifies a 500 from the SDK as provider_unavailable", async () => {
		const events: EvaluatorCallEvent[] = [];
		const { factory } = makeOpenAIFactory(() => Promise.reject(Object.assign(new Error("server error"), { status: 500 })));
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "openai", apiKey: "k", model: "m", createClient: factory },
			onCall: (e) => events.push(e),
		});
		await expect(evaluate({ payload: makePayload(), context: makeContext() })).rejects.toThrow();
		expect(events[0]?.outcome).toBe("provider_unavailable");
	});
});
