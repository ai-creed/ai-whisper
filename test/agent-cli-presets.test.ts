import { describe, expect, it } from "vitest";
import { resolveAgentCliInvocation } from "../packages/cli/src/runtime/agent-cli-presets.ts";

describe("resolveAgentCliInvocation", () => {
	it("seeds the claude preset", () => {
		expect(resolveAgentCliInvocation({ agent: "claude" })).toEqual({ executable: "claude", execArgs: ["-p"], promptVia: "arg" });
	});
	it("seeds the codex preset", () => {
		expect(resolveAgentCliInvocation({ agent: "codex" })).toEqual({ executable: "codex", execArgs: ["exec"], promptVia: "arg" });
	});
	it("overrides win field-by-field", () => {
		expect(resolveAgentCliInvocation({ agent: "claude", executable: "/opt/claude", execArgs: ["--print"], promptVia: "stdin" }))
			.toEqual({ executable: "/opt/claude", execArgs: ["--print"], promptVia: "stdin" });
	});
	it("null overrides fall back to the preset", () => {
		expect(resolveAgentCliInvocation({ agent: "codex", executable: null, execArgs: null, promptVia: null }))
			.toEqual({ executable: "codex", execArgs: ["exec"], promptVia: "arg" });
	});
});
