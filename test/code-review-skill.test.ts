import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSkillInstall } from "../packages/cli/src/commands/skill/install.ts";

// ESM-correct repo root (matches the codebase's module type; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceSkillsDir = join(repoRoot, "packages/cli/skills");
const reviewSkill = join(sourceSkillsDir, "ai-whisper-code-review", "SKILL.md");

/** Run the real build copy from the real source skills dir into a temp dest. */
function copyRealSkills(): string {
	const dest = mkdtempSync(join(tmpdir(), "aiw-codereview-dist-"));
	execFileSync(
		process.execPath,
		[
			join(repoRoot, "packages/cli/scripts/copy-skills.mjs"),
			"--src",
			sourceSkillsDir,
			"--dest",
			join(dest, "skills"),
		],
		{ stdio: "pipe" },
	);
	return join(dest, "skills");
}

describe("ai-whisper-code-review skill content", () => {
	const txt = readFileSync(reviewSkill, "utf8");

	it("source SKILL.md exists and names itself in frontmatter", () => {
		expect(existsSync(reviewSkill)).toBe(true);
		expect(txt).toMatch(/^name:\s*ai-whisper-code-review\s*$/m);
	});

	it("description targets code review of workflow code artifacts", () => {
		// Frontmatter description line.
		const desc = txt.split("\n").find((l) => l.startsWith("description:")) ?? "";
		expect(desc).toMatch(/code review/i);
		expect(desc).toMatch(/implementation output|commit ranges|bug fixes/i);
	});

	it("body says the workflow handoff controls the output format", () => {
		expect(txt).toMatch(/workflow handoff controls the output format/i);
	});

	it("body forbids emitting workflow control labels", () => {
		expect(txt).toMatch(/Do not emit workflow control labels/i);
		// dotAll: the three labels wrap across a line break in the body.
		expect(txt).toMatch(/approve.*findings.*escalate/s);
	});

	it("body names the Findings: section", () => {
		expect(txt).toContain("`Findings:`");
	});

	it("body names Non-blocking risks: AS THE TRAILING/FINAL section", () => {
		// Mere presence of the string is not enough — the spec requires the body
		// to describe `Non-blocking risks:` as the LAST section, because
		// separateReviewSections() strips from the last such header onward.
		expect(txt).toContain("`Non-blocking risks:`");
		expect(txt).toMatch(/`Non-blocking risks:`[^.]*\b(final|last|trailing)\b/i);
	});
});

describe("ai-whisper-code-review skill build + install", () => {
	it("ships into the post-build bundled dir alongside the other skills", () => {
		const bundled = copyRealSkills();
		expect(
			existsSync(join(bundled, "ai-whisper-code-review", "SKILL.md")),
		).toBe(true);
		expect(existsSync(join(bundled, "ai-whisper-sdd", "SKILL.md"))).toBe(true);
	});

	it("install enumerates it into BOTH ~/.claude and ~/.codex", async () => {
		const bundled = copyRealSkills();
		const home = mkdtempSync(join(tmpdir(), "aiw-codereview-home-"));
		await runSkillInstall({
			target: "all",
			fakeHome: home,
			bundledSkillsDir: bundled,
		});
		expect(
			existsSync(
				join(home, ".claude", "skills", "ai-whisper-code-review", "SKILL.md"),
			),
		).toBe(true);
		expect(
			existsSync(
				join(home, ".codex", "skills", "ai-whisper-code-review", "SKILL.md"),
			),
		).toBe(true);
	});
});
