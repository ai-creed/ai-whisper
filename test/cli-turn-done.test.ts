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
const UNREACHABLE = (detail: string) =>
	`ai-whisper could not reach the broker for this workspace (${detail}). Stop here and end your turn; do not read ~/.ai-whisper/state.db directly.`;

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
	db.prepare(
		"INSERT INTO session_binding (collab_id, agent_type, binding_state, updated_at) VALUES ('c1', 'claude', 'bound', '2026-05-15T00:00:00Z')",
	).run();
	db.close();
	return { sqlitePath, cwd };
}

function turnDoneAt(sqlitePath: string): string | null {
	const db = openDatabase(sqlitePath);
	const row = db
		.prepare("SELECT turn_done_at FROM session_binding WHERE collab_id = 'c1' AND agent_type = 'claude'")
		.get() as { turn_done_at: string | null };
	db.close();
	return row.turn_done_at;
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
		expect(turnDoneAt(sqlitePath)).toBeNull();
	});

	it("matching version records session_binding.turn_done_at", () => {
		const { sqlitePath, cwd } = fileDbFixture("0.17.0");
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => connectAgentCommand({ cwd, context: "turn-done", cliVersion: "0.17.0", sqlitePath }),
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 0, stdout: "ok" });
		expect(turnDoneAt(sqlitePath)).toBe(NOW);
	});

	it("resolver failure prints guidance and closes", () => {
		const close = vi.fn();
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => ({
				ok: false,
				reason: "unresolved",
				collabId: null,
				db: null,
				message: "no active collab found for cwd /x",
				close,
			}),
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("no active collab found for cwd /x") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw inside the body prints guidance, exits 1 and closes", () => {
		const close = vi.fn();
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => ({
				ok: true,
				collabId: "c1",
				control: {
					recordSeatTurnDone: () => {
						throw new Error("SQLITE_BUSY: database is locked");
					},
				} as never,
				close,
			}),
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("SQLITE_BUSY: database is locked") });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a throw from connect prints guidance", () => {
		const r = resolveTurnDoneResult({
			callerAgent: "claude",
			connect: () => {
				throw new Error("unable to open database file");
			},
			now: NOW,
		});
		expect(r).toEqual({ exitCode: 1, stdout: UNREACHABLE("unable to open database file") });
	});
});
