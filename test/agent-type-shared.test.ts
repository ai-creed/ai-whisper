import { describe, expect, it } from "vitest";
import { agentTypes, type AgentType } from "@ai-whisper/shared";

describe("AgentType (shared canonical union)", () => {
	it("is assignable from every agentTypes member and includes ezio", () => {
		const all: AgentType[] = [...agentTypes];
		expect(all).toContain("ezio");
		expect(all).toEqual(["codex", "claude", "ezio", "agy", "cursor"]);
	});

	it("rejects a non-member at the type level (compile-time guard)", () => {
		// @ts-expect-error "gpt" is not an AgentType
		const bad: AgentType = "gpt";
		expect(bad).toBe("gpt");
	});
});
