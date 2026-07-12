// Minimal frontmatter version scan for the skill-install guard. Deliberately
// not a YAML parser: the guard's contract (spec 2026-07-12) is that anything
// malformed falls into the "treat as missing" rows of the guard table.
const VALID_VERSION_RE = /^\d+(\.\d+){0,2}$/;

export function parseSkillVersion(content: string): string | null {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") return null;
		const m = /^version:\s*(.+?)\s*$/.exec(line);
		if (m) {
			const raw = (m[1] ?? "").replace(/^["']/, "").replace(/["']$/, "");
			return VALID_VERSION_RE.test(raw) ? raw : null;
		}
	}
	return null;
}

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < 3; i++) {
		const da = Number.parseInt(pa[i] ?? "0", 10);
		const db = Number.parseInt(pb[i] ?? "0", 10);
		if (da !== db) return da < db ? -1 : 1;
	}
	return 0;
}
