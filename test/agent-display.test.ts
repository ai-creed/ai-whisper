import { describe, expect, it } from "vitest";
import { agentDisplayName } from "../packages/cli/src/runtime/agent-display.ts";

describe("agentDisplayName", () => {
	it("title-cases each agent", () => {
		expect(agentDisplayName("agy")).toBe("Agy");
		expect(agentDisplayName("claude")).toBe("Claude");
		expect(agentDisplayName("codex")).toBe("Codex");
		expect(agentDisplayName("ezio")).toBe("Ezio");
	});
});
