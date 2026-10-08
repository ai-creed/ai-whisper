import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/parse.ts";

describe("parseCsv quoted fields (held-out)", () => {
	it("quoted field with comma", () => expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]));
	it("quoted field with LF newline preserved", () => expect(parseCsv('"x\ny",z')).toEqual([["x\ny", "z"]]));
	it("quoted field with CRLF newline preserved", () => expect(parseCsv('"x\r\ny",z')).toEqual([["x\r\ny", "z"]]));
	it("escaped quotes", () => expect(parseCsv('"say ""hi"""')).toEqual([['say "hi"']]));
	it("empty quoted field", () => expect(parseCsv('a,"",c')).toEqual([["a", "", "c"]]));
	it("trailing newline does not add a row", () => expect(parseCsv('"a"\n')).toEqual([["a"]]));
	it("unterminated quote throws", () => expect(() => parseCsv('"abc')).toThrow(/unterminated quoted field/));
	it("quote inside unquoted field is literal", () => expect(parseCsv('a"b,c')).toEqual([['a"b', "c"]]));
	it("existing unquoted behaviour unchanged", () => expect(parseCsv("a,,c\n1,2,3\n")).toEqual([["a", "", "c"], ["1", "2", "3"]]));
});
