import type { TaskMeta } from "../types.ts";

export const SOLO_PREAMBLE = `You are working alone in the project at the current directory. No human will respond — never ask for confirmation, permission, or clarification; make the changes yourself.
Implement the task below. Keep the project's existing tooling intact (package.json scripts, tsconfig, vitest and eslint config). Run the project's own \`npm run typecheck\`, \`npm run lint\` and \`npm test\` and make them pass before you stop. Commit your work with git when done.

`;

export const SELF_REVIEW_PROTOCOL = `

--- Self-review protocol ---
After you believe the implementation is complete, run a structured review of your own diff (\`git diff\` against the baseline commit) against the acceptance criteria above:
1. For each acceptance criterion, state whether the diff satisfies it and cite the code that does.
2. List concrete findings: missed criteria, edge cases the criteria imply but your code does not handle, failing or missing tests, tooling you changed. Write each finding in your reply on its own line in exactly this form: \`FINDING: <one sentence>\`.
3. Fix every finding, re-run typecheck, lint and tests, and commit.
4. End the cycle with one line in exactly this form: \`SELF-REVIEW CYCLE <n> COMPLETE: <k> findings\` (k = the number of FINDING lines in that cycle; 0 is valid).
Repeat steps 1–4 for a maximum of 2 review-fix cycles, then stop. Do not start a third cycle.`;

export function renderTaskContent(task: TaskMeta): string {
	const parts = [
		`# ${task.title}`,
		`## Task\n${task.taskSection}`,
		`## Scope\n${task.scopeBullets.map((p) => `- ${p}`).join("\n")}`,
		`## Acceptance criteria\n${task.acceptanceSection}`,
	];
	if (task.approach !== null) parts.push(`## Approved approach\n${task.approach.trim()}`);
	return parts.join("\n\n");
}

export function composeSoloPrompt(task: TaskMeta, arm: "A" | "B"): string {
	const body = SOLO_PREAMBLE + renderTaskContent(task);
	return arm === "B" ? body + SELF_REVIEW_PROTOCOL : body;
}
