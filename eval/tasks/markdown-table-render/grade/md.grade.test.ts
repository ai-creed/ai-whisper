import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/md.ts";

describe("renderMarkdown tables (held-out)", () => {
	it("basic table html", () => {
		expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
	});
	it("center and right alignment on th and td", () => {
		expect(renderMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")).toBe(
			'<table><thead><tr><th>a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead>' +
				'<tbody><tr><td>1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr></tbody></table>',
		);
	});
	it("escaped pipe literal", () => {
		expect(renderMarkdown("| a | b |\n|---|---|\n| x \\| y | z |")).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x | y</td><td>z</td></tr></tbody></table>",
		);
	});
	it("short row padded", () => {
		expect(renderMarkdown("| a | b |\n|---|---|\n| 1 |")).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr></tbody></table>",
		);
	});
	it("long row truncated", () => {
		expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 | 3 |")).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
	});
	it("inline bold in cell", () => {
		expect(renderMarkdown("| a | b |\n|---|---|\n| **x** | y |")).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><strong>x</strong></td><td>y</td></tr></tbody></table>",
		);
	});
	it("invalid delimiter renders paragraph", () => {
		expect(renderMarkdown("| a | b |\n| nope | x |\n| 1 | 2 |")).toBe("<p>| a | b | | nope | x | | 1 | 2 |</p>");
	});
	it("non-table document unchanged", () => {
		const doc = "# Notes\n\nSome *text* with `code`.\n\n## More\n\nA | B line with a pipe";
		expect(renderMarkdown(doc)).toBe(
			"<h1>Notes</h1>\n<p>Some <em>text</em> with <code>code</code>.</p>\n<h2>More</h2>\n<p>A | B line with a pipe</p>",
		);
	});
});
