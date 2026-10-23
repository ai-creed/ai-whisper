import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	updateBrokerDaemonHeartbeat,
	getBrokerDaemonByCollab,
	getBrokerDaemonByPort,
	deleteBrokerDaemonByCollab,
	listStaleBrokerDaemons,
	listAllBrokerDaemons,
	setBrokerDaemonEvaluatorStatus,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "bd-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("c1", "/tmp/r", "test", "active", "2026-05-15T00:00:00Z", "2026-05-15T00:00:00Z");
	return db;
}

describe("broker-daemon-repository", () => {
	it("inserts a reservation row with pid NULL", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.pid).toBeNull();
		expect(row?.pidStartTime).toBeNull();
		expect(row?.port).toBe(4500);
	});

	it("reads degrade to evaluatorStatus null on a pre-migration DB lacking the column", () => {
		// Regression: a read-only `collab status` (or resolveCollab) against an
		// existing v3 state.db, before the upgraded daemon has applied the
		// migration, must NOT throw "no such column: evaluator_status".
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		// Simulate the pre-migration shape: drop the column the migration adds.
		db.exec("ALTER TABLE broker_daemon DROP COLUMN evaluator_status");
		db.pragma("user_version = 3");

		expect(() => getBrokerDaemonByCollab(db, "c1")).not.toThrow();
		expect(getBrokerDaemonByCollab(db, "c1")?.evaluatorStatus).toBeNull();
		expect(getBrokerDaemonByPort(db, 4500)?.evaluatorStatus).toBeNull();
		expect(() => listAllBrokerDaemons(db)).not.toThrow();
		expect(() =>
			listStaleBrokerDaemons(db, "2099-01-01T00:00:00Z"),
		).not.toThrow();
	});

	it("stores and reads cliVersion", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
			cliVersion: "0.17.0",
		});
		expect(getBrokerDaemonByCollab(db, "c1")?.cliVersion).toBe("0.17.0");
		expect(getBrokerDaemonByPort(db, 4500)?.cliVersion).toBe("0.17.0");
	});

	it("reads degrade to cliVersion null when the column is missing", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		db.exec("ALTER TABLE broker_daemon DROP COLUMN cli_version");

		expect(getBrokerDaemonByCollab(db, "c1")?.cliVersion).toBeNull();
		expect(getBrokerDaemonByPort(db, 4500)?.cliVersion).toBeNull();
		expect(listAllBrokerDaemons(db)[0]?.cliVersion).toBeNull();
		expect(listStaleBrokerDaemons(db, "2099-01-01T00:00:00Z")[0]?.cliVersion).toBeNull();
	});

	it("updates pid and pid_start_time atomically", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 1234,
			pidStartTime: "ABC",
			now: "2026-05-15T00:00:05Z",
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.pid).toBe(1234);
		expect(row?.pidStartTime).toBe("ABC");
		expect(row?.lastHeartbeatAt).toBe("2026-05-15T00:00:05Z");
	});

	it("updates heartbeat without touching pid", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 1234,
			pidStartTime: "ABC",
			now: "2026-05-15T00:00:05Z",
		});
		updateBrokerDaemonHeartbeat(db, { collabId: "c1", now: "2026-05-15T00:00:10Z" });
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.pid).toBe(1234);
		expect(row?.lastHeartbeatAt).toBe("2026-05-15T00:00:10Z");
	});

	it("deletes a row by collab id", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		expect(deleteBrokerDaemonByCollab(db, "c1")).toBe(1);
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
	});

	it("listStaleBrokerDaemons returns rows older than the cutoff", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		expect(listStaleBrokerDaemons(db, "2026-05-15T00:01:30Z")).toHaveLength(1);
		expect(listStaleBrokerDaemons(db, "2026-05-15T00:00:00Z")).toHaveLength(0);
	});

	it("listAllBrokerDaemons returns every row", () => {
		const db = freshDb();
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c2', '/r', 'b', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		insertBrokerDaemon(db, {
			collabId: "c2",
			host: "127.0.0.1",
			port: 4501,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		expect(listAllBrokerDaemons(db)).toHaveLength(2);
	});

	it("evaluatorStatus is null on fresh insert", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBeNull();
	});

	it("setBrokerDaemonEvaluatorStatus writes and reads back", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		setBrokerDaemonEvaluatorStatus(db, { collabId: "c1", status: "missing_anthropic_key" });
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.evaluatorStatus).toBe("missing_anthropic_key");
	});

	it("setBrokerDaemonEvaluatorStatus can update to different status values", () => {
		const db = freshDb();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		for (const status of ["ready", "missing_anthropic_key", "invalid_config", "disabled"] as const) {
			setBrokerDaemonEvaluatorStatus(db, { collabId: "c1", status });
			expect(getBrokerDaemonByCollab(db, "c1")?.evaluatorStatus).toBe(status);
		}
	});

	it("rejects two daemons on the same port", () => {
		const db = freshDb();
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c2', '/r', 'b', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run();
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		expect(() =>
			insertBrokerDaemon(db, {
				collabId: "c2",
				host: "127.0.0.1",
				port: 4500,
				startedAt: "2026-05-15T00:00:00Z",
				lastHeartbeatAt: "2026-05-15T00:00:00Z",
			}),
		).toThrow(/UNIQUE/);
	});
});
