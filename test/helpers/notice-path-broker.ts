import { vi } from "vitest";
import type { AgentType } from "@ai-whisper/shared";
import { createBrokerRuntime } from "../../packages/broker/src/index.ts";
import { runWorkflowStart } from "../../packages/cli/src/commands/workflow/start.ts";
import { createMountedTurnOwnedRelay } from "../../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { buildNoticeLine } from "../../packages/cli/src/runtime/notice-text.ts";
import type { CaptureHandbackResult } from "../../packages/cli/src/runtime/capture-handback-text.ts";

export type Broker = ReturnType<typeof createBrokerRuntime>;

export const T0 = "2026-04-21T00:00:00Z";
export const COLLAB = "collab_np";
export const IDLE_MS = 30_000;

const brokers: Broker[] = [];

/** Call from afterEach: stops every broker booted since the last call. */
export async function stopBrokers(): Promise<void> {
	while (brokers.length > 0) await brokers.pop()!.stop();
}

/** A real `:memory:` broker with an orchestrated collab and both seats bound. */
export function bootBroker(): Broker {
	const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
	brokers.push(broker);
	broker.control.startCollab({
		collabId: COLLAB,
		workspaceRoot: "/tmp",
		displayName: COLLAB,
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: T0,
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: COLLAB,
			agentType: agent,
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: T0,
		});
	}
	return broker;
}

export async function startPendingWorkflow(broker: Broker) {
	const { workflowId } = await runWorkflowStart({
		broker,
		collabId: COLLAB,
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		implementer: "claude",
		reviewer: "codex",
		now: T0,
	});
	await new Promise((r) => setImmediate(r));
	const row = broker.control
		.listRelayHandoffs(COLLAB)
		.find((r) => r.workflowId === workflowId && r.status === "pending");
	const handoff = row ? broker.control.getRelayHandoff(row.handoffId) : null;
	if (!handoff) throw new Error("driver did not create a workflow handoff");
	return { workflowId, handoff };
}

export function makeRelay(
	broker: Broker,
	opts: {
		currentAgent: AgentType;
		deliveryMode?: "notice" | "native" | "paste";
		eventPathEnabled?: boolean;
		suppressQuiescenceHandback?: boolean;
		noticeStrict?: boolean;
		autoHandbackRetryMs?: number;
		captureHandbackText?: (
			turnText: string,
			meta?: { expectedPrompt?: string; promptDeliveredAtMs?: number },
		) => Promise<string | CaptureHandbackResult | null>;
		onHandoffAccepted?: () => void;
	},
) {
	const submitted: string[] = [];
	const local: string[] = [];
	const captureHandbackText = vi.fn(
		opts.captureHandbackText ?? (() => Promise.resolve("CAPTURED VIA /copy")),
	);
	const relay = createMountedTurnOwnedRelay({
		broker,
		collabId: COLLAB,
		currentAgent: opts.currentAgent,
		writeLocalMessage: (text) => {
			local.push(text);
		},
		writeUserInput: vi.fn(),
		submitUserInput: (text) => {
			submitted.push(text);
			return Promise.resolve();
		},
		openComposer: vi.fn(() => Promise.resolve(null)),
		captureHandbackText,
		...(opts.eventPathEnabled
			? { suppressQuiescenceHandback: true, eventPathEnabled: true }
			: {}),
		...(opts.suppressQuiescenceHandback ? { suppressQuiescenceHandback: true } : {}),
		...(opts.deliveryMode ? { deliveryMode: opts.deliveryMode } : {}),
		...(opts.noticeStrict ? { noticeStrict: true } : {}),
		...(opts.onHandoffAccepted ? { onHandoffAccepted: opts.onHandoffAccepted } : {}),
		...(opts.autoHandbackRetryMs !== undefined
			? { autoHandbackRetryMs: opts.autoHandbackRetryMs }
			: {}),
	});
	return { relay, submitted, local, captureHandbackText };
}

export function rawRow(broker: Broker, handoffId: string) {
	return broker.db
		.prepare("SELECT * FROM relay_handoff WHERE handoff_id = ?")
		.get(handoffId) as Record<string, unknown>;
}

export function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

export function noticeLine(
	broker: Broker,
	kind: "notice" | "reminder" | "nudge",
	handoffId: string,
): string {
	const meta = broker.control.getHandoffWithWorkflowMeta(handoffId)!;
	return buildNoticeLine({
		kind,
		handoffId,
		workflowId: meta.workflowId!,
		phaseName: meta.phaseName,
		roundNumber: meta.roundNumber,
	});
}
