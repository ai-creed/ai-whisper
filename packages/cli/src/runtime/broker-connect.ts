import {
	createBrokerEventBus,
	createBrokerRuntime,
	createControlService,
	openDatabase,
} from "@ai-whisper/broker";
import type { BrokerRuntime, ControlService } from "@ai-whisper/broker";
import type Database from "better-sqlite3";
import {
	checkCliBrokerVersion,
	type VersionCheckContext,
} from "./cli-broker-version-check.js";
import { CollabResolverError, resolveCollab } from "./collab-resolver.js";
import { getSharedSqlitePath } from "./state-root.js";

// eslint-disable-next-line @typescript-eslint/require-await
export async function connectToWorkspaceBroker(
	input: { cwd: string; collabIdOverride?: string },
): Promise<{ broker: BrokerRuntime; collabId: string; daemonCliVersion: string | null }> {
	const db = openDatabase(getSharedSqlitePath());
	let resolved;
	try {
		resolved = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
			requireActive: true,
			requireDaemon: true,
		});
	} finally {
		db.close();
	}

	if (resolved.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (resolved.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude|ezio|agy>`.",
		);
	}

	// daemon is non-null because requireDaemon: true
	const daemon = resolved.daemon as {
		host: string;
		port: number;
		pid: number;
		cliVersion: string | null;
	};

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
		// Transient CLI broker: the daemon owns workflow driving and diagnostics
		// retention. Skipping the local timers avoids racing setImmediate-scheduled
		// kickoffs against broker.stop() on command exit.
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});

	return { broker, collabId: resolved.collabId, daemonCliVersion: daemon.cliVersion };
}

export type AgentCommandConnection =
	| {
			ok: false;
			/** No collab/daemon for the workspace; `message` is the resolver's reason. */
			reason: "unresolved";
			collabId: null;
			db: null;
			message: string;
			close(): void;
	  }
	| {
			ok: false;
			/** `message` is the spec's mismatch copy, printed as-is. */
			reason: "version_mismatch";
			collabId: string;
			db: Database.Database;
			message: string;
			close(): void;
	  }
	| { ok: true; collabId: string; control: ControlService; close(): void };

// Agent-facing commands (handoff show/reply, turn done) must never migrate the
// shared DB: a CLI that is out of sync with the running broker must not rewrite
// its schema. So this opens the DB raw and builds a control service directly,
// never going through createBrokerRuntime (which applies migrations).
export function connectAgentCommand(input: {
	cwd: string;
	context: VersionCheckContext;
	cliVersion: string;
	sqlitePath?: string;
	env?: NodeJS.ProcessEnv;
}): AgentCommandConnection {
	const stampedCollab = (input.env ?? process.env).AI_WHISPER_COLLAB;
	const db = openDatabase(input.sqlitePath ?? getSharedSqlitePath());
	const close = (): void => {
		if (db.open) db.close();
	};
	let resolved;
	try {
		resolved = resolveCollab({
			db,
			cwd: input.cwd,
			...(stampedCollab ? { collabIdOverride: stampedCollab } : {}),
			requireActive: true,
			requireDaemon: true,
		});
	} catch (err) {
		if (err instanceof CollabResolverError) {
			close();
			return {
				ok: false,
				reason: "unresolved",
				collabId: null,
				db: null,
				message: err.message,
				close() {},
			};
		}
		close();
		throw err;
	}
	const check = checkCliBrokerVersion({
		cliVersion: input.cliVersion,
		brokerVersion: resolved.daemon?.cliVersion ?? null,
		context: input.context,
	});
	if (!check.ok) {
		return {
			ok: false,
			reason: "version_mismatch",
			collabId: resolved.collabId,
			db,
			message: check.message,
			close,
		};
	}
	let control: ControlService;
	try {
		control = createControlService(db, createBrokerEventBus());
	} catch (err) {
		close();
		throw err;
	}
	return { ok: true, collabId: resolved.collabId, control, close };
}
