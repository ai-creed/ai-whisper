import { describe, expect, it } from "vitest";
import { validate } from "../src/validate.ts";
import type { Schema } from "../src/types.ts";

function errorsOf(schema: Schema, value: unknown) {
	const result = validate(schema, value);
	return result.ok ? [] : result.errors;
}

describe("validate", () => {
	it("accepts a matching type and rejects a mismatched one", () => {
		expect(validate({ type: "string" }, "a")).toEqual({ ok: true });
		expect(errorsOf({ type: "string" }, 1)).toEqual([{ path: "", message: "expected type string" }]);
	});

	it("distinguishes null, array and object", () => {
		expect(validate({ type: "null" }, null)).toEqual({ ok: true });
		expect(validate({ type: "array" }, [])).toEqual({ ok: true });
		expect(errorsOf({ type: "object" }, [])).toHaveLength(1);
		expect(errorsOf({ type: "object" }, null)).toHaveLength(1);
	});

	it("validates properties with pointer paths", () => {
		const schema: Schema = { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } };
		expect(validate(schema, { name: "a", age: 3 })).toEqual({ ok: true });
		expect(errorsOf(schema, { name: 1, age: "x" }).map((e) => e.path)).toEqual(["/name", "/age"]);
	});

	it("reports missing required properties at the missing key", () => {
		expect(errorsOf({ required: ["id"] }, {})).toEqual([{ path: "/id", message: "missing required property" }]);
	});

	it("validates array items with index paths", () => {
		const schema: Schema = { type: "array", items: { type: "number" } };
		expect(errorsOf(schema, [1, "a", 3, "b"]).map((e) => e.path)).toEqual(["/1", "/3"]);
	});

	it("checks enum membership", () => {
		expect(validate({ enum: ["a", 1, null] }, null)).toEqual({ ok: true });
		expect(errorsOf({ enum: ["a", 1] }, "b")).toEqual([{ path: "", message: "value not in enum" }]);
	});

	it("checks minimum and maximum", () => {
		expect(errorsOf({ minimum: 2 }, 1)).toEqual([{ path: "", message: "must be >= 2" }]);
		expect(errorsOf({ maximum: 2 }, 3)).toEqual([{ path: "", message: "must be <= 2" }]);
		expect(validate({ minimum: 2, maximum: 2 }, 2)).toEqual({ ok: true });
	});

	it("checks minLength and maxLength", () => {
		expect(errorsOf({ minLength: 2 }, "a")).toEqual([{ path: "", message: "length must be >= 2" }]);
		expect(errorsOf({ maxLength: 2 }, "abc")).toEqual([{ path: "", message: "length must be <= 2" }]);
	});

	it("escapes ~ and / in pointer segments", () => {
		const schema: Schema = { properties: { "a/b": { type: "string" }, "c~d": { type: "string" } } };
		expect(errorsOf(schema, { "a/b": 1, "c~d": 2 }).map((e) => e.path)).toEqual(["/a~1b", "/c~0d"]);
	});

	it("collects every error instead of stopping at the first", () => {
		const schema: Schema = { type: "object", required: ["a"], properties: { b: { type: "string" } } };
		expect(errorsOf(schema, { b: 1 })).toHaveLength(2);
	});
});
