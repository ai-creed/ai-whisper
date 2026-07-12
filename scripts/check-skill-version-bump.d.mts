export interface VersionBumpViolation {
	skill: string;
	reason: string;
}
export function checkSkillVersionBumps(opts: {
	repoRoot: string;
	baseRef: string;
}): VersionBumpViolation[];
