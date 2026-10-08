import { describe, expect, it } from "vitest";
import { matchTopic } from "../src/match.ts";

describe("matchTopic (held-out)", () => {
	it("matchTopic exported and pure", () => {
		expect(matchTopic("a.*.c", "a.b.c")).toBe(true);
		expect(matchTopic("a.*", "a")).toBe(false);
		expect(matchTopic("a.**", "a.b.c")).toBe(true);
	});
});
