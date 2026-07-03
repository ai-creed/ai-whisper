import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ESM-correct repo root (matches the codebase's module type; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceSkillsDir = join(repoRoot, "packages/cli/skills");
const quickTaskSkill = join(sourceSkillsDir, "ai-whisper-quick-task", "SKILL.md");

/** Run the real build copy from the real source skills dir into a temp dest. */
function copyRealSkills(): string {
	const dest = mkdtempSync(join(tmpdir(), "aiw-quick-task-dist-"));
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

describe("ai-whisper-quick-task skill", () => {
	it("source SKILL.md names itself and pins the quick-task type", () => {
		const md = readFileSync(quickTaskSkill, "utf8");
		expect(md).toMatch(/^name:\s*ai-whisper-quick-task\s*$/m);
		expect(md).toContain("whisper workflow start --type=quick-task");
		expect(md).not.toContain("--type=spec-driven-development");
		expect(md).not.toContain("--type=complex-bug-fixing");
	});

	it("keeps the readiness gate, is fire-and-forget, and carries operator control", () => {
		const md = readFileSync(quickTaskSkill, "utf8");
		expect(md).toContain("whisper collab status --json");
		expect(md).toMatch(/fire-and-forget/i);
		expect(md).toMatch(/do NOT (continue )?poll/i);
		expect(md).toContain("whisper workflow pause");
		expect(md).toContain("whisper workflow resume");
	});

	it("embeds all four brief template headings and the tasks directory location", () => {
		const md = readFileSync(quickTaskSkill, "utf8");
		expect(md).toContain("## Task");
		expect(md).toContain("## Approved approach");
		expect(md).toContain("## Scope");
		expect(md).toContain("## Acceptance checks");
		expect(md).toContain(".ai-whisper/tasks/");
	});

	it("carries the verbatim-relay rule and the never-shrink-scope rule", () => {
		const md = readFileSync(quickTaskSkill, "utf8");
		expect(md).toMatch(/verbatim/i);
		expect(md).toMatch(/do NOT silently (rewrite|shrink)/i);
	});

	it("carries the executability pre-check recommending spec-driven-development", () => {
		const md = readFileSync(quickTaskSkill, "utf8");
		expect(md).toMatch(/executable right away/i);
		expect(md).toMatch(/spec-driven-development/i);
	});

	it("ships into the post-build bundled dir, alongside ai-whisper-sdd", () => {
		const bundled = copyRealSkills();
		const bundledQuickTask = join(bundled, "ai-whisper-quick-task", "SKILL.md");
		expect(existsSync(bundledQuickTask)).toBe(true);
		expect(existsSync(join(bundled, "ai-whisper-sdd", "SKILL.md"))).toBe(true);
		expect(readFileSync(bundledQuickTask, "utf8")).toContain("--type=quick-task");
	});
});
