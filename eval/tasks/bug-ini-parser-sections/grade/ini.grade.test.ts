import { describe, expect, it } from "vitest";
import { parseIni } from "../src/ini.ts";

describe("parseIni (held-out)", () => {
	it("duplicate section merges", () => {
		expect(parseIni("[a]\nx=1\n[b]\ny=2\n[a]\nz=3")).toEqual({
			a: { x: "1", z: "3" },
			b: { y: "2" },
		});
	});
	it("inline semicolon inside quotes kept", () => {
		expect(parseIni('[s]\nk = "v;w"').s).toEqual({ k: "v;w" });
	});
	it("global keys land in empty section", () => {
		expect(parseIni("k = 1\n[a]\nx = 2")).toEqual({
			"": { k: "1" },
			a: { x: "2" },
		});
	});
	it("later duplicate key overrides", () => {
		expect(parseIni("[a]\nx=1\n[a]\nx=2").a).toEqual({ x: "2" });
	});
	it("inline comment after unquoted value stripped", () => {
		expect(parseIni("[a]\nk = v ; c").a).toEqual({ k: "v" });
	});
	it("escaped quote in quoted value", () => {
		expect(parseIni('[a]\nk = "a\\"b"').a).toEqual({ k: 'a"b' });
	});
	it("blank lines ignored", () => {
		expect(parseIni("\n   \n[a]\n\n  \nx=1\n\t\n")).toEqual({ a: { x: "1" } });
	});
});
