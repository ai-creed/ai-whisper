// test/resume-seed.test.ts
import { describe, expect, it } from "vitest";
import {
	composeResumeSeedText,
	readResumeSeedMarker,
	SEED_DIGEST_LINE_CAP,
	SEED_HANDBACK_HEAD_KEEP,
	SEED_HANDBACK_TAIL_KEEP,
	SEED_MESSAGE_CAP,
	SEED_PREAMBLE_HEADER,
	SEED_TOTAL_BUDGET,
	type ResumeSeedMarker,
} from "../packages/broker/src/control/resume-seed.ts";

function marker(overrides: Partial<ResumeSeedMarker> = {}): ResumeSeedMarker {
	return {
		phaseIndex: 2,
		resumedAt: "2026-07-23T10:00:00Z",
		haltReason: "max-rounds-reached (5/5)",
		chainId: "relay_ch_abc",
		message: null,
		...overrides,
	};
}

describe("readResumeSeedMarker", () => {
	it("round-trips a valid marker and rejects junk", () => {
		const m = marker();
		expect(readResumeSeedMarker({ resumeSeed: m })).toEqual(m);
		expect(readResumeSeedMarker({})).toBeNull();
		expect(readResumeSeedMarker({ resumeSeed: null })).toBeNull();
		expect(readResumeSeedMarker({ resumeSeed: "nope" })).toBeNull();
		expect(readResumeSeedMarker({ resumeSeed: { phaseIndex: "2" } })).toBeNull();
	});
});

describe("composeResumeSeedText — sections", () => {
	it("full seed: preamble, exact halt reason, final handback, digest, message, commit range — in order", () => {
		const text = composeResumeSeedText({
			marker: marker({ message: "focus on the flaky test" }),
			rounds: [
				{ roundNumber: 1, step: "review", verdict: "findings", handbackText: "r1 first line\nr1 rest" },
				{ roundNumber: 2, step: "review", verdict: "escalate", handbackText: "final handback body" },
			],
			commitBase: "aaaa111",
		});
		expect(text).toContain(SEED_PREAMBLE_HEADER);
		expect(text).toContain("Halt reason: max-rounds-reached (5/5)");
		expect(text).toContain("Final handback from the halted attempt");
		expect(text).toContain("final handback body");
		expect(text).toContain("Prior rounds");
		expect(text).toContain("round 1 review [findings]: r1 first line");
		expect(text).not.toContain("r1 rest"); // digest is first-line only
		expect(text).toContain("Operator message (verbatim)");
		expect(text).toContain("focus on the flaky test");
		expect(text).toContain("aaaa111..HEAD");
		expect(text).toContain("Ignore any commit hashes quoted in prior handbacks");
		// Order: preamble < halt reason < final handback < digest < message < commit range
		const idx = (s: string) => text.indexOf(s);
		expect(idx(SEED_PREAMBLE_HEADER)).toBeLessThan(idx("Halt reason:"));
		expect(idx("Halt reason:")).toBeLessThan(idx("Final handback"));
		expect(idx("Final handback")).toBeLessThan(idx("Prior rounds"));
		expect(idx("Prior rounds")).toBeLessThan(idx("Operator message"));
		expect(idx("Operator message")).toBeLessThan(idx("Commit range"));
	});

	it("absent data produces no section — no-chain seed has only preamble + halt reason + message", () => {
		const text = composeResumeSeedText({
			marker: marker({ chainId: null, message: "try again" }),
			rounds: [],
			commitBase: null,
		});
		expect(text).toContain(SEED_PREAMBLE_HEADER);
		expect(text).toContain("Halt reason:");
		expect(text).toContain("try again");
		expect(text).not.toContain("Final handback");
		expect(text).not.toContain("Prior rounds");
		expect(text).not.toContain("Commit range");
	});

	it("no message → no operator section; single round → no digest section", () => {
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [{ roundNumber: 1, step: "review", verdict: "escalate", handbackText: "only" }],
			commitBase: null,
		});
		expect(text).not.toContain("Operator message");
		expect(text).not.toContain("Prior rounds");
		expect(text).toContain("only");
	});

	it("terminal round captured EMPTY: final section omitted, earlier handbacks stay in digest", () => {
		// Empty handbacks are valid persisted state (handoffBackRelayTxn writes
		// requestText verbatim). The final-handback section belongs to the terminal
		// round only — never backfilled from an earlier round.
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [
				{ roundNumber: 1, step: "review", verdict: "findings", handbackText: "reviewer found X" },
				{ roundNumber: 1, step: "fix", verdict: null, handbackText: "fixed X partially" },
				{ roundNumber: 2, step: "review", verdict: "escalate", handbackText: "" },
			],
			commitBase: null,
		});
		expect(text).not.toContain("Final handback");
		expect(text).toContain("Prior rounds");
		expect(text).toContain("round 1 fix [findings]: fixed X partially");
	});

	it("terminal handback never captured (null), no earlier handbacks: no final, no digest", () => {
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [{ roundNumber: 1, step: "review", verdict: "escalate", handbackText: null }],
			commitBase: null,
		});
		expect(text).not.toContain("Final handback");
		expect(text).not.toContain("Prior rounds");
		expect(text).toContain("Halt reason:");
	});

	it("one digest line per ROUND: review+fix handbacks sharing a round collapse to one line", () => {
		// findings→fix continuations keep the same round number (createContinuationHandoff
		// with incrementRound: false), so one logical round can carry two handbacks.
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [
				{ roundNumber: 1, step: "review", verdict: "findings", handbackText: "reviewer found X" },
				{ roundNumber: 1, step: "fix", verdict: null, handbackText: "fixed X partially" },
				{ roundNumber: 2, step: "review", verdict: "escalate", handbackText: "final" },
			],
			commitBase: null,
		});
		const digestLines = text.split("\n").filter((l) => l.startsWith("round 1 "));
		expect(digestLines).toHaveLength(1);
		expect(digestLines[0]).toContain("fixed X partially"); // the round's LATEST handback supplies the line
		expect(digestLines[0]).toContain("[findings]"); // verdict inherited from the round's review handoff
		expect(text).not.toContain("reviewer found X");
	});
});

