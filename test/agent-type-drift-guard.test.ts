import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The contract (see the M6 spec, Work area 1): AgentType is the single canonical
// agent-type union. No active-source module may inline-declare an agent-type
// union — neither the two-agent "codex" | "claude" (any order) nor the
// three-agent "codex" | "claude" | "ezio" (any order). Sentinel forms
// (AgentType | "none" | null | "all") are allowed because the sentinel is not an
// agent literal, so this pattern — two ADJACENT agent literals joined by | —
// never matches them.
const INLINE_AGENT_UNION = /"(codex|claude|ezio)"\s*\|\s*"(codex|claude|ezio)"/;

// ESM-safe: the repo root package.json has "type": "module", so __dirname does
// not exist. Resolve packages/ relative to this test file's URL (this file lives
// in test/, so ../packages/ is the repo packages dir).
const PKG_ROOT = fileURLToPath(new URL("../packages/", import.meta.url));

// Excluded: dist (build output), deprecated (dead code), node_modules, *.test.ts
// fixtures, and the canonical definition file itself.
function isExcluded(abs: string): boolean {
	return (
		abs.includes(`${path.sep}dist${path.sep}`) ||
		abs.includes(`${path.sep}deprecated${path.sep}`) ||
		abs.includes(`${path.sep}node_modules${path.sep}`) ||
		abs.endsWith(".test.ts") ||
		abs.endsWith(path.join("shared", "src", "literals.ts"))
	);
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const abs = path.join(dir, entry);
		if (statSync(abs).isDirectory()) {
			if (entry === "node_modules" || entry === "dist" || entry === "deprecated") continue;
			out.push(...walk(abs));
		} else if (abs.endsWith(".ts") && !isExcluded(abs)) {
			out.push(abs);
		}
	}
	return out;
}

describe("AgentType drift guard", () => {
	it("no active-source .ts file inline-declares an agent-type union", () => {
		const offenders: string[] = [];
		for (const file of walk(PKG_ROOT)) {
			const text = readFileSync(file, "utf8");
			text.split("\n").forEach((line, i) => {
				if (INLINE_AGENT_UNION.test(line)) {
					offenders.push(`${path.relative(PKG_ROOT, file)}:${i + 1}  ${line.trim()}`);
				}
			});
		}
		expect(offenders, `inline agent-type unions must use AgentType:\n${offenders.join("\n")}`).toEqual([]);
	});
});
