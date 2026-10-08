export type JsonType = "string" | "number" | "boolean" | "object" | "array" | "null";

export interface Schema {
	type?: JsonType;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

export interface ValidationError {
	path: string;
	message: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] };
