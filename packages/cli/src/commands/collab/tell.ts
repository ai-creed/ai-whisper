import { type AgentType, createBrokerRuntime } from "@ai-whisper/broker";
import { agentTypes, type CompanionProvider, type WorkItem } from "@ai-whisper/shared";
import { normalizeArtifactPaths } from "../../runtime/artifact-input.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { processOneTurn } from "../../runtime/on-demand-processing.js";
import { enqueueRelayWork } from "../../runtime/relay-service.js";
import { waitForReply } from "../../runtime/reply-wait.js";

export async function runCollabTell(input: {
	cwd: string;
	target: AgentType;
	instruction: string;
	explicitAction?: WorkItem["requestedAction"];
	artifactPaths: string[];
	threadTitle?: string;
	providerOverride?: CompanionProvider;
	now: string;
	collabIdOverride?: string;
}) {
	if (!(agentTypes as readonly string[]).includes(input.target)) {
		throw new Error(
			`Invalid target "${String(input.target)}". Must be one of: ${agentTypes.join(", ")}.`,
		);
	}

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});

	try {
		const resolved = resolveCollab({
			db: broker.db,
			cwd: input.cwd,
			...(input.collabIdOverride ? { collabIdOverride: input.collabIdOverride } : {}),
			requireDaemon: true,
		});

		const artifactPaths = normalizeArtifactPaths(
			input.cwd,
			input.artifactPaths,
		);

		// The sender is the OTHER bound agent (replacement model: the pair may be
		// ezio+claude, not codex+claude). Fall back to the literal codex<->claude
		// flip when bindings don't yield a distinct partner (preserves prior behavior).
		const boundAgents = broker.control
			.listSessionBindings(resolved.collabId)
			.filter((b) => b.bindingState === "bound")
			.map((b) => b.agentType)
			.filter((t): t is AgentType => (agentTypes as readonly string[]).includes(t));
		const senderRole: AgentType =
			boundAgents.find((a) => a !== input.target) ??
			(input.target === "codex" ? "claude" : "codex");
		const senderSessionId = broker.control.resolveBoundSession(
			resolved.collabId,
			senderRole,
		);

		const relay = enqueueRelayWork({
			broker,
			collabId: resolved.collabId,
			originSessionId: senderSessionId,
			target: input.target,
			instruction: input.instruction,
			artifactPaths,
			forceNewThread: false,
			now: input.now,
			explicitAction: input.explicitAction,
			threadTitle: input.threadTitle,
		});

		const reply = input.providerOverride
			? await processOneTurn({
					broker,
					collabId: resolved.collabId,
					sessionId: relay.targetSessionId,
					provider: input.providerOverride,
					now: input.now,
				})
			: await waitForReply({
					broker,
					threadId: relay.thread.threadId,
					workItemId: relay.workItem.workItemId,
				});

		return reply;
	} finally {
		await broker.stop();
	}
}
