import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";

type Broker = ReturnType<typeof createBrokerRuntime>;

const T0 = "2026-04-21T00:00:00Z";
const T1 = "2026-04-21T00:00:01Z";
const T2 = "2026-04-21T00:00:02Z";

function startCollab(broker: Broker, collabId: string) {
	broker.control.startCollab({
		collabId,
		workspaceRoot: "/tmp",
		displayName: collabId,
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: T0,
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId,
			agentType: agent,
			sessionId: `session_${collabId}_${agent}`,
			bindingSource: "adopted",
			now: T0,
		});
	}
}

function boot() {
	const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
	startCollab(broker, "collab_c1");
	return broker;
}

async function startPendingWorkflow(broker: Broker, collabId = "collab_c1") {
	const { workflowId } = await runWorkflowStart({
		broker,
		collabId,
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		implementer: "claude",
		reviewer: "codex",
		now: T0,
	});
	await new Promise((r) => setImmediate(r));
	const row = broker.control.listRelayHandoffs(collabId).find((r) => r.workflowId === workflowId);
	if (!row) throw new Error("driver did not create a workflow handoff");
	return { workflowId, handoff: row };
}

function rawRow(broker: Broker, handoffId: string) {
	return broker.db
		.prepare("SELECT * FROM relay_handoff WHERE handoff_id = ?")
		.get(handoffId) as Record<string, unknown>;
}

function turnState(broker: Broker, collabId: string) {
	return broker.db
		.prepare("SELECT * FROM relay_turn_state WHERE collab_id = ?")
		.get(collabId) as Record<string, unknown>;
}

