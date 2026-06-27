#!/usr/bin/env node
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createLiveSessionRuntime } from "../runtime/live-session.js";
import { runCompanionAgentLoop } from "../runtime/companion-agent-loop.js";
import { agentTypes } from "@ai-whisper/shared";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
	type MountTarget,
} from "../runtime/providers.js";
import {
	enqueueRelayWork,
	formatRelayAcknowledgement,
} from "../runtime/relay-service.js";
import { createContextInjector } from "../runtime/context-injector.js";
import { waitForReply } from "../runtime/reply-wait.js";
import { createRelayPaneWriter } from "../runtime/relay-pane-writer.js";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

async function main(): Promise<void> {
	const agentArg = process.argv[2];
	if (agentArg === undefined || !(agentTypes as readonly string[]).includes(agentArg)) {
		throw new Error(
			"companion-agent requires a target argument: codex, claude, ezio, or agy",
		);
	}
	const target: MountTarget = agentArg as MountTarget;

	const sqlitePath = requireEnv("AI_WHISPER_BROKER_SQLITE");
	const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
	const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");
	const collabId = requireEnv("AI_WHISPER_COLLAB_ID");
	const sessionId = requireEnv("AI_WHISPER_SESSION_ID");

	const broker = createBrokerRuntime({
		sqlitePath,
		host,
		port,
		// Companion-agent bin is a long-running client of the broker daemon.
		// The daemon owns workflow driving and diagnostics retention.
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	const provider = createProviderForTarget(target);
	const interactiveSession = createInteractiveSessionForTarget({
		target: target,
		cwd: process.cwd(),
		stdout: process.stdout,
	});
	const relayPaneWriter = createRelayPaneWriter({ broker, collabId });
	let activeRelayWorkItemId: string | null = null;
	const liveSession = createLiveSessionRuntime({
		interactiveSession,
		stdin: process.stdin,
		stdout: process.stdout,
		relayPaneWriter,
		onRelayCancel: () => {
			if (!activeRelayWorkItemId) {
				return;
			}

			broker.control.requestWorkItemCancellation({
				workItemId: activeRelayWorkItemId,
				requestedAt: new Date().toISOString(),
			});
		},
		onRelay: async (directive, sendNow) => {
			if (directive.target === "pull") {
				const injector = createContextInjector({ broker, collabId, sessionId });
				const activeThread = broker.control.listThreads(collabId).find((t) => t.active);
				if (!activeThread) {
					sendNow("[ai-whisper] No active thread to pull context from.\n");
					return null;
				}
				const result = injector.injectContext({ userInput: "", activeThreadId: activeThread.threadId });
				if (result.injected) {
					interactiveSession.writeUserInput(result.payload);
					sendNow(`\u001b[2m↳ relay context attached (${result.summary})\u001b[0m\n`);
				} else {
					sendNow("[ai-whisper] No pending relay context to inject.\n");
				}
				return null;
			}

			const contextInjector = createContextInjector({ broker, collabId, sessionId });

			relayPaneWriter.relayDirective({
				senderAgent: target,
				receiverAgent: directive.target,
				instruction: directive.instruction,
				now: new Date().toISOString(),
			});

			const relay = enqueueRelayWork({
				broker,
				collabId,
				originSessionId: sessionId,
				target: directive.target,
				instruction: directive.instruction,
				artifactPaths: [],
				forceNewThread: directive.forceNewThread,
				now: new Date().toISOString(),
				contextInjector,
			});
			activeRelayWorkItemId = relay.workItem.workItemId;

			try {
				sendNow(
					formatRelayAcknowledgement({
						target: directive.target,
						createdNewThread: relay.createdNewThread,
					}),
				);

				const reply = await waitForReply({
					broker,
					threadId: relay.thread.threadId,
					workItemId: relay.workItem.workItemId,
				});

				relayPaneWriter.relayResponse({
					senderAgent: directive.target,
					receiverAgent: target,
					content: reply.content,
					now: new Date().toISOString(),
				});
			} finally {
				activeRelayWorkItemId = null;
			}

			return null;
		},
	});

	let stopLoop = async () => {};
	let liveSessionStarted = false;
	let stopping = false;
	let requestExit!: () => void;
	const exitRequested = new Promise<void>((resolve) => {
		requestExit = resolve;
	});

	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		requestExit();
	};

	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	try {
		await liveSession.start();
		liveSessionStarted = true;
		stopLoop = await runCompanionAgentLoop({
			broker,
			collabId,
			sessionId,
			provider,
			interactiveSession,
			relayPaneWriter,
		});
		await exitRequested;
	} finally {
		await stopLoop();
		if (liveSessionStarted) {
			await liveSession.stop();
		}
		await broker.stop();
	}
}

await main();
