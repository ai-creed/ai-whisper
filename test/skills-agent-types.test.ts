import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentTypes } from "../packages/shared/src/index.ts";

// ESM-correct repo root (matches the codebase's module type; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every bundled kickoff skill with a collab-readiness section. */
const KICKOFF_SKILLS = [
	"ai-whisper-sdd",
	"ai-whisper-ralph",
	"ai-whisper-bugfix",
	"ai-whisper-deliberation",
	"ai-whisper-quick-task",
] as const;

function readSkill(skill: string): string {
	return readFileSync(
		join(repoRoot, "packages/cli/skills", skill, "SKILL.md"),
		"utf8",
	);
}

// The kickoff skills document which agents can form the implementer+reviewer
// pair. That guidance is derived from the canonical agentTypes list in
// @ai-whisper/shared — when a new adapter lands there (e.g. cursor), these
// tests go red until every kickoff skill's readiness section catches up.
describe("kickoff skills stay in sync with the supported agent types", () => {
	for (const skill of KICKOFF_SKILLS) {
		describe(skill, () => {
			it("names every supported agent type", () => {
				const md = readSkill(skill);
				for (const agent of agentTypes) {
					expect(md, `${skill} must mention \`${agent}\``).toContain(
						`\`${agent}\``,
					);
				}
			});

			it("status JSON example lists every supported agent type", () => {
				const md = readSkill(skill);
				for (const agent of agentTypes) {
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
