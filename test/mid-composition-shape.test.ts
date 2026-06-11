import { describe, expect, it } from "vitest";
import { isMidCompositionShape } from "../packages/cli/src/runtime/mid-composition-shape.ts";

describe("isMidCompositionShape", () => {
	it("flags empty and drafting/scratchpad fragments", () => {
		expect(isMidCompositionShape("")).toBe(true);
		expect(isMidCompositionShape("   ")).toBe(true);
		expect(isMidCompositionShape("Let's draft")).toBe(true);
		expect(isMidCompositionShape("Maybe")).toBe(true);
		expect(isMidCompositionShape("Need include the matrix")).toBe(true);
		expect(isMidCompositionShape("...")).toBe(true);
	});
	it("passes a real structured answer", () => {
		expect(
			isMidCompositionShape("Review matrix:\n| Requirement | Result |\n| --- | --- |\n| X | Pass |"),
		).toBe(false);
	});
});
