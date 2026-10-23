import { mkdirSync } from "node:fs";
import {
	type AgentType,
	applyMigrations,
	deleteBrokerDaemonByCollab,
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
	openDatabase,
	upsertRecoveryState,
	upsertSessionAttachment,
	upsertWorkspace,
} from "@ai-whisper/broker";
import { resolveCliVersion } from "../../runtime/cli-package-info.js";
import { createCliCollabId } from "../../runtime/id-factory.js";
import type { LaunchMode, LaunchResult } from "../../runtime/launcher.js";
import { DEFAULT_PORT_RANGE } from "../../runtime/port-allocator.js";
import {
	getSharedSqlitePath,
	getStateRoot,
} from "../../runtime/state-root.js";
import {
	canonicalWorkspaceRoot,
	workspaceIdFromPath,
} from "../../runtime/workspace-id.js";

export interface CollabStartResult {
	collabId: string;
	port: number;
	host: string;
	pid: number;
}

export interface CollabStartOpts {
	cwd: string;
	displayName: string;
	launchMode: LaunchMode;
	tmuxSession?: string;
	explicitPort?: number;
	portRange?: readonly [number, number];
	now: () => string;
	isPortFreeOs: (port: number) => Promise<boolean>;
	spawnBroker: (input: {
		collabId: string;
		host: string;
		port: number;
		sqlitePath: string;
	}) => number;
	waitForReady: (input: {
		host: string;
		port: number;
		collabId: string;
		timeoutMs: number;
	}) => Promise<boolean>;
	signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	readyTimeoutMs?: number;
}

const READY_TIMEOUT_DEFAULT = 30_000;

export async function runCollabStart(
	opts: CollabStartOpts,
): Promise<CollabStartResult> {
	const root = getStateRoot();
	mkdirSync(root, { recursive: true });
	const sqlitePath = getSharedSqlitePath();
	const db = openDatabase(sqlitePath);
	applyMigrations(db);

	const workspaceRoot = canonicalWorkspaceRoot(opts.cwd);
	const workspaceId = workspaceIdFromPath(opts.cwd);
	const now = opts.now();
	const collabId = createCliCollabId(now);
	const host = "127.0.0.1";

	const orchestratorEnabled =
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED !== "0";
	const orchestratorMaxRounds = Math.max(
		1,
		Number(process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS ?? "3") || 3,
	);

	// Phase A: OS-probe candidate ports outside the tx (async).
	const range = opts.portRange ?? DEFAULT_PORT_RANGE;
	const osFreeCandidates: number[] = [];
	if (opts.explicitPort !== undefined) {
		if (!(await opts.isPortFreeOs(opts.explicitPort))) {
			db.close();
			throw new Error(
				`port ${opts.explicitPort} is in use by another process`,
			);
		}
		osFreeCandidates.push(opts.explicitPort);
	} else {
		for (let p = range[0]; p <= range[1]; p++) {
			if (await opts.isPortFreeOs(p)) osFreeCandidates.push(p);
		}
		if (osFreeCandidates.length === 0) {
			db.close();
			throw new Error(
				`No OS-free port in range [${range[0]}, ${range[1]}]`,
			);
		}
	}

	// Phase B: registry check + port pick + insert atomically.
	let allocatedPort = 0;
	const tx = db.transaction(() => {
		upsertWorkspace(db, { id: workspaceId, workspaceRoot, now });

		const active = db
			.prepare(
				"SELECT collab_id FROM collab WHERE workspace_id = ? AND status = 'active' LIMIT 1",
			)
			.get(workspaceId) as { collab_id: string } | undefined;
		if (active) {
			throw new Error(
				`active collab ${active.collab_id} already exists for workspace ${workspaceRoot}`,
			);
		}

		const takenPorts = new Set(
			(
				db
					.prepare("SELECT port FROM broker_daemon")
					.all() as Array<{ port: number }>
			).map((r) => r.port),
		);
		const picked = osFreeCandidates.find((p) => !takenPorts.has(p));
		if (picked === undefined) throw new Error("ALL_CANDIDATES_TAKEN");
		if (
			opts.explicitPort !== undefined &&
			picked !== opts.explicitPort
		) {
			throw new Error(
				`port ${opts.explicitPort} already in use by another daemon`,
			);
		}
		allocatedPort = picked;

		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)",
		).run(
			collabId,
			workspaceRoot,
			opts.displayName,
			workspaceId,
			opts.launchMode,
			opts.tmuxSession ?? null,
			now,
			now,
			orchestratorEnabled ? 1 : 0,
			orchestratorMaxRounds,
		);
		insertBrokerDaemon(db, {
			collabId,
			host,
			port: allocatedPort,
			startedAt: now,
			lastHeartbeatAt: now,
			cliVersion: resolveCliVersion(),
		});
		upsertRecoveryState(db, {
			collabId,
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	});

	try {
		tx.immediate();
	} catch (err) {
		if ((err as Error).message === "ALL_CANDIDATES_TAKEN") {
			db.close();
			throw new Error(
				`every OS-free port in [${range[0]}, ${range[1]}] is reserved in the registry`,
			);
		}
		db.close();
		throw err;
	}

	const childPid = opts.spawnBroker({
		collabId,
		host,
		port: allocatedPort,
		sqlitePath,
	});

	const cleanupOnFailure = (msg: string): never => {
		const cleanup = db.transaction(() => {
			deleteBrokerDaemonByCollab(db, collabId);
			db.prepare(
				"UPDATE collab SET status='stopped', stopped_at=?, updated_at=? WHERE collab_id = ?",
			).run(opts.now(), opts.now(), collabId);
		});
		cleanup.immediate();
		try {
			opts.signalProcess(childPid, "SIGTERM");
		} catch {
			// ignore
		}
		db.close();
		throw new Error(msg);
	};

	const ready = await opts.waitForReady({
		host,
		port: allocatedPort,
		collabId,
		timeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_DEFAULT,
	});
	if (!ready) {
		cleanupOnFailure(
			`broker readiness check timed out for collab ${collabId}`,
		);
	}

	const finalRow = getBrokerDaemonByCollab(db, collabId);
	if (!finalRow || finalRow.pid === null) {
		cleanupOnFailure(
			`daemon did not write its PID for collab ${collabId}`,
		);
	}

	db.close();
	return {
		collabId,
		port: allocatedPort,
		host,
		// biome-ignore lint/style/noNonNullAssertion: guarded by cleanupOnFailure
		pid: finalRow!.pid!,
	};
}

