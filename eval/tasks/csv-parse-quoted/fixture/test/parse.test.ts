import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/parse.ts";

describe("parseCsv (unquoted)", () => {
	it("splits fields on commas and rows on newlines", () => {
		expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
	});
	it("handles CRLF rows", () => {
		expect(parseCsv("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
	});
	it("keeps empty fields", () => {
		expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
	});
});
