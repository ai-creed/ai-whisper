import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertOutsideRepo } from "./paths.ts";
import type { TaskMeta } from "./types.ts";

const GIT_IDENTITY = ["-c", "user.name=eval-runner", "-c", "user.email=eval-runner@local"];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Fresh fixture copy for one trial: files copied, toolchain linked, git baseline committed. */
export function prepareWorkspace(input: { task: TaskMeta; dest: string; toolchainNodeModules: string; repoRoot?: string }): { workspaceDir: string; baselineSha: string } {
	const repoRoot = input.repoRoot ?? DEFAULT_REPO_ROOT;
	const dest = resolve(input.dest); // as given (not realpath'd): callers and the manifest refer to this string
	assertOutsideRepo("workspace", dest, repoRoot);
	assertOutsideRepo("toolchain", input.toolchainNodeModules, repoRoot); // a workspace's node_modules symlink must not resolve into the repo
	mkdirSync(dest, { recursive: true });
	cpSync(join(input.task.dir, "fixture"), dest, {
		recursive: true,
		// Never copy node_modules, and never carry a symbolic link into the workspace:
		// a link in a fixture could alias grade/ or the repo (validate-tasks rejects
		// them too; this is the second line of defense). lstat so the link itself is
		// inspected, not its target.
		filter: (src) => !/(^|[\\/])node_modules([\\/]|$)/.test(src) && !lstatSync(src).isSymbolicLink(),
	});
	symlinkSync(input.toolchainNodeModules, join(dest, "node_modules"), "dir");
	writeFileSync(join(dest, ".gitignore"), "node_modules/\n.ai-whisper/\n");
	git(dest, ["init", "-q", "-b", "main"]);
	git(dest, ["add", "-A"]);
	git(dest, ["commit", "-q", "-m", "fixture baseline"]);
	return { workspaceDir: dest, baselineSha: git(dest, ["rev-parse", "HEAD"]) };
}
