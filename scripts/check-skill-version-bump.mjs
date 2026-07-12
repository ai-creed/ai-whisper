#!/usr/bin/env node
// CI assertion (spec 2026-07-12 §CI): a bundled skill whose content changed
// vs the base ref must also change its SKILL.md frontmatter `version` —
// guarded installers silently skip unbumped content.
//
// Usage: node scripts/check-skill-version-bump.mjs --base <ref>
//   CI passes the PR base sha (pull_request) or github.event.before (push).
//   An empty/all-zero/unresolvable base is a visible skip (exit 0), never a
//   guess. Exit 1 on violations.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = "packages/cli/skills";

// Mirrors parseSkillVersion in packages/cli/src/commands/skill/version.ts.
// Duplicated because this script must run without a build step (plain .mjs
// cannot import the TS source, and dist may not exist yet locally).
const VALID_VERSION_RE = /^\d+(\.\d+){0,2}$/;
function parseSkillVersion(content) {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") return null;
		const m = /^version:\s*(.+?)\s*$/.exec(line);
		if (m) {
			const raw = (m[1] ?? "").replace(/^["']/, "").replace(/["']$/, "");
			return VALID_VERSION_RE.test(raw) ? raw : null;
		}
	}
	return null;
}

function git(repoRoot, args, opts = {}) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
}

function gitShow(repoRoot, ref, file) {
	try {
		return git(repoRoot, ["show", `${ref}:${file}`]);
	} catch {
		return null;
	}
}

export function checkSkillVersionBumps({ repoRoot, baseRef }) {
	const changed = git(repoRoot, ["diff", "--name-only", baseRef, "HEAD", "--", SKILLS_DIR])
		.split("\n")
		.filter(Boolean);
	const skills = new Set();
	for (const f of changed) {
		const rel = path.posix.relative(SKILLS_DIR, f);
		const skill = rel.split("/")[0];
		if (skill && !skill.startsWith("..")) skills.add(skill);
	}
	const violations = [];
	for (const skill of skills) {
		const skillMd = `${SKILLS_DIR}/${skill}/SKILL.md`;
		const headContent = gitShow(repoRoot, "HEAD", skillMd);
		if (headContent === null) continue; // dir removed at HEAD — nothing to install
		const baseContent = gitShow(repoRoot, baseRef, skillMd);
		if (baseContent === null) continue; // brand-new skill — nothing to compare against
		const headVersion = parseSkillVersion(headContent);
		if (headVersion === null) {
			violations.push({ skill, reason: "SKILL.md at HEAD has no valid version" });
		} else if (headVersion === parseSkillVersion(baseContent)) {
			violations.push({
				skill,
				reason: `content changed but version stayed ${headVersion}`,
			});
		}
	}
	return violations;
}

const isMain =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const baseIdx = process.argv.indexOf("--base");
	const base = baseIdx >= 0 ? (process.argv[baseIdx + 1] ?? "") : "";
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	if (!base || /^0+$/.test(base)) {
		console.log(
			`check-skill-version-bump: no resolvable base ref (got "${base}") — skipping.`,
		);
		process.exit(0);
	}
	let resolvable = true;
	try {
		git(repoRoot, ["cat-file", "-e", `${base}^{commit}`], { stdio: "pipe" });
	} catch {
		try {
			git(repoRoot, ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "pipe" });
			git(repoRoot, ["cat-file", "-e", `${base}^{commit}`], { stdio: "pipe" });
		} catch {
			resolvable = false;
		}
	}
	if (!resolvable) {
		console.log(`check-skill-version-bump: base ${base} unresolvable — skipping.`);
		process.exit(0);
	}
	const violations = checkSkillVersionBumps({ repoRoot, baseRef: base });
	if (violations.length === 0) {
		console.log("check-skill-version-bump: OK");
		process.exit(0);
	}
	for (const v of violations) {
		console.error(`✖ ${v.skill}: ${v.reason}`);
	}
	console.error(
		"Bundled skill content changed without a version bump. Bump `version` in the skill's SKILL.md frontmatter (see AGENTS.md, Bundled Skills).",
	);
	process.exit(1);
}
