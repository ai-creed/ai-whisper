import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSkillVersionBumps } from "../scripts/check-skill-version-bump.mjs";

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function initRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "aiw-vbump-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "test@test"]);
	git(root, ["config", "user.name", "test"]);
	return root;
}

function writeSkill(root: string, name: string, version: string, body: string): void {
	const dir = join(root, "packages", "cli", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: ${version}\n---\n${body}\n`);
}

function commitAll(root: string, msg: string): string {
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", msg]);
	return git(root, ["rev-parse", "HEAD"]).trim();
}

describe("checkSkillVersionBumps", () => {
	it("flags content changes without a version bump", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const base = commitAll(root, "base");
		writeSkill(root, "skill-a", "0.1.0", "EDITED");
		commitAll(root, "edit without bump");
		const violations = checkSkillVersionBumps({ repoRoot: root, baseRef: base });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.skill).toBe("skill-a");
	});

	it("passes when the version is bumped alongside the content change", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const base = commitAll(root, "base");
		writeSkill(root, "skill-a", "0.2.0", "EDITED");
		commitAll(root, "edit with bump");
		expect(checkSkillVersionBumps({ repoRoot: root, baseRef: base })).toHaveLength(0);
	});

	it("ignores untouched skills and accepts brand-new skill dirs", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const base = commitAll(root, "base");
		writeSkill(root, "skill-new", "0.1.0", "fresh");
		commitAll(root, "add new skill");
		expect(checkSkillVersionBumps({ repoRoot: root, baseRef: base })).toHaveLength(0);
	});

	it("flags non-SKILL.md content changes (evals fixtures) without a bump", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const evalsDir = join(root, "packages", "cli", "skills", "skill-a", "evals");
		mkdirSync(evalsDir, { recursive: true });
		writeFileSync(join(evalsDir, "evals.json"), "[]");
		const base = commitAll(root, "base");
		writeFileSync(join(evalsDir, "evals.json"), '[{"changed":true}]');
		commitAll(root, "edit evals without bump");
		const violations = checkSkillVersionBumps({ repoRoot: root, baseRef: base });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.skill).toBe("skill-a");
	});

	it("flags a changed skill whose HEAD SKILL.md has no valid version", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const base = commitAll(root, "base");
		const dir = join(root, "packages", "cli", "skills", "skill-a");
		writeFileSync(join(dir, "SKILL.md"), "---\nname: skill-a\n---\nno version anymore\n");
		commitAll(root, "drop version");
		const violations = checkSkillVersionBumps({ repoRoot: root, baseRef: base });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.reason).toMatch(/no valid version/i);
	});

	it("ignores a skill dir removed at HEAD", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.1.0", "original");
		const base = commitAll(root, "base");
		execFileSync("git", ["rm", "-rq", "packages/cli/skills/skill-a"], { cwd: root });
		commitAll(root, "remove skill");
		expect(checkSkillVersionBumps({ repoRoot: root, baseRef: base })).toHaveLength(0);
	});

	it("flags a decrement even though the version changed (monotonic bump required)", () => {
		const root = initRepo();
		writeSkill(root, "skill-a", "0.2.0", "original");
		const base = commitAll(root, "base");
		writeSkill(root, "skill-a", "0.1.0", "EDITED");
		commitAll(root, "edit with a version decrement");
		const violations = checkSkillVersionBumps({ repoRoot: root, baseRef: base });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.skill).toBe("skill-a");
		expect(violations[0]?.reason).toMatch(/must increase/i);
	});

	it("given the PR merge-base as baseRef, ignores a skill only changed on the base branch after the fork point", () => {
		const root = initRepo();
		// Common ancestor: skill-a and skill-b both exist here.
		writeSkill(root, "skill-a", "0.1.0", "original-a");
		writeSkill(root, "skill-b", "0.1.0", "original-b");
		const mergeBase = commitAll(root, "base");

		// Base branch (e.g. main) keeps moving after the PR forked off: bumps
		// skill-a. A raw two-dot diff against this later base-branch tip (instead
		// of the merge-base) would spuriously see skill-a's content differ from
		// the PR branch and misattribute that to the PR.
		writeSkill(root, "skill-a", "0.2.0", "changed-on-main-after-fork");
		commitAll(root, "main moves on without the PR");

		// PR branch forks from the merge-base, not from main's later tip, and
		// only ever touches skill-b (with a proper bump).
		git(root, ["checkout", "-q", "-b", "pr", mergeBase]);
		writeSkill(root, "skill-b", "0.2.0", "edited-b");
		commitAll(root, "PR edits skill-b with a bump");

		// HEAD is now the PR branch. Diffing against the true merge-base must
		// not flag skill-a (untouched on the PR branch) and must accept
		// skill-b's proper bump.
		const violations = checkSkillVersionBumps({ repoRoot: root, baseRef: mergeBase });
		expect(violations).toHaveLength(0);
	});
});
