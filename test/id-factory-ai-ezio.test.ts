import { describe, expect, it } from "vitest";
import { createCliSessionId } from "../packages/cli/src/runtime/id-factory.ts";

// sessionIdSchema enforces `^session_[a-z0-9_]+$` — the "ai-ezio" hyphen must be
// sanitized or mount registration throws on the generated session id.
describe("createCliSessionId (ai-ezio)", () => {
	it("produces a session id matching the [a-z0-9_] sessionId shape", () => {
		const id = createCliSessionId("ai-ezio", "2026-06-04T00:00:00.000Z");
		expect(id).toMatch(/^session_[a-z0-9_]+$/);
		expect(id).not.toContain("-");
		expect(id).toContain("ai_ezio");
	});

	it("still works for codex/claude", () => {
		expect(createCliSessionId("codex", "2026-06-04T00:00:00.000Z")).toMatch(/^session_codex_[0-9]+$/);
		expect(createCliSessionId("claude", "2026-06-04T00:00:00.000Z")).toMatch(/^session_claude_[0-9]+$/);
	});
});
