import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKFLOW_DIAGNOSIS_PROTOCOL } from "../packages/broker/src/runtime/workflow-registry.ts";

const skill = readFileSync(
	"packages/cli/skills/ai-whisper-bugfix/SKILL.md",
	"utf8",
);

describe("ai-whisper-bugfix skill", () => {
	it("starts the complex-bug-fixing workflow and is fire-and-forget", () => {
		expect(skill).toMatch(/^name:\s*ai-whisper-bugfix\s*$/m);
		expect(skill).toContain("--type=complex-bug-fixing");
		expect(skill).not.toContain("--type=ralph-loop");
		expect(skill).toContain("whisper collab status --json");
		expect(skill).toMatch(/fire-and-forget/i);
	});

	it("documents the operator pause-control flow with the Codex Ctrl+C gotcha", () => {
		for (const name of ["ai-whisper-sdd", "ai-whisper-ralph", "ai-whisper-bugfix", "ai-whisper-deliberation"]) {
			const md = readFileSync(`packages/cli/skills/${name}/SKILL.md`, "utf8");
			expect(md, `${name} missing pause section`).toContain("whisper workflow pause");
			expect(md, `${name} missing resume --message`).toContain("whisper workflow resume");
			expect(md, `${name} missing Ctrl+C gotcha`).toMatch(/Ctrl\+C/);
		}
	});

	it("does NOT duplicate the canonical diagnosis review protocol (single source of truth)", () => {
		// Distinctive protocol marker lines must not be copied into the skill.
		expect(skill).not.toContain("ai-whisper diagnosis review protocol");
		expect(skill).not.toContain("Mutual-agreement gate");
		// And it shares no long verbatim slice with the protocol body.
		const marker = WORKFLOW_DIAGNOSIS_PROTOCOL.slice(60, 140);
		expect(skill).not.toContain(marker);
	});
});
