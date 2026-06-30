#!/usr/bin/env node
/**
 * Broker daemon process — spawned by `whisper collab start`.
 * Reads config from environment variables, opens the broker,
 * starts the HTTP listener, and stays alive.
 */
import {
	createBrokerRuntime,
	createBrokerEventBus,
	createEventSocketServer,
	createWorkflowEventBridge,
	type EventSocketServer,
	type WorkflowEventBridge,
} from "@ai-whisper/broker";
import { createRelayOrchestrator } from "../runtime/relay-orchestrator.js";
import {
	createRelayOrchestratorEvaluator,
	type EvaluatorProviderConfig,
} from "../runtime/relay-orchestrator-evaluator.js";
import { buildEvaluatorObserverCallback } from "../runtime/evaluator-observer.js";
import { writeOwnPidToBrokerDaemon } from "../runtime/process-start-time.js";
import {
	loadEvaluatorConfig,
	type ResolvedEvaluatorConfig,
} from "../runtime/evaluator-config.js";
import { recordEvaluatorStatus } from "../runtime/record-evaluator-status.js";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { getStateSocketsDir } from "../runtime/state-root.js";
import { resolveCliVersion } from "../runtime/cli-package-info.js";

const sqlitePath = process.env.AI_WHISPER_BROKER_SQLITE!;
const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");
const collabId = process.env.AI_WHISPER_COLLAB_ID!;

const broker = createBrokerRuntime({ sqlitePath, host, port });

if (collabId) {
	writeOwnPidToBrokerDaemon(broker.db, {
		collabId,
		now: new Date().toISOString(),
	});
}

await broker.start();

// Event-socket fanout: serve BrokerEventBus emissions to external supervisors
// as newline-delimited JSON. Best-effort — a socket failure must never take
// down the broker; consumers fall back to DB polling.
//
// The socket fans out TWO buses: the daemon's in-process bus (phase/round/
// halted/done emitted by the driver here) and a dedicated cross-process bus fed
// by the workflow-event bridge. CLI control commands (start/pause/resume/cancel)
// run on a separate transient runtime, so their lifecycle events never reach
// the daemon bus; the bridge polls the DB and re-emits them onto the dedicated
// bus. It is kept OFF broker.events on purpose: the workflow driver consumes
// workflow.created/resumed there, so re-emitting them would trigger driving
// side-effects and race the driver's own sweep.
let eventSocket: EventSocketServer | null = null;
let workflowEventBridge: WorkflowEventBridge | null = null;
if (collabId) {
	try {
		const externalEvents = createBrokerEventBus();
		workflowEventBridge = createWorkflowEventBridge({
			db: broker.db,
			events: externalEvents,
			collabId,
			intervalMs: Number(process.env.AI_WHISPER_WORKFLOW_EVENT_BRIDGE_MS ?? 1000),
		});
		workflowEventBridge.start();
		eventSocket = await createEventSocketServer({
			socketPath: join(getStateSocketsDir(), `events-${collabId}.sock`),
			events: [broker.events, externalEvents],
			engineVersion: resolveCliVersion(),
		});
	} catch (err) {
		workflowEventBridge?.stop();
		workflowEventBridge = null;
		console.error(
			`event-socket fanout unavailable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

let resolved: ResolvedEvaluatorConfig | undefined;
let loaderError: Error | null = null;
try {
	resolved = loadEvaluatorConfig();
} catch (err) {
	loaderError = err instanceof Error ? err : new Error(String(err));
}

if (loaderError) {
	console.error(`evaluator config failed to load: ${loaderError.message}`);
}

// Returns null when the kind can't be safely constructed (anthropic without a
// key) — never passes "" / undefined into new Anthropic(...). Guards BOTH
// primary and fallback, so provider=ollama + fallback=anthropic + no key omits
// the anthropic fallback rather than building one with an empty key.
function providerConfigFrom(kind: "anthropic" | "ollama" | "openai" | "agent-cli"): EvaluatorProviderConfig | null {
	if (kind === "anthropic") {
		if (!resolved || resolved.anthropic.apiKey === null) return null;
		return { provider: "anthropic", apiKey: resolved.anthropic.apiKey };
	}
	if (kind === "openai") {
		if (!resolved || resolved.openai.apiKey === null || resolved.openai.model === null) return null;
		return {
			provider: "openai",
			apiKey: resolved.openai.apiKey,
			model: resolved.openai.model,
			...(resolved.openai.baseURL ? { baseURL: resolved.openai.baseURL } : {}),
		};
	}
	if (kind === "ollama") {
		return {
			provider: "ollama",
			...(resolved?.ollama.host ? { host: resolved.ollama.host } : {}),
			...(resolved?.ollama.model ? { model: resolved.ollama.model } : {}),
		};
	}
	// kind === "agent-cli" — implemented in Task 5
	return null;
}

const collab = broker.control.getCollab(collabId);

const evaluator = (() => {
	if (loaderError || !collab?.orchestratorEnabled || !resolved) return null;
	const primary = providerConfigFrom(resolved.provider);
	if (!primary) return null; // e.g. anthropic primary with no key — not configured
	const fallback = resolved.fallback ? providerConfigFrom(resolved.fallback) : null;
	return createRelayOrchestratorEvaluator({
		primary,
		...(fallback ? { fallback } : {}),
		onCall: buildEvaluatorObserverCallback({ broker }),
	});
})();

async function readWorkspaceHead(cId: string): Promise<string> {
	const workspaceRoot = broker.control.getCollab(cId)?.workspaceRoot;
	if (!workspaceRoot) {
		throw new Error(`readWorkspaceHead: no workspaceRoot for collab ${cId}`);
	}
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", workspaceRoot, "rev-parse", "HEAD"],
			(err, stdout) => {
				if (err) reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
				else resolve(stdout.trim());
			},
		);
	});
}

if (collabId) {
	recordEvaluatorStatus(broker.db, {
		collabId,
		resolved,
		loaderError,
		orchestratorEnabled: Boolean(collab?.orchestratorEnabled),
	});
}

const orchestrator =
	collab?.orchestratorEnabled && evaluator
		? createRelayOrchestrator({ broker, collabId, evaluate: evaluator, readWorkspaceHead })
		: null;

orchestrator?.start();

async function shutdown(): Promise<void> {
	orchestrator?.stop();
	workflowEventBridge?.stop();
	await eventSocket?.close();
	await broker.stop();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
