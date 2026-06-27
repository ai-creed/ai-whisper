import { createBrokerRuntime, openDatabase, type BrokerRuntime } from "@ai-whisper/broker";
import type { AgentType } from "@ai-whisper/shared";
import { resolveCurrentTty as defaultResolveCurrentTty } from "../../runtime/current-tty.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { agentDisplayName } from "../../runtime/agent-display.js";

export interface ReattachableSession {
	agentType: AgentType;
	attachmentKind: "mounted" | "adopted";
	ttyPath: string;
	pid: number | null;
}

export function listReattachableSessions(input: {
	cwd: string;
	collabIdOverride?: string;
}): ReattachableSession[] {
	const db = openDatabase(getSharedSqlitePath());
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		return r.attachments
			.filter(
				(a) =>
					(a.attachmentKind === "mounted" || a.attachmentKind === "adopted") &&
					a.ttyPath !== null,
			)
			.map((a) => ({
				agentType: a.agentType,
				attachmentKind: a.attachmentKind as "mounted" | "adopted",
				ttyPath: a.ttyPath as string,
				pid: a.pid,
			}));
	} finally {
		db.close();
	}
}

export async function runCollabReconnect(input: {
	workspaceRoot: string;
	collabIdOverride?: string;
	target: AgentType;
	now: string;
	resolveCurrentTty?: () => string;
	startMountedSession?: (input: {
		target: AgentType;
		workspaceRoot: string;
		ttyPath: string;
		claimId: string;
		secret: string;
		broker: BrokerRuntime;
	}) => Promise<void>;
}) {
	const db = openDatabase(getSharedSqlitePath());
	let resolved;
	try {
		resolved = resolveCollab({
			db,
			cwd: input.workspaceRoot,
			...(input.collabIdOverride
				? { collabIdOverride: input.collabIdOverride }
				: {}),
			requireActive: true,
			requireDaemon: true,
		});
	} finally {
		db.close();
	}

	if (resolved.recovery.state !== "recovered") {
		throw new Error("Collab has not been recovered. Run `whisper collab recover` first.");
	}

	const daemon = resolved.daemon as { host: string; port: number; pid: number };

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});

	const current = broker.control
		.listSessionBindings(resolved.collabId)
		.find((binding) => binding.agentType === input.target);
	if (!current?.activeSessionId) {
		void broker.stop();
		throw new Error(
			`${agentDisplayName(input.target)} has no remembered binding to reconnect.`,
		);
	}

	const boundSession = broker.control
		.listSessions(resolved.collabId)
		.find((session) => session.sessionId === current.activeSessionId);
	if (boundSession?.healthState === "healthy") {
		void broker.stop();
		throw new Error(
			`${agentDisplayName(input.target)} is already healthy. Reconnect is not needed.`,
		);
	}

	const ttyPath = (input.resolveCurrentTty ?? defaultResolveCurrentTty)();

	const claim = broker.control.issueAttachClaim({
		collabId: resolved.collabId,
		agentType: input.target,
		mode: "reconnect",
		targetMode: "mount_current_tty",
		targetTtyPath: ttyPath,
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

	await (input.startMountedSession ??
		(async (mountedInput) => {
			const runtime = createMountSessionRuntime(mountedInput);
			await runtime.start();
		}))({
		target: input.target,
		workspaceRoot: input.workspaceRoot,
		ttyPath,
		claimId: claim.claimId,
		secret: claim.secret,
		broker,
	});

	return {
		mode: "mounted" as const,
		claim,
		ttyPath,
	};
}
