import type { NoticePathState } from "@ai-whisper/broker";
import type { AgentType } from "@ai-whisper/shared";
import { decideNoticeStep } from "./notice-ladder.js";
import { buildNoticeLine, type NoticeKind } from "./notice-text.js";

export type NoticeRelayHandoff = {
	handoffId: string;
	status: string;
};

export type NoticeWorkflowMeta = {
	workflowId: string | null;
	chainId: string | null;
	phaseName?: string | null;
	handoffStep?: string | null;
	roundNumber?: number | null;
};

export type NoticeBrokerLike = {
	control: {
		getRelayHandoff(handoffId: string): NoticeRelayHandoff | null;
		getHandoffWithWorkflowMeta?(handoffId: string): NoticeWorkflowMeta | null;
		getWorkflow?(id: string): { status: string } | null;
		getNoticePathState?(handoffId: string): NoticePathState | null;
		claimWorkflowNotice?(input: { handoffId: string; now: string }): { claimed: boolean };
		claimNoticeStep?(input: {
			handoffId: string;
			kind: "reminder" | "nudge";
			now: string;
		}): boolean;
		escalateNoticeHandoff?(input: { handoffId: string; reason: string; now: string }): {
			action: string;
		};
	};
};

export type NoticePathDriverDeps = {
	broker: NoticeBrokerLike;
	currentAgent: AgentType;
	strict: boolean;
	capMs: number;
	writeLocalMessage(text: string): void;
	submitUserInput(text: string): Promise<void>;
	pasteFallback(handoffId: string): Promise<void>;
	copyFallback(handoffId: string): Promise<void>;
	now(): Date;
	/** Runs after the broker claims the initial notice and before it is typed,
	 *  so the relay can keep its accept-time bookkeeping coherent. */
	onNoticeClaimed?(handoffId: string): void;
};

export type NoticeIdleTick = {
	pending: NoticeRelayHandoff | null;
	accepted: NoticeRelayHandoff | null;
	idleElapsedMs: number;
	gatePassing: boolean;
};

export type NoticePathDriver = ReturnType<typeof createNoticePathDriver>;

const ESCALATION_RETRY_MS = 30_000;

/** Pane line for the owner card while a notice-path handoff waits for idle. */
export function buildQueuedLine(handoffId: string, meta: NoticeWorkflowMeta | null): string {
	const phase = meta?.phaseName ?? "-";
	const step = meta?.handoffStep ?? "-";
	const round = meta?.roundNumber ?? null;
	return `[ai-whisper] ${handoffId} queued · ${phase} ${step} r${round === null ? "-" : round} · delivering when idle`;
}

