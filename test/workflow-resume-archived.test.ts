import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveCollabRuntime,
	createBrokerRuntime,
} from "../packages/broker/src/index.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { canonicalWorkspaceRoot } from "../packages/cli/src/runtime/workspace-id.ts";

describe("workflow lifecycle on archived collabs", () => {
	it("resume of a workflow with an archived parent fails with no state change", () => {
		const repo = mkdtempSync(path.join(os.tmpdir(), "resume-archived-"));
		// Driver off: the guard lives in resumeWorkflow, not the driver, and a live
		// driver would only add nondeterministic kickoff races to a fixture that just
		// needs a halted workflow on an archived collab.
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4711,
			runWorkflowDriver: false,
		});

		try {
			const collabId = "collab_archived_resume";
			broker.control.startCollab({
				collabId,
				workspaceRoot: repo,
				displayName: "archived-resume",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 3,
				now: "2026-04-21T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId,
					agentType: agent,
					sessionId: `session_${agent}`,
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}

			const { workflowId } = broker.control.createWorkflow({
				collabId,
				workflowType: "spec-driven-development",
				specPath: "spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});

			// Halt the workflow via a direct row update — a deterministic halted
			// fixture without driving a full relay cycle.
			broker.db
				.prepare(
					"UPDATE workflows SET status = 'halted', halt_reason = ?, updated_at = ? WHERE workflow_id = ?",
				)
				.run("halted for test", "2026-04-21T00:30:00Z", workflowId);

			const before = broker.db
				.prepare(
					"SELECT status, halt_reason, updated_at FROM workflows WHERE workflow_id = ?",
				)
				.get(workflowId);

			// Archive the collab (Task 3): status='stopped' + archived_at stamped.
			const archiveTx = broker.db.transaction(() =>
				archiveCollabRuntime(broker.db, collabId, "2026-04-21T01:00:00Z"),
			);
			archiveTx.immediate();

			// Full-row snapshot (every column), pinned immediately after archiving —
			// the resume refusal must leave the collab row byte-for-byte untouched,
			// not merely `archived_at` still-a-string.
			const collabBefore = broker.db
				.prepare("SELECT * FROM collab WHERE collab_id = ?")
				.get(collabId);

			expect(() =>
				broker.control.resumeWorkflow({
					workflowId,
					now: "2026-04-21T02:00:00Z",
				}),
			).toThrow(/archived/);

			const after = broker.db
				.prepare(
					"SELECT status, halt_reason, updated_at FROM workflows WHERE workflow_id = ?",
				)
				.get(workflowId);
			expect(after).toEqual(before);

			const collabAfter = broker.db
				.prepare("SELECT * FROM collab WHERE collab_id = ?")
				.get(collabId);
			expect(collabAfter).toEqual(collabBefore);
		} finally {
			void broker.stop();
		}
	});
});

describe("whisper collab start on a workspace with an archived predecessor", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("succeeds when the workspace's only prior collab is archived", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "start-archived-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const workspaceRoot = canonicalWorkspaceRoot(ws);

		const startOpts = (displayName: string, now: string) => ({
			cwd: ws,
			displayName,
			launchMode: "none" as const,
			now: () => now,
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }: { collabId: string }) => {
				const db = openDatabase(getSharedSqlitePath());
				db.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(1, now, collabId);
				db.close();
				return 1;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		});

		// First collab claims the one-active slot for the workspace.
		const first = await runCollabStart(startOpts("first", "2026-05-15T00:00:00Z"));

		// Archive it — sets status='stopped' + archived_at, freeing the slot.
		const db = openDatabase(getSharedSqlitePath());
		const archiveTx = db.transaction(() =>
			archiveCollabRuntime(db, first.collabId, "2026-05-15T00:30:00Z"),
		);
		archiveTx.immediate();
		db.close();

		// Second start against the SAME workspace must succeed through the real path
		// (start.ts active-collab lookup + the partial unique index both key on
		// status='active', which the archived predecessor no longer holds).
		const second = await runCollabStart(startOpts("second", "2026-05-15T01:00:00Z"));
		expect(second.collabId).toBeTruthy();
		expect(second.collabId).not.toBe(first.collabId);

		const verifyDb = openDatabase(getSharedSqlitePath());
		const rows = verifyDb
			.prepare(
				"SELECT collab_id, status, archived_at FROM collab WHERE workspace_root = ? ORDER BY created_at",
			)
			.all(workspaceRoot);
		verifyDb.close();

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ status: "stopped", archived_at: expect.any(String) }); // predecessor untouched
		expect(rows[1]).toMatchObject({ status: "active", archived_at: null }); // fresh collab holds the slot
	});
});
