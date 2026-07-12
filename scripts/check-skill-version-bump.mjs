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

// Mirrors parseSkillVersion and compareSemver in
// packages/cli/src/commands/skill/version.ts. Duplicated because this script
// must run without a build step (plain .mjs cannot import the TS source, and
// dist may not exist yet locally).
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

function compareSemver(a, b) {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < 3; i++) {
		const da = Number.parseInt(pa[i] ?? "0", 10);
		const db = Number.parseInt(pb[i] ?? "0", 10);
		if (da !== db) return da < db ? -1 : 1;
	}
	return 0;
}

function git(repoRoot, args, opts = {}) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
}

function gitShow(repoRoot, ref, file) {
	try {
		return git(repoRoot, ["show", `${ref}:${file}`], { stdio: "pipe" });
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
		const baseVersion = parseSkillVersion(baseContent);
		if (headVersion === null) {
			violations.push({ skill, reason: "SKILL.md at HEAD has no valid version" });
		} else if (baseVersion !== null && compareSemver(headVersion, baseVersion) <= 0) {
			// A changed skill must bump forward, not merely change — a decrement
			// (or unchanged version) would pass a guarded installer's
			// `skipped-newer` check and never actually ship the content edit.
			violations.push({
				skill,
				reason: `content changed but version went ${baseVersion} -> ${headVersion} (must increase)`,
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
	// pull_request diffs must be against the merge-base with the base branch,
	// not the raw base sha: the base branch keeps moving after a PR forks off
	// it, and a raw two-dot diff against its later tip can misattribute
	// base-branch-only changes to the PR (or mask PR changes that the base
	// branch coincidentally also picked up). Fall back to the raw base if the
	// merge-base can't be resolved (e.g. a shallow fetch with no shared history).
	let effectiveBase = base;
	try {
		effectiveBase = git(repoRoot, ["merge-base", base, "HEAD"], { stdio: "pipe" }).trim();
	} catch {
		effectiveBase = base;
	}
	const violations = checkSkillVersionBumps({ repoRoot, baseRef: effectiveBase });
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
