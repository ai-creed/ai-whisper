import { createBrokerRuntime, openDatabase } from "@ai-whisper/broker";
import { createSessionId } from "@ai-whisper/shared";
import { createCliSessionId } from "../../packages/cli/src/runtime/id-factory.ts";
import { resolveCollab } from "../../packages/cli/src/runtime/collab-resolver.ts";
import { getSharedSqlitePath } from "../../packages/cli/src/runtime/state-root.ts";

/**
 * Test helper: simulates the binding state that exists after mount panes
 * complete their attach claim. Use in tests that combine runCollabStart with
 * runCollabTell/runCollabStatus — without this, the broker has no bound
 * sessions because start no longer pre-registers them.
 */
export async function registerLaunchedBindings(input: {
	workspaceRoot: string;
	now: string;
	/** Agents to bind; defaults to the codex/claude pair. */
	agents?: readonly ("codex" | "claude" | "ezio")[];
}) {
	const db = openDatabase(getSharedSqlitePath());
	let resolved;
	try {
		resolved = resolveCollab({
			db,
			cwd: input.workspaceRoot,
			requireActive: true,
			requireDaemon: true,
		});
	} finally {
		db.close();
	}
	const daemon = resolved.daemon as { host: string; port: number; pid: number };

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
	});

	try {
		for (const agentType of input.agents ?? (["codex", "claude"] as const)) {
			const sessionId = createSessionId(createCliSessionId(agentType, input.now));
			broker.control.registerSession({
				sessionId,
				collabId: resolved.collabId,
				agentType,
				capabilities: { supportsDirectPackets: true },
				now: input.now,
			});
			broker.control.setSessionBinding({
				collabId: resolved.collabId,
				agentType,
				sessionId,
				bindingSource: "mounted",
				now: input.now,
			});
		}
	} finally {
		await broker.stop();
	}
}
