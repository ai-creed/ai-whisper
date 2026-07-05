import { describe, expect, it } from "vitest";
import { resolveRoleBindings } from "../packages/cli/src/commands/workflow/start.ts";

// cursor has no hardcoded claude<->codex partner (like ezio). Its partner must
// come from the agents actually bound in the collab; with none, role inference
// fails loudly rather than guessing.
describe("resolveRoleBindings — cursor partner inference", () => {
	it("derives the reviewer from the bound partner when cursor is the caller", () => {
		expect(
			resolveRoleBindings({ callerAgent: "cursor", boundAgents: ["cursor", "claude"] }),
		).toEqual({ implementer: "cursor", reviewer: "claude", source: "caller" });
	});

	it("fills the missing reviewer from bound agents when cursor is the explicit implementer", () => {
		expect(
			resolveRoleBindings({
				explicitImplementer: "cursor",
				boundAgents: ["cursor", "codex"],
			}),
		).toEqual({ implementer: "cursor", reviewer: "codex", source: "explicit" });
	});

	it("throws an explicit error when cursor has no bound partner (no claude<->codex flip)", () => {
		expect(() => resolveRoleBindings({ callerAgent: "cursor" })).toThrow(
			/Cannot infer the partner agent for "cursor"/,
		);
	});
});
