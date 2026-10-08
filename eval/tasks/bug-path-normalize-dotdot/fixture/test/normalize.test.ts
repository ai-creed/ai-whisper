import { describe, expect, it } from "vitest";
import { normalizePath } from "../src/normalize.ts";

describe("normalizePath", () => {
	it("resolves single dots", () => {
		expect(normalizePath("a/./b")).toBe("a/b");
	});
	it("resolves parent segments inside the path", () => {
		expect(normalizePath("a/b/../c")).toBe("a/c");
	});
	it("collapses repeated slashes", () => {
		expect(normalizePath("//a//b")).toBe("/a/b");
	});
	it("keeps an absolute path absolute", () => {
		expect(normalizePath("/a/b/c")).toBe("/a/b/c");
	});
	it("leaves an already normal relative path alone", () => {
		expect(normalizePath("a/b")).toBe("a/b");
	});
});
