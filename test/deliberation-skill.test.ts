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
const deliberationSkill = join(sourceSkillsDir, "ai-whisper-deliberation", "SKILL.md");

/** Run the real build copy from the real source skills dir into a temp dest. */
function copyRealSkills(): string {
	const dest = mkdtempSync(join(tmpdir(), "aiw-deliberation-dist-"));
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

describe("ai-whisper-deliberation skill", () => {
	it("source SKILL.md names itself and pins the deliberation type", () => {
		const md = readFileSync(deliberationSkill, "utf8");
		expect(md).toMatch(/^name:\s*ai-whisper-deliberation\s*$/m);
		expect(md).toContain("whisper workflow start --type=deliberation");
		expect(md).not.toContain("--type=spec-driven-development");
		expect(md).not.toContain("--type=complex-bug-fixing");
	});

	it("keeps the readiness gate, is fire-and-forget, and carries operator control", () => {
		const md = readFileSync(deliberationSkill, "utf8");
		expect(md).toContain("whisper collab status --json");
		expect(md).toMatch(/fire-and-forget/i);
		expect(md).toMatch(/do NOT (continue )?poll/i);
		expect(md).toContain("whisper workflow pause");
		expect(md).toContain("whisper workflow resume");
	});

	it("ships into the post-build bundled dir, alongside ai-whisper-sdd", () => {
		const bundled = copyRealSkills();
		const bundledDeliberation = join(bundled, "ai-whisper-deliberation", "SKILL.md");
		expect(existsSync(bundledDeliberation)).toBe(true);
		expect(existsSync(join(bundled, "ai-whisper-sdd", "SKILL.md"))).toBe(true);
		expect(readFileSync(bundledDeliberation, "utf8")).toContain("--type=deliberation");
	});

	it("install enumerates it into BOTH ~/.claude and ~/.codex", async () => {
		const bundled = copyRealSkills();
		const home = mkdtempSync(join(tmpdir(), "aiw-deliberation-home-"));
		await runSkillInstall({ target: "all", fakeHome: home, bundledSkillsDir: bundled });
		expect(
			existsSync(join(home, ".claude", "skills", "ai-whisper-deliberation", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(home, ".codex", "skills", "ai-whisper-deliberation", "SKILL.md")),
		).toBe(true);
	});
});
