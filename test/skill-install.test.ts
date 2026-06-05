import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSkillInstall } from "../packages/cli/src/commands/skill/install.ts";

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "aiw-skill-home-"));
	const cliDist = mkdtempSync(join(tmpdir(), "aiw-skill-dist-"));
	const skillsSrc = join(cliDist, "skills", "ai-whisper-sdd");
	mkdirSync(skillsSrc, { recursive: true });
	writeFileSync(join(skillsSrc, "SKILL.md"), "---\nname: ai-whisper-sdd\n---\nbody");
	return { home, cliDist };
}

describe("runSkillInstall", () => {
	it("--target=all copies to both ~/.claude/skills/ and ~/.codex/skills/", async () => {
		const s = sandbox();
		const result = await runSkillInstall({
			target: "all",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
		});
		expect(result.installedAt).toContain(
			join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
		);
		expect(result.installedAt).toContain(
			join(s.home, ".codex", "skills", "ai-whisper-sdd", "SKILL.md"),
		);
		expect(
			readFileSync(
				join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
				"utf8",
			),
		).toContain("ai-whisper-sdd");
	});

	it("--target=claude copies to only ~/.claude/skills/", async () => {
		const s = sandbox();
		await runSkillInstall({
			target: "claude",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
		});
		expect(
			existsSync(join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md")),
		).toBe(true);
		expect(existsSync(join(s.home, ".codex"))).toBe(false);
	});

	it("--target=codex copies to only ~/.codex/skills/", async () => {
		const s = sandbox();
		await runSkillInstall({
			target: "codex",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
		});
		expect(
			existsSync(join(s.home, ".codex", "skills", "ai-whisper-sdd", "SKILL.md")),
		).toBe(true);
		expect(existsSync(join(s.home, ".claude"))).toBe(false);
	});

	it("without --force, existing destinations are NOT overwritten and the command reports the conflict", async () => {
		const s = sandbox();
		mkdirSync(join(s.home, ".claude", "skills", "ai-whisper-sdd"), { recursive: true });
		writeFileSync(
			join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
			"EXISTING",
		);
		await expect(
			runSkillInstall({
				target: "claude",
				fakeHome: s.home,
				bundledSkillsDir: join(s.cliDist, "skills"),
				force: false,
			}),
		).rejects.toThrow(/already exists|--force/);
		expect(
			readFileSync(
				join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
				"utf8",
			),
		).toBe("EXISTING");
	});

	it("--force overwrites existing destinations", async () => {
		const s = sandbox();
		mkdirSync(join(s.home, ".claude", "skills", "ai-whisper-sdd"), { recursive: true });
		writeFileSync(
			join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
			"EXISTING",
		);
		await runSkillInstall({
			target: "claude",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
			force: true,
		});
		expect(
			readFileSync(
				join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
				"utf8",
			),
		).toContain("ai-whisper-sdd");
	});

	it("missing bundled-skills directory errors with a pointer to `pnpm build`", async () => {
		await expect(
			runSkillInstall({
				target: "all",
				fakeHome: "/tmp/aiw-irrelevant",
				bundledSkillsDir: "/tmp/aiw-nonexistent-skills",
			}),
		).rejects.toThrow(/pnpm build|build/i);
	});

	it("invalid --target value is rejected at runtime (not silently routed to .codex)", async () => {
		// homeForTarget's ternary maps non-"claude" to .codex by default, so
		// before this guard `--target=banana` would silently install into
		// ~/.codex/skills. Reject at runtime regardless of CLI-layer choices().
		await expect(
			runSkillInstall({
				target: "banana" as never,
				fakeHome: "/tmp/aiw-skill-typo-irrelevant",
				bundledSkillsDir: "/tmp/aiw-skill-typo-irrelevant-src",
			}),
		).rejects.toThrow(/invalid --target.*claude.*codex.*all/i);
	});

	it("empty bundled-skills directory errors clearly", async () => {
		const home = mkdtempSync(join(tmpdir(), "aiw-skill-home-empty-"));
		const cliDist = mkdtempSync(join(tmpdir(), "aiw-skill-dist-empty-"));
		mkdirSync(join(cliDist, "skills"), { recursive: true });
		await expect(
			runSkillInstall({
				target: "all",
				fakeHome: home,
				bundledSkillsDir: join(cliDist, "skills"),
			}),
		).rejects.toThrow(/no skills/i);
	});
});

describe("runSkillInstall — ezio target (M6)", () => {
	it("installs into ${XDG_CONFIG_HOME or $HOME/.config}/ai-ezio/skills", async () => {
		const prevXdg = process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_CONFIG_HOME; // force the $HOME/.config fallback for determinism
		try {
			const s = sandbox();
			const result = await runSkillInstall({
				target: "ezio",
				fakeHome: s.home,
				bundledSkillsDir: join(s.cliDist, "skills"),
			});
			expect(result.installedAt).toContain(
				join(s.home, ".config", "ai-ezio", "skills", "ai-whisper-sdd", "SKILL.md"),
			);
		} finally {
			if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
		}
	});

	it("--target=all installs to claude, codex, AND ezio", async () => {
		const prevXdg = process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_CONFIG_HOME;
		try {
			const s = sandbox();
			const result = await runSkillInstall({
				target: "all",
				fakeHome: s.home,
				bundledSkillsDir: join(s.cliDist, "skills"),
			});
			const joined = result.installedAt.join("\n");
			expect(joined).toMatch(/[/\\]\.claude[/\\]skills/);
			expect(joined).toMatch(/[/\\]\.codex[/\\]skills/);
			expect(joined).toMatch(/ai-ezio[/\\]skills/);
		} finally {
			if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
		}
	});
});