describe("notice claims", () => {
	it("claimWorkflowNotice accepts and records once", async () => {
		const broker = boot();
		const { handoff } = await startPendingWorkflow(broker);
		expect(broker.control.claimWorkflowNotice({ handoffId: handoff.handoffId, now: T1 })).toEqual({
			claimed: true,
		});
		const row = rawRow(broker, handoff.handoffId);
		expect(row.status).toBe("accepted");
		expect(row.accepted_at).toBe(T1);
		expect(row.notice_sent_at).toBe(T1);
		expect(row.delivery_path).toBe("notice");
		expect(turnState(broker, "collab_c1").handoff_state).toBe("accepted");

		expect(broker.control.claimWorkflowNotice({ handoffId: handoff.handoffId, now: T2 })).toEqual({
			claimed: false,
		});
		expect(rawRow(broker, handoff.handoffId)).toEqual(row);
		await broker.stop();
	});

	it("claimWorkflowNotice refuses non-pending, non-workflow and paused handoffs", async () => {
		const broker = boot();
		const { handoff, workflowId } = await startPendingWorkflow(broker);

		// paused
		broker.control.pauseWorkflow({ workflowId, now: T1 });
		const pausedBefore = rawRow(broker, handoff.handoffId);
		expect(broker.control.claimWorkflowNotice({ handoffId: handoff.handoffId, now: T2 })).toEqual({
			claimed: false,
		});
		expect(rawRow(broker, handoff.handoffId)).toEqual(pausedBefore);

		// non-pending (accepted through the legacy path)
		broker.control.resumeWorkflow({ workflowId, now: T1 });
		await new Promise((r) => setImmediate(r)); // let the resume kickoff settle
		broker.control.acceptRelayHandoff({ handoffId: handoff.handoffId, acceptedAt: T1 });
		const acceptedBefore = rawRow(broker, handoff.handoffId);
		expect(broker.control.claimWorkflowNotice({ handoffId: handoff.handoffId, now: T2 })).toEqual({
			claimed: false,
		});
		expect(rawRow(broker, handoff.handoffId)).toEqual(acceptedBefore);

		// non-workflow
		startCollab(broker, "collab_nw");
		broker.control.createRelayHandoff({
			handoffId: "ho_plain",
			collabId: "collab_nw",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "plain relay",
			now: T0,
		});
		const plainBefore = rawRow(broker, "ho_plain");
		expect(broker.control.claimWorkflowNotice({ handoffId: "ho_plain", now: T2 })).toEqual({
			claimed: false,
		});
		expect(rawRow(broker, "ho_plain")).toEqual(plainBefore);
		expect(broker.control.claimWorkflowNotice({ handoffId: "ho_nope", now: T2 })).toEqual({
			claimed: false,
		});
		await broker.stop();
	});

	it("claimNoticeStep is exactly once per kind", async () => {
		const broker = boot();
		const { handoff } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		expect(broker.control.claimNoticeStep({ handoffId: id, kind: "reminder", now: T1 })).toBe(true);
		expect(broker.control.claimNoticeStep({ handoffId: id, kind: "reminder", now: T2 })).toBe(false);
		expect(rawRow(broker, id).reminder_sent_at).toBe(T1);
		expect(rawRow(broker, id).nudge_sent_at).toBeNull();
		expect(broker.control.claimNoticeStep({ handoffId: id, kind: "nudge", now: T2 })).toBe(true);
		expect(broker.control.claimNoticeStep({ handoffId: id, kind: "nudge", now: T2 })).toBe(false);
		await broker.stop();
	});

	it("getNoticePathState returns the target seat turnDoneAt", async () => {
		const broker = boot();
		const { handoff } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		expect(broker.control.getNoticePathState("ho_nope")).toBeNull();
		expect(broker.control.getNoticePathState(id)).toEqual({
			deliveryPath: null,
			noticeSentAt: null,
			reminderSentAt: null,
			nudgeSentAt: null,
			fetchedAt: null,
			capturePath: null,
			repliedAt: null,
			replyRefusedAt: null,
			turnDoneAt: null,
		});
		broker.control.recordSeatTurnDone({
			collabId: "collab_c1",
			agent: otherThan(handoff.senderAgent),
			now: T2,
		});
		// the sender's seat must not leak into the target's state
		broker.control.recordSeatTurnDone({ collabId: "collab_c1", agent: handoff.senderAgent, now: "2026-04-21T00:00:09Z" });
		broker.control.claimWorkflowNotice({ handoffId: id, now: T1 });
		const state = broker.control.getNoticePathState(id);
		expect(state?.turnDoneAt).toBe(T2);
		expect(state?.noticeSentAt).toBe(T1);
		expect(state?.deliveryPath).toBe("notice");
		await broker.stop();
	});

	it("handoffBackRelay writes capture_path when given and not after a reply", async () => {
		const broker = boot();
		const a = await startPendingWorkflow(broker);
		broker.control.acceptRelayHandoff({ handoffId: a.handoff.handoffId, acceptedAt: T1 });
		broker.control.handoffBackRelay({
			handoffId: a.handoff.handoffId,
			senderAgent: a.handoff.targetAgent,
			targetAgent: a.handoff.senderAgent,
			requestText: "CAPTURED",
			captureStatus: "ok",
			capturePath: "copy",
			now: T2,
		});
		expect(rawRow(broker, a.handoff.handoffId).capture_path).toBe("copy");

		startCollab(broker, "collab_c2");
		const b = await startPendingWorkflow(broker, "collab_c2");
		broker.control.acceptRelayHandoff({ handoffId: b.handoff.handoffId, acceptedAt: T1 });
		broker.control.replyWorkflowHandoff({
			handoffId: b.handoff.handoffId,
			collabId: "collab_c2",
			callerAgent: b.handoff.targetAgent,
			body: "REPLY",
			now: T2,
		});
		broker.control.handoffBackRelay({
			handoffId: b.handoff.handoffId,
			senderAgent: b.handoff.targetAgent,
			targetAgent: b.handoff.senderAgent,
			requestText: "LATE CAPTURE",
			captureStatus: "ok",
			capturePath: "copy",
			now: "2026-04-21T00:00:03Z",
		});
		const row = rawRow(broker, b.handoff.handoffId);
		expect(row.capture_path).toBe("reply");
		expect(row.handback_text).toBe("REPLY");
		await broker.stop();
	});

	it("markHandoffDeliveryPath sets once; notice may switch to paste", async () => {
		const broker = boot();
		const { handoff } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		broker.control.markHandoffDeliveryPath({ handoffId: id, path: "native" });
		broker.control.markHandoffDeliveryPath({ handoffId: id, path: "paste" });
		expect(rawRow(broker, id).delivery_path).toBe("native");

		startCollab(broker, "collab_c2");
		const b = await startPendingWorkflow(broker, "collab_c2");
		broker.control.claimWorkflowNotice({ handoffId: b.handoff.handoffId, now: T1 });
		broker.control.markHandoffDeliveryPath({ handoffId: b.handoff.handoffId, path: "paste" });
		expect(rawRow(broker, b.handoff.handoffId).delivery_path).toBe("paste");
		await broker.stop();
	});

	it("countWorkflowFallbacks counts paste and copy rows for the workflow only", async () => {
		const broker = boot();
		const a = await startPendingWorkflow(broker);
		startCollab(broker, "collab_c2");
		const b = await startPendingWorkflow(broker, "collab_c2");
		expect(broker.control.countWorkflowFallbacks(a.workflowId)).toBe(0);
		const set = (id: string, col: string, v: string) =>
			broker.db.prepare(`UPDATE relay_handoff SET ${col} = ? WHERE handoff_id = ?`).run(v, id);
		set(a.handoff.handoffId, "delivery_path", "paste");
		set(b.handoff.handoffId, "delivery_path", "paste");
		expect(broker.control.countWorkflowFallbacks(a.workflowId)).toBe(1);
		set(a.handoff.handoffId, "capture_path", "copy");
		expect(broker.control.countWorkflowFallbacks(a.workflowId)).toBe(1); // same row counted once
		set(a.handoff.handoffId, "capture_path", "reply");
		set(a.handoff.handoffId, "delivery_path", "notice");
		expect(broker.control.countWorkflowFallbacks(a.workflowId)).toBe(0);
		expect(broker.control.countWorkflowFallbacks(b.workflowId)).toBe(1);
		await broker.stop();
	});
});

function otherThan(agent: string): "claude" | "codex" {
	return agent === "claude" ? "codex" : "claude";
}
