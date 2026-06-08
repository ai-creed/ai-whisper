import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@ai-whisper/broker";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";

function tempStateRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "aiw-mount-auto-"));
	return dir;
}

/**
 * Wraps `runCollabStart` with stubbed daemon-spawning so unit tests never
 * launch a real broker child process. Without this, mount's default auto-
 * create branch shells out to `spawnBrokerDaemon` and leaves leaked
 * tsx/node processes around after the suite. The stubs do everything the
 * real start does at the DB level (insert collab + broker_daemon +
 * recovery_state rows) but skip the OS-level fork.
 */
const stubbedRunStart: typeof runCollabStart = async (opts) => {
	return runCollabStart({
		...opts,
		spawnBroker: (input) => {
			const db = openDatabase(getSharedSqlitePath());
			db.prepare(
				"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
			).run(91234, new Date().toISOString(), input.collabId);
			db.close();
			return 91234;
		},
		waitForReady: async () => true,
		isPortFreeOs: async () => true,
		signalProcess: () => {},
	});
};

describe("runCollabMount auto-create", () => {
	let prevStateRoot: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) {
			delete process.env.AI_WHISPER_STATE_ROOT;
		} else {
			process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
		}
	});

	it("creates a new collab in the empty workspace and binds the agent", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () =>
				({
					pidAlive: true,
					httpReachable: true,
					ok: true,
				}) as never,
			runStartFn: stubbedRunStart,
			// stubbedRunStart writes a fake daemon pid; treat it as alive so a
			// re-resolve never revives via the real runCollabRecover →
			// spawnBrokerDaemon (which would leak a broker process).
			isDaemonPidAlive: () => true,
		});

		const db = openDatabase(getSharedSqlitePath());
		const row = db
			.prepare("SELECT collab_id, display_name FROM collab")
			.get() as { collab_id: string; display_name: string };
		db.close();
		expect(row).toBeDefined();
		expect(row.display_name).toBe("ws");
		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
	});

	it("re-mounts after the workspace's collab was stopped (auto-creates a fresh active collab)", async () => {
		// Regression: `whisper collab stop` marks the collab status='stopped'.
		// resolveCollab then throws CollabAlreadyStopped (not NoCollabFoundForCwd),
		// which the auto-create branch must ALSO tolerate — otherwise the user
		// can never re-mount in a workspace they once stopped.
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-stopped");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };
		const mountArgs = {
			workspaceRoot,
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () =>
				({ pidAlive: true, httpReachable: true, ok: true }) as never,
			runStartFn: stubbedRunStart,
			// Fake daemon pid → treat as alive so re-resolve skips the real revive
			// spawn (no leaked broker process).
			isDaemonPidAlive: () => true,
		};

		// First mount: auto-creates collab #1.
		await runCollabMount({ ...mountArgs, target: "codex" });
		const db1 = openDatabase(getSharedSqlitePath());
		const firstId = (
			db1
				.prepare("SELECT collab_id FROM collab WHERE status = 'active' LIMIT 1")
				.get() as { collab_id: string }
		).collab_id;
		// Simulate `collab stop`: flip the only collab to stopped.
		db1.prepare("UPDATE collab SET status = 'stopped' WHERE collab_id = ?").run(firstId);
		db1.close();

		// Second mount in the same workspace must NOT throw CollabAlreadyStopped —
		// it auto-creates a fresh active collab.
		await expect(
			runCollabMount({ ...mountArgs, target: "codex" }),
		).resolves.toBeUndefined();

		const db2 = openDatabase(getSharedSqlitePath());
		const activeCount = (
			db2
				.prepare("SELECT COUNT(*) AS c FROM collab WHERE status = 'active'")
				.get() as { c: number }
		).c;
		const newActiveId = (
			db2
				.prepare("SELECT collab_id FROM collab WHERE status = 'active' LIMIT 1")
				.get() as { collab_id: string }
		).collab_id;
		db2.close();
		expect(activeCount).toBe(1); // exactly one fresh active collab
		expect(newActiveId).not.toBe(firstId); // a NEW collab, not the stopped one
	});

	it("uses the existing collab when one already exists for cwd (no duplicate created)", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws2");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		for (const target of ["codex", "claude"] as const) {
			await runCollabMount({
				workspaceRoot,
				target,
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: async () =>
					({
						pidAlive: true,
						httpReachable: true,
						ok: true,
					}) as never,
				runStartFn: stubbedRunStart,
				// The 2nd iteration re-resolves the existing collab whose fake
				// daemon pid is dead; treat it as alive so mount reuses it instead
				// of reviving via the real spawnBrokerDaemon (the original leak).
				isDaemonPidAlive: () => true,
			});
		}

		const db = openDatabase(getSharedSqlitePath());
		const count = (
			db.prepare("SELECT COUNT(*) AS c FROM collab").get() as {
				c: number;
			}
		).c;
		db.close();
		expect(count).toBe(1);
		expect(fakeRuntime.start).toHaveBeenCalledTimes(2);
	});

	it("auto-create race: tolerates a parallel mount creating the collab first", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws3");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		// Stand-in for a parallel mount: when our mount's create branch
		// calls runStartFn, it will first invoke the real `runCollabStart`
		// to insert a "parallel-winner" collab row, then immediately
		// re-invoke it (now expected to throw "active collab already
		// exists"). The mount should swallow that and re-resolve to the
		// parallel-created collab id.
		let parallelCollabId: string | undefined;
		const runStartFn: typeof runCollabStart = async (opts) => {
			if (parallelCollabId === undefined) {
				// "Parallel" terminal wins the race: invoke the real start.
				const parallelOpts = {
					...opts,
					spawnBroker: (input: {
						collabId: string;
						host: string;
						port: number;
						sqlitePath: string;
					}) => {
						const db = openDatabase(getSharedSqlitePath());
						db.prepare(
							"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
						).run(91234, new Date().toISOString(), input.collabId);
						db.close();
						return 91234;
					},
					waitForReady: async () => true,
					isPortFreeOs: async () => true,
					signalProcess: () => {},
				};
				const r = await runCollabStart(parallelOpts);
				parallelCollabId = r.collabId;
				// Now run the original (slow) start — which will see the
				// active collab and throw "active collab already exists".
				return runCollabStart(opts);
			}
			throw new Error("unexpected second invocation");
		};

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () =>
				({
					pidAlive: true,
					httpReachable: true,
					ok: true,
				}) as never,
			runStartFn,
			// Fake daemon pid → treat as alive so no real revive spawn leaks.
			isDaemonPidAlive: () => true,
		});

		const db = openDatabase(getSharedSqlitePath());
		const rows = db
			.prepare("SELECT collab_id FROM collab")
			.all() as Array<{ collab_id: string }>;
		db.close();
		expect(rows.length).toBe(1);
		expect(rows[0]?.collab_id).toBe(parallelCollabId);
		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
	});
});
