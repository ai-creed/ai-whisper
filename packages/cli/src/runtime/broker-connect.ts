import { createBrokerRuntime, openDatabase } from "@ai-whisper/broker";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { resolveCollab } from "./collab-resolver.js";
import { getSharedSqlitePath } from "./state-root.js";

// eslint-disable-next-line @typescript-eslint/require-await
export async function connectToWorkspaceBroker(
	input: { cwd: string; collabIdOverride?: string },
): Promise<{ broker: BrokerRuntime; collabId: string }> {
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
	const daemon = resolved.daemon as { host: string; port: number; pid: number };

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

	return { broker, collabId: resolved.collabId };
}

