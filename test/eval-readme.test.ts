import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("eval/README.md", () => {
	const md = readFileSync(join(import.meta.dirname, "../eval/README.md"), "utf8");
	it("documents every runner command and the authoring rules", () => {
		for (const s of ["pnpm eval -- toolchain", "--toolchain-root", "pnpm eval -- init", "pnpm eval -- slice", "pnpm eval -- grade", "pnpm eval -- report", "pnpm eval -- validate-tasks --green", "pnpm eval:dry-run", "approach.md", "grade/", "budget.json", "meta.json", "not metered", "harness failure", "FINDING: ", "--workspace-root", "outside the repository", "--billing", "claude auth status", "notional", "usage limit", "exits 4"]) {
			expect(md, s).toContain(s);
		}
	});
});
