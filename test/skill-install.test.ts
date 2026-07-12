import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
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

	it("--target=cursor copies to only ~/.cursor/skills/ (not ~/.codex)", async () => {
		const s = sandbox();
		await runSkillInstall({
			target: "cursor",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
		});
		expect(
			existsSync(join(s.home, ".cursor", "skills", "ai-whisper-sdd", "SKILL.md")),
		).toBe(true);
		// Regression guard: the old homeForTarget ternary routed any non-claude
		// target into ~/.codex; cursor must NOT leak there.
		expect(existsSync(join(s.home, ".codex"))).toBe(false);
		expect(existsSync(join(s.home, ".claude"))).toBe(false);
	});

	it("versionless existing destination is upgraded in place without --force (guard supersedes the old conflict throw)", async () => {
		const s = sandbox();
		mkdirSync(join(s.home, ".claude", "skills", "ai-whisper-sdd"), { recursive: true });
		writeFileSync(
			join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
			"EXISTING",
		);
		const result = await runSkillInstall({
			target: "claude",
			fakeHome: s.home,
			bundledSkillsDir: join(s.cliDist, "skills"),
			force: false,
		});
		expect(result.results[0]?.action).toBe("installed");
		expect(
			readFileSync(
				join(s.home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
				"utf8",
			),
		).toContain("ai-whisper-sdd");
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
			expect(joined).toMatch(/[/\\]\.cursor[/\\]skills/);
			expect(joined).toMatch(/ai-ezio[/\\]skills/);
		} finally {
			if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
		}
	});
});

