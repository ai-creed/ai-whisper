import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSkillInstall } from "../packages/cli/src/commands/skill/install.ts";

// ESM-correct repo root (matches code-review-skill.test.ts; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceSkillsDir = join(repoRoot, "packages/cli/skills");
const planExecSkill = join(
	sourceSkillsDir,
	"ai-whisper-plan-execution",
	"SKILL.md",
);

/** Run the real build copy from the real source skills dir into a temp dest. */
function copyRealSkills(): string {
	const dest = mkdtempSync(join(tmpdir(), "aiw-planexec-dist-"));
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

describe("ai-whisper-plan-execution skill content", () => {
	const txt = readFileSync(planExecSkill, "utf8");

	it("source SKILL.md exists and names itself in frontmatter", () => {
		expect(existsSync(planExecSkill)).toBe(true);
		expect(txt).toMatch(/^name:\s*ai-whisper-plan-execution\s*$/m);
	});

	it("description gates to the implementer inside an autonomous workflow", () => {
		const desc = txt.split("\n").find((l) => l.startsWith("description:")) ?? "";
		expect(desc).toMatch(/autonomous workflow/i);
		expect(desc).toMatch(/implementation plan|plan-execution/i);
		expect(desc).toMatch(/implementer/i);
	});

	it("mandates superpowers:subagent-driven-development when available", () => {
		expect(txt).toContain("superpowers:subagent-driven-development");
		expect(txt).toMatch(/MUST invoke/);
	});

	it("defines the built-in fallback protocol and forbids parallel dispatch", () => {
		expect(txt).toMatch(/built-in minimal protocol/i);
		expect(txt).toMatch(/Never dispatch implementation subagents in parallel/i);
	});

	it("carries the model table with both invariants and no versioned model names", () => {
		expect(txt).toContain("reviewer tier ≥ implementer tier");
		expect(txt).toMatch(/2nd failed review/);
		expect(txt).not.toMatch(/claude-(opus|sonnet|haiku)-\d/);
	});

	it("defines the inline escape with mandatory mode disclosure", () => {
		expect(txt).toContain("≤2 tasks");
		expect(txt).toMatch(/name the execution mode/i);
	});

	it("lists all three execution-mode strings", () => {
		expect(txt).toContain("subagent-driven (superpowers)");
		expect(txt).toContain("subagent-driven (built-in protocol)");
		expect(txt).toContain("inline (");
	});

	it("keeps Path B non-blocking for harnesses without subagent dispatch", () => {
		// The phrase hard-wraps after "your" (lines 99-100: "...changes your\n
		// handback"), so match against a whitespace-normalized copy.
		const norm = (s: string) => s.replace(/\s+/g, " ");
		expect(norm(txt)).toMatch(
			/nothing in this skill blocks or changes your handback/i,
		);
	});

	it("keeps the workflow prompt authoritative", () => {
		expect(txt).toMatch(/workflow prompt is authoritative/i);
	});
});

describe("ai-whisper-plan-execution skill build + install", () => {
	it("ships into the post-build bundled dir alongside the other skills", () => {
		const bundled = copyRealSkills();
		expect(
			existsSync(join(bundled, "ai-whisper-plan-execution", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(bundled, "ai-whisper-code-review", "SKILL.md")),
		).toBe(true);
	});

	it("install enumerates it into the claude, codex, and ezio skill dirs", async () => {
		const bundled = copyRealSkills();
		const home = mkdtempSync(join(tmpdir(), "aiw-planexec-home-"));
		await runSkillInstall({
			target: "all",
			fakeHome: home,
			bundledSkillsDir: bundled,
		});
		expect(
			existsSync(
				join(home, ".claude", "skills", "ai-whisper-plan-execution", "SKILL.md"),
			),
		).toBe(true);
		expect(
			existsSync(
				join(home, ".codex", "skills", "ai-whisper-plan-execution", "SKILL.md"),
			),
		).toBe(true);
		// Ezio dest derives strictly from fakeHome (homeForTarget ignores ambient
		// XDG_CONFIG_HOME under a fakeHome override), so this path is deterministic.
		expect(
			existsSync(
				join(
					home,
					".config",
					"ai-ezio",
					"skills",
					"ai-whisper-plan-execution",
					"SKILL.md",
				),
			),
		).toBe(true);
	});
});
