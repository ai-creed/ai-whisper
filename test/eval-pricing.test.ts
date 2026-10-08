import { describe, expect, it } from "vitest";
import { costFor, loadPricing } from "../eval/runner/pricing.ts";

describe("pricing", () => {
	const table = { "m-1": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } };
	it("computes USD from per-million rates", () => {
		expect(costFor({ inputTokens: 1_000_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 }, "m-1", table)).toBeCloseTo(3 + 1.5 + 0.3, 6);
	});
	it("returns null for an unknown model", () => {
		expect(costFor({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }, "nope", table)).toBeNull();
	});
	it("ships a committed table with the campaign models", () => {
		const t = loadPricing();
		expect(Object.keys(t).length).toBeGreaterThan(0);
		for (const row of Object.values(t)) for (const k of ["input", "cacheWrite", "cacheRead", "output"] as const) expect(row[k]).toBeGreaterThanOrEqual(0);
	});
});