export function createNoticePathDriver(deps: NoticePathDriverDeps) {
	const control = deps.broker.control;
	// Handoffs whose fetch/reply the mount still reports on. In memory only: a
	// restarted mount re-adopts an accepted notice handoff on its next tick.
	const watched = new Set<string>();
	const fetchedShown = new Set<string>();
	const escalated = new Set<string>();
	// A throwing escalation stays retryable, but at most once per back-off
	// window, and each distinct error is logged once per handoff.
	const escalationRetryAt = new Map<string, number>();
	const escalationErrorsLogged = new Map<string, Set<string>>();
	let inFlight = false;

	function writeLine(text: string): void {
		deps.writeLocalMessage(`[ai-whisper] ${text}\r\n`);
	}

	function isNoticeHandoff(handoffId: string): boolean {
		return control.getNoticePathState?.(handoffId)?.deliveryPath === "notice";
	}

	// A pending handoff takes the notice path when it belongs to a running
	// workflow (claimWorkflowNotice re-checks atomically). Manual handoffs, and
	// handoffs of a workflow that is not running, stay on today's paste path.
	function usesNoticePath(handoffId: string): boolean {
		if (!control.claimWorkflowNotice || !control.getNoticePathState) return false;
		const meta = control.getHandoffWithWorkflowMeta?.(handoffId);
		if (!meta?.workflowId) return false;
		return control.getWorkflow?.(meta.workflowId)?.status === "running";
	}

	function typedLine(kind: NoticeKind, handoffId: string): string {
		const meta = control.getHandoffWithWorkflowMeta?.(handoffId) ?? null;
		return buildNoticeLine({
			kind,
			handoffId,
			workflowId: meta?.workflowId ?? "-",
			phaseName: meta?.phaseName ?? null,
			roundNumber: meta?.roundNumber ?? null,
		});
	}

	function observeWatched(): void {
		for (const handoffId of watched) {
			const state = control.getNoticePathState?.(handoffId) ?? null;
			if (state === null) {
				watched.delete(handoffId);
				continue;
			}
			if (state.fetchedAt !== null && !fetchedShown.has(handoffId)) {
				fetchedShown.add(handoffId);
				writeLine(`${handoffId} fetched ✓`);
			}
			if (state.capturePath === "reply") {
				writeLine(`${handoffId} handed back ✓ (reply)`);
				watched.delete(handoffId);
				continue;
			}
			const status = control.getRelayHandoff(handoffId)?.status;
			if (state.capturePath !== null || (status !== "pending" && status !== "accepted")) {
				watched.delete(handoffId);
			}
		}
	}

	async function deliverNotice(handoffId: string): Promise<void> {
		const { claimed } = control.claimWorkflowNotice!({
			handoffId,
			now: deps.now().toISOString(),
		});
		// Not claimed: another tick or process owns this handoff.
		if (!claimed) return;
		watched.add(handoffId);
		deps.onNoticeClaimed?.(handoffId);
		await deps.submitUserInput(typedLine("notice", handoffId));
		writeLine(`${handoffId} notice sent`);
	}

	async function runLadder(handoffId: string, tick: NoticeIdleTick): Promise<void> {
		watched.add(handoffId);
		const state = control.getNoticePathState?.(handoffId) ?? null;
		if (state === null || escalated.has(handoffId)) return;
		const meta = control.getHandoffWithWorkflowMeta?.(handoffId) ?? null;
		// A paused or halted workflow types nothing and escalates nothing.
		if (!meta?.workflowId || control.getWorkflow?.(meta.workflowId)?.status !== "running") {
			return;
		}
		const now = deps.now();
		const action = decideNoticeStep({
			handoffId,
			state,
			idle: { gatePassing: tick.gatePassing, idleElapsedMs: tick.idleElapsedMs },
			nowMs: now.getTime(),
			capMs: deps.capMs,
			strict: deps.strict,
		});
		switch (action.kind) {
			case "none":
				return;
			case "reminder":
			case "nudge": {
				// Claim before typing: a lost claim means another process typed it.
				const claimed =
					control.claimNoticeStep?.({ handoffId, kind: action.kind, now: now.toISOString() }) ??
					false;
				if (claimed) await deps.submitUserInput(typedLine(action.kind, handoffId));
				return;
			}
			case "paste_fallback":
				await deps.pasteFallback(handoffId);
				return;
			case "copy_fallback":
				await deps.copyFallback(handoffId);
				return;
			case "escalate": {
				const retryAt = escalationRetryAt.get(handoffId);
				if (retryAt !== undefined && now.getTime() < retryAt) return;
				let result: { action: string } | undefined;
				try {
					// Ends the handoff (terminal status) and halts the workflow in one
					// broker transaction.
					result = control.escalateNoticeHandoff?.({
						handoffId,
						reason: action.reason,
						now: now.toISOString(),
					});
				} catch (err) {
					escalationRetryAt.set(handoffId, now.getTime() + ESCALATION_RETRY_MS);
					const message = err instanceof Error ? err.message : String(err);
					const logged = escalationErrorsLogged.get(handoffId) ?? new Set<string>();
					escalationErrorsLogged.set(handoffId, logged);
					if (!logged.has(message)) {
						logged.add(message);
						console.warn(
							`[ai-whisper] notice-path escalation failed: target=${deps.currentAgent} handoff=${handoffId}: ${message} (retrying every ${ESCALATION_RETRY_MS / 1000} s)`,
						);
					}
					return;
				}
				// Recorded only once the call returns: a throw leaves the handoff
				// retryable on a later tick.
				escalated.add(handoffId);
				escalationRetryAt.delete(handoffId);
				escalationErrorsLogged.delete(handoffId);
				if (result === undefined || result.action.startsWith("noop-")) return;
				writeLine(
					action.reason.startsWith("strict mode:")
						? `⚠ ${handoffId} ${action.reason}`
						: `⚠ ${handoffId} no reply and no turn done — escalating for operator review`,
				);
				return;
			}
		}
	}

	return {
		isNoticeHandoff,
		usesNoticePath,

		/** Drives one idle tick. Returns true when the notice path owned the tick,
		 *  so the relay must not run its legacy accept/capture for it. */
		async onIdleTick(tick: NoticeIdleTick): Promise<boolean> {
			observeWatched();
			const pending =
				tick.pending !== null && usesNoticePath(tick.pending.handoffId) ? tick.pending : null;
			const accepted =
				tick.accepted !== null && isNoticeHandoff(tick.accepted.handoffId) ? tick.accepted : null;
			if (pending === null && accepted === null) return false;
			if (!tick.gatePassing || inFlight) return true;
			inFlight = true;
			try {
				if (pending !== null) await deliverNotice(pending.handoffId);
				else if (accepted !== null) await runLadder(accepted.handoffId, tick);
			} catch (err) {
				// Prefer under-delivery: a failed step is recovered by the ladder.
				console.warn(
					`[ai-whisper] notice-path tick failed: target=${deps.currentAgent} handoff=${(pending ?? accepted)!.handoffId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				inFlight = false;
			}
			return true;
		},
	};
}
