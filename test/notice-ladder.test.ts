import { describe, expect, it } from "vitest";
import type { NoticePathState } from "../packages/broker/src/index.ts";
import { decideNoticeStep } from "../packages/cli/src/runtime/notice-ladder.ts";

const CAP = 900_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T = Date.parse("2026-04-21T00:00:00Z");
const NOW = T + 10 * 60_000;

function state(overrides: Partial<NoticePathState> = {}): NoticePathState {
	return {
		deliveryPath: "notice",
		noticeSentAt: iso(T),
		reminderSentAt: null,
		nudgeSentAt: null,
		fetchedAt: null,
		capturePath: null,
		repliedAt: null,
		replyRefusedAt: null,
		turnDoneAt: null,
		...overrides,
	};
}

// Quiet period began at `quietSince`, gate passing.
function decide(
	s: NoticePathState,
	opts: { quietSince?: number; gatePassing?: boolean; strict?: boolean; nowMs?: number } = {},
) {
	const nowMs = opts.nowMs ?? NOW;
	return decideNoticeStep({
		handoffId: "ho_1",
		state: s,
		idle: {
			gatePassing: opts.gatePassing ?? true,
			idleElapsedMs: nowMs - (opts.quietSince ?? T + 1000),
		},
		nowMs,
		capMs: CAP,
		strict: opts.strict ?? false,
	});
}

