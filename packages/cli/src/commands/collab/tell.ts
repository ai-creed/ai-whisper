import { createBrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider, WorkItem } from "@ai-whisper/shared";
import { normalizeArtifactPaths } from "../../runtime/artifact-input.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { processOneTurn } from "../../runtime/on-demand-processing.js";
import { enqueueRelayWork } from "../../runtime/relay-service.js";
import { waitForReply } from "../../runtime/reply-wait.js";

export async function runCollabTell(input: {
	cwd: string;
	target: "codex" | "claude" | "ai-ezio";
	instruction: string;
	explicitAction?: WorkItem["requestedAction"];
	artifactPaths: string[];
	threadTitle?: string;
	providerOverride?: CompanionProvider;
	now: string;
	collabIdOverride?: string;
}) {
	if (input.target !== "codex" && input.target !== "claude") {
		throw new Error(
			`Invalid target "${String(input.target)}". Must be "codex" or "claude".`,
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

		const senderRole = input.target === "codex" ? "claude" : "codex";
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
