import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertOutsideRepo } from "./paths.ts";

export const DEFAULT_TOOLCHAIN_ROOT = join(homedir(), ".ai-whisper-eval", "toolchain");

const defaultInstall = (dir: string): void => {
	execFileSync("pnpm", ["install", "--frozen-lockfile", "--dir", dir], { stdio: "inherit" });
};

/** Install the fixture toolchain OUTSIDE the repo so a workspace's node_modules symlink never resolves into it. */
export function ensureToolchain(input: { repoRoot: string; toolchainRoot: string; install?: (dir: string) => void }): string {
	const repoRoot = resolve(input.repoRoot);
	const root = resolve(input.toolchainRoot);
	assertOutsideRepo("toolchain root", root, repoRoot); // physical, symlink-resolved comparison; `root` itself stays as given
	const src = join(repoRoot, "eval", "toolchain");
	mkdirSync(root, { recursive: true });
	const lock = readFileSync(join(src, "pnpm-lock.yaml"));
	const hash = createHash("sha256").update(lock).digest("hex");
	const stamp = join(root, ".lock-sha256");
	const nodeModules = join(root, "node_modules");
	const current = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
	if (!existsSync(nodeModules) || current !== hash) {
		copyFileSync(join(src, "package.json"), join(root, "package.json"));
		writeFileSync(join(root, "pnpm-lock.yaml"), lock);
		(input.install ?? defaultInstall)(root);
		writeFileSync(stamp, hash + "\n");
	}
	return nodeModules;
}
