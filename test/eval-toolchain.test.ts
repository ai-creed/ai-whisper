import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureToolchain } from "../eval/runner/toolchain.ts";

describe("eval toolchain", () => {
	it("pins the fixture devDependencies the fixtures rely on", () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dirname, "../eval/toolchain/package.json"), "utf8"),
		) as { private: boolean; devDependencies: Record<string, string> };
		expect(pkg.private).toBe(true);
		for (const dep of ["typescript", "vitest", "eslint", "@eslint/js", "typescript-eslint", "@types/node"]) {
			expect(pkg.devDependencies[dep], dep).toMatch(/^\d/);
		}
	});
});

describe("ensureToolchain", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("installs once outside the repo and skips when the lockfile is unchanged", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tc-"));
		const repoRoot = join(root, "repo"); mkdirSync(join(repoRoot, "eval", "toolchain"), { recursive: true });
		writeFileSync(join(repoRoot, "eval", "toolchain", "package.json"), "{}"); writeFileSync(join(repoRoot, "eval", "toolchain", "pnpm-lock.yaml"), "lock-v1");
		const installs: string[] = [];
		const install = (dir: string) => { installs.push(dir); mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true }); };
		const tc = join(root, "outside-toolchain"); // note: `root` is NOT realpath'd here — on macOS tmpdir() is an alias, and the return value must still equal the path as given
		expect(ensureToolchain({ repoRoot, toolchainRoot: tc, install })).toBe(join(tc, "node_modules"));
		ensureToolchain({ repoRoot, toolchainRoot: tc, install });
		expect(installs).toEqual([tc]);
		writeFileSync(join(repoRoot, "eval", "toolchain", "pnpm-lock.yaml"), "lock-v2");
		ensureToolchain({ repoRoot, toolchainRoot: tc, install });
		expect(installs).toHaveLength(2);
	});
	it("refuses a toolchain root inside the repo", () => {
		root = mkdtempSync(join(tmpdir(), "eval-tc-"));
		const repoRoot = join(root, "repo"); mkdirSync(join(repoRoot, "eval", "toolchain"), { recursive: true });
		expect(() => ensureToolchain({ repoRoot, toolchainRoot: join(repoRoot, "eval", "toolchain"), install: () => {} })).toThrow(/outside the repository/);
		symlinkSync(join(repoRoot, "eval"), join(root, "tc-alias"), "dir");
		expect(() => ensureToolchain({ repoRoot, toolchainRoot: join(root, "tc-alias", "toolchain-install"), install: () => {} })).toThrow(/outside the repository/);
	});
});
