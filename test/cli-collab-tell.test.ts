import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";
import { registerLaunchedBindings } from "./helpers/register-launched-bindings.ts";

describe("cli collab tell", () => {
	it("routes a work request and returns a provider-backed reply", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-phase5-tell-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});
		// Default mode no longer pre-registers sessions — simulate bindings that
		// would normally be created by the mount panes once they complete.
		await registerLaunchedBindings({
			workspaceRoot,
			now: "2026-04-03T00:00:00.500Z",
		});

		await expect(
			runCollabTell({
				cwd: workspaceRoot,
				target: "codex",
				instruction: "review this plan",
				explicitAction: "review_plan",
				artifactPaths: [planPath],
				threadTitle: "Review plan",
				providerOverride: createMockProvider(),
				now: "2026-04-03T00:00:01.000Z",
			}),
		).resolves.toMatchObject({
			kind: "review",
		});
	});

	it("accepts --target ezio (M6: ezio is a first-class tell target)", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-tell-ezio-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await startCollabForTest({
			workspaceRoot,
			now: "2026-06-05T00:00:00.000Z",
			launchMode: "terminals",
		});
		await registerLaunchedBindings({
			workspaceRoot,
			now: "2026-06-05T00:00:00.500Z",
			agents: ["ezio", "claude"],
		});

		// The guard previously rejected anything but codex/claude; ezio must now
		// pass and route through the normal work path (mock provider reply).
		await expect(
			runCollabTell({
				cwd: workspaceRoot,
				target: "ezio",
				instruction: "review this plan",
				explicitAction: "review_plan",
				artifactPaths: [planPath],
				threadTitle: "Review plan",
				providerOverride: createMockProvider(),
				now: "2026-06-05T00:00:01.000Z",
			}),
		).resolves.toMatchObject({ kind: "review" });
	});
});
