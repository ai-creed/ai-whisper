import { describe, expect, it } from "vitest";
import {
	analyzeTurn,
	applyFreshnessFloor,
	captureCursorHandback,
	extractLastAssistantText,
	extractLastUserText,
	pickByPrompt,
	selectTranscript,
	type CursorCaptureTrace,
	type TranscriptRef,
} from "../packages/cli/src/runtime/cursor-transcript-capture.ts";

const userLine = (text: string) =>
	JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const assistantLine = (...texts: string[]) =>
	JSON.stringify({
		role: "assistant",
		message: { content: texts.map((text) => ({ type: "text", text })) },
	});
const toolCallLine = () =>
	JSON.stringify({
		role: "assistant",
		message: { content: [{ type: "tool_call", name: "shell", args: {} }] },
	});
const turnEndedLine = () => JSON.stringify({ type: "turn_ended", status: "success" });

/** A completed turn: user prompt, assistant reply, turn_ended marker. */
const completedTurn = (text: string) =>
	[userLine("ask"), assistantLine(text), turnEndedLine()].join("\n");

/** A completed turn with an explicit user prompt (for prompt-anchored selection). */
const completedTurnFor = (prompt: string, answer: string) =>
	[userLine(prompt), assistantLine(answer), turnEndedLine()].join("\n");

describe("extractLastAssistantText", () => {
	it("returns the assistant text after the last user entry", () => {
		const jsonl = [
			userLine("first ask"),
			assistantLine("first answer"),
			userLine("second ask"),
			assistantLine("second answer"),
			turnEndedLine(),
		].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe("second answer");
	});

	it("joins multiple assistant text blocks of the turn", () => {
		const jsonl = [
			userLine("ask"),
			assistantLine("planning the change"),
			toolCallLine(),
			assistantLine("done", "here is the summary"),
			turnEndedLine(),
		].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe(
			"planning the change\ndone\nhere is the summary",
		);
	});

	it("excludes assistant text that precedes the last user entry", () => {
		const jsonl = [
			assistantLine("stale answer from a prior turn"),
			userLine("new ask"),
			toolCallLine(),
		].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe("");
	});

	it("skips malformed lines", () => {
		const jsonl = [userLine("ask"), "{not json", assistantLine("ok")].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe("ok");
	});
});

describe("analyzeTurn (completion gating)", () => {
	it("marks a turn complete when a turn_ended marker follows the last user entry", () => {
		const a = analyzeTurn(completedTurn("the answer"));
		expect(a).toEqual({ hasAssistant: true, turnEnded: true, text: "the answer" });
	});

	it("marks a turn in-flight when the last entry is a user prompt (no assistant yet)", () => {
		const a = analyzeTurn([assistantLine("prev"), userLine("new ask")].join("\n"));
		expect(a.hasAssistant).toBe(false);
		expect(a.turnEnded).toBe(false);
		expect(a.text).toBe("");
	});

	it("reports assistant text present but turn not ended (mid-turn)", () => {
		const a = analyzeTurn([userLine("ask"), assistantLine("partial so far")].join("\n"));
		expect(a.hasAssistant).toBe(true);
		expect(a.turnEnded).toBe(false);
		expect(a.text).toBe("partial so far");
	});

	it("marks a tool-call-only completed turn as ended with empty text", () => {
		const a = analyzeTurn([userLine("ask"), toolCallLine(), turnEndedLine()].join("\n"));
		expect(a).toEqual({ hasAssistant: true, turnEnded: true, text: "" });
	});
});

describe("selectTranscript", () => {
	const refs: TranscriptRef[] = [
		{ path: "/newest.jsonl", mtimeMs: 300 },
		{ path: "/middle.jsonl", mtimeMs: 200 },
		{ path: "/oldest.jsonl", mtimeMs: 100 },
	];

	it("picks the transcript whose assistant text matches turnText, not just the newest", () => {
		const files: Record<string, string> = {
			"/newest.jsonl": completedTurn("totally unrelated content here"),
			"/middle.jsonl": completedTurn("the implementer added the hello world helper and tests"),
			"/oldest.jsonl": completedTurn("ancient"),
		};
		const turnText = "the implementer added the hello world helper and tests, all passing";
		const picked = selectTranscript({ refs, turnText, readFile: (p) => files[p] ?? "" });
		expect(picked?.path).toBe("/middle.jsonl");
	});

	it("falls back to the newest-mtime transcript when turnText is empty", () => {
		const files: Record<string, string> = {
			"/newest.jsonl": completedTurn("newest answer"),
			"/middle.jsonl": completedTurn("middle answer"),
			"/oldest.jsonl": completedTurn("oldest answer"),
		};
		const picked = selectTranscript({ refs, turnText: "", readFile: (p) => files[p] ?? "" });
		expect(picked?.path).toBe("/newest.jsonl");
	});
});

