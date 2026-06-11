import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeEventReceiver } from "../packages/cli/src/runtime/event-receiver.ts";

describe("ClaudeEventReceiver", () => {
	it("normalizes a Stop-hook payload into a TurnEvent", () => {
		const raw = readFileSync(
			join(__dirname, "fixtures", "claude-stop-hook.json"),
			"utf8",
		);
		const receiver = new ClaudeEventReceiver();
		const event = receiver.parse(raw, "2026-06-11T00:00:00.000Z");
		expect(event).not.toBeNull();
		expect(event!.provider).toBe("claude");
		expect(event!.cwd).toBe("/private/tmp/repo");
		expect(event!.sessionOrThreadId).toBe("sess-abc");
		expect(event!.turnId).toBeNull();
		expect(event!.message).toBe("Here is the completed review matrix: ...");
		// transcript unreadable → inputMessages empty (sequence backstop will apply)
		expect(event!.inputMessages).toEqual([]);
		expect(event!.receivedAt).toBe("2026-06-11T00:00:00.000Z");
		// workspaceId is derived from cwd via workspaceIdFromPath (16 hex)
		expect(event!.workspaceId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("returns null for malformed JSON", () => {
		expect(new ClaudeEventReceiver().parse("{not json", "t")).toBeNull();
	});
});
