import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/adapter-ai-ezio/src/render-markdown.ts";

describe("renderMarkdown", () => {
	it("renders a header bold", () => {
		const out = renderMarkdown("# Title");
		expect(out).toContain("[1m");
		expect(out).toContain("Title");
	});

	it("renders **bold** and inline `code`", () => {
		const out = renderMarkdown("A **bold** word and `code`.");
		expect(out).toContain("[1mbold[0m");
		expect(out).toContain("[36mcode[0m"); // cyan inline code
	});

	it("renders *italic* / _italic_", () => {
		expect(renderMarkdown("an *em* word")).toContain("[3mem[0m");
		expect(renderMarkdown("an _em_ word")).toContain("[3mem[0m");
	});

	it("renders a fenced code block dim, content preserved", () => {
		const out = renderMarkdown("```\nnpm run build\n```");
		expect(out).toContain("[2m");
		expect(out).toContain("npm run build");
	});

	it("renders unordered list items with a bullet", () => {
		const out = renderMarkdown("- a\n- b");
		expect(out).toContain("• a");
		expect(out).toContain("• b");
	});

	it("renders ordered list items keeping the number", () => {
		expect(renderMarkdown("1. first\n2. second")).toContain("1. first");
	});

	it("renders a blockquote dim with a bar", () => {
		const out = renderMarkdown("> quoted");
		expect(out).toContain("[2m");
		expect(out).toContain("quoted");
	});

	it("renders a link as text + dim url", () => {
		const out = renderMarkdown("see [docs](http://x.y)");
		expect(out).toContain("docs");
		expect(out).toContain("http://x.y");
	});

	it("passes plain text through; an unclosed ** degrades to literal", () => {
		expect(renderMarkdown("just text")).toContain("just text");
		expect(renderMarkdown("a **bad")).toContain("**bad");
	});

	it("does not format inside a fenced code block", () => {
		const out = renderMarkdown("```\n**not bold** here\n```");
		expect(out).toContain("**not bold**"); // literal, not rendered bold
	});
});
