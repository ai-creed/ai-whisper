import type { AgentCommandConnection } from "../runtime/broker-connect.js";
import type { VersionCheckContext } from "../runtime/cli-broker-version-check.js";

export interface AgentCommandResult {
	exitCode: 0 | 1;
	stdout: string;
}

type ReadyConnection = Extract<AgentCommandConnection, { ok: true }>;
type MismatchConnection = Extract<AgentCommandConnection, { reason: "version_mismatch" }>;

// The agent reads stdout and acts on it, so every failure names the next step
// and steers it away from reading state.db itself.
export function agentCommandFailureCopy(context: VersionCheckContext, detail: string): string {
	const oneLine = detail.replace(/\s+/g, " ").trim();
	if (context === "reply") {
		return `ai-whisper could not record your reply (${oneLine}). Your reply was not recorded. End your turn with your complete handback as your final message; ai-whisper will capture it. Do not read ~/.ai-whisper/state.db directly.`;
	}
	return `ai-whisper could not reach the broker for this workspace (${oneLine}). Stop here and end your turn; do not read ~/.ai-whisper/state.db directly.`;
}

/**
 * Shared flow for agent-facing commands (handoff show/reply, turn done):
 * caller policy before connecting, then connect, run, and always close. A
 * resolver failure or any thrown error becomes exit 1 plus guidance copy, never
 * a stack trace.
 */
export function runAgentCommand(input: {
	context: VersionCheckContext;
	/** Non-null refuses before connecting, so the DB is never opened. */
	refuseBeforeConnect: AgentCommandResult | null;
	connect: () => AgentCommandConnection;
	/** Defaults to printing the version-mismatch copy. */
	onVersionMismatch?: (conn: MismatchConnection) => AgentCommandResult;
	run: (conn: ReadyConnection) => AgentCommandResult;
}): AgentCommandResult {
	if (input.refuseBeforeConnect !== null) return input.refuseBeforeConnect;
	let conn: AgentCommandConnection | null = null;
	try {
		conn = input.connect();
		if (conn.ok) return input.run(conn);
		if (conn.reason === "version_mismatch") {
			return input.onVersionMismatch
				? input.onVersionMismatch(conn)
				: { exitCode: 1, stdout: conn.message };
		}
		return { exitCode: 1, stdout: agentCommandFailureCopy(input.context, conn.message) };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: agentCommandFailureCopy(input.context, detail) };
	} finally {
		try {
			conn?.close();
		} catch {
			// Closing is best effort; the command's result already stands.
		}
	}
}
