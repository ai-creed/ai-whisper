import { createCompanionRuntime } from "@ai-whisper/companion-core";
import type { BrokerRuntime } from "@ai-whisper/broker";
import type {
	AgentType,
	CompanionProvider,
	InteractiveSessionController,
} from "@ai-whisper/shared";
import { createBrokerArtifactService } from "./broker-artifact-service.js";
import { createLiveSessionBrokerExecutor } from "./live-session-broker-executor.js";
import type { createRelayPaneWriter } from "./relay-pane-writer.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runCompanionAgentLoop(input: {
	broker: BrokerRuntime;
	collabId: string;
	sessionId: string;
	provider: CompanionProvider;
	interactiveSession: InteractiveSessionController;
	relayPaneWriter: ReturnType<typeof createRelayPaneWriter>;
	pollIntervalMs?: number;
}): Promise<() => Promise<void>> {
	input.provider.attachInteractiveSession?.(input.interactiveSession);
	const fallbackAgent: AgentType = (() => {
		const family = input.provider.getIdentity().toolFamily;
		if (family === "codex") return "codex";
		if (family === "hax") return "ezio";
		if (family === "antigravity") return "agy";
		return "claude";
	})();
	const sessionRole =
		input.broker.control
			.listSessions(input.collabId)
			.find((session) => session.sessionId === input.sessionId)?.agentType ??
		fallbackAgent;

	const artifactService = createBrokerArtifactService();
	const baseExecutor = createLiveSessionBrokerExecutor({
		provider: input.provider,
		artifactService,
		sessionId: input.sessionId,
	});
	const executor = async (request: Parameters<typeof baseExecutor>[0]) => {
		input.relayPaneWriter.status({
			content: `Received broker work for ${sessionRole}.`,
			now: new Date().toISOString(),
		});

		const reply = await baseExecutor(request);

		if (input.broker.control.isWorkItemCancellationRequested(request.workItemId)) {
			input.relayPaneWriter.cancellation({
				agent: sessionRole,
				content: "relay work cancelled by user",
				now: new Date().toISOString(),
			});
			return {
				kind: "failure" as const,
				content: "Relay work cancelled by user",
				transitionIntent: "failed" as const,
			};
		}

		return reply;
	};

	artifactService.sweep();

	const companion = createCompanionRuntime({
		broker: input.broker,
		collabId: input.collabId,
		sessionId: input.sessionId,
		provider: input.provider,
		executor,
	});

	companion.register(new Date().toISOString());
	let stopping = false;
	let loopDoneResolve!: () => void;
	const loopDone = new Promise<void>((resolve) => {
		loopDoneResolve = resolve;
	});

	void (async () => {
		let lastHeartbeatAt = 0;
		while (!stopping) {
			const now = Date.now();
			if (now - lastHeartbeatAt >= 1000) {
				companion.heartbeat(new Date(now).toISOString());
				lastHeartbeatAt = now;
			}
			await companion.processNext(new Date().toISOString());
			await sleep(input.pollIntervalMs ?? 25);
		}
		loopDoneResolve();
	})();

	return Promise.resolve(async () => {
		stopping = true;
		await loopDone;
	});
}
