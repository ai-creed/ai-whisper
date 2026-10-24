import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";
import { buildNoticeLine } from "../packages/cli/src/runtime/notice-text.ts";
import type { AgentType } from "@ai-whisper/shared";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";

type Broker = ReturnType<typeof createBrokerRuntime>;

const T0 = "2026-04-21T00:00:00Z";
const COLLAB = "collab_np";
const IDLE_MS = 30_000;

const brokers: Broker[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (brokers.length > 0) await brokers.pop()!.stop();
});

function bootBroker(): Broker {
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

async function startPendingWorkflow(broker: Broker) {
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

function makeRelay(
	broker: Broker,
	opts: {
		currentAgent: AgentType;
		deliveryMode?: "notice" | "native" | "paste";
		eventPathEnabled?: boolean;
	},
) {
	const submitted: string[] = [];
	const local: string[] = [];
	const captureHandbackText = vi.fn(() => Promise.resolve("CAPTURED VIA /copy"));
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
		...(opts.deliveryMode ? { deliveryMode: opts.deliveryMode } : {}),
	});
	return { relay, submitted, local, captureHandbackText };
}

function rawRow(broker: Broker, handoffId: string) {
	return broker.db
		.prepare("SELECT * FROM relay_handoff WHERE handoff_id = ?")
		.get(handoffId) as Record<string, unknown>;
}

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

