import { cp, mkdir, readdir, stat } from "node:fs/promises";
import type { AgentType } from "@ai-whisper/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillInstallTarget = AgentType | "all";

export interface SkillInstallInput {
	target: SkillInstallTarget;
	force?: boolean;
	// Test-only overrides:
	fakeHome?: string;
	bundledSkillsDir?: string;
}

export interface SkillInstallResult {
	installedAt: string[];
}

function defaultBundledSkillsDir(): string {
	// Compiled to dist/commands/skill/install.js. dist/skills/ is at
	// ../../skills from there.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "skills");
}

function homeForTarget(target: AgentType, fakeHome?: string): string {
	const home = fakeHome ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) throw new Error("Could not determine $HOME for skill install destination");
	return path.join(home, target === "claude" ? ".claude" : ".codex", "skills");
}

const VALID_TARGETS: ReadonlySet<SkillInstallTarget> = new Set(["claude", "codex", "all"]);

export async function runSkillInstall(
	input: SkillInstallInput,
): Promise<SkillInstallResult> {
	if (!VALID_TARGETS.has(input.target)) {
		// Catch typos at runtime even when the caller bypasses the CLI's
		// `.choices()` validation (e.g., programmatic callers, tests). The
		// homeForTarget ternary would otherwise silently route any non-"claude"
		// string into ~/.codex/skills.
		throw new Error(
			`Invalid --target value "${String(input.target)}". Expected one of: claude, codex, all.`,
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

	const targets: (AgentType)[] =
		input.target === "all" ? ["claude", "codex"] : [input.target];

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
			if (destExists && !input.force) {
				throw new Error(
					`Skill destination already exists at ${dest}. Re-run with --force to overwrite.`,
				);
			}
			await cp(src, dest, { recursive: true, force: true });
			installedAt.push(path.join(dest, "SKILL.md"));
		}
	}

	return { installedAt };
}
