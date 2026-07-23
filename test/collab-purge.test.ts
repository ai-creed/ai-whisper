import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { findNonTerminalWorkflow } from "../packages/broker/src/storage/repositories/workflow-repository.ts";
import { listAllCollabs } from "../packages/broker/src/storage/repositories/collab-repository.ts";
import {
	classifyCollab,
	runCollabPurge,
} from "../packages/cli/src/commands/collab/purge.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function db() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "purge-wf-"));
	const d = openDatabase(path.join(tmp, "state.db"));
	applyMigrations(d);
	return d;
}

function seedWorkflow(
	d: ReturnType<typeof openDatabase>,
	collabId: string,
	wfId: string,
	status: string,
	createdAt: string,
) {
	d.prepare(
		`INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at)
     VALUES (?, ?, 'spec-driven-development', '/s', '{}', ?, 0, ?, ?)`,
	).run(wfId, collabId, status, createdAt, createdAt);
}

function seedCollabRow(
	d: ReturnType<typeof openDatabase>,
	id: string,
	status = "active",
) {
	d.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 't', ?, ?, 't', 't')`,
	).run(id, `/ws/${id}`, status, `wsid-${id}`);
}
function seedDaemon(
	d: ReturnType<typeof openDatabase>,
	id: string,
	pid: number | null,
) {
	d.prepare(
		`INSERT INTO broker_daemon (collab_id, host, port, pid, started_at, last_heartbeat_at)
     VALUES (?, '127.0.0.1', ?, ?, 't', 't')`,
	).run(id, _daemonPortSeq++, pid);
}
function seedAttachment(
	d: ReturnType<typeof openDatabase>,
	id: string,
	pid: number | null,
) {
	d.prepare(
		`INSERT INTO session_attachment (collab_id, agent_type, attachment_kind, pid, attached_at)
     VALUES (?, 'codex', 'mounted', ?, 't')`,
	).run(id, pid);
}
function only(d: ReturnType<typeof openDatabase>, id: string) {
	return listAllCollabs(d).find((c) => c.collabId === id)!;
}

let _daemonPortSeq = 1;

const DEAD = () => false;
const ALIVE = () => true;

describe("classifyCollab", () => {
	it("LIVE when the daemon pid is alive", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		const c = classifyCollab(d, only(d, "c1"), ALIVE);
		expect(c.bucket).toBe("live");
		expect(c.reason).toBe("live-daemon");
		d.close();
	});

	it("LIVE when any mounted agent pid is alive (daemon dead)", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		seedAttachment(d, "c1", 1000);
		const c = classifyCollab(d, only(d, "c1"), (pid) => pid === 1000);
		expect(c.bucket).toBe("live");
		expect(c.reason).toBe("live-mount");
		d.close();
	});

	it("PROTECTED when dead but a non-terminal workflow exists", () => {
		const d = db();
		seedCollabRow(d, "c1");
		seedDaemon(d, "c1", 999);
		seedWorkflow(d, "c1", "w1", "halted", "2026-06-30T00:00:00Z");
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("protected");
		expect(c.workflowId).toBe("w1");
		expect(c.workflowStatus).toBe("halted");
		d.close();
	});

	it("STALE when dead with no protecting workflow (active-but-dead-after-restart)", () => {
		const d = db();
		seedCollabRow(d, "c1", "active");
		seedDaemon(d, "c1", 999);
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("stale");
		expect(c.reason).toBe("dead-daemon");
		d.close();
	});

	it("STALE for a stopped leftover", () => {
		const d = db();
		seedCollabRow(d, "c1", "stopped");
		const c = classifyCollab(d, only(d, "c1"), DEAD);
		expect(c.bucket).toBe("stale");
		expect(c.reason).toBe("stopped");
		d.close();
	});
});

describe("findNonTerminalWorkflow", () => {
	it("returns null when all workflows are done/canceled", () => {
		const d = db();
		seedWorkflow(d, "c1", "w1", "done", "2026-06-30T00:00:00Z");
		seedWorkflow(d, "c1", "w2", "canceled", "2026-06-30T00:00:01Z");
		expect(findNonTerminalWorkflow(d, "c1")).toBeNull();
		d.close();
	});

	it("returns the most recent non-terminal workflow", () => {
		const d = db();
		seedWorkflow(d, "c1", "w1", "halted", "2026-06-30T00:00:00Z");
		seedWorkflow(d, "c1", "w2", "paused", "2026-06-30T00:00:05Z");
		expect(findNonTerminalWorkflow(d, "c1")).toEqual({
			workflowId: "w2",
			status: "paused",
		});
		d.close();
	});
});

// Build a temp state root with seeded collabs; returns helpers bound to it.
function setupStateRoot() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "purge-cmd-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const d = openDatabase(getSharedSqlitePath());
	applyMigrations(d);
	return { tmp, d };
}

describe("runCollabPurge", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("archives a stale collab on --yes and leaves a live one untouched", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "active");
		seedDaemon(d, "stale1", 999); // dead pid
		seedCollabRow(d, "live1", "active");
		seedDaemon(d, "live1", 1000); // alive pid
		d.close();

		const logs: string[] = [];
		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: (pid) => pid === 1000,
			isTTY: false,
			log: (l) => logs.push(l),
		});

		expect(res.purged).toEqual(["stale1"]);
		expect(res.exitCode).toBe(0);
		expect(logs).toContain(
			"Archived 1 collab(s) (runtime state removed, history kept), skipped (went live) 0, errors 0, protected 0.",
		);
		const d2 = openDatabase(getSharedSqlitePath());
		const stale = d2
			.prepare("SELECT archived_at, status FROM collab WHERE collab_id='stale1'")
			.get() as { archived_at: string | null; status: string };
		expect(stale.archived_at).toEqual(expect.any(String));
		expect(stale.status).toBe("stopped");
		const live = d2
			.prepare("SELECT archived_at FROM collab WHERE collab_id='live1'")
			.get() as { archived_at: string | null };
		expect(live.archived_at).toBeNull();
		d2.close();
	});

	it("archives stale collabs instead of deleting ledger rows", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		seedWorkflow(d, "stale1", "wf1", "done", "2026-06-30T00:00:00Z");
		d.close();

		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});

		expect(res.purged).toEqual(["stale1"]);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			d2
				.prepare("SELECT archived_at FROM collab WHERE collab_id = ?")
				.get("stale1"),
		).toMatchObject({ archived_at: expect.any(String) });
		expect(
			d2
				.prepare("SELECT COUNT(*) n FROM workflows WHERE collab_id = ?")
				.get("stale1"),
		).toMatchObject({ n: 1 });
		d2.close();
	});

	it("does not re-process already-archived collabs", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		d.close();

		const first = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});
		expect(first.purged).toEqual(["stale1"]);

		const out = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});
		expect(out.purged).toHaveLength(0); // archived collab no longer classified
		expect(out.classifications).toHaveLength(0);
	});

	it("protects a dead collab with a non-terminal workflow unless --force", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "prot1", "active");
		seedDaemon(d, "prot1", 999);
		seedWorkflow(d, "prot1", "w1", "halted", "2026-06-30T00:00:00Z");
		d.close();

		const noForce = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});
		expect(noForce.purged).toEqual([]);
		expect(noForce.protectedSkipped).toEqual(["prot1"]);

		const forced = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			force: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});
		expect(forced.purged).toEqual(["prot1"]);
	});

	it("--dry-run deletes nothing", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		d.close();
		const res = await runCollabPurge({
			cwd: "/tmp",
			dryRun: true,
			isAlive: DEAD,
			isTTY: true,
			log: () => {},
		});
		expect(res.purged).toEqual([]);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			(
				d2
					.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id='stale1'")
					.get() as { n: number }
			).n,
		).toBe(1);
		d2.close();
	});

	it("non-TTY without --yes refuses safely (exit non-zero, deletes nothing)", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		d.close();
		const res = await runCollabPurge({
			cwd: "/tmp",
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
		});
		expect(res.aborted).toBe(true);
		expect(res.exitCode).not.toBe(0);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			(
				d2
					.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id='stale1'")
					.get() as { n: number }
			).n,
		).toBe(1);
		d2.close();
	});

	it("TTY answering 'n' aborts without deleting", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		d.close();
		const res = await runCollabPurge({
			cwd: "/tmp",
			isAlive: DEAD,
			isTTY: true,
			confirm: async () => false,
			log: () => {},
		});
		expect(res.aborted).toBe(true);
		expect(res.purged).toEqual([]);
	});

	it("--workspace confines archival to one workspace; stale elsewhere is untouched", async () => {
		const { d } = setupStateRoot();
		const wsA = mkdtempSync(path.join(os.tmpdir(), "wsA-"));
		const wsB = mkdtempSync(path.join(os.tmpdir(), "wsB-"));
		const { workspaceIdFromPath } =
			await import("../packages/cli/src/runtime/workspace-id.ts");
		d.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at) VALUES ('a','${wsA}','t','stopped',?, 't','t')`,
		).run(workspaceIdFromPath(wsA));
		d.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at) VALUES ('b','${wsB}','t','stopped',?, 't','t')`,
		).run(workspaceIdFromPath(wsB));
		d.close();

		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			workspace: wsA,
			log: () => {},
		});
		expect(res.purged).toEqual(["a"]);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			(
				d2
					.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id='b'")
					.get() as { n: number }
			).n,
		).toBe(1);
		d2.close();
	});

	it("skips a collab that goes live between classification and deletion (TOCTOU)", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "race1", "active");
		seedDaemon(d, "race1", 1234);
		d.close();
		// Dead at classify, alive at the in-transaction re-check.
		let calls = 0;
		const isAlive = (_pid: number) => {
			calls += 1;
			return calls > 1; // first probe (classify) dead; later probes (re-check) alive
		};
		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive,
			isTTY: false,
			log: () => {},
		});
		expect(res.skippedWentLive).toEqual(["race1"]);
		expect(res.purged).toEqual([]);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			(
				d2
					.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id='race1'")
					.get() as { n: number }
			).n,
		).toBe(1);
		d2.close();
	});

	it("--json emits a machine-readable shape and (without --yes) deletes nothing", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "stale1", "stopped");
		d.close();
		const logs: string[] = [];
		const res = await runCollabPurge({
			cwd: "/tmp",
			json: true,
			isAlive: DEAD,
			isTTY: false,
			log: (l) => logs.push(l),
		});
		expect(res.purged).toEqual([]);
		const payload = JSON.parse(logs.join("\n")) as {
			classifications: { collabId: string; bucket: string }[];
		};
		expect(Array.isArray(payload.classifications)).toBe(true);
		expect(payload.classifications[0]).toMatchObject({
			collabId: "stale1",
			bucket: "stale",
		});
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			(
				d2
					.prepare("SELECT COUNT(*) AS n FROM collab WHERE collab_id='stale1'")
					.get() as { n: number }
			).n,
		).toBe(1);
		d2.close();
	});

	it("rejects --collab + --workspace together", async () => {
		setupStateRoot().d.close();
		await expect(
			runCollabPurge({
				cwd: "/tmp",
				collabId: "x",
				workspace: "/y",
				isAlive: DEAD,
				isTTY: false,
				log: () => {},
			}),
		).rejects.toThrow(/mutually exclusive/);
	});

	it("--collab narrows archival to a single collab id (AC-7)", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "s1", "stopped");
		seedCollabRow(d, "s2", "stopped"); // also stale, in scope of a no-filter sweep
		d.close();

		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			collabId: "s1",
			log: () => {},
		});

		// Only s1 is even classified/purged; s2 is never touched.
		expect(res.purged).toEqual(["s1"]);
		expect(res.classifications.map((c) => c.collabId)).toEqual(["s1"]);
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			d2
				.prepare("SELECT archived_at FROM collab WHERE collab_id='s1'")
				.get(),
		).toMatchObject({ archived_at: expect.any(String) });
		expect(
			d2
				.prepare("SELECT archived_at FROM collab WHERE collab_id='s2'")
				.get(),
		).toMatchObject({ archived_at: null });
		d2.close();
	});

	it("a per-collab archival failure is recorded and does NOT abort the sweep (AC-8)", async () => {
		const { d } = setupStateRoot();
		seedCollabRow(d, "boom", "stopped");
		seedCollabRow(d, "ok", "stopped");
		d.close();

		const { archiveCollabRuntime } =
			await import("../packages/broker/src/storage/repositories/collab-repository.ts");
		const res = await runCollabPurge({
			cwd: "/tmp",
			yes: true,
			isAlive: DEAD,
			isTTY: false,
			log: () => {},
			// Fail the first candidate; delegate the rest to the real archive action.
			deleteCascade: (db, collabId) => {
				if (collabId === "boom") throw new Error("simulated delete failure");
				archiveCollabRuntime(db, collabId, "2026-07-23T00:00:00.000Z");
			},
		});

		expect(res.skippedError.map((e) => e.collabId)).toEqual(["boom"]);
		expect(res.purged).toEqual(["ok"]); // sweep continued past the failure
		expect(res.exitCode).toBe(1); // a per-collab error makes the run non-zero
		const d2 = openDatabase(getSharedSqlitePath());
		expect(
			d2
				.prepare("SELECT archived_at FROM collab WHERE collab_id='boom'")
				.get(),
		).toMatchObject({ archived_at: null }); // failed transaction rolled back
		expect(
			d2
				.prepare("SELECT archived_at FROM collab WHERE collab_id='ok'")
				.get(),
		).toMatchObject({ archived_at: expect.any(String) });
		d2.close();
	});
});
