import {
	applyMigrations,
	createBrokerRuntime,
	deleteBrokerDaemonByCollab,
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
	openDatabase,
	upsertRecoveryState,
	type IsAliveResult,
} from "@ai-whisper/broker";
import { resolveCliVersion } from "../../runtime/cli-package-info.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { DEFAULT_PORT_RANGE } from "../../runtime/port-allocator.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

export interface CollabRecoverResult {
	collabId: string;
	host: string;
	port: number;
	pid: number;
}

export interface CollabRecoverOpts {
	cwd: string;
	collabIdOverride?: string;
	explicitPort?: number;
	portRange?: readonly [number, number];
	now: () => string;
	isPortFreeOs: (port: number) => Promise<boolean>;
	isAlive?: (pid: number) => Promise<IsAliveResult>;
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
	staleThresholdMs?: number;
}

const READY_TIMEOUT_DEFAULT = 30_000;
const STALE_THRESHOLD_DEFAULT = 90_000;

function defaultIsAliveImpl(pid: number): Promise<IsAliveResult> {
	try {
		process.kill(pid, 0);
		return Promise.resolve({ alive: true, startTime: null });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return Promise.resolve({ alive: true, startTime: null });
		return Promise.resolve({ alive: false, startTime: null });
	}
}

export async function runCollabRecover(
	opts: CollabRecoverOpts,
): Promise<CollabRecoverResult> {
	const sqlitePath = getSharedSqlitePath();
	const db = openDatabase(sqlitePath);
	applyMigrations(db);

	const isAlive = opts.isAlive ?? defaultIsAliveImpl;
	const staleThresholdMs = opts.staleThresholdMs ?? STALE_THRESHOLD_DEFAULT;

	const resolved = resolveCollab({
		db,
		cwd: opts.cwd,
		...(opts.collabIdOverride ? { collabIdOverride: opts.collabIdOverride } : {}),
		requireActive: true,
	});
	const collabId = resolved.collabId;
	const host = "127.0.0.1";

	// Pre-check (outside tx, async): if the existing row has a live pid that
	// matches the recorded pid_start_time, there is nothing to recover.
	const preCheckRow = getBrokerDaemonByCollab(db, collabId);
	let preCheckPid: number | null = null;
	let preCheckPidStartTime: string | null = null;
	let preCheckHeartbeat: string | null = null;
	if (preCheckRow && preCheckRow.pid !== null) {
		preCheckPid = preCheckRow.pid;
		preCheckPidStartTime = preCheckRow.pidStartTime;
		preCheckHeartbeat = preCheckRow.lastHeartbeatAt;
		const liveness = await isAlive(preCheckRow.pid);
		const startTimeMatches =
			preCheckRow.pidStartTime === null ||
			liveness.startTime === null ||
			liveness.startTime === preCheckRow.pidStartTime;
		if (liveness.alive && startTimeMatches) {
			db.close();
			throw new Error(
				`daemon already running for collab ${collabId} (pid ${preCheckRow.pid})`,
			);
		}
	}

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

	const now = opts.now();

	// Phase B: registry check + port pick + reservation atomically.
	let allocatedPort = 0;
	const tx = db.transaction(() => {
		const existing = getBrokerDaemonByCollab(db, collabId);

		if (existing) {
			if (existing.pid === null) {
				const heartbeatMs = Date.parse(existing.lastHeartbeatAt);
				const nowMs = Date.parse(now);
				const ageMs = Number.isFinite(heartbeatMs) && Number.isFinite(nowMs)
					? nowMs - heartbeatMs
					: Number.POSITIVE_INFINITY;
				if (ageMs < staleThresholdMs) {
					throw new Error("RECOVERY_ALREADY_IN_PROGRESS");
				}
				// stale orphan: fall through to delete + insert
				deleteBrokerDaemonByCollab(db, collabId);
			} else {
				// pid IS NOT NULL. Verify the row still matches the pre-checked dead
				// row. If something changed since the pre-check, a peer has acted.
				if (
					preCheckPid === null ||
					existing.pid !== preCheckPid ||
					existing.pidStartTime !== preCheckPidStartTime ||
					existing.lastHeartbeatAt !== preCheckHeartbeat
				) {
					throw new Error("DAEMON_NOW_RUNNING");
				}
				deleteBrokerDaemonByCollab(db, collabId);
			}
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
		if (opts.explicitPort !== undefined && picked !== opts.explicitPort) {
			throw new Error(
				`port ${opts.explicitPort} already in use by another daemon`,
			);
		}
		allocatedPort = picked;

		insertBrokerDaemon(db, {
			collabId,
			host,
			port: allocatedPort,
			startedAt: now,
			lastHeartbeatAt: now,
			cliVersion: resolveCliVersion(),
		});
	});

	try {
		tx.immediate();
	} catch (err) {
		const msg = (err as Error).message;
		db.close();
		if (msg === "RECOVERY_ALREADY_IN_PROGRESS") {
			throw new Error(
				`recovery already in progress for collab ${collabId}`,
			);
		}
		if (msg === "DAEMON_NOW_RUNNING") {
			throw new Error(
				`daemon already running for collab ${collabId}`,
			);
		}
		if (msg === "ALL_CANDIDATES_TAKEN") {
			throw new Error(
				`every OS-free port in [${range[0]}, ${range[1]}] is reserved in the registry`,
			);
		}
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

	// Success path: the daemon is up and has written its pid. Re-arm session
	// bindings / mark work items recovery-blocked, then record recovery_state so
	// `whisper collab reconnect` (which gates on recovery.state === "recovered")
	// is unblocked. Use a transient broker control surface against the shared DB;
	// it never calls start() so no port is bound, and stop() closes its own
	// (WAL) handle independently of the raw handle closed above.
	const recoveryBroker = createBrokerRuntime({
		sqlitePath,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	try {
		const prepared = recoveryBroker.control.prepareCollabRecovery({
			collabId,
			now,
		});
		const hasRememberedBindings = prepared.bindings.some(
			(b) => b.activeSessionId !== null,
		);
		upsertRecoveryState(recoveryBroker.db, {
			collabId,
			state: hasRememberedBindings ? "recovered" : "normal",
			idleAfterRecovery: hasRememberedBindings,
			recoveredAt: hasRememberedBindings ? now : null,
		});
	} finally {
		await recoveryBroker.stop();
	}

	return {
		collabId,
		host,
		port: allocatedPort,
		// biome-ignore lint/style/noNonNullAssertion: guarded by cleanupOnFailure
		pid: finalRow!.pid!,
	};
}
