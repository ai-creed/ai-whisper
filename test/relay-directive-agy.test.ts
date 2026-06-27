// test/relay-directive-agy.test.ts
import { describe, expect, it } from "vitest";
import { getRelayDirectiveError, parseRelayDirective } from "../packages/cli/src/runtime/relay-directive.ts";

describe("@@agy relay directive", () => {
	it("parses a non-empty agy directive", () => {
		const d = parseRelayDirective("@@agy please review the diff");
		expect(d).not.toBeNull();
		expect(d?.target).toBe("agy");
		expect(d?.instruction).toBe("please review the diff");
	});

	it("rejects an empty agy instruction", () => {
		expect(parseRelayDirective("@@agy")).toBeNull();
	});

	it("flags unsupported agy bracket syntax", () => {
		expect(getRelayDirectiveError("@@agy[bad] x")).toContain("agy");
	});
});