describe("composeResumeSeedText — §2a caps", () => {
	it("handback over cap keeps exactly head 8000 + tail 4000 source chars around an elision marker", () => {
		const big = "H".repeat(9000) + "M".repeat(2000) + "T".repeat(5000); // 16000 chars
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [{ roundNumber: 1, step: "review", verdict: "escalate", handbackText: big }],
			commitBase: null,
		});
		const head = big.slice(0, SEED_HANDBACK_HEAD_KEEP);
		const tail = big.slice(big.length - SEED_HANDBACK_TAIL_KEEP);
		expect(text).toContain(head);
		expect(text).toContain(tail);
		expect(text).toContain("characters elided");
		expect(text).not.toContain("H".repeat(SEED_HANDBACK_HEAD_KEEP + 1));
	});

	it("message over cap is tail-truncated with a marker; retained source = cap", () => {
		const big = "x".repeat(SEED_MESSAGE_CAP + 500);
		const text = composeResumeSeedText({
			marker: marker({ message: big }),
			rounds: [],
			commitBase: null,
		});
		expect(text).toContain("x".repeat(SEED_MESSAGE_CAP));
		expect(text).not.toContain("x".repeat(SEED_MESSAGE_CAP + 1));
		expect(text).toContain("characters truncated");
	});

	it("digest line over 200 chars keeps exactly 200 composed-line chars + inline tail marker", () => {
		const longFirst = "L".repeat(260);
		const text = composeResumeSeedText({
			marker: marker(),
			rounds: [
				{ roundNumber: 1, step: "review", verdict: "findings", handbackText: `${longFirst}\nrest` },
				{ roundNumber: 2, step: "review", verdict: "escalate", handbackText: "final" },
			],
			commitBase: null,
		});
		const line = text.split("\n").find((l) => l.startsWith("round 1 "))!;
		const kept = line.split(" [... ")[0] ?? "";
		expect(kept.length).toBe(SEED_DIGEST_LINE_CAP); // retained composed-line chars = exactly the cap
		expect(line).toContain("characters truncated]"); // inline marker — the round stays one physical line
		expect(line).not.toContain("rest");
	});

	it("total over budget drops oldest digest rounds first, notes the omission, stays under budget, and is deterministic", () => {
		const rounds = Array.from({ length: 300 }, (_, i) => ({
			roundNumber: i + 1,
			step: "review",
			verdict: "findings",
			handbackText: `round ${i + 1} ` + "d".repeat(190),
		}));
		rounds.push({ roundNumber: 301, step: "review", verdict: "escalate", handbackText: "f".repeat(12_500) });
		const input = { marker: marker({ message: "m".repeat(4_200) }), rounds, commitBase: "aaaa111" };
		const a = composeResumeSeedText(input);
		const b = composeResumeSeedText(input);
		expect(a).toBe(b); // byte-identical on repeat composition
		expect(a.length).toBeLessThanOrEqual(SEED_TOTAL_BUDGET);
		expect(a).toContain("digest truncated");
		expect(a).toContain("round 300"); // newest digest rounds survive
		expect(a).not.toContain("round 1 review"); // oldest dropped first
	});
});
