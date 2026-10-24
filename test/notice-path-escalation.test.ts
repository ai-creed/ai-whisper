import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasInFlightAcceptedHandoffForWorkflow } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";
import {
	type Broker,
	COLLAB,
	IDLE_MS,
	bootBroker,
	isoAgo,
	makeRelay,
	noticeLine,
	rawRow,
	startPendingWorkflow,
	stopBrokers,
} from "./helpers/notice-path-broker.ts";

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await stopBrokers();
});

/** D12: fetched long ago, no turn done; idling past the cap nudges, then escalates. */
async function escalateD12(broker: Broker) {
	const { handoff, workflowId } = await startPendingWorkflow(broker);
	const id = handoff.handoffId;
	broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(40 * 60_000) });
	broker.control.fetchWorkflowHandoff({
		handoffId: id,
		collabId: COLLAB,
		callerAgent: handoff.targetAgent,
		now: isoAgo(30 * 60_000),
	});
	const { relay, submitted } = makeRelay(broker, {
		currentAgent: handoff.targetAgent,
		deliveryMode: "notice",
	});
	await relay.checkIdleActions(16 * 60_000);
	expect(submitted).toEqual([noticeLine(broker, "nudge", id)]);
	await new Promise((r) => setTimeout(r, 5));
	await relay.checkIdleActions(1);
	return {
		handoff,
		workflowId,
		reason: `no reply and no turn done after 15 min idle (handoff ${id})`,
	};
}

/** Strict mode: notice and reminder never fetched; the paste fallback escalates instead. */
async function escalateStrict(broker: Broker) {
	const { handoff, workflowId } = await startPendingWorkflow(broker);
	const id = handoff.handoffId;
	broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(5 * 60_000) });
	broker.control.claimNoticeStep({ handoffId: id, kind: "reminder", now: isoAgo(2 * 60_000) });
	const { relay } = makeRelay(broker, {
		currentAgent: handoff.targetAgent,
		deliveryMode: "notice",
		noticeStrict: true,
	});
	await relay.checkIdleActions(IDLE_MS);
	return {
		handoff,
		workflowId,
		reason: `strict mode: paste fallback suppressed (handoff ${id})`,
	};
}

describe("an escalated notice handoff ends the handoff", () => {
	for (const [name, escalate] of [
		["D12", escalateD12],
		["strict", escalateStrict],
	] as const) {
		it(`${name}: the handoff is terminal and the workflow halts with the exact reason`, async () => {
			const broker = bootBroker();
			const { handoff, workflowId, reason } = await escalate(broker);
			const id = handoff.handoffId;

			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("halted");
			expect(wf?.haltReason).toBe(reason);

			const row = rawRow(broker, id);
			expect(row.status).toBe("failed");
			expect(row.resolved_at).not.toBeNull();
			expect(row.capture_path).toBeNull();
			expect(row.evaluator_verdict).toBe("escalate");

			// (a) no longer in flight
			expect(hasInFlightAcceptedHandoffForWorkflow(broker.db, workflowId)).toBe(false);

			// (c) turn done no longer points at the dead handoff
			const done = broker.control.recordSeatTurnDone({
				collabId: COLLAB,
				agent: handoff.targetAgent,
				now: new Date().toISOString(),
			});
			expect(done.fetchedUnrepliedHandoffId).toBeNull();

			// (b) resume then pause captures the quiesce snapshot
			broker.control.resumeWorkflow({ workflowId, now: new Date().toISOString() });
			await new Promise((r) => setImmediate(r));
			broker.control.pauseWorkflow({ workflowId, now: new Date().toISOString() });
			const context = broker.control.getWorkflow(workflowId)?.workflowContext as {
				pauseSnapshotRef?: unknown;
			};
			expect(context.pauseSnapshotRef).not.toBeUndefined();
		});
	}

	it("escalateNoticeHandoff is a no-op once the handoff left accepted", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(5 * 60_000) });
		broker.control.fetchWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: handoff.targetAgent,
			now: isoAgo(4 * 60_000),
		});
		const replied = broker.control.replyWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: handoff.targetAgent,
			body: "done",
			now: isoAgo(3 * 60_000),
		});
		expect(replied.ok).toBe(true);
		const before = rawRow(broker, id);

		const result = broker.control.escalateNoticeHandoff({
			handoffId: id,
			reason: "late escalation",
			now: new Date().toISOString(),
		});

		expect(result.action).toBe("noop-not-in-flight");
		expect(rawRow(broker, id)).toEqual(before);
		expect(broker.control.getWorkflow(workflowId)?.haltReason ?? null).not.toBe(
			"late escalation",
		);
	});
});
