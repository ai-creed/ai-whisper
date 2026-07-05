/**
 * Scan free-form provider stdout and return every balanced top-level `{...}`
 * substring, in source order. Brace tracking is string-aware: braces inside JSON
 * string literals (and escaped quotes) are ignored, so an object whose values
 * contain `{` / `}` is still extracted whole. Nested objects are folded into
 * their enclosing top-level candidate rather than returned separately.
 *
 * Cloned verbatim from `adapter-codex/src/parse-codex-output.ts`'s private
 * helper so both the Codex and Cursor parsers can recover a JSON reply that a
 * model wrapped in prose or code fences. (Codex's local copy is intentionally
 * left in place for now; deduplicating it is a later, separate change.)
 */
export function extractJsonObjectCandidates(stdout: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let index = 0; index < stdout.length; index += 1) {
		const char = stdout[index];

		if (start !== -1 && inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (char === "\\") {
				escaping = true;
				continue;
			}
			if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "{") {
			if (depth === 0) {
				start = index;
			}
			depth += 1;
			continue;
		}

		if (depth === 0) {
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0 && start !== -1) {
				candidates.push(stdout.slice(start, index + 1));
				start = -1;
			}
		}
	}

	return candidates;
}
