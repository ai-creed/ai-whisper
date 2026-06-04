import { describe, expect, it } from "vitest";
import { createCliSessionId } from "../packages/cli/src/runtime/id-factory.ts";

// sessionIdSchema enforces `^session_[a-z0-9_]+$` — the generated session id for
// the ezio role must stay within that shape (no mount-registration throw).
describe("createCliSessionId (ezio)", () => {
	it("produces a session id matching the [a-z0-9_] sessionId shape", () => {
		const id = createCliSessionId("ezio", "2026-06-04T00:00:00.000Z");
		expect(id).toMatch(/^session_ezio_[0-9]+$/);
		expect(id).not.toContain("-");
	});

	it("still works for codex/claude", () => {
		expect(createCliSessionId("codex", "2026-06-04T00:00:00.000Z")).toMatch(/^session_codex_[0-9]+$/);
		expect(createCliSessionId("claude", "2026-06-04T00:00:00.000Z")).toMatch(/^session_claude_[0-9]+$/);
	});
});
