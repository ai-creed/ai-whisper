import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../eval/runner/workspace.ts";
import type { TaskMeta } from "../eval/runner/types.ts";

describe("prepareWorkspace", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("copies the fixture, links the toolchain, and commits a git baseline", () => {
		root = mkdtempSync(join(tmpdir(), "eval-ws-"));
		const taskDir = join(root, "task");
		mkdirSync(join(taskDir, "fixture", "src"), { recursive: true });
		mkdirSync(join(taskDir, "fixture", "node_modules", "junk"), { recursive: true });
		writeFileSync(join(taskDir, "fixture", "src", "a.ts"), "export const a = 1;\n");
		mkdirSync(join(taskDir, "grade")); writeFileSync(join(taskDir, "grade", "secret.grade.test.ts"), "// held out\n");
		symlinkSync(join(taskDir, "grade"), join(taskDir, "fixture", "src", "answers"), "dir"); // must NOT survive the copy
		const toolchain = join(root, "toolchain-nm");
		mkdirSync(join(toolchain, ".bin"), { recursive: true });
		const task = { slug: "t", dir: taskDir } as TaskMeta;
		const dest = join(root, "ws");
		const { workspaceDir, baselineSha } = prepareWorkspace({ task, dest, toolchainNodeModules: toolchain });
		expect(workspaceDir).toBe(dest); // the path as given, even though tmpdir() may be a symlink alias on macOS
		expect(readFileSync(join(dest, "src", "a.ts"), "utf8")).toContain("a = 1");
		expect(existsSync(join(dest, "node_modules", "junk"))).toBe(false);
		expect(existsSync(join(dest, "src", "answers"))).toBe(false); // symlink to grade/ dropped by the lstat filter
		expect(lstatSync(join(dest, "node_modules")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(dest, ".gitignore"), "utf8")).toMatch(/node_modules\/\n\.ai-whisper\//);
		expect(baselineSha).toMatch(/^[0-9a-f]{40}$/);
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: dest, encoding: "utf8" })).toBe("");
	});
	it("returns the destination as given when it is reached through a symlink alias outside the repo", () => {
		root = mkdtempSync(join(tmpdir(), "eval-ws-"));
		const taskDir = join(root, "task"); mkdirSync(join(taskDir, "fixture"), { recursive: true });
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"), "dir");
		const dest = join(root, "alias", "ws");
		const { workspaceDir } = prepareWorkspace({ task: { slug: "t", dir: taskDir } as TaskMeta, dest, toolchainNodeModules: root, repoRoot: join(root, "repo") });
		expect(workspaceDir).toBe(dest);
		expect(existsSync(join(root, "real", "ws", ".gitignore"))).toBe(true);
	});
	it("resolves a relative toolchain path so the link target is the guarded absolute path", () => {
		root = mkdtempSync(join(tmpdir(), "eval-ws-"));
		const taskDir = join(root, "task"); mkdirSync(join(taskDir, "fixture"), { recursive: true });
		const toolchainDir = join(root, "toolchain-nm"); mkdirSync(toolchainDir);
		const dest = join(root, "ws");
		prepareWorkspace({ task: { slug: "t", dir: taskDir } as TaskMeta, dest, toolchainNodeModules: relative(process.cwd(), toolchainDir) });
		expect(readlinkSync(join(dest, "node_modules"))).toBe(resolve(toolchainDir));
	});
	it("refuses a destination inside the repository (held-out isolation)", () => {
		root = mkdtempSync(join(tmpdir(), "eval-ws-"));
		const task = { slug: "t", dir: join(root, "task") } as TaskMeta;
		mkdirSync(join(root, "task", "fixture"), { recursive: true });
		const fakeRepo = join(root, "repo"); mkdirSync(fakeRepo);
		expect(() => prepareWorkspace({ task, dest: join(fakeRepo, "eval", "results", "x", "workspace"), toolchainNodeModules: root, repoRoot: fakeRepo })).toThrow(/workspace must live outside the repository/);
		expect(() => prepareWorkspace({ task, dest: join(root, "ws"), toolchainNodeModules: join(fakeRepo, "eval", "toolchain", "node_modules"), repoRoot: fakeRepo })).toThrow(/toolchain must live outside the repository/);
		// symlink alias regression: an "external" path that is physically inside the repo
		mkdirSync(join(fakeRepo, "eval"), { recursive: true });
		symlinkSync(join(fakeRepo, "eval"), join(root, "outside-looking"), "dir");
		expect(() => prepareWorkspace({ task, dest: join(root, "outside-looking", "ws"), toolchainNodeModules: root, repoRoot: fakeRepo })).toThrow(/workspace must live outside the repository/);
		expect(() => prepareWorkspace({ task, dest: join(root, "ws2"), toolchainNodeModules: join(root, "outside-looking", "node_modules"), repoRoot: fakeRepo })).toThrow(/toolchain must live outside the repository/);
	});
});
