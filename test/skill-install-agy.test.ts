import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSkillInstall } from "../packages/cli/src/commands/skill/install.ts";

function makeBundledSkills(): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-skills-"));
	mkdirSync(join(dir, "demo-skill"), { recursive: true });
	writeFileSync(join(dir, "demo-skill", "SKILL.md"), "# demo");
	return dir;
}

describe("skill install --target agy", () => {
	it("installs into ~/.gemini/config/skills", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "agy-home-"));
		const result = await runSkillInstall({
			target: "agy",
			fakeHome,
			bundledSkillsDir: makeBundledSkills(),
		});
		expect(result.installedAt[0]).toBe(
			join(fakeHome, ".gemini", "config", "skills", "demo-skill", "SKILL.md"),
		);
	});

	it("includes agy in --target all", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "agy-home-all-"));
		const result = await runSkillInstall({
			target: "all",
			fakeHome,
			bundledSkillsDir: makeBundledSkills(),
		});
		expect(result.installedAt.some((p) => p.includes(join(".gemini", "config", "skills")))).toBe(true);
	});
});