describe("runSkillInstall — version guard (spec 2026-07-12)", () => {
	function md(fm: string[] | null, body: string): string {
		return fm === null ? body : ["---", ...fm, "---", body].join("\n");
	}

	// bundledFm: frontmatter lines for the bundled skill (null = SKILL.md with no frontmatter).
	// installedFm: omit = no pre-existing install; null = installed SKILL.md without frontmatter.
	function guardSandbox(opts: { bundledFm: string[] | null; installedFm?: string[] | null }) {
		const home = mkdtempSync(join(tmpdir(), "aiw-guard-home-"));
		const cliDist = mkdtempSync(join(tmpdir(), "aiw-guard-dist-"));
		const src = join(cliDist, "skills", "ai-whisper-sdd");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "SKILL.md"), md(opts.bundledFm, "BUNDLED"));
		if (opts.installedFm !== undefined) {
			const dest = join(home, ".claude", "skills", "ai-whisper-sdd");
			mkdirSync(dest, { recursive: true });
			writeFileSync(join(dest, "SKILL.md"), md(opts.installedFm, "INSTALLED"));
		}
		return {
			home,
			bundledSkillsDir: join(cliDist, "skills"),
			destSkillMd: join(home, ".claude", "skills", "ai-whisper-sdd", "SKILL.md"),
		};
	}

	it("case 1: missing destination installs", async () => {
		const s = guardSandbox({ bundledFm: ["name: ai-whisper-sdd", "version: 0.1.0"] });
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results).toHaveLength(1);
		expect(r.results[0]).toMatchObject({
			skill: "ai-whisper-sdd", target: "claude", action: "installed",
			bundledVersion: "0.1.0", installedVersion: null,
		});
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("BUNDLED");
		expect(r.installedAt).toContain(s.destSkillMd);
	});

	it("case 2: bundled newer than installed upgrades", async () => {
		const s = guardSandbox({
			bundledFm: ["version: 0.2.0"], installedFm: ["version: 0.1.0"],
		});
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results[0]).toMatchObject({
			action: "installed", bundledVersion: "0.2.0", installedVersion: "0.1.0",
		});
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("BUNDLED");
	});

	it("case 3: equal versions report up-to-date, destination byte-identical, zero writes", async () => {
		const s = guardSandbox({
			bundledFm: ["version: 0.1.0"], installedFm: ["version: 0.1.0"],
		});
		const bytesBefore = readFileSync(s.destSkillMd);
		const mtimeBefore = statSync(s.destSkillMd).mtimeMs;
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results[0]).toMatchObject({ action: "up-to-date" });
		// Zero-writes proof: exact bytes AND mtime unchanged — a copy that
		// happens to rewrite identical content would still move the mtime.
		expect(readFileSync(s.destSkillMd).equals(bytesBefore)).toBe(true);
		expect(statSync(s.destSkillMd).mtimeMs).toBe(mtimeBefore);
		expect(r.installedAt).toHaveLength(0);
	});

	it("case 4: bundled older reports skipped-newer, destination untouched, no throw", async () => {
		const s = guardSandbox({
			bundledFm: ["version: 0.1.0"], installedFm: ["version: 0.2.0"],
		});
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results[0]).toMatchObject({
			action: "skipped-newer", bundledVersion: "0.1.0", installedVersion: "0.2.0",
		});
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("INSTALLED");
		expect(r.installedAt).toHaveLength(0);
	});

	it("case 5: installed copy without a version field is upgraded in place (migration path)", async () => {
		const s = guardSandbox({
			bundledFm: ["version: 0.1.0"], installedFm: ["name: ai-whisper-sdd"],
		});
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results[0]).toMatchObject({
			action: "installed", bundledVersion: "0.1.0", installedVersion: null,
		});
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("BUNDLED");
	});

	it("case 6: --force over a newer installed copy reports forced with the replaced version", async () => {
		const s = guardSandbox({
			bundledFm: ["version: 0.1.0"], installedFm: ["version: 0.2.0"],
		});
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir, force: true,
		});
		expect(r.results[0]).toMatchObject({
			action: "installed", forced: true, installedVersion: "0.2.0",
		});
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("BUNDLED");
	});

	it("case 7: mixed corpus in one run — every outcome reported, none aborts the others", async () => {
		const home = mkdtempSync(join(tmpdir(), "aiw-guard-home-mixed-"));
		const cliDist = mkdtempSync(join(tmpdir(), "aiw-guard-dist-mixed-"));
		const bundled = join(cliDist, "skills");
		const installedBase = join(home, ".claude", "skills");
		const fixtures: Array<[string, string, string | undefined]> = [
			// [skill, bundledVersion, installedVersion?]
			["skill-fresh", "0.1.0", undefined],
			["skill-upgrade", "0.2.0", "0.1.0"],
			["skill-equal", "0.1.0", "0.1.0"],
			["skill-newer-installed", "0.1.0", "0.2.0"],
		];
		for (const [name, bv, iv] of fixtures) {
			mkdirSync(join(bundled, name), { recursive: true });
			writeFileSync(join(bundled, name, "SKILL.md"), `---\nversion: ${bv}\n---\nBUNDLED`);
			if (iv !== undefined) {
				mkdirSync(join(installedBase, name), { recursive: true });
				writeFileSync(join(installedBase, name, "SKILL.md"), `---\nversion: ${iv}\n---\nINSTALLED`);
			}
		}
		const r = await runSkillInstall({ target: "claude", fakeHome: home, bundledSkillsDir: bundled });
		const byName = new Map(r.results.map((e) => [e.skill, e.action]));
		expect(byName.get("skill-fresh")).toBe("installed");
		expect(byName.get("skill-upgrade")).toBe("installed");
		expect(byName.get("skill-equal")).toBe("up-to-date");
		expect(byName.get("skill-newer-installed")).toBe("skipped-newer");
		expect(r.results).toHaveLength(4);
	});

	it("case 8a: bundled missing/malformed version never overwrites a versioned install without --force", async () => {
		for (const bundledFm of [null, ["version: not-a-version"]] as const) {
			const s = guardSandbox({
				bundledFm: bundledFm as string[] | null, installedFm: ["version: 0.1.0"],
			});
			const r = await runSkillInstall({
				target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
			});
			expect(r.results[0]).toMatchObject({
				action: "skipped-newer", bundledVersion: null, installedVersion: "0.1.0",
			});
			expect(readFileSync(s.destSkillMd, "utf8")).toContain("INSTALLED");
		}
	});

	it("case 8b: bundled missing version still installs into a missing destination", async () => {
		const s = guardSandbox({ bundledFm: null });
		const r = await runSkillInstall({
			target: "claude", fakeHome: s.home, bundledSkillsDir: s.bundledSkillsDir,
		});
		expect(r.results[0]).toMatchObject({ action: "installed", bundledVersion: null });
		expect(readFileSync(s.destSkillMd, "utf8")).toContain("BUNDLED");
	});
});
