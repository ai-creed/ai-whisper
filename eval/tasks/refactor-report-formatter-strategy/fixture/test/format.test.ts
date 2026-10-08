import { describe, expect, it } from "vitest";
import { formatReport } from "../src/format.ts";
import type { Report } from "../src/types.ts";

const sample: Report = {
	title: "Q3 Sales",
	rows: [
		{ name: "north", value: 12 },
		{ name: "south", value: 7 },
	],
};

const empty: Report = { title: "Empty", rows: [] };

describe("formatReport", () => {
	it("renders text", () => {
		expect(formatReport(sample, "text")).toBe(
			"Q3 Sales\n========\nnorth: 12\nsouth: 7",
		);
	});
	it("renders json", () => {
		expect(formatReport(sample, "json")).toBe(
			'{\n  "title": "Q3 Sales",\n  "rows": [\n    {\n      "name": "north",\n      "value": 12\n    },\n    {\n      "name": "south",\n      "value": 7\n    }\n  ]\n}',
		);
	});
	it("renders csv", () => {
		expect(formatReport(sample, "csv")).toBe("name,value\nnorth,12\nsouth,7");
	});
	it("renders an empty report in each format", () => {
		expect(formatReport(empty, "text")).toBe("Empty\n=====");
		expect(formatReport(empty, "json")).toBe(
			'{\n  "title": "Empty",\n  "rows": []\n}',
		);
		expect(formatReport(empty, "csv")).toBe("name,value");
	});
});
