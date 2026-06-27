import { describe, expect, it } from "vitest";
import { agentTypes } from "../packages/shared/src/literals.ts";
import { relayTargets } from "../packages/shared/src/relay-host.ts";

describe("agy agent token", () => {
	it("is a recognized agent type", () => {
		expect(agentTypes as readonly string[]).toContain("agy");
	});

	it("is a valid relay target", () => {
		expect(relayTargets as readonly string[]).toContain("agy");
	});
});
