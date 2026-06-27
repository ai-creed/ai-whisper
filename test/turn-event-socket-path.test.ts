import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnEventSocketPath } from "../packages/cli/src/runtime/turn-event-socket-path.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

describe("turnEventSocketPath", () => {
	it("composes <dir>/<workspaceId>-<provider>.sock", () => {
		expect(turnEventSocketPath("/s", "abc123", "claude")).toBe(
			"/s/abc123-claude.sock",
		);
		expect(turnEventSocketPath("/s", "abc123", "codex")).toBe(
			"/s/abc123-codex.sock",
		);
	});

	// Spec §5: two worktrees of one repo are two distinct canonical paths → two
	// distinct workspace ids → two distinct sockets. This exercises the REAL
	// workspaceIdFromPath canonicalization, so a regression in its path isolation
	// (not just string formatting) is caught.
	it("two distinct worktree paths derive distinct sockets for the same provider (no collision)", () => {
		const wtA = realpathSync(mkdtempSync(join(tmpdir(), "aiw-wt-a-")));
		const wtB = realpathSync(mkdtempSync(join(tmpdir(), "aiw-wt-b-")));
		const idA = workspaceIdFromPath(wtA);
		const idB = workspaceIdFromPath(wtB);
		expect(idA).not.toBe(idB);
		const sockA = turnEventSocketPath("/s", idA, "claude");
		const sockB = turnEventSocketPath("/s", idB, "claude");
		expect(sockA).not.toBe(sockB);
		// ...and the same path always derives the same id (stable, idempotent).
		expect(workspaceIdFromPath(wtA)).toBe(idA);
	});

	it("builds the agy socket path", () => {
		expect(turnEventSocketPath("/sockets", "ws1", "agy")).toBe("/sockets/ws1-agy.sock");
	});
});
