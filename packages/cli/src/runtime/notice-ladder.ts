import type { NoticePathState } from "@ai-whisper/broker";

export type NoticeAction =
	| { kind: "none" }
	| { kind: "reminder" }
	| { kind: "paste_fallback" }
	| { kind: "nudge" }
	| { kind: "copy_fallback" }
	| { kind: "escalate"; reason: string };

export type NoticeStepInput = {
	handoffId: string;
	state: NoticePathState;
	idle: { gatePassing: boolean; idleElapsedMs: number };
	nowMs: number;
	capMs: number;
	strict: boolean;
};

const NONE: NoticeAction = { kind: "none" };

// Pure ladder decision for a notice-path handoff. The first matching row wins.
export function decideNoticeStep(input: NoticeStepInput): NoticeAction {
	return applyStrictMode(decideRow(input), input.handoffId, input.strict);
}

// Strict mode (D10): a paste or /copy fallback escalates instead.
export function applyStrictMode(
	action: NoticeAction,
	handoffId: string,
	strict: boolean,
): NoticeAction {
	if (!strict) return action;
	if (action.kind === "paste_fallback") {
		return {
			kind: "escalate",
			reason: `strict mode: paste fallback suppressed (handoff ${handoffId})`,
		};
	}
	if (action.kind === "copy_fallback") {
		return {
			kind: "escalate",
			reason: `strict mode: copy fallback suppressed (handoff ${handoffId})`,
		};
	}
	return action;
}

function decideRow(input: NoticeStepInput): NoticeAction {
	const { state, idle, nowMs, capMs, handoffId } = input;

	// A window after T passes when the idle gate passes and the current quiet
	// period began at or after T. A missing or unparseable T never matches.
	const windowAfter = (iso: string | null): boolean => {
		if (!idle.gatePassing) return false;
		const t = parseMs(iso);
		return t !== null && nowMs - idle.idleElapsedMs >= t;
	};

	const fetchedMs = parseMs(state.fetchedAt);
	const turnDoneMs = parseMs(state.turnDoneAt);
	const turnDoneSinceFetch = fetchedMs !== null && turnDoneMs !== null && turnDoneMs > fetchedMs;

	if (state.deliveryPath !== "notice" || state.repliedAt || state.capturePath) return NONE;

	if (state.fetchedAt === null) {
		if (state.reminderSentAt === null && windowAfter(state.noticeSentAt)) {
			return { kind: "reminder" };
		}
		if (state.reminderSentAt !== null && windowAfter(state.reminderSentAt)) {
			return { kind: "paste_fallback" };
		}
		return NONE;
	}

	if (state.replyRefusedAt && windowAfter(state.replyRefusedAt)) return { kind: "copy_fallback" };

	if (state.nudgeSentAt === null) {
		if (turnDoneSinceFetch && windowAfter(state.turnDoneAt)) return { kind: "nudge" };
		if (
			!turnDoneSinceFetch &&
			idle.gatePassing &&
			idle.idleElapsedMs >= capMs &&
			windowAfter(state.fetchedAt)
		) {
			return { kind: "nudge" };
		}
		return NONE;
	}

	if (windowAfter(state.nudgeSentAt)) {
		if (turnDoneSinceFetch) return { kind: "copy_fallback" };
		return {
			kind: "escalate",
			reason: `no reply and no turn done after ${Math.round(capMs / 60000)} min idle (handoff ${handoffId})`,
		};
	}
	return NONE;
}

function parseMs(iso: string | null): number | null {
	if (iso === null) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}
