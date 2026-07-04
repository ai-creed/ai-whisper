import { describe, expect, it } from "vitest";
import { agentDisplayName, characterDisplayName } from "../packages/cli/src/runtime/agent-display.ts";

describe("agentDisplayName", () => {
	it("title-cases each agent", () => {
		expect(agentDisplayName("agy")).toBe("Agy");
		expect(agentDisplayName("claude")).toBe("Claude");
		expect(agentDisplayName("codex")).toBe("Codex");
		expect(agentDisplayName("ezio")).toBe("Ezio");
	});
});

describe("characterDisplayName", () => {
	it("renders '<characterName> (<agentType>)' for each agent type when a name is present", () => {
		expect(characterDisplayName("claude", "Batman")).toBe("Batman (claude)");
		expect(characterDisplayName("codex", "Robin")).toBe("Robin (codex)");
		expect(characterDisplayName("ezio", "Walter White")).toBe("Walter White (ezio)");
		expect(characterDisplayName("agy", "Jesse Pinkman")).toBe("Jesse Pinkman (agy)");
	});

	it("falls back to the RAW agentType (today's exact rendering) when characterName is null", () => {
		expect(characterDisplayName("claude", null)).toBe("claude");
	});

	it("falls back to the RAW agentType when characterName is undefined", () => {
		expect(characterDisplayName("codex", undefined)).toBe("codex");
	});

	it("falls back to the RAW agentType when characterName is an empty string", () => {
		expect(characterDisplayName("ezio", "")).toBe("ezio");
	});
});
