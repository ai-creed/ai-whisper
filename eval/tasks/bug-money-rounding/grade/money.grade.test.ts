import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocate } from "../src/money.ts";

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

describe("allocate (held-out)", () => {
	it("allocates 100 across three equal ratios summing exactly", () => {
		expect(allocate(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
	});
	it("distributes leftover cents earliest-first for 0.05", () => {
		expect(allocate(0.05, [1, 1, 1])).toEqual([0.02, 0.02, 0.01]);
	});
	it("handles negative amounts without negative zero", () => {
		const parts = allocate(-100, [1, 1, 1]);
		expect(parts).toEqual([-33.34, -33.33, -33.33]);
		expect(parts.every((p) => !Object.is(p, -0))).toBe(true);
		expect(allocate(-10, [0, 1]).every((p) => !Object.is(p, -0))).toBe(true);
	});
	it("parts sum to the amount for 1000 seeded random cases", () => {
		const next = lcg(20260819);
		for (let i = 0; i < 1000; i++) {
			const cents = (next() % 2_000_001) - 1_000_000;
			const ratios = Array.from({ length: 1 + (next() % 5) }, () => next() % 4);
			if (ratios.every((r) => r === 0)) ratios[ratios.length - 1] = 1;
			const parts = allocate(cents / 100, ratios);
			expect(parts).toHaveLength(ratios.length);
			const partCents = parts.map((p) => Math.round(p * 100));
			expect(partCents.reduce((s, c) => s + c, 0)).toBe(cents);
			parts.forEach((p, j) => {
				expect(Object.is(p, -0)).toBe(false);
				expect(Math.abs(p * 100 - partCents[j]!)).toBeLessThan(1e-6);
			});
		}
	});
	it("allocates zero to zero ratios", () => {
		expect(allocate(10, [0, 1, 0, 1])).toEqual([0, 5, 0, 5]);
		expect(allocate(0.05, [0, 1, 1, 1])).toEqual([0, 0.02, 0.02, 0.01]);
		expect(allocate(0.01, [1, 0, 1])).toEqual([0.01, 0, 0]);
	});
	it("throws on empty ratios", () => {
		expect(() => allocate(10, [])).toThrow();
	});
	it("throws on all-zero ratios", () => {
		expect(() => allocate(10, [0, 0, 0])).toThrow();
	});
	it("uses integer minor units without toFixed", () => {
		const src = readFileSync(`${import.meta.dirname}/../src/money.ts`, "utf8");
		expect(/toFixed/.test(src)).toBe(false);
	});
});
