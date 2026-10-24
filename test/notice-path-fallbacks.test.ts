import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "../packages/cli/src/runtime/turn-event.ts";
import {
	type Broker,
	COLLAB,
	IDLE_MS,
	bootBroker,
	isoAgo,
	makeRelay,
	rawRow,
	startPendingWorkflow,
	stopBrokers,
} from "./helpers/notice-path-broker.ts";

// The /copy ladder traces every capture with console.warn; keep test output clean.
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await stopBrokers();
});

// Long enough (>= 100 chars) for classifyCapture to trust a /copy clip without
// high-confidence turn text to validate it against.
const COPIED =
	"Implemented the requested change. All tests pass, typecheck and lint are clean, and the summary of the work follows below.";
const REPLY = "REPLY BODY written with whisper handoff reply";

function turnEvent(message: string, inputMessages: string[]): TurnEvent {
	return {
		provider: "claude",
		workspaceId: "ws",
		cwd: "/tmp",
		sessionOrThreadId: "s1",
		turnId: null,
		message,
		inputMessages,
		receivedAt: new Date().toISOString(),
	};
}

/** Notice claimed and reminded long ago, never fetched: the next idle tick falls back to paste. */
async function unfetchedPastReminder(broker: Broker) {
	const started = await startPendingWorkflow(broker);
	const id = started.handoff.handoffId;
	broker.control.claimWorkflowNotice({ handoffId: id, now: isoAgo(5 * 60_000) });
	broker.control.claimNoticeStep({ handoffId: id, kind: "reminder", now: isoAgo(2 * 60_000) });
	return started;
}

/** Fetched, turn done, nudged long ago, no reply: the next idle tick captures via /copy. */
async function nudgedAfterTurnDone(broker: Broker) {
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
	broker.control.claimNoticeStep({ handoffId: id, kind: "nudge", now: isoAgo(4 * 60_000) });
	return started;
}

function reply(broker: Broker, handoffId: string, callerAgent: Parameters<
	Broker["control"]["replyWorkflowHandoff"]
>[0]["callerAgent"]) {
	const result = broker.control.replyWorkflowHandoff({
		handoffId,
		collabId: COLLAB,
		callerAgent,
		body: REPLY,
		now: new Date().toISOString(),
	});
	if (!result.ok) throw new Error(`reply refused: ${JSON.stringify(result)}`);
}

function replyFields(broker: Broker, handoffId: string) {
	const row = rawRow(broker, handoffId);
	return {
		status: row.status,
		capture_path: row.capture_path,
		capture_status: row.capture_status,
		handback_text: row.handback_text,
		replied_at: row.replied_at,
		resolved_at: row.resolved_at,
	};
}

