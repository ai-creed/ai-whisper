/**
 * Normalizes a POSIX path: collapses repeated slashes, resolves `.` and `..`
 * segments, and preserves a leading `/`.
 */
export function normalizePath(p: string): string {
	const absolute = p.startsWith("/");
	const out: string[] = absolute ? [""] : [];
	const floor = absolute ? 1 : 0;

	for (const segment of p.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (out.length > floor) {
				out.pop();
			} else if (absolute) {
				out.push("");
			}
			continue;
		}
		out.push(segment);
	}

	if (out.length === 0) return ".";
	return out.join("/");
}
