import { describe, expect, it } from "vitest";
import {
	agyTurnEventsExplicitlyRequested,
	formatTurnEventsStartupLine,
	resolveTurnEvents,
} from "../packages/cli/src/runtime/turn-events-config.ts";

describe("agy turn-events", () => {
	it("is off when unset", () => {
		expect(resolveTurnEvents(undefined).agy).toBe(false);
	});

	it("stays off even when explicitly requested", () => {
		expect(resolveTurnEvents("agy").agy).toBe(false);
	});

	it("is off under the off kill-switch", () => {
		expect(resolveTurnEvents("off").agy).toBe(false);
	});

	it("flags an explicit agy request for a warning", () => {
		expect(agyTurnEventsExplicitlyRequested("claude,agy")).toBe(true);
		expect(agyTurnEventsExplicitlyRequested("claude")).toBe(false);
	});

	it("renders agy=off in the startup line", () => {
		expect(formatTurnEventsStartupLine(resolveTurnEvents(undefined))).toContain("agy=off");
	});
});