describe("decideNoticeStep", () => {
	it("row 1: not a notice-path handoff, replied, or captured is none", () => {
		expect(decide(state({ deliveryPath: "paste" }))).toEqual({ kind: "none" });
		expect(decide(state({ deliveryPath: null }))).toEqual({ kind: "none" });
		expect(decide(state({ repliedAt: iso(T + 5) }))).toEqual({ kind: "none" });
		expect(decide(state({ capturePath: "copy" }))).toEqual({ kind: "none" });
	});

	it("row 2: unfetched, no reminder, idle window after notice sends a reminder", () => {
		expect(decide(state())).toEqual({ kind: "reminder" });
	});

	it("row 3: unfetched after a reminder, idle window after it falls back to paste", () => {
		const s = state({ reminderSentAt: iso(T + 60_000) });
		expect(decide(s, { quietSince: T + 120_000 })).toEqual({ kind: "paste_fallback" });
	});

	it("row 3 strict: paste fallback becomes escalate", () => {
		const s = state({ reminderSentAt: iso(T + 60_000) });
		expect(decide(s, { quietSince: T + 120_000, strict: true })).toEqual({
			kind: "escalate",
			reason: "strict mode: paste fallback suppressed (handoff ho_1)",
		});
	});

	it("row 4: unfetched with no window elapsed is none", () => {
		expect(decide(state(), { gatePassing: false })).toEqual({ kind: "none" });
		const s = state({ reminderSentAt: iso(T + 60_000) });
		expect(decide(s, { quietSince: T + 30_000 })).toEqual({ kind: "none" });
	});

	it("row 5: refused reply with idle window after the refusal falls back to copy", () => {
		const s = state({ fetchedAt: iso(T + 1000), replyRefusedAt: iso(T + 2000) });
		expect(decide(s, { quietSince: T + 3000 })).toEqual({ kind: "copy_fallback" });
	});

	it("row 5 strict: copy fallback becomes escalate", () => {
		const s = state({ fetchedAt: iso(T + 1000), replyRefusedAt: iso(T + 2000) });
		expect(decide(s, { quietSince: T + 3000, strict: true })).toEqual({
			kind: "escalate",
			reason: "strict mode: copy fallback suppressed (handoff ho_1)",
		});
	});

	it("row 6: turn done since fetch, idle window after turn done nudges", () => {
		const s = state({ fetchedAt: iso(T + 1000), turnDoneAt: iso(T + 2000) });
		expect(decide(s, { quietSince: T + 3000 })).toEqual({ kind: "nudge" });
	});

	it("row 7: no turn done, idle at least the cap and window after fetch nudges", () => {
		const s = state({ fetchedAt: iso(T + 1000) });
		const nowMs = T + 20 * 60_000;
		expect(decide(s, { nowMs, quietSince: nowMs - CAP })).toEqual({ kind: "nudge" });
	});

	it("row 8: nudged, turn done since fetch, idle window after nudge falls back to copy", () => {
		const s = state({
			fetchedAt: iso(T + 1000),
			turnDoneAt: iso(T + 2000),
			nudgeSentAt: iso(T + 3000),
		});
		expect(decide(s, { quietSince: T + 4000 })).toEqual({ kind: "copy_fallback" });
	});

	it("row 8 strict: copy fallback becomes escalate", () => {
		const s = state({
			fetchedAt: iso(T + 1000),
			turnDoneAt: iso(T + 2000),
			nudgeSentAt: iso(T + 3000),
		});
		expect(decide(s, { quietSince: T + 4000, strict: true })).toEqual({
			kind: "escalate",
			reason: "strict mode: copy fallback suppressed (handoff ho_1)",
		});
	});

	it("row 9: nudged, no turn done, idle window after nudge escalates", () => {
		const s = state({ fetchedAt: iso(T + 1000), nudgeSentAt: iso(T + 3000) });
		expect(decide(s, { quietSince: T + 4000 })).toEqual({
			kind: "escalate",
			reason: "no reply and no turn done after 15 min idle (handoff ho_1)",
		});
	});

	it("row 9 is not altered by strict mode", () => {
		const s = state({ fetchedAt: iso(T + 1000), nudgeSentAt: iso(T + 3000) });
		expect(decide(s, { quietSince: T + 4000, strict: true }).kind).toBe("escalate");
		expect(
			(decide(s, { quietSince: T + 4000, strict: true }) as { reason: string }).reason,
		).toContain("no reply and no turn done");
	});

	it("row 10: fetched and nothing due is none", () => {
		const s = state({ fetchedAt: iso(T + 1000), nudgeSentAt: iso(T + 3000) });
		expect(decide(s, { quietSince: T + 3000, gatePassing: false })).toEqual({ kind: "none" });
		expect(decide(state({ fetchedAt: iso(T + 1000) }), { quietSince: NOW - 1000 })).toEqual({
			kind: "none",
		});
	});

	it("operator activity after a step resets that step's window", () => {
		// quiet period began before the notice was sent: operator typed after, not yet
		expect(decide(state(), { quietSince: T - 1 })).toEqual({ kind: "none" });
		expect(decide(state(), { quietSince: T })).toEqual({ kind: "reminder" });
	});

	it("a background-subagent wait shorter than the cap never nudges", () => {
		const s = state({ fetchedAt: iso(T + 1000) });
		const nowMs = T + 20 * 60_000;
		expect(decide(s, { nowMs, quietSince: nowMs - (CAP - 1) })).toEqual({ kind: "none" });
	});

	it("a turn done from before the fetch does not count", () => {
		const s = state({ fetchedAt: iso(T + 5000), turnDoneAt: iso(T + 1000) });
		// would nudge via row 6 if it counted; row 7 needs the cap
		expect(decide(s, { quietSince: T + 6000 })).toEqual({ kind: "none" });
		const nudged = { ...s, nudgeSentAt: iso(T + 7000) };
		expect(decide(nudged, { quietSince: T + 8000 }).kind).toBe("escalate");
	});

	it("unparseable required timestamps never match", () => {
		expect(decide(state({ noticeSentAt: null }))).toEqual({ kind: "none" });
		expect(decide(state({ noticeSentAt: "garbage" }))).toEqual({ kind: "none" });
		const s = state({ fetchedAt: iso(T + 1000), turnDoneAt: "garbage" });
		expect(decide(s, { quietSince: T + 3000 })).toEqual({ kind: "none" });
	});
});
