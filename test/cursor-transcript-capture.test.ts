import { describe, expect, it } from "vitest";
import {
	captureCursorHandback,
	extractLastAssistantText,
	selectTranscript,
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

describe("extractLastAssistantText", () => {
	it("returns the assistant text after the last user entry", () => {
		const jsonl = [
			userLine("first ask"),
			assistantLine("first answer"),
			userLine("second ask"),
			assistantLine("second answer"),
		].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe("second answer");
	});

	it("joins multiple assistant text blocks of the turn", () => {
		const jsonl = [
			userLine("ask"),
			assistantLine("planning the change"),
			toolCallLine(),
			assistantLine("done", "here is the summary"),
		].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe(
			"planning the change\ndone\nhere is the summary",
		);
	});

	it("returns empty string for a tool-call-only turn", () => {
		const jsonl = [userLine("ask"), toolCallLine()].join("\n");
		expect(extractLastAssistantText(jsonl)).toBe("");
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

	it("returns empty string for empty input", () => {
		expect(extractLastAssistantText("")).toBe("");
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
			"/newest.jsonl": [userLine("q"), assistantLine("totally unrelated content here")].join("\n"),
			"/middle.jsonl": [
				userLine("q"),
				assistantLine("the implementer added the hello world helper and tests"),
			].join("\n"),
			"/oldest.jsonl": [userLine("q"), assistantLine("ancient")].join("\n"),
		};
		const turnText =
			"the implementer added the hello world helper and tests, all passing";
		const picked = selectTranscript({ refs, turnText, readFile: (p) => files[p] ?? "" });
		expect(picked?.path).toBe("/middle.jsonl");
		expect(picked?.text).toContain("hello world helper");
	});

	it("falls back to the newest-mtime transcript when turnText is empty", () => {
		const files: Record<string, string> = {
			"/newest.jsonl": [userLine("q"), assistantLine("newest answer")].join("\n"),
			"/middle.jsonl": [userLine("q"), assistantLine("middle answer")].join("\n"),
			"/oldest.jsonl": [userLine("q"), assistantLine("oldest answer")].join("\n"),
		};
		const picked = selectTranscript({ refs, turnText: "", readFile: (p) => files[p] ?? "" });
		expect(picked?.path).toBe("/newest.jsonl");
	});

	it("returns null when no transcript has assistant text", () => {
		const files: Record<string, string> = {
			"/newest.jsonl": [userLine("q"), toolCallLine()].join("\n"),
			"/middle.jsonl": "",
			"/oldest.jsonl": [userLine("q"), toolCallLine()].join("\n"),
		};
		expect(selectTranscript({ refs, turnText: "x", readFile: (p) => files[p] ?? "" })).toBeNull();
	});
});

describe("captureCursorHandback", () => {
	const noSleep = async () => {};

	function deliveredText(text: string) {
		return [userLine("ask"), assistantLine(text)].join("\n");
	}

	it("captures the matching transcript's assistant text and updates the freshness marker", async () => {
		const refs: TranscriptRef[] = [{ path: "/a.jsonl", mtimeMs: 1 }];
		const lastDelivered: { hash: string | null } = { hash: null };
		const result = await captureCursorHandback({
			turnText: "implemented the feature cleanly",
			lastDelivered,
			listTranscripts: () => refs,
			readFile: () => deliveredText("implemented the feature cleanly"),
			sleep: noSleep,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("implemented the feature cleanly");
		expect(lastDelivered.hash).not.toBeNull();
	});

	it("degrades to PTY-only when no transcript exists", async () => {
		const lastDelivered: { hash: string | null } = { hash: null };
		const result = await captureCursorHandback({
			turnText: "x",
			lastDelivered,
			listTranscripts: () => [],
			readFile: () => "",
			sleep: noSleep,
			settleAttempts: 2,
		});
		expect(result.status).toBe("degraded_pty_only");
		expect(result.text).toBeNull();
	});

	it("reports no-response (captured null) for a tool-call-only turn", async () => {
		const refs: TranscriptRef[] = [{ path: "/a.jsonl", mtimeMs: 1 }];
		const lastDelivered: { hash: string | null } = { hash: null };
		const result = await captureCursorHandback({
			turnText: "x",
			lastDelivered,
			listTranscripts: () => refs,
			readFile: () => [userLine("ask"), toolCallLine()].join("\n"),
			sleep: noSleep,
			settleAttempts: 2,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
	});

	it("dedupes against the last delivered handback (no re-delivery of the prior turn)", async () => {
		const text = "same answer as before";
		const refs: TranscriptRef[] = [{ path: "/a.jsonl", mtimeMs: 1 }];
		// Pre-seed the marker with the hash of the text the transcript will yield.
		const seed: { hash: string | null } = { hash: null };
		await captureCursorHandback({
			turnText: text,
			lastDelivered: seed,
			listTranscripts: () => refs,
			readFile: () => deliveredText(text),
			sleep: noSleep,
		});
		const priorHash = seed.hash;

		const result = await captureCursorHandback({
			turnText: text,
			lastDelivered: seed,
			listTranscripts: () => refs,
			readFile: () => deliveredText(text),
			sleep: noSleep,
			settleAttempts: 2,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBeNull();
		expect(seed.hash).toBe(priorHash); // marker unchanged on a duplicate
	});

	it("recovers a late transcript flush via the settle poll", async () => {
		const refs: TranscriptRef[] = [{ path: "/a.jsonl", mtimeMs: 1 }];
		let call = 0;
		const result = await captureCursorHandback({
			turnText: "delivered after a flush delay",
			lastDelivered: { hash: null },
			// First poll: nothing on disk yet. Second poll: the transcript appears.
			listTranscripts: () => (++call >= 2 ? refs : []),
			readFile: () => deliveredText("delivered after a flush delay"),
			sleep: noSleep,
			settleAttempts: 3,
		});
		expect(result.status).toBe("captured");
		expect(result.text).toBe("delivered after a flush delay");
	});
});