function noticeLine(
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

function turnEvent(provider: "claude" | "codex", inputMessages: string[]): TurnEvent {
	return {
		provider,
		workspaceId: "ws",
		cwd: "/tmp",
		sessionOrThreadId: "s1",
		turnId: null,
		message: "Waiting for the background task to finish…",
		inputMessages,
		receivedAt: new Date().toISOString(),
	};
}

describe("notice-path relay", () => {
	it("pending workflow handoff gets a claimed one-line notice, not the request", async () => {
		const broker = bootBroker();
		const { handoff } = await startPendingWorkflow(broker);
		const acceptSpy = vi.spyOn(broker.control, "acceptRelayHandoff");
		const { relay, submitted, local } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
		});

		relay.refreshOwnerView();
		const card = local.join("");
		expect(card).toContain(`[ai-whisper] ${handoff.handoffId} queued · `);
		expect(card).toContain("delivering when idle");
		expect(card).not.toContain(handoff.requestText.slice(0, 40));

		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "notice", handoff.handoffId)]);
		expect(submitted).not.toContain(handoff.requestText);
		expect(acceptSpy).not.toHaveBeenCalled();
		expect(local).toContain(`[ai-whisper] ${handoff.handoffId} notice sent\r\n`);
		const row = rawRow(broker, handoff.handoffId);
		expect(row.status).toBe("accepted");
		expect(row.delivery_path).toBe("notice");
		expect(row.notice_sent_at).not.toBeNull();
	});

	it("turn events on a notice-path handoff never capture or arm /copy", async () => {
		const broker = bootBroker();
		const { handoff } = await startPendingWorkflow(broker);
		const backSpy = vi.spyOn(broker.control, "handoffBackRelay");
		const { relay, submitted, captureHandbackText } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			eventPathEnabled: true,
		});
		await relay.checkIdleActions(IDLE_MS); // claims + types the notice
		const notice = noticeLine(broker, "notice", handoff.handoffId);
		expect(submitted).toEqual([notice]);

		for (const ev of [
			turnEvent("claude", []),
			turnEvent("claude", [notice]),
			turnEvent("codex", []),
			turnEvent("codex", [notice]),
		]) {
			await relay.handleTurnEvent(ev);
		}
		expect(relay.isCopyFallbackArmed()).toBe(false);

		// Past the no-event grace window: the legacy /copy path must stay closed.
		await relay.checkIdleActions(IDLE_MS);
		relay.settleHeldTurnEvent(handoff.handoffId);

		expect(backSpy).not.toHaveBeenCalled();
		expect(captureHandbackText).not.toHaveBeenCalled();
		expect(submitted).toEqual([notice]);
		expect(rawRow(broker, handoff.handoffId).status).toBe("accepted");
		const actions = broker.db
			.prepare("SELECT action FROM relay_turn_event_diagnostics WHERE handoff_id = ?")
			.all(handoff.handoffId) as Array<{ action: string }>;
		expect(actions.map((a) => a.action)).toEqual([
			"notice_path_ignored",
			"notice_path_ignored",
			"notice_path_ignored",
			"notice_path_ignored",
		]);
	});

	it("restart after claim types a reminder, never a second notice", async () => {
		const broker = bootBroker();
		const { handoff } = await startPendingWorkflow(broker);
		// A previous mount claimed the notice and died before Enter landed.
		expect(
			broker.control.claimWorkflowNotice({ handoffId: handoff.handoffId, now: isoAgo(120_000) }),
		).toEqual({ claimed: true });

		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
		});
		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "reminder", handoff.handoffId)]);
		expect(rawRow(broker, handoff.handoffId).reminder_sent_at).not.toBeNull();
	});

	it("paused workflow gets no notice until resume", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await startPendingWorkflow(broker);
		broker.control.pauseWorkflow({ workflowId, now: isoAgo(1_000) });
		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
		});

		await relay.checkIdleActions(IDLE_MS);
		expect(submitted).toEqual([]);
		const paused = rawRow(broker, handoff.handoffId);
		expect(paused.status).toBe("pending");
		expect(paused.notice_sent_at).toBeNull();

		broker.control.resumeWorkflow({ workflowId, now: new Date().toISOString() });
		await new Promise((r) => setImmediate(r));
		await relay.checkIdleActions(IDLE_MS);
		const current = broker.control
			.listRelayHandoffs(COLLAB)
			.find((r) => r.workflowId === workflowId && r.status === "accepted");
		expect(current).toBeDefined();
		expect(submitted).toEqual([noticeLine(broker, "notice", current!.handoffId)]);
	});

	it("reminder and nudge are typed at most once across repeated ticks", async () => {
		const broker = bootBroker();
		const { handoff } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		const target = handoff.targetAgent;
		broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(300_000) });

		const first = makeRelay(broker, { currentAgent: target, deliveryMode: "notice" });
		for (let i = 0; i < 3; i += 1) await first.relay.checkIdleActions(IDLE_MS);
		expect(first.submitted).toEqual([noticeLine(broker, "reminder", id)]);

		// The agent fetches, finishes a turn, but never replies.
		broker.control.fetchWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: target,
			now: isoAgo(200_000),
		});
		broker.control.recordSeatTurnDone({ collabId: COLLAB, agent: target, now: isoAgo(100_000) });
		for (let i = 0; i < 3; i += 1) await first.relay.checkIdleActions(IDLE_MS);
		expect(first.submitted).toEqual([
			noticeLine(broker, "reminder", id),
			noticeLine(broker, "nudge", id),
		]);
		expect(first.local).toContain(`[ai-whisper] ${id} fetched ✓\r\n`);
		expect(first.local.filter((l) => l.includes("fetched ✓"))).toHaveLength(1);

		// A second relay over the same broker never retypes a claimed step.
		const second = makeRelay(broker, { currentAgent: target, deliveryMode: "notice" });
		for (let i = 0; i < 3; i += 1) await second.relay.checkIdleActions(IDLE_MS);
		expect(second.submitted).toEqual([]);
	});

	it("D12: no reply and no turn done past the cap escalates", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		const target = handoff.targetAgent;
		const verdictSpy = vi.spyOn(broker.control, "applyOrchestratorVerdict");
		broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(40 * 60_000) });
		broker.control.fetchWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: target,
			now: isoAgo(30 * 60_000),
		});
		const { relay, submitted, local, captureHandbackText } = makeRelay(broker, {
			currentAgent: target,
			deliveryMode: "notice",
		});

		// Idle past the 15 min cap with no turn done → nudge.
		await relay.checkIdleActions(16 * 60_000);
		expect(submitted).toEqual([noticeLine(broker, "nudge", id)]);

		// Still nothing after the nudge's window → escalate, never /copy.
		await new Promise((r) => setTimeout(r, 5));
		await relay.checkIdleActions(1);
		await relay.checkIdleActions(1);

		const reason = `no reply and no turn done after 15 min idle (handoff ${id})`;
		expect(verdictSpy).toHaveBeenCalledTimes(1);
		expect(verdictSpy).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: id, verdict: "escalate", confidence: 1, reason }),
		);
		expect(local).toContain(
			`[ai-whisper] ⚠ ${id} no reply and no turn done — escalating for operator review\r\n`,
		);
		expect(captureHandbackText).not.toHaveBeenCalled();
		expect(submitted).toEqual([noticeLine(broker, "nudge", id)]);
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
	});

	it("ezio and manual handoffs keep today's path", async () => {
		// native mode (ezio): the workflow request is pasted exactly as today.
		const nativeBroker = bootBroker();
		const { handoff } = await startPendingWorkflow(nativeBroker);
		const native = makeRelay(nativeBroker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "native",
		});
		await native.relay.checkIdleActions(IDLE_MS);
		expect(native.submitted).toEqual([handoff.requestText]);
		const nativeRow = rawRow(nativeBroker, handoff.handoffId);
		expect(nativeRow.status).toBe("accepted");
		expect(nativeRow.notice_sent_at).toBeNull();

		// notice mode, manual (non-workflow) handoff: pasted exactly as today.
		const manualBroker = bootBroker();
		manualBroker.control.createRelayHandoff({
			handoffId: "ho_manual",
			collabId: COLLAB,
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "plain manual relay",
			now: new Date().toISOString(),
		});
		const manual = makeRelay(manualBroker, { currentAgent: "claude", deliveryMode: "notice" });
		await manual.relay.checkIdleActions(IDLE_MS);
		expect(manual.submitted).toEqual(["plain manual relay"]);
		const manualRow = rawRow(manualBroker, "ho_manual");
		expect(manualRow.status).toBe("accepted");
		expect(manualRow.delivery_path).toBeNull();
	});
});
