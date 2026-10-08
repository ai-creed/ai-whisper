import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatReport } from "../src/format.ts";
import type { Report } from "../src/types.ts";

const sample: Report = {
	title: "Q3 Sales",
	rows: [
		{ name: "north", value: 12 },
		{ name: "south", value: 7 },
	],
};

describe("report formatting (held-out)", () => {
	it("text byte-identical", () => {
		expect(formatReport(sample, "text")).toBe(
			"Q3 Sales\n========\nnorth: 12\nsouth: 7",
		);
	});
	it("json byte-identical", () => {
		expect(formatReport(sample, "json")).toBe(
			'{\n  "title": "Q3 Sales",\n  "rows": [\n    {\n      "name": "north",\n      "value": 12\n    },\n    {\n      "name": "south",\n      "value": 7\n    }\n  ]\n}',
		);
	});
	it("csv byte-identical", () => {
		expect(formatReport(sample, "csv")).toBe("name,value\nnorth,12\nsouth,7");
	});
	it("markdown output", () => {
		expect(formatReport(sample, "markdown")).toBe(
			"# Q3 Sales\n\n| name | value |\n|---|---|\n| north | 12 |\n| south | 7 |",
		);
	});
	it("listFormats order", async () => {
		const { listFormats } = await import("../src/registry.ts");
		expect(listFormats()).toEqual(["text", "json", "csv", "markdown"]);
	});
	it("unknown format error", async () => {
		const { getFormatter } = await import("../src/registry.ts");
		expect(() => getFormatter("nope")).toThrow("unknown format nope");
	});
	it("duplicate registration throws", async () => {
		const { registerFormatter } = await import("../src/registry.ts");
		expect(() => registerFormatter("text", () => "x")).toThrow();
	});
	it("format.ts has no switch", () => {
		const src = readFileSync(`${import.meta.dirname}/../src/format.ts`, "utf8");
		expect(!/switch|case "/.test(src)).toBe(true);
	});
});
