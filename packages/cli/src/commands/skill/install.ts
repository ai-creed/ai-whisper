import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import type { AgentType } from "@ai-whisper/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, parseSkillVersion } from "./version.js";

export type SkillInstallTarget = AgentType | "all";

export interface SkillInstallInput {
	target: SkillInstallTarget;
	force?: boolean;
	// Test-only overrides:
	fakeHome?: string;
	bundledSkillsDir?: string;
}

export type SkillInstallAction = "installed" | "up-to-date" | "skipped-newer";

export interface SkillInstallEntry {
	skill: string;
	target: AgentType;
	dest: string; // skill directory at the destination
	action: SkillInstallAction;
	bundledVersion: string | null;
	installedVersion: string | null; // pre-install version at dest, null if absent/unreadable/malformed
	forced?: true; // present only when --force overrode a would-be skip
}

export interface SkillInstallResult {
	results: SkillInstallEntry[];
	installedAt: string[]; // SKILL.md paths actually written (derived from results)
}

function defaultBundledSkillsDir(): string {
	// Compiled to dist/commands/skill/install.js. dist/skills/ is at
	// ../../skills from there.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "skills");
}

async function readSkillVersion(skillMdPath: string): Promise<string | null> {
	let content: string;
	try {
		content = await readFile(skillMdPath, "utf8");
	} catch {
		return null;
	}
	return parseSkillVersion(content);
}

function homeForTarget(target: AgentType, fakeHome?: string): string {
	const home = fakeHome ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) throw new Error("Could not determine $HOME for skill install destination");
	if (target === "ezio") {
		// Mirrors ai-ezio's aiEzioGlobalSkillsDir (ai-ezio
		// packages/harness/src/skills-dir.ts): ${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills,
		// the dir the engine reads via HAX_EXTRA_SKILLS_DIR. Replicated locally to
		// avoid a cross-repo import from the ai-whisper CLI.
		// Under a fakeHome test override, derive strictly from fakeHome and ignore
		// the ambient XDG_CONFIG_HOME so installs stay isolated; in production honor
		// XDG_CONFIG_HOME (matching the engine), falling back to $HOME/.config.
		const xdg = process.env.XDG_CONFIG_HOME;
		const base = fakeHome
			? path.join(fakeHome, ".config")
			: xdg && xdg !== ""
				? xdg
				: path.join(home, ".config");
		return path.join(base, "ai-ezio", "skills");
	}
	if (target === "agy") {
		// agy is Gemini-CLI-based; it reads skills from ~/.gemini/config/skills.
		return path.join(home, ".gemini", "config", "skills");
	}
	// Explicit per-agent dir. NB: the prior `claude ? .claude : .codex` ternary
	// silently routed every non-claude target (including cursor) into ~/.codex;
	// cursor needs its own ~/.cursor branch. VALID_TARGETS guards anything else.
	const dir = target === "claude" ? ".claude" : target === "cursor" ? ".cursor" : ".codex";
	return path.join(home, dir, "skills");
}

const VALID_TARGETS: ReadonlySet<SkillInstallTarget> = new Set([
	"claude",
	"codex",
	"cursor",
	"ezio",
	"agy",
	"all",
]);

export async function runSkillInstall(
	input: SkillInstallInput,
): Promise<SkillInstallResult> {
	if (!VALID_TARGETS.has(input.target)) {
		// Catch typos at runtime even when the caller bypasses the CLI's
		// `.choices()` validation (e.g., programmatic callers, tests). The
		// homeForTarget ternary would otherwise silently route any non-"claude"
		// string into ~/.codex/skills.
		throw new Error(
			`Invalid --target value "${String(input.target)}". Expected one of: claude, codex, cursor, ezio, agy, all.`,
		);
	}
	const bundledDir = input.bundledSkillsDir ?? defaultBundledSkillsDir();
	try {
		await stat(bundledDir);
	} catch {
		throw new Error(
			`Bundled skills directory not found at ${bundledDir}. Run \`pnpm build\` first (or reinstall the CLI package).`,
		);
	}

	const skills = (await readdir(bundledDir, { withFileTypes: true }))
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	if (skills.length === 0) {
		throw new Error(`No skills found in ${bundledDir}.`);
	}

	const targets: AgentType[] =
		input.target === "all"
			? ["claude", "codex", "cursor", "ezio", "agy"]
			: [input.target];

	const results: SkillInstallEntry[] = [];
	const installedAt: string[] = [];

	for (const t of targets) {
		const destBase = homeForTarget(t, input.fakeHome);
		await mkdir(destBase, { recursive: true });
		for (const skill of skills) {
			const src = path.join(bundledDir, skill);
			const dest = path.join(destBase, skill);
			let destExists = false;
			try {
				await stat(dest);
				destExists = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			const bundledVersion = await readSkillVersion(path.join(src, "SKILL.md"));
			const installedVersion = destExists
				? await readSkillVersion(path.join(dest, "SKILL.md"))
				: null;

			// Guard table (spec 2026-07-12): a missing destination or a
			// versionless/unreadable installed copy installs; otherwise semver
			// decides. A versionless bundled skill compares as 0.0.0 so a broken
			// bundle can never downgrade a versioned install without --force.
			let action: SkillInstallAction;
			if (!destExists || installedVersion === null) {
				action = "installed";
			} else {
				const cmp = compareSemver(bundledVersion ?? "0.0.0", installedVersion);
				action = cmp > 0 ? "installed" : cmp === 0 ? "up-to-date" : "skipped-newer";
			}
			const forced = action !== "installed" && input.force === true;
			if (forced) action = "installed";

			results.push({
				skill,
				target: t,
				dest,
				action,
				bundledVersion,
				installedVersion,
				...(forced ? { forced: true as const } : {}),
			});
			if (action === "installed") {
				await cp(src, dest, { recursive: true, force: true });
				installedAt.push(path.join(dest, "SKILL.md"));
			}
		}
	}

	return { results, installedAt };
}
