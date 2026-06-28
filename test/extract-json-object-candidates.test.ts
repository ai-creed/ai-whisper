import { describe, expect, it } from "vitest";
import { extractJsonObjectCandidates } from "../packages/shared/src/extract-json-object-candidates.ts";

describe("extractJsonObjectCandidates", () => {
	it("returns a single top-level object", () => {
		expect(extractJsonObjectCandidates('{"a":1}')).toEqual(['{"a":1}']);
	});

	it("returns multiple top-level objects in order", () => {
		expect(extractJsonObjectCandidates('{"a":1} junk {"b":2}')).toEqual([
			'{"a":1}',
			'{"b":2}',
		]);
	});

	it("treats a nested object as part of its enclosing top-level object", () => {
		expect(extractJsonObjectCandidates('{"a":{"b":2}}')).toEqual([
			'{"a":{"b":2}}',
		]);
	});

	it("ignores braces that appear inside string values", () => {
		expect(extractJsonObjectCandidates('{"a":"}{"}')).toEqual(['{"a":"}{"}']);
	});

	it("ignores escaped quotes when tracking strings", () => {
		expect(extractJsonObjectCandidates('{"a":"x\\"}y"}')).toEqual([
			'{"a":"x\\"}y"}',
		]);
	});

	it("recovers an object embedded in surrounding prose / fences", () => {
		const raw = 'Here you go:\n```json\n{"kind":"answer"}\n```\nDone.';
		expect(extractJsonObjectCandidates(raw)).toEqual(['{"kind":"answer"}']);
	});

	it("returns an empty array when no object is present", () => {
		expect(extractJsonObjectCandidates("no json here")).toEqual([]);
	});
});
