import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/md.ts";

describe("renderMarkdown", () => {
	it("renders # and ## headings", () => {
		expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
		expect(renderMarkdown("## Sub")).toBe("<h2>Sub</h2>");
	});
	it("renders paragraphs separated by blank lines", () => {
		expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one two</p>\n<p>three</p>");
	});
	it("renders bold, emphasis and inline code", () => {
		expect(renderMarkdown("a **b** *c* `d`")).toBe("<p>a <strong>b</strong> <em>c</em> <code>d</code></p>");
	});
	it("does not interpret markup inside inline code", () => {
		expect(renderMarkdown("`**x**`")).toBe("<p><code>**x**</code></p>");
	});
	it("escapes HTML in text", () => {
		expect(renderMarkdown("1 < 2 & 3")).toBe("<p>1 &lt; 2 &amp; 3</p>");
	});
	it("renders a mixed document", () => {
		const doc = "# Notes\n\nSome *text* with `code`.\n\n## More\n\nA | B line with a pipe";
		expect(renderMarkdown(doc)).toBe(
			"<h1>Notes</h1>\n<p>Some <em>text</em> with <code>code</code>.</p>\n<h2>More</h2>\n<p>A | B line with a pipe</p>",
		);
	});
});
