import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { insertBrokerDaemon, updateBrokerDaemonPid } from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { connectAgentCommand } from "../packages/cli/src/runtime/broker-connect.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

const NOTICE_COLUMNS = [
	"delivery_path",
	"notice_sent_at",
	"reminder_sent_at",
	"nudge_sent_at",
	"fetched_at",
	"fetch_count",
	"capture_path",
	"replied_at",
	"reply_refused_at",
];

function tableInfo(db: Database.Database, table: string) {
	return db.prepare(`PRAGMA table_info(${table})`).all();
}

// Builds a file DB whose schema predates the notice path (user_version 7).
// keepCliVersion retains broker_daemon.cli_version, set to cliVersion.
function buildFixture(opts: { cliVersion: string | null; keepCliVersion: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), "ac-"));
	const cwd = mkdtempSync(join(tmpdir(), "ac-ws-"));
	const sqlitePath = join(dir, "broker.sqlite");
	const db = openDatabase(sqlitePath);
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
	).run("c1", cwd, "test", workspaceIdFromPath(cwd), "2026-05-15T00:00:00Z", "2026-05-15T00:00:00Z");
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
		...(opts.cliVersion !== null ? { cliVersion: opts.cliVersion } : {}),
	});
	updateBrokerDaemonPid(db, { collabId: "c1", pid: 1234, pidStartTime: null, now: "2026-05-15T00:00:01Z" });
	for (const col of NOTICE_COLUMNS) db.exec(`ALTER TABLE relay_handoff DROP COLUMN ${col}`);
	db.exec("ALTER TABLE session_binding DROP COLUMN turn_done_at");
	if (!opts.keepCliVersion) db.exec("ALTER TABLE broker_daemon DROP COLUMN cli_version");
	db.pragma("user_version = 7");
	db.close();
	return { sqlitePath, cwd };
}

function snapshot(sqlitePath: string) {
	const db = openDatabase(sqlitePath);
	const snap = {
		version: db.pragma("user_version", { simple: true }),
		handoff: tableInfo(db, "relay_handoff"),
		tables: db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),
	};
	db.close();
	return snap;
}

describe("connectAgentCommand", () => {
	it("does not migrate an unmigrated DB on mismatch", () => {
		const { sqlitePath, cwd } = buildFixture({ cliVersion: null, keepCliVersion: false });
		const before = snapshot(sqlitePath);
		const r = connectAgentCommand({ cwd, context: "show", cliVersion: "0.17.0", sqlitePath });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.message).toBe(
			"ai-whisper CLI 0.17.0 does not match the running broker unknown. Stop here and end your turn; ai-whisper will resend this handoff. Do not read ~/.ai-whisper/state.db directly.",
		);
		expect(r.reason).toBe("version_mismatch");
		expect(r.collabId).toBe("c1");
		expect(r.db).not.toBeNull();
		r.close();
		expect(snapshot(sqlitePath)).toEqual(before);
		expect(before.version).toBe(7);
	});

	it("does not migrate on the success path either", () => {
		const { sqlitePath, cwd } = buildFixture({ cliVersion: "0.17.0", keepCliVersion: true });
		const before = snapshot(sqlitePath);
		const r = connectAgentCommand({ cwd, context: "show", cliVersion: "0.17.0", sqlitePath });
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.collabId).toBe("c1");
		expect(typeof r.control.handoffBackRelay).toBe("function");
		r.close();
		expect(snapshot(sqlitePath)).toEqual(before);
		expect(before.version).toBe(7);
	});

	it("turns resolver errors into a failed result", () => {
		const { sqlitePath } = buildFixture({ cliVersion: "0.17.0", keepCliVersion: true });
		const other = mkdtempSync(join(tmpdir(), "ac-other-"));
		const r = connectAgentCommand({ cwd: other, context: "reply", cliVersion: "0.17.0", sqlitePath });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.message).toContain("no active collab found");
		expect(r.reason).toBe("unresolved");
		expect(r.collabId).toBeNull();
		expect(r.db).toBeNull();
	});
});
