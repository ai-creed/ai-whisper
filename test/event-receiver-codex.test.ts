import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexEventReceiver } from "../packages/cli/src/runtime/event-receiver.ts";

describe("CodexEventReceiver", () => {
	it("normalizes a notify payload into a TurnEvent", () => {
		const raw = readFileSync(
			join(__dirname, "fixtures", "codex-notify.json"),
			"utf8",
		);
		const event = new CodexEventReceiver().parse(raw, "2026-06-11T00:00:00.000Z");
		expect(event).not.toBeNull();
		expect(event!.provider).toBe("codex");
		expect(event!.sessionOrThreadId).toBe("thread-xyz");
		expect(event!.turnId).toBe("turn-7");
		expect(event!.message).toContain("Review matrix");
		expect(event!.inputMessages).toEqual([
			"Please review the spec and produce a matrix.",
		]);
	});
});
