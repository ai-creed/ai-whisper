import type { BrokerRuntime } from "@ai-whisper/broker";
import type { WorkItem } from "@ai-whisper/shared";
import { inferRequestedAction } from "./action-inference.js";
import { requiresExplicitArtifacts } from "./context-policy.js";
import { createCliThreadId, createCliWorkItemId } from "./id-factory.js";
import type { createContextInjector } from "./context-injector.js";

export function enqueueRelayWork(input: {
	broker: BrokerRuntime;
	collabId: string;
	originSessionId: string;
	target: "codex" | "claude" | "ezio";
	instruction: string;
	artifactPaths: string[];
	forceNewThread: boolean;
	now: string;
	explicitAction?: WorkItem["requestedAction"] | undefined;
	threadTitle?: string | undefined;
	contextInjector?: ReturnType<typeof createContextInjector> | undefined;
}) {
	const targetSessionId = input.broker.control.resolveBoundSession(
		input.collabId,
		input.target,
	);

	const activeThread = input.broker.control
		.listThreads(input.collabId)
		.find((thread) => thread.active);

	const action = input.explicitAction ?? inferRequestedAction(input.instruction);
	const mustCreateThread = input.forceNewThread || !activeThread;

	if (
		mustCreateThread &&
		requiresExplicitArtifacts(action) &&
		input.artifactPaths.length === 0
	) {
		throw new Error(
			`Action ${action} requires explicit artifacts on a new thread. Use whisper collab tell --artifact ... first.`,
		);
	}

	const thread = activeThread && !input.forceNewThread
		? activeThread
		: input.broker.control.createThread({
				threadId: createCliThreadId(input.now),
				collabId: input.collabId,
				title: input.threadTitle ?? input.instruction,
				createdBySessionId: input.originSessionId,
				now: input.now,
			});

	const basePacket = {
		kind: "full" as const,
		goal: input.instruction,
		currentState: mustCreateThread
			? "New thread"
			: "Continuing active thread",
		decisionsMade: [],
		assumptions: [],
		relevantArtifacts: input.artifactPaths,
		openQuestions: [],
		successCriteria: [],
	};

	const contextPacket = input.contextInjector
		? input.contextInjector.enrichContextPacket({
				activeThreadId: thread.threadId,
				basePacket,
			})
		: basePacket;

	const workItem = input.broker.control.enqueueWorkItem({
		workItemId: createCliWorkItemId(input.now),
		threadId: thread.threadId,
		collabId: input.collabId,
		senderSessionId: input.originSessionId,
		targetSessionId: targetSessionId,
		requestedAction: action,
		instruction: input.instruction,
		contextPacket,
		artifactManifestIds: [],
		now: input.now,
	});

	return {
		action,
		thread,
		workItem,
		targetSessionId: targetSessionId,
		createdNewThread: mustCreateThread,
	};
}

export function formatRelayAcknowledgement(input: {
	target: "codex" | "claude" | "ezio";
	createdNewThread: boolean;
}) {
	return input.createdNewThread
		? `[ai-whisper] Started new thread and relayed to ${input.target}.`
		: `[ai-whisper] Relayed to ${input.target} on active thread.`;
}

export function formatRelayReplySummary(input: {
	target: "codex" | "claude" | "ezio";
	replyKind: string;
	content: string;
}) {
	return `[ai-whisper][${input.target}] ${input.replyKind}: ${input.content}`;
}
