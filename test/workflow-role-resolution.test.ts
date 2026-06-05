import { describe, expect, it } from "vitest";
import {
	parseCallerAgent,
	resolveRoleBindings,
} from "../packages/cli/src/commands/workflow/start.ts";

const sddDef = { defaultImplementer: "claude", defaultReviewer: "codex" } as const;

describe("resolveRoleBindings", () => {
	it("uses both explicit flags verbatim", () => {
		const r = resolveRoleBindings({
			explicitImplementer: "codex",
			explicitReviewer: "claude",
			callerAgent: "claude",
			def: sddDef,
		});
		expect(r).toMatchObject({ implementer: "codex", reviewer: "claude", source: "explicit" });
		expect(r.warning).toBeUndefined();
	});

	it("fills the opposite role when only --implementer is given", () => {
		expect(resolveRoleBindings({ explicitImplementer: "codex", def: sddDef })).toMatchObject({
			implementer: "codex",
			reviewer: "claude",
			source: "explicit",
		});
	});

	it("fills the opposite role when only --reviewer is given", () => {
		expect(resolveRoleBindings({ explicitReviewer: "claude", def: sddDef })).toMatchObject({
			implementer: "codex",
			reviewer: "claude",
			source: "explicit",
		});
	});

	it("rejects same-agent explicit flags", () => {
		expect(() =>
			resolveRoleBindings({ explicitImplementer: "codex", explicitReviewer: "codex", def: sddDef }),
		).toThrow(/same agent/i);
	});

	it("derives implementer from caller (codex)", () => {
		const r = resolveRoleBindings({ callerAgent: "codex", def: sddDef });
		expect(r).toMatchObject({ implementer: "codex", reviewer: "claude", source: "caller" });
		expect(r.warning).toBeUndefined();
	});

	it("derives implementer from caller (claude)", () => {
		expect(resolveRoleBindings({ callerAgent: "claude", def: sddDef })).toMatchObject({
			implementer: "claude",
			reviewer: "codex",
			source: "caller",
		});
	});

	it("falls back to def default with a warning when no flags and no caller", () => {
		const r = resolveRoleBindings({ callerAgent: null, def: sddDef });
		expect(r).toMatchObject({ implementer: "claude", reviewer: "codex", source: "default" });
		expect(r.warning).toMatch(/no triggering agent detected|defaulted/i);
	});

	it("throws when no flags, no caller, and no def defaults", () => {
		expect(() => resolveRoleBindings({ callerAgent: null, def: {} })).toThrow(
			/no default role bindings/i,
		);
	});
});

describe("parseCallerAgent", () => {
	it("accepts claude/codex/ezio", () => {
		expect(parseCallerAgent("claude")).toBe("claude");
		expect(parseCallerAgent("codex")).toBe("codex");
		expect(parseCallerAgent("ezio")).toBe("ezio");
	});

	it("rejects anything else as null", () => {
		for (const v of [undefined, "", "gpt", "Claude ", "both", "ezio "]) {
			expect(parseCallerAgent(v)).toBeNull();
		}
	});
});

describe("resolveRoleBindings — bound-agent aware (M6)", () => {
	it("ezio caller in an ezio+claude collab → implementer ezio, reviewer claude", () => {
		const r = resolveRoleBindings({
			callerAgent: "ezio",
			boundAgents: ["ezio", "claude"],
		});
		expect(r).toMatchObject({ implementer: "ezio", reviewer: "claude", source: "caller" });
	});

	it("explicit --implementer ezio fills reviewer from the other bound agent", () => {
		const r = resolveRoleBindings({
			explicitImplementer: "ezio",
			boundAgents: ["claude", "ezio"],
		});
		expect(r).toMatchObject({ implementer: "ezio", reviewer: "claude", source: "explicit" });
	});

	it("codex/claude with no bindings still flips (fallback preserved)", () => {
		expect(resolveRoleBindings({ callerAgent: "codex" })).toMatchObject({
			implementer: "codex",
			reviewer: "claude",
		});
	});

	it("ezio with no bindings and no explicit partner throws (ambiguous)", () => {
		expect(() => resolveRoleBindings({ callerAgent: "ezio" })).toThrow(/partner/i);
	});

	it("same agent for both roles is still rejected", () => {
		expect(() =>
			resolveRoleBindings({ explicitImplementer: "ezio", explicitReviewer: "ezio" }),
		).toThrow(/cannot be the same/i);
	});
});