/**
 * Persists the runtime metadata produced by `launchSessions` so that
 * `whisper collab stop` can tear down what `start` launched. Symmetric
 * with `recordMountedSession` in mount.ts.
 *
 * - tmux mode: records the deterministic tmux session name on the collab
 *   row so stop issues `tmux kill-session`.
 * - terminals mode: records each launched codex/claude window (kind
 *   "owned") so stop closes the window and signals the pid. The
 *   relay-monitor's terminal window/pid cannot live in
 *   `session_attachment` (its PK is `(collab_id, agent_type,
 *   attachment_kind)` and `agent_type` is constrained to
 *   `codex|claude`), so they are persisted on the `collab` row
 *   instead (parallel to `tmux_session`) for stop to tear down.
 */
export function recordLaunchedSessions(input: {
	collabId: string;
	launchMode: "tmux" | "terminals";
	launch: LaunchResult;
}): void {
	const db = openDatabase(getSharedSqlitePath());
	try {
		if (input.launch.tmuxSession) {
			const now = new Date().toISOString();
			db.prepare(
				"UPDATE collab SET tmux_session = ?, updated_at = ? WHERE collab_id = ?",
			).run(input.launch.tmuxSession, now, input.collabId);
		}

		if (input.launchMode === "terminals") {
			const runtime = input.launch.runtime;
			const agents: Array<{
				agentType: AgentType;
				windowLabel: string | undefined;
				pid: number | undefined;
			}> = [
				{
					agentType: "codex",
					windowLabel: runtime.codexWindowLabel,
					pid: runtime.codexPid,
				},
				{
					agentType: "claude",
					windowLabel: runtime.claudeWindowLabel,
					pid: runtime.claudePid,
				},
			];
			const now = new Date().toISOString();
			for (const agent of agents) {
				if (
					agent.windowLabel === undefined &&
					agent.pid === undefined
				) {
					continue;
				}
				upsertSessionAttachment(db, {
					collabId: input.collabId,
					agentType: agent.agentType,
					attachmentKind: "owned",
					sessionId: null,
					providerId: agent.agentType,
					launchMode: input.launchMode,
					ttyPath: null,
					pid: agent.pid ?? null,
					windowLabel: agent.windowLabel ?? null,
					attachedAt: now,
				});
			}

			const relayMonitorWindowLabel =
				runtime.relayMonitorWindowLabel;
			const relayMonitorPid = runtime.relayMonitorPid;
			if (
				relayMonitorWindowLabel !== undefined ||
				relayMonitorPid !== undefined
			) {
				db.prepare(
					"UPDATE collab SET relay_monitor_window_label = ?, relay_monitor_pid = ?, updated_at = ? WHERE collab_id = ?",
				).run(
					relayMonitorWindowLabel ?? null,
					relayMonitorPid ?? null,
					now,
					input.collabId,
				);
			}
		}
	} finally {
		db.close();
	}
}
