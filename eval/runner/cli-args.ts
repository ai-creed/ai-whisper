import { ARMS, type Arm } from "./types.ts";

export class UsageError extends Error {}

function parseInteger(name: string, raw: string | undefined, min: number, fallback: number | undefined): number | undefined {
	if (raw === undefined) return fallback;
	const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < min) {
		throw new UsageError(`${name} must be ${min === 0 ? "a non-negative" : "a positive"} integer, got ${raw}`);
	}
	return value;
}

export function parsePositiveInt(name: string, raw: string | undefined, fallback?: number): number {
	return parseInteger(name, raw, 1, fallback) as number;
}

export function parseNonNegativeInt(name: string, raw: string | undefined, fallback?: number): number {
	return parseInteger(name, raw, 0, fallback) as number;
}

export function parseArms(raw: string[] | undefined): Arm[] | undefined {
	if (!raw) return undefined;
	for (const a of raw) if (!(ARMS as readonly string[]).includes(a)) throw new UsageError(`--arm must be one of ${ARMS.join(", ")}`);
	return raw as Arm[];
}
