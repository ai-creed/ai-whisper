import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	WORKFLOW_READ_FANOUT_GUIDANCE,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("WORKFLOW_READ_FANOUT_GUIDANCE fragment", () => {
	it("is harness-conditional", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/If your harness supports dispatching subagents/,
		);
	});
	it("scopes fan-out to read-only work", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toContain("read-only work");
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/Anything that writes .* stays inline and serial/,
		);
	});
	it("requires synthesis before handback", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/synthesize the results yourself before handing back/,
		);
	});
	it("isolates subagents from the relay and the other agent", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/never hands back, never touches the relay, and never communicates with the other agent/,
		);
	});
	it("has a sequential fallback", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE).toMatch(
			/no subagent dispatch, do the same reads sequentially/,
		);
	});
	it("ends with a paragraph break so it composes by + and by interpolation", () => {
		expect(WORKFLOW_READ_FANOUT_GUIDANCE.endsWith("\n\n")).toBe(true);
	});
});
