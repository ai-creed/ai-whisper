import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Broker,
	COLLAB,
	IDLE_MS,
	bootBroker,
	isoAgo,
	makeRelay,
	noticeLine,
	nudgedAfterTurnDone,
	rawRow,
	startPendingWorkflow,
	stopBrokers,
	unfetchedPastReminder,
} from "./helpers/notice-path-broker.ts";

// The /copy ladder traces every capture with console.warn; keep test output clean.
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await stopBrokers();
});

// Long enough (>= 100 chars) for classifyCapture to trust a /copy clip.
const COPIED =
	"Implemented the requested change. All tests pass, typecheck and lint are clean, and the summary of the work follows below.";

/** A notice claimed by an earlier notice-mode mount, not yet fetched. */
async function claimedUnfetched(broker: Broker, claimedAgoMs: number) {
	const started = await startPendingWorkflow(broker);
	broker.control.claimWorkflowNotice({
		handoffId: started.handoff.handoffId,
		now: isoAgo(claimedAgoMs),
	});
	return started;
}

/** Fetched, then a turn done, no nudge yet: the next idle tick nudges. */
async function fetchedTurnDone(broker: Broker) {
	const started = await startPendingWorkflow(broker);
	const id = started.handoff.handoffId;
	const target = started.handoff.targetAgent;
	broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(10 * 60_000) });
	broker.control.fetchWorkflowHandoff({
		handoffId: id,
		collabId: COLLAB,
		callerAgent: target,
		now: isoAgo(8 * 60_000),
	});
	broker.control.recordSeatTurnDone({ collabId: COLLAB, agent: target, now: isoAgo(6 * 60_000) });
	return started;
}

describe("a notice handoff left over when the mount is not in notice mode", () => {
	it("paste mode: an unfetched notice handoff is pasted once, with the ⚠ line", async () => {
		const broker = bootBroker();
		// Claimed seconds ago: no reminder window has passed, the kill switch pastes anyway.
		const { handoff, workflowId } = await claimedUnfetched(broker, 1_000);
		const id = handoff.handoffId;
		const { relay, submitted, local } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "paste",
		});

		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([rawRow(broker, id).request_text]);
		expect(rawRow(broker, id).delivery_path).toBe("paste");
		expect(local).toContain(
			`[ai-whisper] ⚠ ${id} not fetched after 2 notices — falling back to paste (fallback 1 in ${workflowId})\r\n`,
		);
	});

	it("paste mode: a fetched notice handoff with a turn done is nudged", async () => {
		const broker = bootBroker();
		const { handoff } = await fetchedTurnDone(broker);
		const id = handoff.handoffId;
		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "paste",
		});

		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "nudge", id)]);
		expect(rawRow(broker, id).delivery_path).toBe("notice");
	});

	it("paste mode: a fetched notice handoff ignored after the nudge falls back to /copy", async () => {
		const broker = bootBroker();
		const { handoff } = await nudgedAfterTurnDone(broker);
		const id = handoff.handoffId;
		const { relay, submitted, captureHandbackText } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "paste",
			captureHandbackText: () => Promise.resolve(COPIED),
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(captureHandbackText).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual([]);
		const row = rawRow(broker, id);
		expect(row.status).toBe("handed_back");
		expect(row.capture_path).toBe("copy");
	});

	it("paste mode: a fetched notice handoff with no turn done past the cap escalates", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await startPendingWorkflow(broker);
		const id = handoff.handoffId;
		broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(40 * 60_000) });
		broker.control.fetchWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: handoff.targetAgent,
			now: isoAgo(30 * 60_000),
		});
		const { relay, submitted, captureHandbackText } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "paste",
		});

		await relay.checkIdleActions(16 * 60_000);
		expect(submitted).toEqual([noticeLine(broker, "nudge", id)]);
		await new Promise((r) => setTimeout(r, 5));
		await relay.checkIdleActions(1);

		expect(captureHandbackText).not.toHaveBeenCalled();
		const wf = broker.control.getWorkflow(workflowId);
		expect(wf?.status).toBe("halted");
		expect(wf?.haltReason).toBe(`no reply and no turn done after 15 min idle (handoff ${id})`);
		expect(rawRow(broker, id).status).toBe("failed");
	});

	it("native mode: the ladder keeps driving an unfetched notice handoff", async () => {
		const broker = bootBroker();
		const { handoff } = await claimedUnfetched(broker, 2 * 60_000);
		const id = handoff.handoffId;
		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "native",
		});

		await relay.checkIdleActions(IDLE_MS);
		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "reminder", id)]);
		expect(rawRow(broker, id).delivery_path).toBe("notice");
	});
});

