import type { BrokerRuntime } from "@ai-whisper/broker";

export type InspectSnapshotState = {
	collabId: string;
	recovery: { state: "normal" | "recovery_required" | "recovered" };
};

export function truncatePreview(input: string, limit = 120): string {
	if (input.length <= limit) return input;
	return `${input.slice(0, Math.max(0, limit - 3))}...`;
}

export function buildInspectSnapshot(input: {
	broker: BrokerRuntime;
	state: InspectSnapshotState;
	now: string;
}) {
	const threads = input.broker.control.listThreads(input.state.collabId);
	const activeThread = threads.find((thread) => thread.active) ?? null;
	const bindings = input.broker.control.listSessionBindings(input.state.collabId);
	const sessions = input.broker.control.listSessions(input.state.collabId);
	const turn = input.broker.control.getRelayTurnState(input.state.collabId);
	const lastHandedBack = input.broker.control.getLatestHandedBackHandoff(
		input.state.collabId,
	);
	const lastCaptureStatus = lastHandedBack?.captureStatus ?? null;

	const roles = (["codex", "claude"] as const).map((agentType) => {
		const binding = bindings.find((candidate) => candidate.agentType === agentType);
		const session = binding?.activeSessionId
			? sessions.find((candidate) => candidate.sessionId === binding.activeSessionId)
			: null;
		return {
			agentType,
			bindingState: binding?.bindingState ?? "unbound",
			healthState: session?.healthState ?? null,
			bindingSource: binding?.bindingSource ?? null,
			targetTtyPath: binding?.targetTtyPath ?? null,
		};
	});

	if (!activeThread) {
		return {
			collabId: input.state.collabId,
			recoveryState: input.state.recovery.state,
			brokerHealth: "ok" as const,
			roles,
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			refreshedAt: input.now,
			turnOwner: turn.turnOwner,
			waitingAgent: turn.waitingAgent,
			handoffState: turn.handoffState,
			handoffAgeMs: turn.handoffAgeMs,
			lastCaptureStatus,
			orchestratorEnabled: turn.orchestratorEnabled,
			currentRound: turn.currentRound,
			maxRounds: turn.maxRounds,
			chainStatus: turn.chainStatus,
		};
	}

	const allWorkItemsRaw = input.broker.control.listWorkItems(activeThread.threadId);

	const workItems = allWorkItemsRaw
		.slice(-5)
		.reverse()
		.map((item) => {
			const sender = sessions.find((session) => session.sessionId === item.senderSessionId);
			const target = sessions.find((session) => session.sessionId === item.targetSessionId);
			return {
				workItemId: item.workItemId,
				turnIndex: item.turnIndex,
				senderRole: sender?.agentType ?? "unknown",
				targetRole: target?.agentType ?? "unknown",
				requestedAction: item.requestedAction,
				deliveryState: item.deliveryState,
				instructionPreview: truncatePreview(item.instruction, 100),
			};
		});

	const replies = input.broker.control
		.listReplies(activeThread.threadId)
		.slice(-5)
		.reverse()
		.map((reply) => {
			const source = sessions.find((session) => session.sessionId === reply.sourceSessionId);
			return {
				replyId: reply.replyId,
				sourceRole: source?.agentType ?? "unknown",
				kind: reply.kind,
				transitionIntent: reply.transitionIntent,
				contentPreview: truncatePreview(reply.content, 100),
			};
		});

	const flaggedItems = allWorkItemsRaw
		.filter((item) => item.deliveryState === "failed" || item.deliveryState === "recovery_blocked")
		.slice(-5)
		.reverse()
		.map((item) => ({
			workItemId: item.workItemId,
			deliveryState: item.deliveryState,
			instructionPreview: truncatePreview(item.instruction, 100),
		}));

	return {
		collabId: input.state.collabId,
		recoveryState: input.state.recovery.state,
		brokerHealth: "ok" as const,
		roles,
		activeThread: {
			threadId: activeThread.threadId,
			title: activeThread.title,
			threadState: activeThread.threadState,
			currentTurnIndex: activeThread.currentTurnIndex,
		},
		workItems,
		replies,
		flaggedItems,
		refreshedAt: input.now,
		turnOwner: turn.turnOwner,
		waitingAgent: turn.waitingAgent,
		handoffState: turn.handoffState,
		handoffAgeMs: turn.handoffAgeMs,
		lastCaptureStatus,
		orchestratorEnabled: turn.orchestratorEnabled,
		currentRound: turn.currentRound,
		maxRounds: turn.maxRounds,
		chainStatus: turn.chainStatus,
	};
}

