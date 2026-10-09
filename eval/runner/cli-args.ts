import { ARMS, BILLING_MODES, DEFAULT_BILLING_MODE, type Arm, type BillingMode } from "./types.ts";

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

export function parseBilling(raw: string | undefined): BillingMode {
	if (raw === undefined) return DEFAULT_BILLING_MODE;
	if (!(BILLING_MODES as readonly string[]).includes(raw)) throw new UsageError(`--billing must be one of ${BILLING_MODES.join(", ")}, got ${raw}`);
	return raw as BillingMode;
}

/** --billing is a campaign pin: only init may set it. Accepting it elsewhere would let a slice look api-billed while running on the manifest's mode. */
export function assertBillingFlagScope(cmd: string | undefined, raw: string | undefined): void {
	if (raw !== undefined && cmd !== "init") throw new UsageError(`--billing is pinned at init and cannot be changed per ${cmd ?? "command"}; init a new campaign to switch billing modes`);
}