describe("captureCursorHandback (turn_ended-gated)", () => {
	const noSleep = async () => {};
	const refs: TranscriptRef[] = [{ path: "/a.jsonl", mtimeMs: 1 }];

	it("captures the assistant text once the turn has ended", async () => {
		const lastDelivered: { hash: string | null } = { hash: null };
		const result = await captureCursorHandback({
			turnText: "implemented the feature cleanly",
			lastDelivered,
			listTranscripts: () => refs,
			readFile: () => completedTurn("implemented the feature cleanly"),
			sleep: noSleep,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("implemented the feature cleanly");
		expect(lastDelivered.hash).not.toBeNull();
	});

	it("returns timed_out (for the relay's retry ladder) while the turn is still in flight", async () => {
		// Transcript's last entry is a user prompt — the agent hasn't responded yet.
		const inFlight = [assistantLine("prev turn"), userLine("the new fix prompt")].join("\n");
		const result = await captureCursorHandback({
			turnText: "",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: () => inFlight,
			sleep: noSleep,
			budgetMs: 300,
			pollIntervalMs: 100, // → 3 polls, all in-flight
		});
		expect(result.status).toBe("timed_out");
		expect(result.text).toBeNull();
	});

	it("captures once turn_ended appears across polls (in-flight, then complete)", async () => {
		const inFlight = [userLine("ask"), assistantLine("working on it")].join("\n");
		const done = [userLine("ask"), assistantLine("all done, added hello.py")].join("\n") + "\n" + turnEndedLine();
		let call = 0;
		const result = await captureCursorHandback({
			turnText: "all done, added hello.py",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			// first read mid-turn (no marker), then the turn_ended flush.
			readFile: () => (++call >= 3 ? done : inFlight),
			sleep: noSleep,
			budgetMs: 5000,
			pollIntervalMs: 100,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("all done, added hello.py");
	});

	it("treats a stable assistant response without a turn_ended marker as complete", async () => {
		// Some turns may not emit turn_ended; identical text across stabilityPolls reads => done.
		const stable = [userLine("ask"), assistantLine("final answer, no marker")].join("\n");
		const result = await captureCursorHandback({
			turnText: "final answer, no marker",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: () => stable,
			sleep: noSleep,
			budgetMs: 5000,
			pollIntervalMs: 100,
			stabilityPolls: 2,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("final answer, no marker");
	});

	it("reports no-response (captured null) for a completed tool-call-only turn", async () => {
		const result = await captureCursorHandback({
			turnText: "x",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: () => [userLine("ask"), toolCallLine(), turnEndedLine()].join("\n"),
			sleep: noSleep,
			budgetMs: 5000,
			pollIntervalMs: 100,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
	});

	it("dedupes against the last delivered handback even when the turn has ended", async () => {
		const text = "same answer as before";
		const seed: { hash: string | null } = { hash: null };
		await captureCursorHandback({
			turnText: text,
			lastDelivered: seed,
			listTranscripts: () => refs,
			readFile: () => completedTurn(text),
			sleep: noSleep,
		});
		const priorHash = seed.hash;
		const result = await captureCursorHandback({
			turnText: text,
			lastDelivered: seed,
			listTranscripts: () => refs,
			readFile: () => completedTurn(text),
			sleep: noSleep,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
		expect(seed.hash).toBe(priorHash);
	});

	it("degrades to PTY-only when no transcript exists at all", async () => {
		const result = await captureCursorHandback({
			turnText: "x",
			lastDelivered: { hash: null },
			listTranscripts: () => [],
			readFile: () => "",
			sleep: noSleep,
			budgetMs: 300,
			pollIntervalMs: 100,
		});
		expect(result.status).toBe("degraded_pty_only");
		expect(result.text).toBeNull();
	});
});

describe("extractLastUserText", () => {
	it("returns the text of the last user entry", () => {
		const jsonl = [
			userLine("stale prior prompt"),
			assistantLine("prior answer"),
			userLine("the delivered instruction"),
			assistantLine("working"),
		].join("\n");
		expect(extractLastUserText(jsonl)).toBe("the delivered instruction");
	});

	it("returns empty string when there is no user entry", () => {
		expect(extractLastUserText(assistantLine("only assistant"))).toBe("");
	});
});

describe("pickByPrompt", () => {
	const refs: TranscriptRef[] = [
		{ path: "/newest.jsonl", mtimeMs: 300 },
		{ path: "/match.jsonl", mtimeMs: 200 },
		{ path: "/old.jsonl", mtimeMs: 100 },
	];
	const files: Record<string, string> = {
		"/newest.jsonl": completedTurnFor("implement the parser refactor please", "did parser"),
		"/match.jsonl": completedTurnFor("add a hello world helper with tests", "added hello.py and tests"),
		"/old.jsonl": completedTurnFor("ancient unrelated request", "old answer"),
	};
	const readFile = (p: string) => files[p] ?? "";

	it("picks the transcript whose last user entry matches the expected prompt, not the newest", () => {
		const r = pickByPrompt({
			refs,
			expectedPrompt: "add a hello world helper with tests, everything passing",
			readFile,
		});
		expect(r.pick?.path).toBe("/match.jsonl");
		expect(r.pick?.analysis.text).toBe("added hello.py and tests");
	});

	it("reports candidate and matched counts", () => {
		const r = pickByPrompt({
			refs,
			expectedPrompt: "add a hello world helper with tests",
			readFile,
		});
		expect(r.candidateCount).toBe(3);
		expect(r.matchedCount).toBe(1);
	});

	it("returns a null pick when no user entry matches the expected prompt", () => {
		const r = pickByPrompt({
			refs,
			expectedPrompt: "something entirely different concerning telemetry dashboards",
			readFile,
		});
		expect(r.pick).toBeNull();
		expect(r.matchedCount).toBe(0);
	});
});

describe("applyFreshnessFloor", () => {
	it("drops refs older than promptDeliveredAtMs minus clockSkew", () => {
		const refs: TranscriptRef[] = [
			{ path: "/fresh.jsonl", mtimeMs: 1000 },
			{ path: "/stale.jsonl", mtimeMs: 100 },
		];
		const out = applyFreshnessFloor(refs, 900, 200); // floor = 700
		expect(out.map((r) => r.path)).toEqual(["/fresh.jsonl"]);
	});

	it("returns all refs when promptDeliveredAtMs is undefined", () => {
		const refs: TranscriptRef[] = [
			{ path: "/a.jsonl", mtimeMs: 1 },
			{ path: "/b.jsonl", mtimeMs: 2 },
		];
		expect(applyFreshnessFloor(refs, undefined, 200)).toEqual(refs);
	});
});

describe("captureCursorHandback (prompt-anchored + freshness + trace)", () => {
	const noSleep = async () => {};

	it("captures the assistant text of the expectedPrompt-matching transcript, not the newest", async () => {
		const refs: TranscriptRef[] = [
			{ path: "/newest.jsonl", mtimeMs: 300 },
			{ path: "/match.jsonl", mtimeMs: 200 },
		];
		const files: Record<string, string> = {
			"/newest.jsonl": completedTurnFor("do the unrelated refactor task", "unrelated answer"),
			"/match.jsonl": completedTurnFor(
				"apply the hotfix to the auth module",
				"applied the auth hotfix, tests green",
			),
		};
		const result = await captureCursorHandback({
			turnText: "", // PTY scrape unreliable for the TUI
			expectedPrompt: "apply the hotfix to the auth module now",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: (p) => files[p] ?? "",
			sleep: noSleep,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("applied the auth hotfix, tests green");
	});

	it("ignores a matching but stale transcript below the freshness floor", async () => {
		const refs: TranscriptRef[] = [{ path: "/stale.jsonl", mtimeMs: 100 }];
		const files: Record<string, string> = {
			"/stale.jsonl": completedTurnFor("apply the hotfix to the auth module", "stale answer"),
		};
		const result = await captureCursorHandback({
			turnText: "",
			expectedPrompt: "apply the hotfix to the auth module",
			promptDeliveredAtMs: 10_000,
			clockSkewMs: 1_000, // floor 9000 > 100 → excluded
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: (p) => files[p] ?? "",
			sleep: noSleep,
			budgetMs: 300,
			pollIntervalMs: 100,
		});
		expect(result.status).toBe("degraded_pty_only");
		expect(result.text).toBeNull();
	});

	it("emits a trace breadcrumb on capture", async () => {
		const refs: TranscriptRef[] = [{ path: "/match.jsonl", mtimeMs: 200 }];
		const files: Record<string, string> = {
			"/match.jsonl": completedTurnFor("apply the hotfix to the auth module", "applied the auth hotfix"),
		};
		const traces: CursorCaptureTrace[] = [];
		const result = await captureCursorHandback({
			turnText: "",
			expectedPrompt: "apply the hotfix to the auth module",
			lastDelivered: { hash: null },
			listTranscripts: () => refs,
			readFile: (p) => files[p] ?? "",
			sleep: noSleep,
			onTrace: (t) => traces.push(t),
		});
		expect(result.status).toBe("captured");
		expect(traces).toHaveLength(1);
		expect(traces[0]).toMatchObject({
			candidateCount: 1,
			matchedCount: 1,
			chosenPath: "/match.jsonl",
			status: "captured",
		});
		expect(traces[0]!.textLen).toBeGreaterThan(0);
	});
});
