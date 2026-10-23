import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	insertBrokerDaemon,
	updateBrokerDaemonPid,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { connectAgentCommand } from "../packages/cli/src/runtime/broker-connect.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { resolveTurnDoneResult, runTurnDone } from "../packages/cli/src/commands/turn/done.ts";

type Record_ = Parameters<typeof runTurnDone>[0]["control"]["recordSeatTurnDone"];

const NOW = "2026-10-23T00:00:00.000Z";

function deps(fetched: string | null, overrides: Record<string, unknown> = {}) {
	const recordSeatTurnDone = vi.fn(() => ({ fetchedUnrepliedHandoffId: fetched }));
	return {
		recordSeatTurnDone,
		input: {
			control: { recordSeatTurnDone: recordSeatTurnDone as unknown as Record_ },
			collabId: "collab_1",
			callerAgent: "claude" as const,
			now: NOW,
			...overrides,
		},
	};
}

function fileDbFixture(daemonVersion: string) {
	const sqlitePath = join(mkdtempSync(join(tmpdir(), "td-")), "b.sqlite");
	const cwd = mkdtempSync(join(tmpdir(), "td-ws-"));
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
		cliVersion: daemonVersion,
	});
	updateBrokerDaemonPid(db, { collabId: "c1", pid: 1234, pidStartTime: null, now: "2026-05-15T00:00:01Z" });
	db.close();
	return { sqlitePath, cwd };
}

function turnDoneRows(sqlitePath: string): number {
	const db = openDatabase(sqlitePath);
	const n = (db.prepare("SELECT COUNT(*) AS n FROM seat_turn_done").get() as { n: number }).n;
	db.close();
	return n;
}

describe("runTurnDone", () => {
	it("records and prints ok", () => {
		const d = deps(null);
		expect(runTurnDone(d.input)).toEqual({ exitCode: 0, stdout: "ok" });
		expect(d.recordSeatTurnDone).toHaveBeenCalledWith({ collabId: "collab_1", agent: "claude", now: NOW });
	});

	it("prints the reply hint when a fetched handoff has no reply", () => {
		expect(runTurnDone(deps("ho_7").input)).toEqual({
			exitCode: 0,
			stdout:
				"note: handoff ho_7 is fetched but has no reply — if your work for it is complete, run whisper handoff reply ho_7 --file <path>",
		});
	});

	it("missing AI_WHISPER_AGENT exits 1 and records nothing", () => {
		const d = deps(null, { callerAgent: null });
		expect(runTurnDone(d.input)).toEqual({
			exitCode: 1,
			stdout: "whisper turn done must be run by a mounted agent (AI_WHISPER_AGENT is not set).",
		});
		expect(d.recordSeatTurnDone).not.toHaveBeenCalled();
	});
});

describe("resolveTurnDoneResult", () => {
	it("null agent never connects", () => {
		const connect = vi.fn();
		const r = resolveTurnDoneResult({ callerAgent: null, connect, now: NOW });
		expect(r.exitCode).toBe(1);
		expect(connect).not.toHaveBeenCalled();
	});

	it("version mismatch exits 1 and records nothing", () => {
		const { sqlitePath, cwd } = fileDbFixture("0.16.0");
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => connectAgentCommand({ cwd, context: "turn-done", cliVersion: "0.17.0", sqlitePath }),
			now: NOW,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stdout).toContain("does not match the running broker 0.16.0");
		expect(turnDoneRows(sqlitePath)).toBe(0);
	});

	it("matching version records a seat_turn_done row and closes", () => {
		const { sqlitePath, cwd } = fileDbFixture("0.17.0");
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => connectAgentCommand({ cwd, context: "turn-done", cliVersion: "0.17.0", sqlitePath }),
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 0, stdout: "ok" });
		expect(turnDoneRows(sqlitePath)).toBe(1);
	});

	it("resolver failure prints the message", () => {
		const close = vi.fn();
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => ({ ok: false, collabId: null, db: null, message: "no collab", close }),
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: "no collab" });
		expect(close).toHaveBeenCalledTimes(1);
	});
});
