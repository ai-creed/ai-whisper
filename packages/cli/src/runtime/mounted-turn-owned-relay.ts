import type { CaptureHandbackResult } from "./capture-handback-text.js";
import type { AgentType } from "@ai-whisper/shared";

type RelayTurnState = {
	collabId: string;
	turnOwner: AgentType | "none";
	waitingAgent: AgentType | null;
	unresolvedHandoffId: string | null;
	handoffState: "idle" | "pending" | "deferred" | "accepted" | "stale_handoff" | "failed";
	handoffAgeMs: number | null;
};

type RelayHandoff = {
	handoffId: string;
	collabId: string;
	senderAgent: AgentType;
	targetAgent: AgentType;
	requestText: string;
	status: "pending" | "deferred" | "accepted" | "declined" | "handed_back" | "failed";
};

type BrokerLike = {
	control: {
		getRelayTurnState(collabId: string, now?: string): RelayTurnState;
		getRelayHandoff(handoffId: string): RelayHandoff | null;
		markRelayHandoffStale?(input: { handoffId: string; now: string }): void;
		acceptRelayHandoff(input: { handoffId: string; acceptedAt: string }): void;
		declineRelayHandoff(input: { handoffId: string; now: string }): void;
		deferRelayHandoff(input: { handoffId: string; deferredAt: string }): void;
		failRelayHandoffOnDisconnect?(input: { handoffId: string; now: string }): void;
		handoffBackRelay?(input: {
			handoffId: string;
			nextHandoffId: string;
			senderAgent: AgentType;
			targetAgent: AgentType;
			requestText: string;
			captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
			now: string;
		}): void;
		getHandoffWithWorkflowMeta?(handoffId: string): { workflowId: string | null; chainId: string | null } | null;
		recordCaptureDiagnostic?(input: {
			handoffId: string;
			collabId: string;
			chainId: string | null;
			workflowId: string | null;
			targetProvider: AgentType;
			captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured";
			clipLen: number;
			turnLen: number;
			turnConfidence: "high" | "low";
			jaccardScore: number | null;
			containmentScore: number | null;
			clipSample: string | null;
			turnSample: string | null;
			abortedByRaceGuard: boolean;
			interferenceDetected?: boolean;
			now: string;
		}): { captureId: string };
		getWorkflow?(id: string): { status: string } | null;
		getRelayChain?(id: string): { status: string } | null;
		applyOrchestratorVerdict?(input: { handoffId: string; verdict: string; confidence: number; reason: string; now: string }): void;
		isWorkflowDeliverySuspended?(handoffId: string): boolean;
		recordTurnEventDiagnostic?(input: {
			receivedAt: string;
			provider: "claude" | "codex" | "ezio";
			workspaceId: string;
			cwd: string;
			sessionOrThreadId: string | null;
			turnId: string | null;
			workflowActive: boolean;
			collabId: string | null;
			workflowId: string | null;
			chainId: string | null;
			handoffId: string | null;
			inputCorrelated: boolean | null;
			containmentScore: number | null;
			fidelityVerdict: "clean" | "mid_composition" | "empty" | "superseded" | "n/a";
			deferCount: number;
			action:
				| "delivered"
				| "ignored_no_workflow"
				| "ignored_unrelated_turn"
				| "deferred_rearmed"
				| "rejected_mid_composition"
				| "fallback_indeterminate"
				| "fallback_exhausted";
			messageLen: number;
			messageSample: string | null;
		}): { eventId: string };
	};
};

type TurnEventAction = NonNullable<
	BrokerLike["control"]["recordTurnEventDiagnostic"]
> extends (input: infer I) => unknown
	? I extends { action: infer A }
		? A
		: never
	: never;

type TurnEventFidelityVerdict = NonNullable<
	BrokerLike["control"]["recordTurnEventDiagnostic"]
> extends (input: infer I) => unknown
	? I extends { fidelityVerdict: infer V }
		? V
		: never
	: never;

const CLEAR_LINE = "\r\u001b[2K";
const CURSOR_UP = "\u001b[1A";
const OWNER_CARD_BG = "\u001b[48;5;29m";
const OWNER_CARD_FG = "\u001b[38;5;250m";
const ANSI_RESET = "\u001b[0m";

function submitInjectedInput(writeUserInput: (text: string) => void, text: string) {
	writeUserInput(text);
	writeUserInput("\r");
}

// Hard-wrap the card to the terminal width and report the exact number of
// physical rows it occupies. clearOwnerCard walks back that many rows, so
// logical-line count MUST equal rendered physical rows — otherwise the clear
// under-counts, the cursor desyncs, and the card's BG/FG bleeds across
// un-reset wrapped rows (the RC2 dim/garble).
export function styleOwnerCard(
	message: string,
	cols: number,
): { text: string; lineCount: number } {
	// 1-col safety margin: a full row is " " + content + " " = contentWidth+2
	// visible chars; keeping that <= cols-1 avoids the terminal auto-margin
	// wrapping it to an extra physical row.
	const contentWidth = Math.max(1, cols - 3);
	const wrapped: string[] = [];
	for (const logical of message.split("\n")) {
		if (logical.length === 0) {
			wrapped.push("");
			continue;
		}
		for (let i = 0; i < logical.length; i += contentWidth) {
			wrapped.push(logical.slice(i, i + contentWidth));
		}
	}
	const text = wrapped
		.map(
			(line) =>
				`${OWNER_CARD_BG}${OWNER_CARD_FG} ${line.padEnd(contentWidth, " ")} ${ANSI_RESET}`,
		)
		.join("\n");
	return { text, lineCount: wrapped.length };
}

function computeLcs(a: string[], b: string[]): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		const row = dp[i]!;
		const prevRow = dp[i - 1]!;
		for (let j = 1; j <= n; j++) {
			row[j] =
				a[i - 1] === b[j - 1]
					? prevRow[j - 1]! + 1
					: Math.max(prevRow[j]!, row[j - 1]!);
		}
	}
	return dp[m]![n]!;
}

