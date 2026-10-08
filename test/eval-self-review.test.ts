import { describe, expect, it } from "vitest";
import { parseSelfReviewFindings } from "../eval/runner/arms/self-review.ts";

describe("parseSelfReviewFindings", () => {
	it("counts FINDING lines across cycles", () => {
		expect(parseSelfReviewFindings(["FINDING: missed criterion 3\nFINDING: no test for empty input\nSELF-REVIEW CYCLE 1 COMPLETE: 2 findings", "SELF-REVIEW CYCLE 2 COMPLETE: 0 findings"])).toEqual({ cycles: 2, findings: 2 });
	});
	it("returns null when the protocol marker never appears", () => {
		expect(parseSelfReviewFindings(["I reviewed my diff and it looks fine."])).toBeNull();
	});
	it("ignores the marker's own count and blank FINDING lines", () => {
		expect(parseSelfReviewFindings(["FINDING:   \nFINDING: real\nSELF-REVIEW CYCLE 1 COMPLETE: 7 findings"])).toEqual({ cycles: 1, findings: 1 });
	});
});
