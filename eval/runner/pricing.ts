import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { UsageTotals } from "./types.ts";

const rateSchema = z.object({ input: z.number().nonnegative(), cacheWrite: z.number().nonnegative(), cacheRead: z.number().nonnegative(), output: z.number().nonnegative() });
export type PricingTable = Record<string, z.infer<typeof rateSchema>>;
export const PRICING_PATH = join(import.meta.dirname, "pricing.json");

export function loadPricing(path: string = PRICING_PATH): PricingTable {
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const out: PricingTable = {};
	for (const [k, v] of Object.entries(raw)) {
		if (k.startsWith("_")) continue;
		out[k] = rateSchema.parse(v);
	}
	return out;
}

export function costFor(usage: UsageTotals, model: string, table: PricingTable): number | null {
	const r = table[model];
	if (!r) return null;
	const perTok = (n: number, rate: number): number => (n / 1_000_000) * rate;
	return perTok(usage.inputTokens, r.input) + perTok(usage.cacheWriteTokens, r.cacheWrite) + perTok(usage.cacheReadTokens, r.cacheRead) + perTok(usage.outputTokens, r.output);
}