describe("ladder steps reset the mount's idle clock", () => {
	it("after a typed reminder", async () => {
		const broker = bootBroker();
		const { handoff } = await claimedUnfetched(broker, 2 * 60_000);
		const onHandoffAccepted = vi.fn();
		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			onHandoffAccepted,
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "reminder", handoff.handoffId)]);
		expect(onHandoffAccepted).toHaveBeenCalledTimes(1);
	});

	it("after a typed nudge", async () => {
		const broker = bootBroker();
		const { handoff } = await fetchedTurnDone(broker);
		const onHandoffAccepted = vi.fn();
		const { relay, submitted } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			onHandoffAccepted,
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(submitted).toEqual([noticeLine(broker, "nudge", handoff.handoffId)]);
		expect(onHandoffAccepted).toHaveBeenCalledTimes(1);
	});

	it("after the typed initial notice, as well as at the claim", async () => {
		const broker = bootBroker();
		const { handoff } = await startPendingWorkflow(broker);
		const order: string[] = [];
		const { relay } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			onHandoffAccepted: () => order.push("reset"),
			onSubmit: () => order.push("typed"),
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(order).toEqual(["reset", "typed", "reset"]);
	});

	it("after the paste fallback", async () => {
		const broker = bootBroker();
		const { handoff } = await unfetchedPastReminder(broker);
		const order: string[] = [];
		const { relay } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			onHandoffAccepted: () => order.push("reset"),
			onSubmit: () => order.push("typed"),
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(order).toEqual(["typed", "reset"]);
	});
});

describe("cursor /copy fallback on the notice path anchors on the last typed line", () => {
	it("the nudge, after a turn done and an ignored nudge", async () => {
		const broker = bootBroker(["cursor", "codex"]);
		const { handoff } = await nudgedAfterTurnDone(broker, {
			implementer: "codex",
			reviewer: "cursor",
		});
		expect(handoff.targetAgent).toBe("cursor");
		const { relay, captureHandbackText } = makeRelay(broker, {
			currentAgent: "cursor",
			deliveryMode: "notice",
			captureHandbackText: () => Promise.resolve(COPIED),
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(captureHandbackText).toHaveBeenCalledTimes(1);
		expect(captureHandbackText.mock.calls[0]?.[1]?.expectedPrompt).toBe(
			noticeLine(broker, "nudge", handoff.handoffId),
		);
	});

	it("the initial notice, after a refused reply with no reminder or nudge", async () => {
		const broker = bootBroker(["cursor", "codex"]);
		const { handoff } = await startPendingWorkflow(broker, {
			implementer: "codex",
			reviewer: "cursor",
		});
		const id = handoff.handoffId;
		broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(10 * 60_000) });
		broker.control.fetchWorkflowHandoff({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: "cursor",
			now: isoAgo(8 * 60_000),
		});
		broker.control.recordWorkflowReplyRefused({
			handoffId: id,
			collabId: COLLAB,
			callerAgent: "cursor",
			now: isoAgo(6 * 60_000),
		});
		const { relay, captureHandbackText } = makeRelay(broker, {
			currentAgent: "cursor",
			deliveryMode: "notice",
			captureHandbackText: () => Promise.resolve(COPIED),
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(captureHandbackText).toHaveBeenCalledTimes(1);
		expect(captureHandbackText.mock.calls[0]?.[1]?.expectedPrompt).toBe(
			noticeLine(broker, "notice", id),
		);
	});
});
