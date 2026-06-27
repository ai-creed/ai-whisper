import { describe, expect, it } from "vitest";
import {
	formatTurnEventsStartupLine,
	resolveTurnEvents,
} from "../packages/cli/src/runtime/turn-events-config.ts";

describe("agy turn-events", () => {
	it("is on by default (like claude/codex)", () => {
		expect(resolveTurnEvents(undefined).agy).toBe(true);
	});

	it("is on when explicitly requested", () => {
		expect(resolveTurnEvents("agy").agy).toBe(true);
	});

	it("is off under the off/none kill-switch", () => {
		expect(resolveTurnEvents("off").agy).toBe(false);
		expect(resolveTurnEvents("none").agy).toBe(false);
	});

	it("renders agy=ON in the startup line when enabled", () => {
		expect(
			formatTurnEventsStartupLine(resolveTurnEvents(undefined)),
		).toContain("agy=ON");
	});
});