export function computeOrderedJaccard(a: string, b: string): number {
	const normalize = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
	const extractWords = (t: string) =>
		normalize(t)
			.split(" ")
			.filter((w) => w.length >= 4);

	const wa = extractWords(a);
	const wb = extractWords(b);
	const setA = new Set(wa);
	const setB = new Set(wb);
	const intersectionSize = [...setA].filter((w) => setB.has(w)).length;
	const unionSize = new Set([...setA, ...setB]).size;
	if (unionSize === 0) return 0;

	const jaccard = intersectionSize / unionSize;
	const lcs = computeLcs(wa, wb);
	const shorter = Math.min(wa.length, wb.length);
	if (shorter === 0) return 0;

	return jaccard * (lcs / shorter);
}

export function computeContainment(clip: string, turn: string): number {
	const normalize = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
	const extractWords = (t: string) =>
		normalize(t)
			.split(" ")
			.filter((w) => w.length >= 4);

	const clipWords = extractWords(clip);
	if (clipWords.length === 0) return 0;
	const turnSet = new Set(extractWords(turn));
	const matched = clipWords.filter((w) => turnSet.has(w)).length;
	return matched / clipWords.length;
}

export type CaptureClassification = {
	status: "ok" | "no_response_captured_confidently" | "no_response_captured";
	jaccardScore: number | null;
	containmentScore: number | null;
};

export function classifyCapture(
	turnResult: { confidence: "high" | "low"; text: string | null },
	clipboardText: string | null,
): CaptureClassification {
	const turnText = turnResult.text ?? "";
	const clipText = clipboardText ?? "";

	if (turnText.trim().length === 0 && clipText.trim().length === 0) {
		return { status: "no_response_captured", jaccardScore: null, containmentScore: null };
	}

	if (clipText.trim().length > 0) {
		// When high-confidence current-phase turn text is available, the clip MUST be
		// validated against it — REGARDLESS of clip length. A substantial clip that
		// bears no resemblance to the current turn is stale/prior-phase content (a
		// re-/copy of an earlier turn that still advanced changeCount, so the lease
		// freshness check in captureHandbackText cannot detect it), not the response
		// to this phase's request, and must not resolve the gate.
		//
		// Bug 2026-06-06: the >=100-char fast-path below used to fire FIRST and trust
		// any substantial clip unconditionally, so a reviewer's prior-phase plan
		// review (clip_len=3732, jaccard/containment NULL) was accepted as the
		// code-review handback even though high-confidence turn text was present to
		// reject it. See docs/superpowers/bugs/2026-06-06-code-review-gate-passed-on-
		// stale-prior-phase-review.md.
		if (turnResult.confidence === "high" && turnText.trim().length > 0) {
			const jaccardScore = computeOrderedJaccard(turnText, clipText);
			const containmentScore = computeContainment(clipText, turnText);
			if (jaccardScore >= 0.6 || containmentScore >= 0.8) {
				return { status: "ok", jaccardScore, containmentScore };
			}
			return {
				status: "no_response_captured_confidently",
				jaccardScore,
				containmentScore,
			};
		}

		// No high-confidence turn text to validate against. Full-screen TUI providers
		// (e.g. Claude Code) produce cursor-positioned PTY output that
		// normalizeCapturedOutput cannot reconstruct, so PTY similarity checks always
		// fail even when the response is valid. A substantial clipboard (>= 100 chars)
		// captured under the held lease is trusted as a fresh /copy — the clipboard
		// change detection in captureClipboardHandback already guarantees it is not a
		// foreign-clobbered read.
		if (clipText.trim().length >= 100) {
			return { status: "ok", jaccardScore: null, containmentScore: null };
		}
	}

	return {
		status: "no_response_captured_confidently",
		jaccardScore: null,
		containmentScore: null,
	};
}

function isAutonomousHandoff(handoffId: string, broker: BrokerLike): boolean {
	const meta = broker.control.getHandoffWithWorkflowMeta?.(handoffId);
	if (!meta?.workflowId || !meta?.chainId) return false;
	const wf = broker.control.getWorkflow?.(meta.workflowId);
	const chain = broker.control.getRelayChain?.(meta.chainId);
	return wf?.status === "running" && chain?.status === "active";
}

