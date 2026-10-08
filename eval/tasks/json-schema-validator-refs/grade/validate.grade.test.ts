import { describe, expect, it } from "vitest";
import { validate } from "../src/validate.ts";
import type { Schema } from "../src/types.ts";

type Err = { path: string; message: string };

function run(schema: unknown, value: unknown): { ok: boolean; errors: Err[] } {
	const result = validate(schema as Schema, value) as { ok: boolean; errors?: Err[] };
	return { ok: result.ok, errors: result.errors ?? [] };
}

describe("json-schema-validator-refs (held-out)", () => {
	it("resolves $ref to definitions and $defs", () => {
		const viaDefinitions = { definitions: { name: { type: "string" } }, properties: { n: { $ref: "#/definitions/name" } } };
		const viaDefs = { $defs: { name: { type: "string" } }, properties: { n: { $ref: "#/$defs/name" } } };
		for (const schema of [viaDefinitions, viaDefs]) {
			expect(run(schema, { n: "x" }).ok).toBe(true);
			expect(run(schema, { n: 1 })).toEqual({ ok: false, errors: [{ path: "/n", message: "expected type string" }] });
		}
	});

	it("resolves nested refs, including recursive schemas", () => {
		const schema = {
			definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/c" }, c: { type: "number" } },
			properties: { v: { $ref: "#/definitions/a" } },
		};
		expect(run(schema, { v: 1 }).ok).toBe(true);
		expect(run(schema, { v: "x" }).errors).toEqual([{ path: "/v", message: "expected type number" }]);
		const tree = {
			$defs: { node: { type: "object", required: ["value"], properties: { value: { type: "number" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
			$ref: "#/$defs/node",
		};
		expect(run(tree, { value: 1, children: [{ value: 2, children: [{ value: 3 }] }] }).ok).toBe(true);
		expect(run(tree, { value: 1, children: [{ value: 2, children: [{ value: "x" }] }] }).errors).toEqual([
			{ path: "/children/0/children/0/value", message: "expected type number" },
		]);
	});

	it("reports a circular $ref at the path instead of looping", () => {
		const direct = { $ref: "#/definitions/a", definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } } };
		expect(run(direct, 1)).toEqual({ ok: false, errors: [{ path: "", message: "circular $ref" }] });
		const nested = { properties: { x: { $ref: "#/$defs/a" } }, $defs: { a: { $ref: "#/$defs/a" } } };
		expect(run(nested, { x: 1 })).toEqual({ ok: false, errors: [{ path: "/x", message: "circular $ref" }] });
	});

	it("allOf collects errors from all branches", () => {
		const schema = { allOf: [{ type: "object", required: ["a"] }, { type: "object", required: ["b"] }] };
		expect(run(schema, {}).errors).toEqual([
			{ path: "/a", message: "missing required property" },
			{ path: "/b", message: "missing required property" },
		]);
		expect(run(schema, { a: 1, b: 2 }).ok).toBe(true);
	});

	it("anyOf is ok when any branch is ok", () => {
		const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
		expect(run(schema, 5).ok).toBe(true);
		expect(run(schema, "x").ok).toBe(true);
	});

	it("anyOf reports errors from every branch prefixed anyOf[i]", () => {
		const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
		expect(run(schema, true)).toEqual({
			ok: false,
			errors: [
				{ path: "", message: "anyOf[0]: expected type string" },
				{ path: "", message: "anyOf[1]: expected type number" },
			],
		});
	});

	it("oneOf with two matches is an error", () => {
		const schema = { oneOf: [{ type: "number" }, { minimum: 0 }] };
		expect(run(schema, 5).errors).toEqual([{ path: "", message: "expected exactly one match, got 2" }]);
		expect(run(schema, -1).ok).toBe(true);
		expect(run({ oneOf: [{ type: "number" }, { type: "boolean" }] }, "x").errors).toEqual([{ path: "", message: "expected exactly one match, got 0" }]);
	});

	it("additionalProperties false rejects extras with the path to the extra key", () => {
		const schema = { type: "object", properties: { a: { type: "number" } }, additionalProperties: false };
		expect(run(schema, { a: 1 }).ok).toBe(true);
		const result = run(schema, { a: 1, b: 2, c: 3 });
		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.path)).toEqual(["/b", "/c"]);
	});

	it("additionalProperties as a schema validates extras", () => {
		const schema = { properties: { a: { type: "number" } }, additionalProperties: { type: "string" } };
		expect(run(schema, { a: 1, b: "x" }).ok).toBe(true);
		expect(run(schema, { a: "no", b: 2 }).errors).toEqual([
			{ path: "/a", message: "expected type number" },
			{ path: "/b", message: "expected type string" },
		]);
	});

	it("pattern mismatch error includes the pattern", () => {
		const schema = { type: "string", pattern: "^[a-z]+$" };
		expect(run(schema, "abc").ok).toBe(true);
		const result = run(schema, "ABC");
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe("");
		expect(result.errors[0]?.message).toContain("^[a-z]+$");
	});

	it("every error path is a JSON pointer, root is the empty string", () => {
		const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } };
		expect(run(schema, { items: [{ name: "ok" }, { name: 1 }] }).errors).toEqual([{ path: "/items/1/name", message: "expected type string" }]);
		expect(run({ type: "string" }, 1).errors[0]?.path).toBe("");
		const paths = run(
			{ allOf: [{ properties: { a: { properties: { "x/y": { type: "string" } } } } }], properties: { a: {} }, additionalProperties: false },
			{ a: { "x/y": 1 }, extra: 1 },
		).errors.map((e) => e.path);
		expect(paths).toEqual(["/a/x~1y", "/extra"]);
		for (const p of paths) expect(p === "" || p.startsWith("/")).toBe(true);
	});

	it("existing keyword behaviour is unchanged", () => {
		expect(run({ type: "string", minLength: 2, maxLength: 3 }, "abcd").errors).toEqual([{ path: "", message: "length must be <= 3" }]);
		expect(run({ enum: [1, 2] }, 3).errors).toEqual([{ path: "", message: "value not in enum" }]);
		expect(run({ minimum: 1, maximum: 2 }, 3).errors).toEqual([{ path: "", message: "must be <= 2" }]);
		expect(run({ required: ["id"] }, {}).errors).toEqual([{ path: "/id", message: "missing required property" }]);
		expect(run({ type: "array", items: { type: "number" } }, [1, "a"]).errors).toEqual([{ path: "/1", message: "expected type number" }]);
		expect(validate({ type: "null" }, null)).toEqual({ ok: true });
	});

	it("errors are in document order", () => {
		const schema = {
			type: "object",
			required: ["z"],
			properties: { a: { type: "string" }, b: { type: "array", items: { type: "number" } }, c: { type: "string" } },
		};
		const paths = run(schema, { a: 1, b: [1, "x", "y"], c: 2 }).errors.map((e) => e.path);
		expect(paths).toEqual(["/z", "/a", "/b/1", "/b/2", "/c"]);
	});
});
