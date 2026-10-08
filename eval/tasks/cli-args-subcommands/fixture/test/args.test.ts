import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";

const spec = { flags: { verbose: "boolean", out: "string" } } as const;

describe("parseArgs", () => {
	it("parses a boolean flag", () => {
		const r = parseArgs(["--verbose"], { flags: { ...spec.flags } });
		expect(r.flags).toEqual({ verbose: true });
		expect(r.positionals).toEqual([]);
	});
	it("parses --flag=value", () => {
		expect(parseArgs(["--out=dist"], { flags: { ...spec.flags } }).flags).toEqual({ out: "dist" });
	});
	it("parses --flag value", () => {
		expect(parseArgs(["--out", "dist"], { flags: { ...spec.flags } }).flags).toEqual({ out: "dist" });
	});
	it("collects positionals around flags", () => {
		const r = parseArgs(["a", "--verbose", "b"], { flags: { ...spec.flags } });
		expect(r.positionals).toEqual(["a", "b"]);
	});
	it("treats everything after -- as positional", () => {
		const r = parseArgs(["--verbose", "--", "--out", "x"], { flags: { ...spec.flags } });
		expect(r.flags).toEqual({ verbose: true });
		expect(r.positionals).toEqual(["--out", "x"]);
	});
	it("throws when a string flag has no value", () => {
		expect(() => parseArgs(["--out"], { flags: { ...spec.flags } })).toThrow(/missing value/);
	});
});
