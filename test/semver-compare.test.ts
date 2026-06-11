import { describe, it, expect } from "vitest";
import { compareSemver } from "../packages/cli/src/semver-compare.js";

describe("compareSemver", () => {
	it("orders prerelease numerics", () => {
		expect(compareSemver("0.2.0-beta.1", "0.2.0-beta.2")).toBe(-1);
		expect(compareSemver("0.2.0-beta.10", "0.2.0-beta.2")).toBe(1); // numeric, not lexical
	});
	it("a release outranks its prerelease", () => {
		expect(compareSemver("0.2.0-beta.2", "0.2.0")).toBe(-1);
		expect(compareSemver("0.2.0", "0.2.0-beta.2")).toBe(1);
	});
	it("compares core version fields", () => {
		expect(compareSemver("0.3.0", "0.2.9")).toBe(1);
		expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
	});
	it("equal versions compare to 0", () => {
		expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
		expect(compareSemver("0.2.0-beta.1", "0.2.0-beta.1")).toBe(0);
	});
	it("tolerates a leading v and missing patch", () => {
		expect(compareSemver("v1.2", "1.2.0")).toBe(0);
	});
});
