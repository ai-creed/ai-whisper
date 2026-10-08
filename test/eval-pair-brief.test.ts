import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTaskBrief } from "@ai-whisper/broker";
import { afterEach, describe, expect, it } from "vitest";
import { composeQuickTaskBrief, composeSddSpec, writePairArtifact } from "../eval/runner/arms/pair-brief.ts";
import { renderTaskContent } from "../eval/runner/arms/solo-prompt.ts";
import type { TaskMeta } from "../eval/runner/types.ts";

const task: TaskMeta = {
	slug: "csv-parse-quoted", category: "feature", shape: "quick-task", dir: "/t",
	title: "CSV: quoted fields", taskSection: "Add quoted-field support.", scopeBullets: ["src/parse.ts", "src/tokenize.ts", "test/parse.test.ts"],
	acceptanceSection: "- parse handles quotes\n- npm test passes", approach: "Extend the tokenizer state machine.\n",
	budget: { wallClockSeconds: 900, tokenCap: 400000 },
};

describe("composeQuickTaskBrief", () => {
	it("passes the real quick-task scope gate", () => {
		const v = validateTaskBrief(composeQuickTaskBrief(task));
		expect(v.ok, JSON.stringify(v)).toBe(true);
	});
	it("embeds approach.md verbatim and the task's scope bullets", () => {
		const b = composeQuickTaskBrief(task);
		expect(b).toContain("## Approved approach\nExtend the tokenizer state machine.");
		expect(b).toContain("## Scope\n- `src/parse.ts`\n- `src/tokenize.ts`\n- `test/parse.test.ts`");
		expect(b).toContain("## Acceptance checks\n- parse handles quotes");
		expect(b).toMatch(/^# Task: CSV: quoted fields/);
	});
});

describe("composeSddSpec", () => {
	it("is the shared task content with no approach section", () => {
		const sdd = { ...task, shape: "spec-driven-development" as const, approach: null };
		expect(composeSddSpec(sdd)).toContain(renderTaskContent(sdd));
		expect(composeSddSpec(sdd)).not.toContain("Approved approach");
	});
});

describe("writePairArtifact", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("writes the brief under .ai-whisper/tasks in the workspace", () => {
		dir = mkdtempSync(join(tmpdir(), "eval-brief-"));
		const p = writePairArtifact(task, dir);
		expect(p).toBe(join(dir, ".ai-whisper", "tasks", "brief.md"));
		expect(readFileSync(p, "utf8")).toContain("## Approved approach");
	});
});
