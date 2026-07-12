import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentTypes } from "../packages/shared/src/index.ts";

// ESM-correct repo root (matches the codebase's module type; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The four name-preserving aliases. Each keeps a pre-collapse picker name alive
// and delegates to the ai-whisper-workflow dispatcher, which now owns the
// collab-readiness gate, the status-JSON shape, and the supported-agent list.
const ALIAS_SKILLS = [
	"ai-whisper-sdd",
	"ai-whisper-ralph",
	"ai-whisper-bugfix",
	"ai-whisper-deliberation",
] as const;

// The two skills that still carry a full collab-readiness section: the
// dispatcher and quick-task (which writes its own brief before kicking off).
const READINESS_SKILLS = ["ai-whisper-workflow", "ai-whisper-quick-task"] as const;

// The calibrated M5d corpus documents workflow seats as codex/claude/ezio/agy;
// `cursor` exists in @ai-whisper/shared agentTypes but is not yet named by the
// calibrated skill prose — shipping that mention is a parked, versioned content
// edit (see docs/superpowers/specs/2026-07-12-bundled-skills-ownership-design.md,
// out-of-scope: content edits ship later as versioned product edits). When that
// edit ships, restore the sync to the full agentTypes list.
const WORKFLOW_SEATS = ["codex", "claude", "ezio", "agy"] as const;

function readSkill(skill: string): string {
	return readFileSync(
		join(repoRoot, "packages/cli/skills", skill, "SKILL.md"),
		"utf8",
	);
}

// Keep the documented seat set anchored to the canonical shared list so a
// rename in @ai-whisper/shared can't silently desync the readiness prose.
describe("workflow seat set stays anchored to the shared agent types", () => {
	it("every documented seat is a real @ai-whisper/shared agent type", () => {
		for (const seat of WORKFLOW_SEATS) {
			expect(
				agentTypes,
				`seat \`${seat}\` must exist in shared agentTypes`,
			).toContain(seat);
		}
	});
});

// The dispatcher and quick-task own the readiness section: it must name every
// workflow seat and carry a status-JSON example listing each seat. (The list
// is pinned to WORKFLOW_SEATS, not the full agentTypes, per the note above.)
describe("readiness-carrying skills name every workflow seat", () => {
	for (const skill of READINESS_SKILLS) {
		describe(skill, () => {
			it("names every workflow seat agent type", () => {
				const md = readSkill(skill);
				for (const agent of WORKFLOW_SEATS) {
					expect(md, `${skill} must mention \`${agent}\``).toContain(
						`\`${agent}\``,
					);
				}
			});

			it("status JSON example lists every workflow seat agent type", () => {
				const md = readSkill(skill);
				for (const agent of WORKFLOW_SEATS) {
					expect(md).toContain(`"agentType": "${agent}"`);
				}
			});

			it("carries no stale three-agent-only phrasing", () => {
				const md = readSkill(skill);
				expect(md).not.toContain("among `codex`, `claude`, and `ezio`");
				expect(md).not.toContain("all three types");
				// <codex|claude|ezio> without agy — the fixed hint continues `|agy>`.
				expect(md).not.toMatch(/<codex\|claude\|ezio>/);
				expect(md).not.toContain("when `ezio` replaces it");
				expect(md).not.toContain("reconnect codex");
			});
		});
	}
});

// The aliases no longer carry a readiness section of their own; they delegate
// to the ai-whisper-workflow dispatcher, which owns that guidance. Each alias
// must reference the dispatcher and describe itself as delegating to it.
describe("kickoff aliases delegate to the ai-whisper-workflow dispatcher", () => {
	for (const skill of ALIAS_SKILLS) {
		describe(skill, () => {
			it("delegates to the ai-whisper-workflow dispatcher", () => {
				const md = readSkill(skill);
				expect(md, `${skill} must reference the dispatcher`).toContain(
					"ai-whisper-workflow",
				);
				expect(md, `${skill} must describe itself as delegating`).toMatch(
					/delegat/i,
				);
				expect(
					md,
					`${skill} must read the dispatcher's SKILL.md`,
				).toContain("Read the `ai-whisper-workflow` skill's SKILL.md");
			});
		});
	}
});