describe("notice-path fallbacks", () => {
	it("paste fallback injects the stored request once and hands off to today's capture", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await unfetchedPastReminder(broker);
		const id = handoff.handoffId;
		const { relay, submitted, local } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			eventPathEnabled: true,
		});

		await relay.checkIdleActions(IDLE_MS);

		const stored = rawRow(broker, id).request_text as string;
		expect(submitted).toEqual([stored]);
		expect(rawRow(broker, id).delivery_path).toBe("paste");
		expect(local).toContain(
			`[ai-whisper] ⚠ ${id} not fetched after 2 notices — falling back to paste (fallback 1 in ${workflowId})\r\n`,
		);

		// From here today's machinery owns the handoff: a correlated turn event delivers.
		const answer = "Implemented the plan; all tests pass and the summary follows.";
		await relay.handleTurnEvent(turnEvent(answer, [stored]));
		const row = rawRow(broker, id);
		expect(row.status).toBe("handed_back");
		expect(row.capture_path).toBe("turn_event");
		expect(row.handback_text).toBe(answer);
		expect(submitted).toEqual([stored]);
	});

	it("paste fallback never runs after a fetch", async () => {
		const broker = bootBroker();
		const { handoff } = await unfetchedPastReminder(broker);
		const id = handoff.handoffId;
		const target = handoff.targetAgent;
		const markSpy = vi.spyOn(broker.control, "markHandoffDeliveryPath");
		// The agent fetches right after the ladder read its state (so the ladder
		// decides paste) and before the fallback re-reads it.
		const original = broker.control.getNoticePathState.bind(broker.control);
		let reads = 0;
		vi.spyOn(broker.control, "getNoticePathState").mockImplementation((handoffId) => {
			const state = original(handoffId);
			reads += 1;
			if (reads === 2) {
				broker.control.fetchWorkflowHandoff({
					handoffId: id,
					collabId: COLLAB,
					callerAgent: target,
					now: new Date().toISOString(),
				});
			}
			return state;
		});
		const { relay, submitted, local } = makeRelay(broker, {
			currentAgent: target,
			deliveryMode: "notice",
		});
		const before = rawRow(broker, id);

		await relay.checkIdleActions(IDLE_MS);

		expect(reads).toBeGreaterThanOrEqual(3); // the fallback re-read the state
		expect(submitted).toEqual([]);
		expect(markSpy).not.toHaveBeenCalled();
		expect(local.some((l) => l.includes("falling back to paste"))).toBe(false);
		const after = rawRow(broker, id);
		expect(after.delivery_path).toBe("notice");
		expect({ ...after, fetched_at: null, fetch_count: null }).toEqual({
			...before,
			fetched_at: null,
			fetch_count: null,
		});
	});

	it("paste fallback does not switch a handoff fetched just before the switch", async () => {
		const broker = bootBroker();
		const { handoff } = await unfetchedPastReminder(broker);
		const id = handoff.handoffId;
		const target = handoff.targetAgent;
		const markSpy = vi.spyOn(broker.control, "markHandoffDeliveryPath");
		// The fallback's own read (the 3rd) still sees an unfetched state, but the
		// fetch is recorded before the broker switch runs.
		const original = broker.control.getNoticePathState.bind(broker.control);
		let reads = 0;
		vi.spyOn(broker.control, "getNoticePathState").mockImplementation((handoffId) => {
			const state = original(handoffId);
			reads += 1;
			if (reads === 3) {
				broker.control.fetchWorkflowHandoff({
					handoffId: id,
					collabId: COLLAB,
					callerAgent: target,
					now: new Date().toISOString(),
				});
			}
			return state;
		});
		const { relay, submitted, local } = makeRelay(broker, {
			currentAgent: target,
			deliveryMode: "notice",
		});

		await relay.checkIdleActions(IDLE_MS);

		expect(markSpy).toHaveBeenCalledTimes(1);
		expect(markSpy.mock.results[0]?.value).toBe(false);
		expect(rawRow(broker, id).delivery_path).toBe("notice");
		expect(rawRow(broker, id).fetched_at).not.toBeNull();
		expect(submitted).toEqual([]);
		expect(local.some((l) => l.includes("falling back to paste"))).toBe(false);
	});

	it("a /copy capture after the paste fallback measures freshness from the paste", async () => {
		const broker = bootBroker();
		const { handoff } = await unfetchedPastReminder(broker);
		// Without the paste-time seed the floor would derive from the handoff's age
		// (created 2 min ago), well before the paste.
		broker.db
			.prepare("UPDATE relay_handoff SET created_at = ? WHERE handoff_id = ?")
			.run(isoAgo(2 * 60_000), handoff.handoffId);
		const { relay, submitted, captureHandbackText } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			captureHandbackText: () => Promise.resolve(COPIED),
		});
		const beforePaste = Date.now();
		await relay.checkIdleActions(IDLE_MS); // paste fallback
		expect(submitted).toEqual([handoff.requestText]);
		await relay.checkIdleActions(IDLE_MS); // today's /copy ladder

		expect(captureHandbackText).toHaveBeenCalledTimes(1);
		const meta = captureHandbackText.mock.calls[0]?.[1];
		expect(meta?.promptDeliveredAtMs).toBeGreaterThanOrEqual(beforePaste);
		expect(rawRow(broker, handoff.handoffId).capture_path).toBe("copy");
	});

	it("copy fallback captures with capture_path copy and prints the ⚠ line with the fallback count", async () => {
		const broker = bootBroker();
		const { handoff, workflowId } = await nudgedAfterTurnDone(broker);
		const id = handoff.handoffId;
		const clips = ["", COPIED];
		const { relay, submitted, local, captureHandbackText } = makeRelay(broker, {
			currentAgent: handoff.targetAgent,
			deliveryMode: "notice",
			autoHandbackRetryMs: 0,
			captureHandbackText: () => Promise.resolve(clips.shift() ?? null),
		});

		// First capture comes back empty and retries; the second one lands.
		await relay.checkIdleActions(IDLE_MS);
		expect(rawRow(broker, id).status).toBe("accepted");
		await relay.checkIdleActions(IDLE_MS);

		expect(captureHandbackText).toHaveBeenCalledTimes(2);
		const row = rawRow(broker, id);
		expect(row.status).toBe("handed_back");
		expect(row.capture_path).toBe("copy");
		expect(row.handback_text).toBe(COPIED);
		expect(row.delivery_path).toBe("notice");
		const line = `[ai-whisper] ⚠ ${id} no reply after nudge — capturing via /copy (fallback 1 in ${workflowId})\r\n`;
		expect(local.filter((l) => l === line)).toHaveLength(1);
		expect(submitted).toEqual([]);
		expect(broker.control.countWorkflowFallbacks(workflowId)).toBe(1);
	});

	describe("reply racing the copy fallback leaves the reply intact", () => {
		it("reply lands while /copy runs", async () => {
			const broker = bootBroker();
			const { handoff } = await nudgedAfterTurnDone(broker);
			const id = handoff.handoffId;
			let afterReply: ReturnType<typeof replyFields> | null = null;
			const { relay, captureHandbackText } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "notice",
				captureHandbackText: () => {
					reply(broker, id, handoff.targetAgent);
					afterReply = replyFields(broker, id);
					return Promise.resolve(COPIED);
				},
			});

			await relay.checkIdleActions(IDLE_MS);
			await relay.checkIdleActions(IDLE_MS);

			expect(captureHandbackText).toHaveBeenCalledTimes(1);
			expect(afterReply).not.toBeNull();
			expect(replyFields(broker, id)).toEqual(afterReply);
			expect(rawRow(broker, id).capture_path).toBe("reply");
			expect(rawRow(broker, id).handback_text).toBe(REPLY);
		});

		it("reply lands after the race guard, right before handoffBackRelay", async () => {
			const broker = bootBroker();
			const { handoff } = await nudgedAfterTurnDone(broker);
			const id = handoff.handoffId;
			const backSpy = vi.spyOn(broker.control, "handoffBackRelay");
			let afterReply: ReturnType<typeof replyFields> | null = null;
			const originalDiag = broker.control.recordCaptureDiagnostic.bind(broker.control);
			vi.spyOn(broker.control, "recordCaptureDiagnostic").mockImplementation((diag) => {
				const result = originalDiag(diag);
				reply(broker, id, handoff.targetAgent);
				afterReply = replyFields(broker, id);
				return result;
			});
			const { relay, captureHandbackText } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "notice",
				captureHandbackText: () => Promise.resolve(COPIED),
			});

			await relay.checkIdleActions(IDLE_MS);
			await relay.checkIdleActions(IDLE_MS);

			// The /copy capture reached handoffBackRelay, which was a no-op.
			expect(backSpy).toHaveBeenCalledWith(
				expect.objectContaining({ handoffId: id, capturePath: "copy", requestText: COPIED }),
			);
			expect(captureHandbackText).toHaveBeenCalledTimes(1);
			expect(afterReply).not.toBeNull();
			expect(replyFields(broker, id)).toEqual(afterReply);
			expect(rawRow(broker, id).capture_path).toBe("reply");
			expect(rawRow(broker, id).handback_text).toBe(REPLY);
		});
	});

	describe("legacy capture sites record capture_path", () => {
		it("turn_event for a pasted handoff (kill switch)", async () => {
			const broker = bootBroker();
			const { handoff } = await startPendingWorkflow(broker);
			const id = handoff.handoffId;
			const { relay, submitted } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "paste",
				eventPathEnabled: true,
			});
			await relay.checkIdleActions(IDLE_MS);
			expect(submitted).toEqual([handoff.requestText]);
			expect(rawRow(broker, id).delivery_path).toBe("paste");

			const answer = "Implemented the plan; all tests pass and the summary follows.";
			await relay.handleTurnEvent(turnEvent(answer, [handoff.requestText]));
			expect(rawRow(broker, id).capture_path).toBe("turn_event");
			expect(rawRow(broker, id).handback_text).toBe(answer);
		});

		it("copy for a pasted handoff captured by today's /copy ladder", async () => {
			const broker = bootBroker();
			const { handoff, workflowId } = await startPendingWorkflow(broker);
			const id = handoff.handoffId;
			const { relay } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				captureHandbackText: () => Promise.resolve(COPIED),
			});
			await relay.checkIdleActions(IDLE_MS); // accept + paste
			await relay.checkIdleActions(IDLE_MS); // /copy
			const row = rawRow(broker, id);
			expect(row.delivery_path).toBe("paste");
			expect(row.capture_path).toBe("copy");
			expect(broker.control.countWorkflowFallbacks(workflowId)).toBe(1);
		});

		it("native for ezio", async () => {
			const broker = bootBroker();
			const { handoff } = await startPendingWorkflow(broker);
			const id = handoff.handoffId;
			const { relay, submitted } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "native",
				suppressQuiescenceHandback: true,
			});
			await relay.checkIdleActions(IDLE_MS);
			expect(submitted).toEqual([handoff.requestText]);
			expect(rawRow(broker, id).delivery_path).toBe("native");

			await relay.handbackResolvedContent("ezio handback content");
			expect(rawRow(broker, id).capture_path).toBe("native");
			expect(rawRow(broker, id).handback_text).toBe("ezio handback content");
		});

		it("a failing delivery-path record still completes the accept", async () => {
			const broker = bootBroker();
			const { handoff } = await startPendingWorkflow(broker);
			vi.spyOn(broker.control, "markHandoffDeliveryPath").mockImplementation(() => {
				throw new Error("disk I/O error");
			});
			const onHandoffAccepted = vi.fn();
			const { relay, submitted } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				onHandoffAccepted,
			});
			await relay.checkIdleActions(IDLE_MS);
			expect(submitted).toEqual([handoff.requestText]);
			expect(rawRow(broker, handoff.handoffId).status).toBe("accepted");
			expect(onHandoffAccepted).toHaveBeenCalledTimes(1);
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("disk I/O error"));
		});

		it("manual handoffs get no delivery_path", async () => {
			const broker = bootBroker();
			broker.control.createRelayHandoff({
				handoffId: "ho_manual",
				collabId: COLLAB,
				senderAgent: "codex",
				targetAgent: "claude",
				requestText: "plain manual relay",
				now: new Date().toISOString(),
			});
			const { relay, submitted } = makeRelay(broker, { currentAgent: "claude" });
			await relay.checkIdleActions(IDLE_MS);
			expect(submitted).toEqual(["plain manual relay"]);
			expect(rawRow(broker, "ho_manual").delivery_path).toBeNull();
		});
	});

	describe("strict mode escalates instead of pasting or copying", () => {
		it("paste fallback suppressed", async () => {
			const broker = bootBroker();
			const { handoff, workflowId } = await unfetchedPastReminder(broker);
			const id = handoff.handoffId;
			const { relay, submitted, local } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "notice",
				noticeStrict: true,
			});

			await relay.checkIdleActions(IDLE_MS);

			const reason = `strict mode: paste fallback suppressed (handoff ${id})`;
			expect(local).toContain(`[ai-whisper] ⚠ ${id} ${reason}\r\n`);
			expect(submitted).toEqual([]);
			expect(rawRow(broker, id).delivery_path).toBe("notice");
			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("halted");
			expect(wf?.haltReason).toBe(reason);
		});

		it("copy fallback suppressed", async () => {
			const broker = bootBroker();
			const { handoff, workflowId } = await nudgedAfterTurnDone(broker);
			const id = handoff.handoffId;
			const { relay, submitted, local, captureHandbackText } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "notice",
				noticeStrict: true,
			});

			await relay.checkIdleActions(IDLE_MS);

			const reason = `strict mode: copy fallback suppressed (handoff ${id})`;
			expect(local).toContain(`[ai-whisper] ⚠ ${id} ${reason}\r\n`);
			expect(captureHandbackText).not.toHaveBeenCalled();
			expect(submitted).toEqual([]);
			expect(rawRow(broker, id).capture_path).toBeNull();
			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("halted");
			expect(wf?.haltReason).toBe(reason);
		});
	});

	describe("escalation bookkeeping", () => {
		it("a throwing escalation stays retryable, backs off 30 s and warns once per distinct error", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const broker = bootBroker();
				const { handoff, workflowId } = await unfetchedPastReminder(broker);
				const id = handoff.handoffId;
				const warn = vi.mocked(console.warn);
				const escalateSpy = vi.spyOn(broker.control, "escalateNoticeHandoff");
				escalateSpy
					.mockImplementationOnce(() => {
						throw new Error("database is locked");
					})
					.mockImplementationOnce(() => {
						throw new Error("database is locked");
					})
					.mockImplementationOnce(() => {
						throw new Error("disk I/O error");
					});
				const { relay, local } = makeRelay(broker, {
					currentAgent: handoff.targetAgent,
					deliveryMode: "notice",
					noticeStrict: true,
				});
				const line = `[ai-whisper] ⚠ ${id} strict mode: paste fallback suppressed (handoff ${id})\r\n`;
				const escalationWarns = (needle: string) =>
					warn.mock.calls.filter((c) => String(c[0]).includes(needle)).length;

				await relay.checkIdleActions(IDLE_MS); // throws "locked"
				expect(local).not.toContain(line);
				expect(escalationWarns("database is locked")).toBe(1);

				vi.setSystemTime(Date.now() + 1_000);
				await relay.checkIdleActions(IDLE_MS); // inside the back-off: not retried
				expect(escalateSpy).toHaveBeenCalledTimes(1);

				vi.setSystemTime(Date.now() + 30_000);
				await relay.checkIdleActions(IDLE_MS); // throws "locked" again: no new warn
				expect(escalateSpy).toHaveBeenCalledTimes(2);
				expect(escalationWarns("database is locked")).toBe(1);

				vi.setSystemTime(Date.now() + 30_000);
				await relay.checkIdleActions(IDLE_MS); // a different error warns once
				expect(escalateSpy).toHaveBeenCalledTimes(3);
				expect(escalationWarns("disk I/O error")).toBe(1);

				vi.setSystemTime(Date.now() + 30_000);
				await relay.checkIdleActions(IDLE_MS); // succeeds
				await relay.checkIdleActions(IDLE_MS);
				expect(escalateSpy).toHaveBeenCalledTimes(4);
				expect(local.filter((l) => l === line)).toHaveLength(1);
				expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
			} finally {
				vi.useRealTimers();
			}
		});

		it("noop-already-applied prints no escalating line and is not retried", async () => {
			const broker = bootBroker();
			const { handoff } = await unfetchedPastReminder(broker);
			const id = handoff.handoffId;
			const verdictSpy = vi
				.spyOn(broker.control, "escalateNoticeHandoff")
				.mockReturnValue({ action: "noop-already-applied", chainId: "" });
			const { relay, local, submitted } = makeRelay(broker, {
				currentAgent: handoff.targetAgent,
				deliveryMode: "notice",
				noticeStrict: true,
			});

			await relay.checkIdleActions(IDLE_MS);
			await relay.checkIdleActions(IDLE_MS);

			expect(verdictSpy).toHaveBeenCalledTimes(1);
			expect(local.some((l) => l.includes("⚠"))).toBe(false);
			expect(submitted).toEqual([]);
			expect(rawRow(broker, id).delivery_path).toBe("notice");
		});
	});
});
