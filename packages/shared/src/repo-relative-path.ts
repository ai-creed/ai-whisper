import { basename, isAbsolute, relative } from "node:path";

/**
 * Reduce an absolute path to a display path relative to `root`.
 *
 * - If `absPath` is under `root`, returns the path relative to `root`
 *   (e.g. `/repo/docs/foo.md` + `/repo` → `docs/foo.md`).
 * - If `absPath` is outside `root` (including a sibling that merely shares a
 *   name prefix), returns `absPath` unchanged (absolute fallback).
 * - A non-absolute `absPath`, or an empty `root`, is returned unchanged.
 * - Empty `absPath` returns `""`.
 *
 * Pure: no I/O, no `process.cwd()` dependence.
 */
export function repoRelativePath(absPath: string, root: string): string {
	if (!absPath) return "";
	if (!root || !isAbsolute(absPath) || !isAbsolute(root)) return absPath;
	const rel = relative(root, absPath);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absPath;
	return rel;
}

/**
 * Display form of an artifact path used by the card and the Inspector header.
 * Single-sources the empty/whitespace handling so Wall, compact cards, and the
 * Inspector `wf` row all omit the artifact identically.
 *
 * - Trims; empty/whitespace input → `null` (caller omits the artifact segment).
 * - Otherwise returns `repoRelativePath(trimmed, root)`, falling back to
 *   `basename(trimmed)` only if that reduction is somehow empty (defensive),
 *   then `null`.
 */
export function displayArtifactPath(absPath: string, root: string): string | null {
	const trimmed = (absPath ?? "").trim();
	if (!trimmed) return null;
	const rel = repoRelativePath(trimmed, root).trim();
	return rel || basename(trimmed).trim() || null;
}
