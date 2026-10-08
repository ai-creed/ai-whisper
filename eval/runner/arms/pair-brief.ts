import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskMeta, TaskShape } from "../types.ts";
import { TOOLING_PRESERVATION_LINE, renderAcceptanceBody, renderScopeBullets, renderTaskContent, renderTaskSection } from "./solo-prompt.ts";

export const PAIR_ARTIFACT_RELATIVE: Record<TaskShape, string> = {
	"quick-task": ".ai-whisper/tasks/brief.md",
	"spec-driven-development": ".ai-whisper/tasks/spec.md",
};

export function composeQuickTaskBrief(task: TaskMeta): string {
	if (task.approach === null) throw new Error(`task ${task.slug} is quick-task-shaped but has no approach.md`);
	return [
		`# Task: ${task.title}`,
		renderTaskSection(task),
		`## Approved approach\n${task.approach.trim()}`,
		`## Scope\n${renderScopeBullets(task)}`,
		`## Acceptance checks\n${renderAcceptanceBody(task)}`,
	].join("\n\n") + "\n";
}

export function composeSddSpec(task: TaskMeta): string {
	return `${renderTaskContent({ ...task, approach: null })}\n\n${TOOLING_PRESERVATION_LINE}\n`;
}

export function writePairArtifact(task: TaskMeta, workspaceDir: string): string {
	const rel = PAIR_ARTIFACT_RELATIVE[task.shape];
	const abs = join(workspaceDir, rel);
	mkdirSync(join(workspaceDir, ".ai-whisper", "tasks"), { recursive: true });
	writeFileSync(abs, task.shape === "quick-task" ? composeQuickTaskBrief(task) : composeSddSpec(task));
	return abs;
}
