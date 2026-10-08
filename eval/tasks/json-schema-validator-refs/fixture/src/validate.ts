import type { JsonType, Schema, ValidationError, ValidationResult } from "./types.ts";

function jsonTypeOf(value: unknown): JsonType | "other" {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return Number.isFinite(value) ? "number" : "other";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return "other";
	}
}

function escapeSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function collect(schema: Schema, value: unknown, path: string, errors: ValidationError[]): void {
	const actual = jsonTypeOf(value);
	if (schema.type !== undefined && actual !== schema.type) {
		errors.push({ path, message: `expected type ${schema.type}` });
	}
	if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
		errors.push({ path, message: "value not in enum" });
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
		if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
	}
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `length must be >= ${schema.minLength}` });
		if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `length must be <= ${schema.maxLength}` });
	}
	if (actual === "object") {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) errors.push({ path: `${path}/${escapeSegment(key)}`, message: "missing required property" });
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (key in record) collect(child, record[key], `${path}/${escapeSegment(key)}`, errors);
		}
	}
	if (actual === "array" && schema.items !== undefined) {
		(value as unknown[]).forEach((item, index) => collect(schema.items as Schema, item, `${path}/${index}`, errors));
	}
}

export function validate(schema: Schema, value: unknown): ValidationResult {
	const errors: ValidationError[] = [];
	collect(schema, value, "", errors);
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
