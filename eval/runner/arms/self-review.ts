const FINDING_RE = /^\s*FINDING:\s*\S/gm;
const CYCLE_RE = /^\s*SELF-REVIEW CYCLE \d+ COMPLETE/gm;

/** Arm B secondary metric: findings the agent reported under the self-review protocol. */
export function parseSelfReviewFindings(texts: readonly string[]): { cycles: number; findings: number } | null {
	const all = texts.join("\n");
	const cycles = (all.match(CYCLE_RE) ?? []).length;
	if (cycles === 0) return null;
	return { cycles, findings: (all.match(FINDING_RE) ?? []).length };
}
