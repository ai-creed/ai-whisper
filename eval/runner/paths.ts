import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Symlink-resolved absolute path. The deepest existing ancestor is realpath'd; the not-yet-created tail is appended verbatim. */
export function physicalPath(p: string): string {
	let existing = resolve(p);
	const tail: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break; // filesystem root
		tail.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	return join(realpathSync.native(existing), ...tail);
}

export function isInside(child: string, parent: string): boolean {
	const c = physicalPath(child);
	const p = physicalPath(parent);
	return c === p || c.startsWith(p + sep);
}

/** Containment guard for everything an agent can reach. Guard only: callers keep the path they were given. */
export function assertOutsideRepo(label: string, path: string, repoRoot: string): void {
	const physical = physicalPath(path);
	const repo = physicalPath(repoRoot);
	if (physical === repo || physical.startsWith(repo + sep)) {
		throw new Error(`${label} must live outside the repository (${repo}); got ${physical}`);
	}
}
