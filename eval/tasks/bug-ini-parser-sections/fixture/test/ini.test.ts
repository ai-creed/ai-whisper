import { describe, expect, it } from "vitest";
import { parseIni } from "../src/ini.ts";

describe("parseIni", () => {
	it("parses a single section", () => {
		expect(parseIni("[main]\nname = demo\nport=80")).toEqual({
			main: { name: "demo", port: "80" },
		});
	});
	it("parses several distinct sections", () => {
		expect(parseIni("[a]\nx=1\n[b]\ny=2")).toEqual({
			a: { x: "1" },
			b: { y: "2" },
		});
	});
	it("skips full-line comments", () => {
		expect(parseIni("; note\n[a]\n# other\nx=1")).toEqual({ a: { x: "1" } });
	});
	it("unwraps a quoted value", () => {
		expect(parseIni('[a]\nk = "hello world"')).toEqual({
			a: { k: "hello world" },
		});
	});
	it("returns an empty object for empty input", () => {
		expect(parseIni("")).toEqual({});
	});
});
