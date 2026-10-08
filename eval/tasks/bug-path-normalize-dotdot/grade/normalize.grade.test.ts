import { describe, expect, it } from "vitest";
import { normalizePath } from "../src/normalize.ts";

describe("normalizePath (held-out)", () => {
	it('normalizes "/../a"', () => {
		expect(normalizePath("/../a")).toBe("/a");
	});
	it('normalizes "/"', () => {
		expect(normalizePath("/")).toBe("/");
	});
	it('normalizes "../a"', () => {
		expect(normalizePath("../a")).toBe("../a");
	});
	it('normalizes "/.."', () => {
		expect(normalizePath("/..")).toBe("/");
	});
	it('normalizes "a/../.."', () => {
		expect(normalizePath("a/../..")).toBe("..");
	});
	it('normalizes "a/../../b"', () => {
		expect(normalizePath("a/../../b")).toBe("../b");
	});
	it('normalizes "./"', () => {
		expect(normalizePath("./")).toBe(".");
	});
	it('normalizes ""', () => {
		expect(normalizePath("")).toBe(".");
	});
	it('normalizes "/a/b/"', () => {
		expect(normalizePath("/a/b/")).toBe("/a/b");
	});
});
