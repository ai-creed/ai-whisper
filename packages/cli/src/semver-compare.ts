// Minimal semver comparator (no dependency). Handles `X.Y.Z` with an optional
// `-prerelease` of dot-separated numeric/alphanumeric identifiers, which is all
// the ai-whisper / @ai-creed/ai-ezio version forms use.

type Parsed = { main: [number, number, number]; pre: string[] };

function parse(version: string): Parsed {
	const v = version.replace(/^v/, "");
	const dash = v.indexOf("-");
	const core = dash === -1 ? v : v.slice(0, dash);
	const pre = dash === -1 ? "" : v.slice(dash + 1);
	const nums = core.split(".").map((s) => Number.parseInt(s, 10) || 0);
	const main: [number, number, number] = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
	return { main, pre: pre ? pre.split(".") : [] };
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const av = pa.main[i] ?? 0;
		const bv = pb.main[i] ?? 0;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	// A version with no prerelease outranks one that has a prerelease.
	if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
	if (pa.pre.length === 0) return 1;
	if (pb.pre.length === 0) return -1;
	const n = Math.max(pa.pre.length, pb.pre.length);
	for (let i = 0; i < n; i++) {
		const x = pa.pre[i];
		const y = pb.pre[i];
		if (x === undefined) return -1; // shorter prerelease list < longer
		if (y === undefined) return 1;
		const xNum = /^\d+$/.test(x);
		const yNum = /^\d+$/.test(y);
		if (xNum && yNum) {
			const dx = Number(x);
			const dy = Number(y);
			if (dx !== dy) return dx < dy ? -1 : 1;
		} else if (xNum !== yNum) {
			return xNum ? -1 : 1; // numeric identifiers rank lower than alphanumeric
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}
