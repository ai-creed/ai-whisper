import { describe, expect, it } from "vitest";
import { buildAiEzioPrompt } from "../packages/adapter-ai-ezio/src/ai-ezio-prompt.ts";

const request = {
	workItemId: "w1",
	collabId: "c1",
	threadId: "th1",
	requestedAction: "implement_plan",
	instruction: "build the widget",
};

describe("buildAiEzioPrompt", () => {
	it("includes the requestedAction header and the instruction", () => {
		const prompt = buildAiEzioPrompt(request);
		expect(prompt).toContain("implement_plan");
		expect(prompt).toContain("build the widget");
	});

	it("appends the artifact request-file path when an artifact handle is present", () => {
		const prompt = buildAiEzioPrompt(request, {
			artifactHandle: {
				workItemId: "w1",
				artifactDirPath: "/tmp/art/w1",
				requestFilePath: "/tmp/art/w1/request.md",
				statusFilePath: "/tmp/art/w1/status.json",
			},
		});
		expect(prompt).toContain("/tmp/art/w1/request.md");
	});

	it("omits the artifact line when no handle is present", () => {
		const prompt = buildAiEzioPrompt(request);
		expect(prompt).not.toContain("request file");
	});
});
