import { describe, expect, it } from "vitest";
import { StreamUsageAccumulator } from "../eval/runner/arms/stream-usage.ts";

const asst = (id: string, inp: number, out: number) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: inp, output_tokens: out, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } });

describe("StreamUsageAccumulator", () => {
	it("sums assistant usage, deduplicating repeated message ids", () => {
		const a = new StreamUsageAccumulator();
		a.feed(asst("m1", 10, 1));
		a.feed(asst("m1", 10, 5)); // same message, later block → replaces
		a.feed(asst("m2", 20, 2));
		expect(a.usage).toEqual({ inputTokens: 30, outputTokens: 7, cacheWriteTokens: 2, cacheReadTokens: 4 });
	});
	it("prefers the result event's usage and cost when present", () => {
		const a = new StreamUsageAccumulator();
		a.feed(asst("m1", 10, 1));
		a.feed(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.42, num_turns: 3, usage: { input_tokens: 11, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
		expect(a.sawResult).toBe(true);
		expect(a.resultCostUsd).toBe(0.42);
		expect(a.numTurns).toBe(3);
		expect(a.finalUsage()).toEqual({ inputTokens: 11, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 });
	});
	it("falls back to summed assistant usage when no result event arrived (killed at a cap)", () => {
		const a = new StreamUsageAccumulator();
		a.feed(asst("m1", 10, 1));
		a.feed(asst("m2", 5, 1));
		expect(a.sawResult).toBe(false);
		expect(a.resultCostUsd).toBeNull();
		expect(a.finalUsage()).toEqual({ inputTokens: 15, outputTokens: 2, cacheWriteTokens: 2, cacheReadTokens: 4 });
	});
	it("ignores blank, partial and non-JSON lines", () => {
		const a = new StreamUsageAccumulator();
		a.feed(""); a.feed("{\"type\":\"assist"); a.feed("not json"); a.feed(JSON.stringify({ type: "system" }));
		expect(a.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
	});
	it("collects assistant text blocks and the result text in order", () => {
		const a = new StreamUsageAccumulator();
		a.feed(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "FINDING: a" }, { type: "tool_use", name: "x" }] } }));
		a.feed(JSON.stringify({ type: "result", subtype: "success", result: "SELF-REVIEW CYCLE 1 COMPLETE: 1 findings" }));
		expect(a.texts).toEqual(["FINDING: a", "SELF-REVIEW CYCLE 1 COMPLETE: 1 findings"]);
	});
	it("does not duplicate the result text when it repeats the last assistant text", () => {
		const a = new StreamUsageAccumulator();
		const text = "FINDING: a\nSELF-REVIEW CYCLE 1 COMPLETE: 1 findings";
		a.feed(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text }] } }));
		a.feed(JSON.stringify({ type: "result", subtype: "success", result: `${text}\n` }));
		expect(a.texts).toEqual([text]);
	});
	it("keeps the result text when it differs from the last assistant text", () => {
		const a = new StreamUsageAccumulator();
		a.feed(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "FINDING: a" }] } }));
		a.feed(JSON.stringify({ type: "result", subtype: "success", result: "done" }));
		expect(a.texts).toHaveLength(2);
	});
});
