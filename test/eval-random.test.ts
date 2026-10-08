import { describe, expect, it } from "vitest";
import { mulberry32, seededShuffle } from "../eval/runner/random.ts";

describe("seeded randomness", () => {
	it("mulberry32 is deterministic for a seed", () => {
		const a = mulberry32(7), b = mulberry32(7);
		expect([a(), a(), a()]).toEqual([b(), b(), b()]);
	});
	it("seededShuffle is a permutation and reproducible", () => {
		const items = Array.from({ length: 90 }, (_, i) => i);
		const s1 = seededShuffle(items, 42), s2 = seededShuffle(items, 42);
		expect(s1).toEqual(s2);
		expect([...s1].sort((x, y) => x - y)).toEqual(items);
		expect(s1).not.toEqual(items);
		expect(items[0]).toBe(0); // input untouched
	});
});
