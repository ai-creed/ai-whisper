import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("workspace foundation", () => {
	it("declares the root workspace scripts and pnpm workspace file", () => {
		const packageJsonPath = resolve(root, "package.json");
		const workspacePath = resolve(root, "pnpm-workspace.yaml");

		expect(existsSync(packageJsonPath)).toBe(true);
		expect(existsSync(workspacePath)).toBe(true);

		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			scripts?: Record<string, string>;
		};

		expect(pkg.scripts?.build).toBe("pnpm -r --if-present build");
		expect(pkg.scripts?.test).toBe("vitest run");
		expect(pkg.scripts?.typecheck).toBe(
			"node packages/cli/scripts/stamp-ezio-provenance.mjs && tsc --noEmit -p tsconfig.json && pnpm -r --if-present typecheck",
		);
		expect(pkg.scripts?.lint).toBe("eslint .");
	});
});
