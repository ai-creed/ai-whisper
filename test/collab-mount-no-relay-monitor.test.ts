import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

const assessBroker = vi.fn(() =>
	Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }),
);

describe("runCollabMount no longer requires relay-monitor", () => {
	it("mount succeeds when isRelayMonitorConnected returns false (dashboard subsumes the role)", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-mount-no-relay-monitor-"));
		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-06T10:00:00.000Z",
			launchMode: "none",
		});

		const fakeRuntime = { start: () => Promise.resolve() };

		// No relay monitor registered at any point. Mount must NOT throw.
		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: "2026-04-06T10:01:00.000Z",
				resolveCurrentTty: () => "/dev/ttys031",
				assessBroker,
				createRuntime: () => fakeRuntime as never,
				// The seeded daemon pid is fake (not a live process). Without this,
				// mount's stale-pid check treats it as dead and revives via the real
				// runCollabRecover → spawnBrokerDaemon, leaking a tsx/node broker
				// process. Treat the daemon as alive so no real fork happens.
				isDaemonPidAlive: () => true,
			}),
		).resolves.toBeUndefined();
	});
});
