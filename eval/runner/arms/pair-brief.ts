import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskMeta, TaskShape } from "../types.ts";
import { renderTaskContent } from "./solo-prompt.ts";

export const PAIR_ARTIFACT_RELATIVE: Record<TaskShape, string> = {
	"quick-task": ".ai-whisper/tasks/brief.md",
	"spec-driven-development": ".ai-whisper/tasks/spec.md",
};

export function composeQuickTaskBrief(task: TaskMeta): string {
	if (task.approach === null) throw new Error(`task ${task.slug} is quick-task-shaped but has no approach.md`);
	return [
		`# Task: ${task.title}`,
		`## Task\n${task.taskSection}`,
		`## Approved approach\n${task.approach.trim()}`,
		`## Scope\n${task.scopeBullets.map((p) => `- \`${p}\``).join("\n")}`,
		`## Acceptance checks\n${task.acceptanceSection}`,
	].join("\n\n") + "\n";
}

export function composeSddSpec(task: TaskMeta): string {
	return `${renderTaskContent({ ...task, approach: null })}\n\nKeep the project's existing tooling intact (package.json scripts, tsconfig, vitest and eslint config); the project's own typecheck, lint and test commands are the verification commands.\n`;
}

export function writePairArtifact(task: TaskMeta, workspaceDir: string): string {
	const rel = PAIR_ARTIFACT_RELATIVE[task.shape];
	const abs = join(workspaceDir, rel);
	mkdirSync(join(workspaceDir, ".ai-whisper", "tasks"), { recursive: true });
	writeFileSync(abs, task.shape === "quick-task" ? composeQuickTaskBrief(task) : composeSddSpec(task));
	return abs;
}
