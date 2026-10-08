import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("eval/ repo wiring", () => {
	it("root tsconfig typechecks the runner", () => {
		const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as { include: string[] };
		expect(tsconfig.include).toContain("eval/runner/**/*.ts");
	});
	it("eslint ignores fixtures, toolchain and results but not the runner", () => {
		const cfg = readFileSync(join(root, "eslint.config.mjs"), "utf8");
		expect(cfg).toContain("\"eval/tasks/**\"");
		expect(cfg).toContain("\"eval/toolchain/**\"");
		expect(cfg).toContain("\"eval/results/**\"");
		expect(cfg).not.toContain("\"eval/runner/**\"");
	});
	it("gitignores raw run output and the toolchain install", () => {
		const gi = readFileSync(join(root, ".gitignore"), "utf8");
		expect(gi).toContain("eval/results/*/runs/");
		expect(gi).toContain("eval/toolchain/node_modules/");
		expect(gi).toContain("eval/results/dry-run-*/");
	});
	it("exposes the runner through a root script", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
		expect(pkg.scripts.eval).toBe("tsx eval/runner/cli.ts");
	});
});
