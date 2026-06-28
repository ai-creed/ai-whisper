import { describe, expect, it } from "vitest";
import type { ProviderWorkRequest } from "../packages/shared/src/index.ts";
import {
	buildCursorFileBackedBrokerPrompt,
	buildCursorPrompt,
} from "../packages/adapter-cursor/src/cursor-prompt.ts";

const REQUEST: ProviderWorkRequest = {
	workItemId: "work_cursor_prompt",
	collabId: "collab_test",
	threadId: "thread_test",
	requestedAction: "answer_question",
	instruction: "Reply with minimal JSON.",
};

describe("buildCursorPrompt", () => {
	it("instructs a JSON-only reply and embeds every request field", () => {
		const prompt = buildCursorPrompt(REQUEST);

		expect(prompt).toContain("Return ONLY valid JSON.");
		expect(prompt).toContain(
			'"kind": "answer" | "review" | "clarification" | "failure"',
		);
		expect(prompt).toContain(
			'"transitionIntent": "in_progress" | "awaiting_user" | "completed" | "failed" | null',
		);
		expect(prompt).toContain("action: answer_question");
		expect(prompt).toContain("instruction: Reply with minimal JSON.");
		expect(prompt).toContain("collabId: collab_test");
		expect(prompt).toContain("threadId: thread_test");
		expect(prompt).toContain("workItemId: work_cursor_prompt");
	});
});

describe("buildCursorFileBackedBrokerPrompt", () => {
	it("points the agent at the request file as the source of truth", () => {
		const prompt = buildCursorFileBackedBrokerPrompt("/tmp/a/request.json");

		expect(prompt).toContain("Return ONLY valid JSON matching this schema:");
		expect(prompt).toContain("The work request is in the file: /tmp/a/request.json");
		expect(prompt).toContain("authoritative source of truth");
	});
});
