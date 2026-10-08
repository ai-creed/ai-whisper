import { describe, expect, it } from "vitest";
import { allocate } from "../src/money.ts";

describe("allocate", () => {
	it("splits an evenly divisible amount", () => {
		expect(allocate(100, [1, 1])).toEqual([50, 50]);
	});
	it("splits by weighted ratios", () => {
		expect(allocate(10, [1, 1, 3, 5])).toEqual([1, 1, 3, 5]);
	});
	it("gives zero to zero-weight parts", () => {
		expect(allocate(10, [0, 1])).toEqual([0, 10]);
	});
	it("throws for empty ratios", () => {
		expect(() => allocate(10, [])).toThrow();
	});
	it("throws when every ratio is zero", () => {
		expect(() => allocate(10, [0, 0])).toThrow();
	});
});
