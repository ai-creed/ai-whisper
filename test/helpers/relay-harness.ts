import type { TurnEventAction } from "@ai-whisper/broker";
import { createMountedTurnOwnedRelay } from "../../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

type AcceptedHandoff = {
	handoffId: string;
	senderAgent: string;
	targetAgent: string;
	requestText: string;
	collabId: string;
	status: "accepted";
} | null;

type RecordedTurnEventDiagnostic = {
	action: TurnEventAction;
	workflowActive: boolean;
	fidelityVerdict: string;
	inputCorrelated: boolean | null;
	containmentScore: number | null;
	deferCount: number;
};

/**
 * Shared harness for the relay turn-event gate tests (Tasks 10-12, 16).
 *
 * It mirrors the EXACT `createMountedTurnOwnedRelay` input contract observed in
 * the sibling relay tests (e.g. `test/pty-idle-auto-handback.test.ts`): the
 * broker control exposes `getRelayTurnState`/`getRelayHandoff` so the relay's
 * `getAcceptedHandoff()` resolves a non-null accepted handoff, plus the
 * `getHandoffWithWorkflowMeta`/`getWorkflow`/`getRelayChain` trio that
 * `isAutonomousHandoff()` consults. It also captures `handoffBackRelay` and
 * `recordTurnEventDiagnostic` calls for assertions.
 *
 * The additional fields this feature introduces are `workspaceId`,
 * `eventPathEnabled`, the `recordTurnEventDiagnostic` recorder, the
 * `turnCapture.extractLatestAssistantTurn` scrape stub (codex output
 * corroboration), and the `captureHandbackText`/`copyText` `/copy` stub (the
 * no-event fallback regression in Task 16). The copy-fallback-armed state is
 * RELAY-INTERNAL — tests observe it via `relay.isCopyFallbackArmed()`.
 */
export function makeRelayHarness(opts: {
	acceptedHandoff: AcceptedHandoff;
	autonomous?: boolean;
	scrapedTurnText?: string;
	copyText?: string | null;
}) {
	const handoffBackCalls: Array<{ requestText: string; captureStatus?: string }> = [];
	const turnEventDiagnostics: RecordedTurnEventDiagnostic[] = [];

	const handoff = opts.acceptedHandoff;
	const collabId = handoff?.collabId ?? "c";
	const handoffId = handoff?.handoffId ?? "hf_none";
	const currentAgent = (handoff?.targetAgent ?? "claude") as "claude";

	const control = {
		getRelayTurnState: (_collabId: string, _now?: string) => ({
			collabId,
			turnOwner: currentAgent,
			waitingAgent: "codex" as const,
			unresolvedHandoffId: handoff ? handoffId : null,
			handoffState: (handoff ? "accepted" : "idle") as
				| "idle"
				| "pending"
				| "deferred"
				| "accepted"
				| "stale_handoff"
				| "failed",
			handoffAgeMs: handoff ? 60_000 : null,
		}),
		getRelayHandoff: (_id: string) => handoff,
		acceptRelayHandoff: (_input: { handoffId: string; acceptedAt: string }) => {},
		declineRelayHandoff: (_input: { handoffId: string; now: string }) => {},
		deferRelayHandoff: (_input: { handoffId: string; deferredAt: string }) => {},
		markRelayHandoffStale: (_input: { handoffId: string; now: string }) => {},
		getHandoffWithWorkflowMeta: (_id: string) =>
			opts.autonomous === false
				? { workflowId: null, chainId: null }
				: { workflowId: "wf", chainId: "ch" },
		getWorkflow: (_id: string) => ({ status: opts.autonomous === false ? "idle" : "running" }),
		getRelayChain: (_id: string) => ({ status: opts.autonomous === false ? "done" : "active" }),
		handoffBackRelay: (i: { requestText: string; captureStatus?: string }) => handoffBackCalls.push(i),
		recordCaptureDiagnostic: (_i: unknown) => ({ captureId: "cap_1" }),
		recordTurnEventDiagnostic: (i: RecordedTurnEventDiagnostic) => {
			turnEventDiagnostics.push(i);
			return { eventId: `tevt_${turnEventDiagnostics.length}` };
		},
	};

	// turnCapture stub: extractLatestAssistantTurn returns the configured scrape so
	// codex output corroboration (computeContainment(message, scrapedTurnText)) is
	// exercisable. Empty scrape → corroboration is skipped (no reliable scrape).
	const turnCapture = {
		reset: () => {},
		finishAssistantTurn: () => {},
		hasVisibleAssistantTurn: () => true,
		extractLatestAssistantTurn: () => ({
			text: opts.scrapedTurnText ?? "",
			confidence: "high" as const,
		}),
	};

	const input = {
		currentAgent,
		collabId,
		workspaceId: "ws",
		eventPathEnabled: true,
		suppressQuiescenceHandback: true,
		broker: { control },
		writeLocalMessage: (_text: string) => {},
		writeUserInput: (_text: string) => {},
		openComposer: async (_args: { prompt: string; initialValue: string }) => null,
		turnCapture,
		// `/copy` capture stub for the no-event fallback regression (Task 16): returns
		// the configured clipboard text. With copyText ≈ scrapedTurnText, the relay's
		// internal classifyCapture yields "ok" and the auto-handback delivers.
		captureHandbackText: async (_turnText: string) => opts.copyText ?? null,
		isPausedInput: () => false,
	} as unknown as Parameters<typeof createMountedTurnOwnedRelay>[0];

	return { input, handoffBackCalls, turnEventDiagnostics };
}