export function formatInspectSnapshot(input: {
	collabId: string;
	recoveryState: "normal" | "recovery_required" | "recovered";
	brokerHealth: "ok" | "degraded";
	roles: Array<{
		agentType: string;
		bindingState: string;
		healthState: string | null;
		bindingSource?: string | null;
		targetTtyPath?: string | null;
	}>;
	activeThread: {
		threadId: string;
		title: string;
		threadState: string;
		currentTurnIndex: number;
	} | null;
	workItems: Array<{
		workItemId: string;
		turnIndex: number;
		senderRole: string;
		targetRole: string;
		requestedAction: string;
		deliveryState: string;
		instructionPreview: string;
	}>;
	replies: Array<{
		replyId: string;
		sourceRole: string;
		kind: string;
		transitionIntent: string | null;
		contentPreview: string;
	}>;
	flaggedItems: Array<{ workItemId: string; deliveryState: string; instructionPreview: string }>;
	watch: boolean;
	refreshedAt: string;
	turnOwner: "codex" | "claude" | "ai-ezio" | "none";
	waitingAgent: "codex" | "claude" | "ai-ezio" | null;
	handoffState: "idle" | "pending" | "deferred" | "accepted" | "stale_handoff" | "failed";
	handoffAgeMs?: number | null;
	lastCaptureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
	orchestratorEnabled?: boolean;
	currentRound?: number;
	maxRounds?: number;
	chainStatus?: "active" | "done" | "escalated" | "abandoned";
}) {
	const lines = [
		...(input.watch ? [`Live Inspect (${input.refreshedAt})`] : []),
		`Collab: ${input.collabId}`,
		`Recovery: ${input.recoveryState}`,
		`Broker: ${input.brokerHealth}`,
		"Roles:",
		...input.roles.map(
			(role) =>
				`  - ${role.agentType}: ${role.bindingState}${role.healthState ? ` (${role.healthState})` : ""}${role.bindingSource ? ` [${role.bindingSource}]` : ""}${role.targetTtyPath ? ` tty=${role.targetTtyPath}` : ""}`,
		),
		`Turn owner: ${input.turnOwner ?? "none"}`,
		`Waiting: ${input.waitingAgent ?? "none"}`,
		`Handoff state: ${input.handoffState ?? "idle"}`,
		...(input.handoffAgeMs != null ? [`Handoff age: ${Math.floor(input.handoffAgeMs / 1000)}s`] : []),
		...(input.lastCaptureStatus != null ? [`Last capture: ${input.lastCaptureStatus}`] : []),
		`Orchestrator: ${input.orchestratorEnabled ? "yes" : "no"}`,
		...(input.orchestratorEnabled ? [`Chain status: ${input.chainStatus ?? "done"}`] : []),
		...(input.orchestratorEnabled ? [`Round: ${input.currentRound ?? 0}/${input.maxRounds ?? 3}`] : []),
	];

	if (!input.activeThread) {
		lines.push("Active Thread: none");
		return `${lines.join("\n")}\n`;
	}

	lines.push(
		`Active Thread: ${input.activeThread.title}`,
		`  id=${input.activeThread.threadId} state=${input.activeThread.threadState} turn=${input.activeThread.currentTurnIndex}`,
		"Recent Work Items:",
		...(input.workItems.length
			? input.workItems.map(
					(item) =>
						`  - #${item.turnIndex} ${item.senderRole}->${item.targetRole} ${item.requestedAction} [${item.deliveryState}] ${item.instructionPreview}`,
				)
			: ["  - none"]),
		"Recent Replies:",
		...(input.replies.length
			? input.replies.map(
					(reply) =>
						`  - ${reply.sourceRole} ${reply.kind}${reply.transitionIntent ? ` (${reply.transitionIntent})` : ""}: ${reply.contentPreview}`,
				)
			: ["  - none"]),
		"Recent Failures / Blocked:",
		...(input.flaggedItems.length
			? input.flaggedItems.map(
					(item) => `  - ${item.workItemId} [${item.deliveryState}] ${item.instructionPreview}`,
				)
			: ["  - none"]),
	);

	return `${lines.join("\n")}\n`;
}