export function createMountedTurnOwnedRelay(input: {
	broker: BrokerLike;
	collabId: string;
	currentAgent: AgentType;
	writeLocalMessage: (text: string) => void;
	writeUserInput: (text: string) => void;
	submitUserInput?: (text: string) => Promise<void>;
	openComposer: (args: { prompt: string; initialValue: string }) => Promise<string | null>;
	captureHandbackText?: (
		turnText: string,
	) => Promise<string | CaptureHandbackResult | null>;
	confirmHandbackCapture?: (args: { target: AgentType; text: string }) => Promise<boolean>;
	prefillHandbackFromCapture?: boolean;
	turnCapture?: {
		reset(): void;
		finishAssistantTurn(): void;
		hasVisibleAssistantTurn(): boolean;
		extractLatestAssistantTurn(): { confidence: "high" | "low"; text: string | null };
	};
	isPausedInput?: () => boolean;
	getTerminalCols?: () => number;
	onHandoffAccepted?: () => void;
	/** Max auto-handback capture attempts before delivering an empty handback
	 *  (escalate floor). A single transient empty /copy must not be terminal. */
	autoHandbackMaxAttempts?: number | undefined;
	/** Minimum spacing between auto-handback retries — the 1s idle poll must not
	 *  hammer /copy every tick while a long claude step is briefly idle. */
	autoHandbackRetryMs?: number | undefined;
	/** Protocol-native providers (ai-ezio) hand back via an explicit idle event
	 *  (handbackResolvedContent), so the quiescence /copy auto-handback must be
	 *  skipped. Auto-ACCEPT still runs — it is the delivery path. */
	suppressQuiescenceHandback?: boolean;
	/** Workspace id (sha256 of the canonical worktree root) for turn-event
	 *  diagnostics. Threaded from the mount; only used by handleTurnEvent. */
	workspaceId?: string;
	/** Whether the push-based turn-event path is enabled for this provider
	 *  (claude/codex). Gates the /copy fallback in the suppressed idle branch so
	 *  protocol-native ezio (suppress + no event path) keeps today's hard-return. */
	eventPathEnabled?: boolean;
}) {
	function resolveCols(): number {
		const c = input.getTerminalCols?.() ?? process.stdout.columns;
		return typeof c === "number" && c > 0 ? c : 120;
	}
	const STALE_HANDOFF_AFTER_MS = 5 * 60_000;
	const HAND_BACK_READY_AFTER_MS = 30_000;
	const autoHandbackMaxAttempts = Math.max(1, input.autoHandbackMaxAttempts ?? 3);
	const autoHandbackRetryMs = Math.max(0, input.autoHandbackRetryMs ?? 10_000);
	// Per-handoff retry bookkeeping for the auto-handback empty-capture ladder.
	const autoHandbackAttempts = new Map<
		string,
		{ attempts: number; nextEligibleAt: number }
	>();
	// Synchronous reservation guarding the awaited capture. The mount fires
	// checkIdleActions() on a 1s timer while a capture can take several seconds
	// (clipboard poll + lease wait), so an overlapping tick must not start a second
	// /copy for the same in-flight handoff. (The pre-2026-06-03 one-shot guard, set
	// before the await, used to provide this; the retry ladder records its state
	// only after the await, so it needs an explicit in-flight flag.)
	let autoHandbackInFlight = false;
	let disconnectHandled = false;
	let lastOwnerCardKey: string | null = null;
	let renderedOwnerCardLines = 0;
	let autoAcceptFiredFor: string | null = null;
	let autoHandbackFiredFor: string | null = null;

	// ----- Turn-event gate state (push-based handback, §4.1-4.3) -----------------
	// Per-handoff defer count (fidelity gate): bumped on each rejected/superseded
	// candidate, reported in diagnostics, reset on delivery.
	const turnEventDeferals = new Map<string, number>();
	// Latest clean codex candidate per handoff (settle-on-last). claude delivers on
	// arrival (Stop is structurally the last turn) so it never populates this.
	const heldClean = new Map<
		string,
		{ event: import("./turn-event.js").TurnEvent; containment: number | null }
	>();
	// Sequence backstop: handoffIds expecting their FIRST post-injection turn-event.
	// Populated in acceptPendingHandoff (right after the request is injected) and
	// consumed by the first no-input event in correlateInput, which then treats that
	// turn as the response. Never seeded by the harness, so a unit no-input event is
	// `indeterminate` there.
	const sequenceBackstop = new Set<string>();

	const TURN_EVENT_INPUT_MATCH_MIN = 0.9; // §12 Q3
	const TURN_EVENT_CODEX_CORROBORATION_MIN = 0.5; // §12 Q5 (codex output corroboration)

	type RelevanceState = "relevant" | "positive_mismatch" | "indeterminate";

	// Copy-fallback reservation: a RELAY-INTERNAL one-shot flag (no input callback).
	// The indeterminate (§4.2) and fidelity-exhausted (§4.3) paths arm it; the idle
	// path (checkIdleActions, Task 16) consumes it to release the proven /copy path
	// for one cycle. isCopyFallbackArmed() is a read-only peek exposed on the api for
	// tests; consumeCopyFallbackArmed() reads-and-resets for the idle path.
	let copyFallbackArmed = false;
	function armCopyFallbackOnce(): void {
		copyFallbackArmed = true;
	}
	function consumeCopyFallbackArmed(): boolean {
		const armed = copyFallbackArmed;
		copyFallbackArmed = false;
		return armed;
	}

	function normalizeForMatch(s: string): string {
		return s.trim().replace(/\s+/g, " ").toLowerCase();
	}

	function correlateInput(
		injectedRequest: string,
		handoffId: string,
		event: import("./turn-event.js").TurnEvent,
	): { state: RelevanceState; containment: number | null } {
		const candidates = event.inputMessages.map(normalizeForMatch).filter((s) => s.length > 0);
		const req = normalizeForMatch(injectedRequest);
		if (candidates.length === 0) {
			// No usable input (claude transcript read unavailable AND no event input).
			// Sequence backstop: the FIRST post-injection turn-event for this accepted
			// handoff is the response; consume the flag. Once consumed (or never set), a
			// no-input event is indeterminate → release the proven /copy path.
			if (sequenceBackstop.has(handoffId)) {
				sequenceBackstop.delete(handoffId);
				return { state: "relevant", containment: null };
			}
			return { state: "indeterminate", containment: null };
		}
		for (const c of candidates) {
			if (c === req) return { state: "relevant", containment: 1 };
			const containment = computeContainment(req, c);
			if (containment >= TURN_EVENT_INPUT_MATCH_MIN) return { state: "relevant", containment };
		}
		// Input present but does not match → affirmatively unrelated.
		return { state: "positive_mismatch", containment: computeContainment(req, candidates[0]!) };
	}

	// §4.2 relevance gate. Routes a workflow-gated event into deliver / suppress /
	// release-/copy by input correlation (both providers) and codex output
	// corroboration (codex only — claude's full-screen TUI scrape is lossy).
	async function routeRelevance(
		accepted: RelayHandoff,
		event: import("./turn-event.js").TurnEvent,
	): Promise<void> {
		const { state, containment } = correlateInput(accepted.requestText, accepted.handoffId, event);

		if (state === "positive_mismatch") {
			// Operator-interjection class: suppress, do NOT arm /copy, wait for a later
			// correlated turn. This is the no-false-handback guarantee.
			logTurnEvent(event, "ignored_unrelated_turn", {
				workflowActive: true,
				handoffId: accepted.handoffId,
				inputCorrelated: false,
				containmentScore: containment,
				fidelityVerdict: "n/a",
				deferCount: turnEventDeferals.get(accepted.handoffId) ?? 0,
			});
			return;
		}

		if (state === "indeterminate") {
			logTurnEvent(event, "fallback_indeterminate", {
				workflowActive: true,
				handoffId: accepted.handoffId,
				inputCorrelated: null,
				containmentScore: containment,
				fidelityVerdict: "n/a",
				deferCount: turnEventDeferals.get(accepted.handoffId) ?? 0,
			});
			armCopyFallbackOnce(); // release the proven path for one idle cycle
			return;
		}

		// Relevant. §4.2 codex output corroboration: where a reliable PTY scrape is
		// available (codex), additionally require containment(message, scrape) to clear
		// a threshold. NOT applied to claude — its full-screen TUI scrape is lossy and
		// would false-negative a correct event.
		if (event.provider === "codex") {
			const scraped = input.turnCapture?.extractLatestAssistantTurn?.()?.text ?? "";
			if (scraped.length > 0) {
				const corr = computeContainment(event.message, scraped);
				if (corr < TURN_EVENT_CODEX_CORROBORATION_MIN) {
					logTurnEvent(event, "fallback_indeterminate", {
						workflowActive: true,
						handoffId: accepted.handoffId,
						inputCorrelated: true,
						containmentScore: corr,
						fidelityVerdict: "n/a",
						deferCount: turnEventDeferals.get(accepted.handoffId) ?? 0,
					});
					armCopyFallbackOnce();
					return;
				}
			}
		}

		await acceptCandidate(accepted, event, containment);
	}

	// §4.3 candidate acceptance. claude delivers on arrival (Stop is structurally the
	// last turn); codex holds the latest clean candidate (settle-on-last) and delivers
	// on settleHeldTurnEvent. Task 12 prepends the mid-composition shape guard.
	// eslint-disable-next-line @typescript-eslint/require-await
	async function acceptCandidate(
		accepted: RelayHandoff,
		event: import("./turn-event.js").TurnEvent,
		containment: number | null,
	): Promise<void> {
		if (autoHandbackFiredFor === accepted.handoffId) return;
		const deferCount = turnEventDeferals.get(accepted.handoffId) ?? 0;

		if (event.provider === "claude") {
			// Stop fires once per submitted prompt → the turn IS the final answer.
			deliverClean(accepted, event, containment, deferCount);
			return;
		}
		// codex: settle-on-last. A newer clean completion supersedes the held one.
		const prior = heldClean.get(accepted.handoffId);
		if (prior) {
			const next = deferCount + 1;
			turnEventDeferals.set(accepted.handoffId, next);
			logTurnEvent(prior.event, "deferred_rearmed", {
				workflowActive: true,
				handoffId: accepted.handoffId,
				inputCorrelated: true,
				containmentScore: prior.containment,
				fidelityVerdict: "superseded",
				deferCount: next,
			});
		}
		heldClean.set(accepted.handoffId, { event, containment });
		// Delivery happens on settleHeldTurnEvent (driven by genuine idle, Task 15).
	}

	function deliverClean(
		accepted: RelayHandoff,
		event: import("./turn-event.js").TurnEvent,
		containment: number | null,
		deferCount: number,
	): void {
		if (autoHandbackFiredFor === accepted.handoffId) return;
		autoHandbackFiredFor = accepted.handoffId;
		const now = new Date().toISOString();
		logTurnEvent(event, "delivered", {
			workflowActive: true,
			handoffId: accepted.handoffId,
			inputCorrelated: true,
			containmentScore: containment,
			fidelityVerdict: "clean",
			deferCount,
		});
		input.broker.control.handoffBackRelay?.({
			handoffId: accepted.handoffId,
			nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
			senderAgent: input.currentAgent,
			targetAgent: accepted.senderAgent,
			requestText: event.message,
			captureStatus: "ok",
			now,
		});
		input.turnCapture?.reset();
		turnEventDeferals.delete(accepted.handoffId);
		heldClean.delete(accepted.handoffId);
	}

	// Called by the mount's idle detector when the session goes genuinely idle: the
	// held clean codex candidate (settle-on-last) is delivered.
	function settleHeldTurnEvent(handoffId: string): void {
		const held = heldClean.get(handoffId);
		if (!held) return;
		heldClean.delete(handoffId);
		const accepted = getAcceptedHandoff();
		if (!accepted || accepted.handoffId !== handoffId) return;
		deliverClean(accepted, held.event, held.containment, turnEventDeferals.get(handoffId) ?? 0);
	}

	function logTurnEvent(
		event: import("./turn-event.js").TurnEvent,
		action: TurnEventAction,
		extra: {
			workflowActive: boolean;
			handoffId: string | null;
			inputCorrelated: boolean | null;
			containmentScore: number | null;
			fidelityVerdict: TurnEventFidelityVerdict;
			deferCount: number;
		},
	): void {
		const meta = extra.handoffId
			? (input.broker.control.getHandoffWithWorkflowMeta?.(extra.handoffId) ?? null)
			: null;
		const samplesAllowed = process.env["AI_WHISPER_NO_CAPTURE_SAMPLES"] !== "1";
		try {
			input.broker.control.recordTurnEventDiagnostic?.({
				receivedAt: event.receivedAt,
				provider: event.provider,
				workspaceId: event.workspaceId,
				cwd: event.cwd,
				sessionOrThreadId: event.sessionOrThreadId || null,
				turnId: event.turnId,
				workflowActive: extra.workflowActive,
				collabId: input.collabId,
				workflowId: meta?.workflowId ?? null,
				chainId: meta?.chainId ?? null,
				handoffId: extra.handoffId,
				inputCorrelated: extra.inputCorrelated,
				containmentScore: extra.containmentScore,
				fidelityVerdict: extra.fidelityVerdict,
				deferCount: extra.deferCount,
				action,
				messageLen: event.message.length,
				messageSample: samplesAllowed ? event.message.slice(0, 200) : null,
			});
		} catch (err) {
			console.warn(
				`[ai-whisper] turn-event diagnostic write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	function clearOwnerCard() {
		if (renderedOwnerCardLines === 0) {
			return;
		}

		let control = "";
		for (let index = 0; index < renderedOwnerCardLines; index += 1) {
			control += CLEAR_LINE;
			if (index < renderedOwnerCardLines - 1) {
				control += CURSOR_UP;
			}
		}
		input.writeLocalMessage(control);
		renderedOwnerCardLines = 0;
	}

	function renderOwnerCard(message: string, cardKey: string) {
		if (cardKey === lastOwnerCardKey) {
			return;
		}
		clearOwnerCard();
		lastOwnerCardKey = cardKey;
		const { text, lineCount } = styleOwnerCard(message, resolveCols());
		renderedOwnerCardLines = lineCount;
		input.writeLocalMessage(text);
	}

	function refreshTurnState(now = new Date().toISOString()): RelayTurnState {
		let state = input.broker.control.getRelayTurnState(input.collabId, now);
		if (
			state.unresolvedHandoffId &&
			(state.handoffState === "pending" ||
				state.handoffState === "deferred" ||
				state.handoffState === "accepted") &&
			state.handoffAgeMs !== null &&
			state.handoffAgeMs >= STALE_HANDOFF_AFTER_MS
		) {
			input.broker.control.markRelayHandoffStale?.({
				handoffId: state.unresolvedHandoffId,
				now,
			});
			state = input.broker.control.getRelayTurnState(input.collabId, now);
		}
		return state;
	}

	function getPendingHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.turnOwner !== input.currentAgent) return null;
		if (!state.unresolvedHandoffId) return null;
		const handoff = input.broker.control.getRelayHandoff(state.unresolvedHandoffId);
		if (!handoff) return null;
		if (handoff.status !== "pending" && handoff.status !== "deferred") return null;
		if (handoff.targetAgent !== input.currentAgent) return null;
		// Workflow-pause delivery gate: while the owning workflow is paused, the broker
		// suspends delivery. The mount must not surface (and therefore must not inject)
		// a paused workflow's pending request — the broker-side acceptRelayHandoff gate
		// alone is too late, since the mount injects the request text before calling it.
		// Auto-handback (getAcceptedHandoff) is intentionally NOT gated: recording an
		// in-flight handback while paused is allowed and drives the quiesce boundary.
		if (input.broker.control.isWorkflowDeliverySuspended?.(handoff.handoffId)) {
			return null;
		}
		return handoff;
	}

	function getAcceptedHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.turnOwner !== input.currentAgent) return null;
		if (!state.unresolvedHandoffId) return null;
		const handoff = input.broker.control.getRelayHandoff(state.unresolvedHandoffId);
		if (!handoff) return null;
		if (handoff.status !== "accepted") return null;
		if (handoff.targetAgent !== input.currentAgent) return null;
		return handoff;
	}

	function getAcceptedReadyHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.handoffAgeMs === null || state.handoffAgeMs < HAND_BACK_READY_AFTER_MS) {
			return null;
		}
		const handoff = getAcceptedHandoff();
		if (!handoff) return null;
		if (!input.turnCapture?.hasVisibleAssistantTurn()) return null;
		return handoff;
	}

	function getAcceptedForceableHandoff(): RelayHandoff | null {
		return getAcceptedHandoff();
	}

	async function handleOwnerInput(text: string): Promise<boolean> {
		const pendingHandoff = getPendingHandoff();
		const currentHandoff = pendingHandoff ?? getAcceptedHandoff();
		if (currentHandoff && isAutonomousHandoff(currentHandoff.handoffId, input.broker)) {
			return false; // autonomous mode — broker drives this handoff
		}
		const handoff = pendingHandoff;
		if (handoff) {
			if (text === "a" || text === "A") {
				await api.acceptPendingHandoff();
				return true;
			}
			if (text === "e" || text === "E") {
				await api.amendPendingHandoff();
				return true;
			}
			if (text === "d" || text === "D") {
				api.declinePendingHandoff();
				return true;
			}
			if (text === " ") {
				api.deferPendingHandoff();
				return true;
			}
		}

		const forceable = getAcceptedForceableHandoff();
		if (forceable && text === "\u0008") {
			await api.handBackTo(forceable.senderAgent, { force: true });
			return true;
		}

		const accepted = getAcceptedReadyHandoff();
		if (accepted && (text === "h" || text === "H")) {
			await api.handBackTo(accepted.senderAgent);
			return true;
		}
		return false;
	}

	const api = {
		getWaitingGate() {
			return {
				isBlocked: () => refreshTurnState().waitingAgent === input.currentAgent,
				renderBlockedMessage: () => {
					const state = refreshTurnState();
					const elapsed =
						state.handoffAgeMs === null
							? "0s"
							: `${Math.floor(state.handoffAgeMs / 1000)}s`;
					return `waiting for reply from ${state.turnOwner} (${elapsed})`;
				},
				onCancel: () => {
					const state = refreshTurnState();
					if (state.unresolvedHandoffId) {
						input.broker.control.declineRelayHandoff({
							handoffId: state.unresolvedHandoffId,
							now: new Date().toISOString(),
						});
					}
				},
			};
		},

		refreshOwnerView() {
			const handoff = getPendingHandoff();
			if (handoff) {
				const label = handoff.status === "deferred" ? "Deferred handoff" : "Pending handoff";
				const autonomous = isAutonomousHandoff(handoff.handoffId, input.broker);
				const hint = autonomous
					? "handoff pending (auto-accept)"
					: "[a] accept  [e] amend  [d] decline  [space] defer";
				const cardKey = `${handoff.handoffId}|${handoff.status}|${handoff.requestText}|${autonomous}`;
				renderOwnerCard(
					`[ai-whisper] ${label} from ${handoff.senderAgent}\n${handoff.requestText}\n${hint}`,
					cardKey,
				);
				return;
			}

			const accepted = getAcceptedReadyHandoff();
			if (accepted) {
				const autonomous = isAutonomousHandoff(accepted.handoffId, input.broker);
				if (!autonomous) {
					const cardKey = `${accepted.handoffId}|accepted-ready|${accepted.senderAgent}`;
					renderOwnerCard(
						`[ai-whisper] Ready to hand back to ${accepted.senderAgent}  [h] hand back`,
						cardKey,
					);
					return;
				}
				// Autonomous mode: auto-handback fires within ~1s of readiness; the
				// ready-card has no operator action and would only add noise. Fall
				// through to clearOwnerCard so any prior card is cleaned up.
			}

			clearOwnerCard();
			lastOwnerCardKey = null;
		},

		async acceptPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			input.turnCapture?.reset();
			autoHandbackFiredFor = null;
			if (input.submitUserInput) {
				await input.submitUserInput(handoff.requestText);
			} else {
				submitInjectedInput(input.writeUserInput, handoff.requestText);
			}
			// Seed the turn-event sequence backstop: the FIRST post-injection turn-event
			// for this handoff whose input cannot be read (claude transcript unavailable)
			// is treated as the response (correlateInput consumes this flag once).
			sequenceBackstop.add(handoff.handoffId);
			input.broker.control.acceptRelayHandoff({
				handoffId: handoff.handoffId,
				acceptedAt: new Date().toISOString(),
			});
			input.onHandoffAccepted?.();
		},

		async amendPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			const composed = await input.openComposer({
				prompt: "[ai-whisper] Edit the request text before accepting:",
				initialValue: handoff.requestText,
			});
			if (composed === null) return;
			input.turnCapture?.reset();
			input.writeUserInput(composed);
			input.broker.control.acceptRelayHandoff({
				handoffId: handoff.handoffId,
				acceptedAt: new Date().toISOString(),
			});
		},

		declinePendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			autoAcceptFiredFor = null;
			input.broker.control.declineRelayHandoff({
				handoffId: handoff.handoffId,
				now: new Date().toISOString(),
			});
		},

		deferPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			input.broker.control.deferRelayHandoff({
				handoffId: handoff.handoffId,
				deferredAt: new Date().toISOString(),
			});
		},

		async handBackTo(
			target: AgentType,
			options?: { force?: boolean },
		) {
			const handoff = getAcceptedHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			if (options?.force) {
				input.writeLocalMessage(
					`[ai-whisper] Force handback to ${target}: attempting /copy first`,
				);
			}
			let composed: string | null = null;
			let initialValue = "";
			if (input.captureHandbackText) {
				// Force-handback path: prefill the composer with the captured text.
				// Normalize the structured result (or a legacy string) to a string;
				// a lease degrade yields null text → empty prefill (same as a miss).
				const outcome = (await input.captureHandbackText("")) ?? "";
				const captured = typeof outcome === "string" ? outcome : (outcome.text ?? "");
				if (captured.trim().length > 0 && input.confirmHandbackCapture) {
					const accepted = await input.confirmHandbackCapture({
						target,
						text: captured,
					});
					if (!accepted) {
						return;
					}
					composed = captured;
				} else {
					initialValue = captured;
				}
			} else if (input.prefillHandbackFromCapture !== false) {
				input.turnCapture?.finishAssistantTurn();
				const captured = input.turnCapture?.extractLatestAssistantTurn() ?? { confidence: "low" as const, text: null };
				initialValue = captured.confidence === "high" && captured.text !== null ? captured.text : "";
			}
			if (composed === null) {
				composed = await input.openComposer({
					prompt: `[ai-whisper] Hand back to ${target}`,
					initialValue,
				});
			}
			if (composed === null) {
				if (handoff && isAutonomousHandoff(handoff.handoffId, input.broker)) {
					input.broker.control.applyOrchestratorVerdict?.({
						handoffId: handoff.handoffId,
						verdict: "escalate",
						confidence: 1.0,
						reason: "capture-failure: composer returned null",
						now: new Date().toISOString(),
					});
				}
				return;
			}
			const now = new Date().toISOString();
			input.broker.control.handoffBackRelay?.({
				handoffId: handoff.handoffId,
				nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
				senderAgent: input.currentAgent,
				targetAgent: target,
				requestText: composed,
				now,
			});
			input.turnCapture?.reset();
		},

		/** Protocol-native handback: deliver the authoritative content from the
		 *  explicit idle event directly to the original sender. Uses
		 *  getAcceptedHandoff() (clean state — no age/visible-output heuristics).
		 *  async to mirror the other relay methods / await call sites; body is sync. */
		// eslint-disable-next-line @typescript-eslint/require-await
		async handbackResolvedContent(content: string) {
			const accepted = getAcceptedHandoff();
			if (!accepted) return;
			if (autoHandbackFiredFor === accepted.handoffId) return;
			autoHandbackFiredFor = accepted.handoffId;
			const now = new Date().toISOString();
			input.broker.control.handoffBackRelay?.({
				handoffId: accepted.handoffId,
				nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
				senderAgent: input.currentAgent,
				targetAgent: accepted.senderAgent,
				requestText: content,
				captureStatus: "ok",
				now,
			});
			input.turnCapture?.reset();
		},

		/** Push-based turn-completion handback gate (§4.1-4.3). Routes a normalized
		 *  TurnEvent through the workflow gate, then (Task 11) the relevance gate and
		 *  (Task 12) the fidelity gate. Every received event writes exactly one
		 *  relay_turn_event_diagnostics row via logTurnEvent. */
		async handleTurnEvent(event: import("./turn-event.js").TurnEvent): Promise<void> {
			// §4.1 workflow gate: deliver only when an accepted, autonomous handoff is
			// awaiting handback for this collab and the handback has not already fired.
			const accepted = getAcceptedHandoff();
			const autonomous = accepted
				? isAutonomousHandoff(accepted.handoffId, input.broker)
				: false;
			if (accepted === null || autoHandbackFiredFor === accepted.handoffId || !autonomous) {
				logTurnEvent(event, "ignored_no_workflow", {
					workflowActive: false,
					handoffId: accepted?.handoffId ?? null,
					inputCorrelated: null,
					containmentScore: null,
					fidelityVerdict: "n/a",
					deferCount: 0,
				});
				return;
			}
			// §4.2 relevance gate (+ §4.3 fidelity gate inside acceptCandidate).
			await routeRelevance(accepted, event);
		},

		/** Deliver a held clean codex candidate once the session settles (idle). */
		settleHeldTurnEvent(handoffId: string): void {
			settleHeldTurnEvent(handoffId);
		},

		/** Read-only peek for tests/diagnostics — does NOT reset the armed flag. */
		isCopyFallbackArmed(): boolean {
			return copyFallbackArmed;
		},

		async checkIdleActions() {
			// Auto-accept: pending (not deferred) handoff, guard not set, not paused.
			// Autonomous handoffs (workflow=running, chain=active) also flow through
			// this path: the broker has no PTY handle, so the mount pane is the only
			// process that can inject the request text into the agent's prompt.
			const pending = getPendingHandoff();
			if (
				pending !== null &&
				pending.status === "pending" &&
				autoAcceptFiredFor !== pending.handoffId &&
				!(input.isPausedInput?.() ?? false)
			) {
				autoAcceptFiredFor = pending.handoffId;
				await api.acceptPendingHandoff();
				return;
			}

			// Protocol-native sessions resolve handback from the explicit idle event
			// (handbackResolvedContent); auto-accept above already delivered the
			// request, so skip the /copy quiescence handback below.
			if (input.suppressQuiescenceHandback) return;

			// Auto-handback: accepted handoff, guard not set, not paused. Same
			// rationale as auto-accept — autonomous mode runs through this path so
			// the orchestrator can evaluate the captured handback verdict.
			const accepted = getAcceptedHandoff();
			if (
				accepted === null ||
				autoHandbackFiredFor === accepted.handoffId ||
				(input.isPausedInput?.() ?? false)
			) {
				return;
			}

			// Retry-on-empty ladder (Mode C fix, 2026-06-03). The auto-handback used
			// to fire exactly once (autoHandbackFiredFor set here, before the capture
			// result was known), so a single transient empty /copy on a long claude
			// step delivered an empty handback and permanently halted the workflow.
			// We now spread up to autoHandbackMaxAttempts captures across idle ticks,
			// spaced by autoHandbackRetryMs, and only burn the one-shot guard once we
			// either capture a real handback or exhaust the budget (escalate floor).
			const retryState = autoHandbackAttempts.get(accepted.handoffId) ?? {
				attempts: 0,
				nextEligibleAt: 0,
			};
			if (Date.now() < retryState.nextEligibleAt) {
				return; // within spacing window — don't hammer /copy on the 1s poll
			}

			// Reserve synchronously BEFORE the awaited capture so a concurrent 1s
			// timer tick cannot start a second /copy for this in-flight handoff.
			// (retryState is only updated after the await, so the checks above do not
			// protect against overlap on their own.) try/finally guarantees release
			// on every exit — retry return, race-guard abort, delivery, or a throw.
			if (autoHandbackInFlight) return;
			autoHandbackInFlight = true;
			try {

			// Always extract turn text before attempting clipboard capture — must run even if clipboard throws.
			// finishAssistantTurn clears the streaming flag so extractLatestAssistantTurn
			// can return high-confidence text; without this call it always returns low/null.
			input.turnCapture?.finishAssistantTurn();
			const turnResult: { confidence: "high" | "low"; text: string | null } =
				input.turnCapture?.extractLatestAssistantTurn() ?? { confidence: "low", text: null };

			// Diagnostic: trace every auto-handback entry so the operator can see in the
			// mount pane WHEN the capture pipeline fires, on which handoff, and what
			// turn state it has to work with. Pairs with the lease-degrade / swallowed-
			// exception warns below to expose the silent-exit bug observed 2026-05-29.
			console.warn(
				`[ai-whisper] auto-handback fire: target=${input.currentAgent} handoff=${accepted.handoffId} turnLen=${(turnResult.text ?? "").length} turnConf=${turnResult.confidence}`,
			);

			let clipboardText: string | null = null;
			let leaseDegraded = false;
			let interferenceDetected = false;
			// True only for a CLEAN captured result whose clip was empty (the
			// read-before-write race signature — bug 2026-06-08). Deliberately NOT set
			// for a lease degrade (which delivers the PTY fallback), an exception, or a
			// null short-circuit — those have their own established handling and must
			// not be folded into the empty-clip retry.
			let cleanCaptureEmpty = false;
			try {
				const captureResult =
					(await input.captureHandbackText?.(turnResult.text ?? "")) ?? null;
				if (typeof captureResult === "string") {
					clipboardText = captureResult; // legacy / direct text
				} else if (captureResult !== null) {
					interferenceDetected = captureResult.interferenceDetected;
					if (captureResult.status === "captured") {
						clipboardText = captureResult.text;
						cleanCaptureEmpty = (captureResult.text ?? "").trim().length === 0;
					} else {
						leaseDegraded = true; // degraded_pty_only (timeout or persistent interference)
						console.warn(
							`[ai-whisper] capture lease degraded: target=${input.currentAgent} handoff=${accepted.handoffId} interference=${interferenceDetected} — /copy was NOT executed; PTY fallback only`,
						);
					}
				} else {
					// captureHandbackText returned null (e.g. mount-session-main's
					// !resolvedClaim early-return). Surface it explicitly — otherwise
					// looks identical to "no clipboard change" downstream.
					console.warn(
						`[ai-whisper] capture pipeline returned null: target=${input.currentAgent} handoff=${accepted.handoffId} — captureHandbackText short-circuited (likely no session claim)`,
					);
				}
			} catch (err) {
				// Surface the swallowed error — silent-swallow here was the root cause
				// of the 2026-05-29 halts where codex produced a real review but the
				// orchestrator received an empty handback with no diagnostic clue why.
				clipboardText = null;
				const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
				console.warn(
					`[ai-whisper] capture pipeline threw (swallowed): target=${input.currentAgent} handoff=${accepted.handoffId}\n${msg}`,
				);
			}

			const classification = classifyCapture(turnResult, clipboardText);
			const captureStatus = classification.status;
			let requestText = captureStatus === "ok" ? (clipboardText ?? "") : "";

			// Spec: a lease degrade (acquire timeout or persistent human interference)
			// falls back to the PTY turn text rather than delivering an empty handback.
			if (leaseDegraded && (turnResult.text ?? "").trim().length > 0) {
				requestText = turnResult.text as string;
			}

			// Retry-on-empty (Mode C): if we captured *nothing* — neither clipboard
			// nor a PTY fallback (captureStatus === "no_response_captured") — and the
			// attempt budget is not yet spent, schedule another attempt on a later
			// idle tick instead of delivering an empty (workflow-halting) handback.
			// Leaving autoHandbackFiredFor unset lets the next tick re-fire;
			// nextEligibleAt spaces the retries. The final attempt falls through to
			// deliver an empty handback (the genuine-failure escalate floor).
			const capturedNothing = captureStatus === "no_response_captured";
			// Bug 2026-06-06: a confident no-match against HIGH-confidence current-phase
			// turn text means the captured clip is stale/prior-turn content — the agent
			// is still echoing this phase's request and has not yet produced its
			// response. Re-running /copy on a later tick will capture different
			// (matching) content, so retry rather than burning the one-shot guard on
			// stale content. classifyCapture only populates jaccardScore on this
			// high-confidence similarity path; a null-score confident-miss is the Mode A
			// claude-TUI case (agent already replied but PTY can't validate it) and must
			// NOT retry — re-/copy would just re-capture the identical reply.
			const staleAgainstCurrentTurn =
				captureStatus === "no_response_captured_confidently" &&
				classification.jaccardScore !== null;
			// Bug 2026-06-08 (wf_292cb0933def440b): a CLEAN captured result whose clip was
			// EMPTY, paired with non-empty HIGH-confidence turn chrome, classifies as
			// no_response_captured_confidently (jaccardScore null — there is no clip to
			// score), landing in the same bucket as the Mode A no-retry case. But an empty
			// clip from a clean capture is a read-before-write race (the /copy had not landed
			// yet), not a definitive no-response: retry rather than burning the one-shot guard
			// on an empty handback that escalates/halts the gate. Scoped to cleanCaptureEmpty
			// so it stays distinct from (a) Mode A, which has a PRESENT short clip — re-/copy
			// would just re-capture the identical reply; (b) a lease degrade, which already
			// delivers the PTY fallback; and (c) an exception/null short-circuit.
			const emptyClipConfidentMiss =
				captureStatus === "no_response_captured_confidently" &&
				cleanCaptureEmpty;
			if (
				(capturedNothing || staleAgainstCurrentTurn || emptyClipConfidentMiss) &&
				retryState.attempts + 1 < autoHandbackMaxAttempts
			) {
				retryState.attempts += 1;
				retryState.nextEligibleAt = Date.now() + autoHandbackRetryMs;
				autoHandbackAttempts.set(accepted.handoffId, retryState);
				console.warn(
					`[ai-whisper] auto-handback empty capture — retrying: target=${input.currentAgent} handoff=${accepted.handoffId} attempt=${retryState.attempts}/${autoHandbackMaxAttempts}`,
				);
				return;
			}

			// Terminal: we have a real handback, or the retry budget is exhausted.
			// Burn the one-shot guard and stop tracking retries for this handoff.
			autoHandbackFiredFor = accepted.handoffId;
			autoHandbackAttempts.delete(accepted.handoffId);

			// Evaluate race guard synchronously so the diagnostic row carries the correct flag.
			const currentAcceptedId = getAcceptedHandoff()?.handoffId;
			const abortedByRaceGuard = currentAcceptedId !== accepted.handoffId;

			// Pull workflow/chain context for diagnostics (best-effort; nullable in the row).
			const handoffMeta = input.broker.control.getHandoffWithWorkflowMeta?.(accepted.handoffId) ?? null;
			const samplesAllowed = process.env["AI_WHISPER_NO_CAPTURE_SAMPLES"] !== "1";
			const sampleOf = (text: string | null): string | null => {
				if (text === null) return null;
				if (!samplesAllowed) return null;
				return text.slice(0, 200);
			};

			const now = new Date().toISOString();
			try {
				input.broker.control.recordCaptureDiagnostic?.({
					handoffId: accepted.handoffId,
					collabId: input.collabId,
					chainId: handoffMeta?.chainId ?? null,
					workflowId: handoffMeta?.workflowId ?? null,
					targetProvider: input.currentAgent,
					captureStatus,
					clipLen: (clipboardText ?? "").length,
					turnLen: (turnResult.text ?? "").length,
					turnConfidence: turnResult.confidence,
					jaccardScore: classification.jaccardScore,
					containmentScore: classification.containmentScore,
					clipSample: sampleOf(clipboardText),
					turnSample: sampleOf(turnResult.text),
					abortedByRaceGuard,
					interferenceDetected,
					now,
				});
			} catch (err) {
				// Diagnostics are observability — never block the relay path.
				console.warn(
					`[ai-whisper] capture diagnostic write failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (process.env["AI_WHISPER_DEBUG_CAPTURE"]) {
				const { writeFileSync } = await import("node:fs");
				writeFileSync(
					process.env["AI_WHISPER_DEBUG_CAPTURE"],
					JSON.stringify({
						captureStatus,
						jaccardScore: classification.jaccardScore,
						containmentScore: classification.containmentScore,
						turnTextLen: (turnResult.text ?? "").length,
						clipLen: (clipboardText ?? "").length,
						turnText: turnResult.text,
						clipText: clipboardText,
					}, null, 2),
					"utf8",
				);
			}

			if (abortedByRaceGuard) return;

			input.broker.control.handoffBackRelay?.({
				handoffId: accepted.handoffId,
				nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
				senderAgent: input.currentAgent,
				targetAgent: accepted.senderAgent,
				requestText,
				captureStatus,
				now,
			});
			input.turnCapture?.reset();
			} finally {
				autoHandbackInFlight = false;
			}
		},

		handleOwnerDisconnect() {
			if (disconnectHandled) return;
			disconnectHandled = true;
			const state = input.broker.control.getRelayTurnState(input.collabId);
			if (state.turnOwner !== input.currentAgent) {
				return;
			}
			if (!state.unresolvedHandoffId) {
				return;
			}
			input.broker.control.failRelayHandoffOnDisconnect?.({
				handoffId: state.unresolvedHandoffId,
				now: new Date().toISOString(),
			});
			input.writeLocalMessage(
				`[ai-whisper] Mounted ${input.currentAgent} session disconnected during unresolved handoff.`,
			);
		},
		handleOwnerInput,
	};

	return api;
}
