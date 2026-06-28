import { describe, expect, it } from "vitest";
import { parseCursorOutput } from "../packages/adapter-cursor/src/parse-cursor-output.ts";

/** Build a Cursor `--output-format json` envelope around a `result` string. */
function envelope(result: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		duration_ms: 100,
		duration_api_ms: 100,
		result,
		session_id: "sess",
		request_id: "req",
		...overrides,
	});
}

describe("parseCursorOutput", () => {
	it("parses a structured provider reply carried in result", () => {
		const stdout = envelope(
			'{"kind":"answer","content":"ok","transitionIntent":"completed"}',
		);

		expect(parseCursorOutput(stdout)).toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("recovers a structured reply that the model wrapped in prose / code fences", () => {
		const stdout = envelope(
			'Sure!\n```json\n{"kind":"review","content":"lgtm","transitionIntent":"awaiting_user"}\n```',
		);

		expect(parseCursorOutput(stdout)).toEqual({
			kind: "review",
			content: "lgtm",
			transitionIntent: "awaiting_user",
		});
	});

	it("wraps a plain-text result as an answer reply", () => {
		const stdout = envelope("just some prose, no json");

		expect(parseCursorOutput(stdout)).toEqual({
			kind: "answer",
			content: "just some prose, no json",
			transitionIntent: null,
		});
	});

	it("tolerates an unknown usage field in the envelope", () => {
		const stdout = envelope(
			'{"kind":"answer","content":"ok","transitionIntent":null}',
			{ usage: { inputTokens: 7, outputTokens: 3 } },
		);

		expect(parseCursorOutput(stdout)).toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: null,
		});
	});

	it("returns failure when the envelope reports an error", () => {
		const stdout = envelope("partial", { is_error: true, subtype: "error" });

		expect(parseCursorOutput(stdout).kind).toBe("failure");
	});

	it("returns failure when subtype is not success", () => {
		const stdout = envelope("x", { subtype: "max_turns" });

		expect(parseCursorOutput(stdout).kind).toBe("failure");
	});

	it("returns failure when result is empty", () => {
		const stdout = envelope("   ");

		expect(parseCursorOutput(stdout).kind).toBe("failure");
	});

	it("returns failure when stdout is not valid JSON", () => {
		expect(parseCursorOutput("not json at all").kind).toBe("failure");
	});

	it("returns failure on empty stdout", () => {
		expect(parseCursorOutput("").kind).toBe("failure");
	});
});
