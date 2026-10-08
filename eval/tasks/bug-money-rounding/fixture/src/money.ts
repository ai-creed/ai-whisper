/**
 * Splits a decimal `amount` (for example 100.00) across `ratios`, returning one
 * part per ratio rounded to two decimals.
 */
export function allocate(amount: number, ratios: number[]): number[] {
	if (ratios.length === 0) {
		throw new RangeError("ratios must not be empty");
	}
	const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
	if (total === 0) {
		throw new RangeError("ratios must not all be zero");
	}
	return ratios.map((ratio) => Number(((amount * ratio) / total).toFixed(2)));
}
