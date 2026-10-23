import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "../packages/shared/src/index.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import { runWorkflowCancel } from "../packages/cli/src/commands/workflow/cancel.ts";
import { getNoticePathFields } from "../packages/broker/src/storage/repositories/notice-path-repository.ts";

type Broker = ReturnType<typeof createBrokerRuntime>;

const T0 = "2026-04-21T00:00:00Z";

function startCollab(broker: Broker, collabId: string, workspaceRoot = "/tmp") {
	broker.control.startCollab({
		collabId,
		workspaceRoot,
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
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	startCollab(broker, "collab_c1");
	return broker;
}

async function startWorkflow(broker: Broker, opts: { accept?: boolean } = {}) {
	const { workflowId } = await runWorkflowStart({
		broker,
		collabId: "collab_c1",
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		implementer: "claude",
		reviewer: "codex",
		now: T0,
	});
	await new Promise((r) => setImmediate(r));
	const rows = broker.control.listRelayHandoffs("collab_c1");
	const row = rows.find((r) => r.workflowId === workflowId);
	if (!row) throw new Error("driver did not create a workflow handoff");
	if (opts.accept !== false) {
		broker.control.acceptRelayHandoff({
			handoffId: row.handoffId,
			acceptedAt: "2026-04-21T00:00:01Z",
		});
	}
	const handoff = broker.control.getRelayHandoff(row.handoffId);
	if (!handoff) throw new Error("handoff vanished");
	return { workflowId, handoff };
}

function rawRow(broker: Broker, handoffId: string) {
	return broker.db
		.prepare("SELECT * FROM relay_handoff WHERE handoff_id = ?")
		.get(handoffId) as Record<string, unknown>;
}

function otherAgent(agent: AgentType): AgentType {
	return agent === "claude" ? "codex" : "claude";
}

describe("notice-path control methods", () => {
	it("show returns stored request_text verbatim and records the fetch", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const result = broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			now: "2026-04-21T00:00:02Z",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.handoff.requestText).toBe(rawRow(broker, handoff.handoffId).request_text);
		expect(result.handoff.handoffId).toBe(handoff.handoffId);
		expect(result.handoff.targetAgent).toBe(handoff.targetAgent);
		expect(result.handoff.senderAgent).toBe(handoff.senderAgent);
		expect(result.handoff.workflowId).toMatch(/^wf_/);
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.fetchedAt).toBe(
			"2026-04-21T00:00:02Z",
		);
		broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: null,
			now: "2026-04-21T00:00:03Z",
		});
		const fields = getNoticePathFields(broker.db, handoff.handoffId);
		expect(fields?.fetchCount).toBe(2);
		expect(fields?.fetchedAt).toBe("2026-04-21T00:00:02Z");
		await broker.stop();
	});

	it("show with record false returns the handoff without recording the fetch", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const result = broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: null,
			now: "2026-04-21T00:00:02Z",
			record: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.handoff.requestText).toBe(rawRow(broker, handoff.handoffId).request_text);
		const fields = getNoticePathFields(broker.db, handoff.handoffId);
		expect(fields?.fetchedAt).toBeNull();
		expect(fields?.fetchCount).toBe(0);
		await broker.stop();
	});

	it("show refuses unknown, pending and non-workflow handoffs with the right reason", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker, { accept: false });
		expect(
			broker.control.fetchWorkflowHandoff({
				handoffId: "ho_nope",
				collabId: "collab_c1",
				callerAgent: null,
				now: "2026-04-21T00:00:02Z",
			}),
		).toEqual({ ok: false, reason: "unknown" });

		const pending = broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: null,
			now: "2026-04-21T00:00:02Z",
		});
		expect(pending).toMatchObject({ ok: false, reason: "not_accepted", status: "pending" });
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.fetchedAt).toBeNull();

		startCollab(broker, "collab_nw");
		broker.control.createRelayHandoff({
			handoffId: "ho_plain",
			collabId: "collab_nw",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "plain relay",
			now: T0,
		});
		broker.control.acceptRelayHandoff({ handoffId: "ho_plain", acceptedAt: T0 });
		expect(
			broker.control.fetchWorkflowHandoff({
				handoffId: "ho_plain",
				collabId: "collab_nw",
				callerAgent: "codex",
				now: "2026-04-21T00:00:02Z",
			}),
		).toMatchObject({ ok: false, reason: "not_workflow" });
		expect(getNoticePathFields(broker.db, "ho_plain")?.fetchedAt).toBeNull();
		await broker.stop();
	});

	it("show by a non-target agent is refused and not recorded", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const result = broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: otherAgent(handoff.targetAgent),
			now: "2026-04-21T00:00:02Z",
		});
		expect(result).toMatchObject({
			ok: false,
			reason: "wrong_agent",
			targetAgent: handoff.targetAgent,
		});
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.fetchedAt).toBeNull();
		await broker.stop();
	});

	it("reply hands back through the existing path", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const result = broker.control.replyWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			body: "REPLY BODY",
			now: "2026-04-21T00:00:05Z",
		});
		expect(result).toEqual({ ok: true });
		const row = rawRow(broker, handoff.handoffId);
		expect(row.status).toBe("handed_back");
		expect(row.handback_text).toBe("REPLY BODY");
		expect(row.orchestrator_status).toBe("idle");
		const fields = getNoticePathFields(broker.db, handoff.handoffId);
		expect(fields?.capturePath).toBe("reply");
		expect(fields?.repliedAt).toBe("2026-04-21T00:00:05Z");
		await broker.stop();
	});

	it("second reply is refused and first body kept", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const base = {
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
		};
		expect(
			broker.control.replyWorkflowHandoff({ ...base, body: "FIRST", now: "2026-04-21T00:00:05Z" }),
		).toEqual({ ok: true });
		const second = broker.control.replyWorkflowHandoff({
			...base,
			body: "SECOND",
			now: "2026-04-21T00:00:06Z",
		});
		expect(second).toEqual({
			ok: false,
			reason: "not_accepted",
			status: "handed_back",
			capturePath: "reply",
		});
		expect(rawRow(broker, handoff.handoffId).handback_text).toBe("FIRST");
		await broker.stop();
	});

	it("reply refuses a handoff already handed back by the capture path", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		broker.control.handoffBackRelay({
			handoffId: handoff.handoffId,
			senderAgent: handoff.targetAgent,
			targetAgent: handoff.senderAgent,
			requestText: "CAPTURED",
			captureStatus: "ok",
			now: "2026-04-21T00:00:04Z",
		});
		const result = broker.control.replyWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			body: "REPLY",
			now: "2026-04-21T00:00:05Z",
		});
		expect(result).toEqual({
			ok: false,
			reason: "not_accepted",
			status: "handed_back",
			capturePath: null,
		});
		expect(rawRow(broker, handoff.handoffId).handback_text).toBe("CAPTURED");
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.capturePath).toBeNull();
		await broker.stop();
	});

	it("reply by the wrong agent is refused", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const result = broker.control.replyWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: otherAgent(handoff.targetAgent),
			body: "REPLY",
			now: "2026-04-21T00:00:05Z",
		});
		expect(result).toMatchObject({ ok: false, reason: "wrong_agent", targetAgent: handoff.targetAgent });
		const row = rawRow(broker, handoff.handoffId);
		expect(row.status).toBe("accepted");
		expect(row.handback_text).toBeNull();
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.repliedAt).toBeNull();
		await broker.stop();
	});

	it("a capture after a reply does not overwrite it or re-arm orchestration", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		broker.control.replyWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			body: "REPLY BODY",
			now: "2026-04-21T00:00:05Z",
		});
		// The orchestrator claims the replied handoff, as the real one would.
		expect(
			broker.control.claimRelayHandoffForOrchestration({
				handoffId: handoff.handoffId,
				claimedAt: "2026-04-21T00:00:05.500Z",
			}),
		).not.toBeNull();
		const pick = (row: Record<string, unknown>) => ({
			orchestrator_status: row.orchestrator_status,
			status: row.status,
			resolved_at: row.resolved_at,
		});
		const before = pick(rawRow(broker, handoff.handoffId));
		expect(before.orchestrator_status).toBe("pending");
		const countRows = () =>
			(broker.db.prepare("SELECT COUNT(*) AS n FROM relay_handoff").get() as { n: number }).n;
		const rowsBefore = countRows();

		broker.control.handoffBackRelay({
			handoffId: handoff.handoffId,
			nextHandoffId: "handoff_late_capture",
			senderAgent: handoff.targetAgent,
			targetAgent: handoff.senderAgent,
			requestText: "CAPTURED",
			captureStatus: "ok",
			now: "2026-04-21T00:00:06Z",
		});

		const after = rawRow(broker, handoff.handoffId);
		expect(after.handback_text).toBe("REPLY BODY");
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.capturePath).toBe("reply");
		expect(pick(after)).toEqual(before);
		expect(
			broker.control
				.listRelayHandoffsPendingOrchestration("collab_c1")
				.some((h) => h.handoffId === handoff.handoffId),
		).toBe(false);
		expect(countRows()).toBe(rowsBefore);
		await broker.stop();
	});

	it("reply on a paused workflow hands back, captures the quiesce snapshot and defers orchestration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "np-git-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		writeFileSync(join(dir, "a.txt"), "a\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4321 });
		startCollab(broker, "collab_c1", dir);
		try {
			const { workflowId, handoff } = await startWorkflow(broker);
			broker.control.pauseWorkflow({ workflowId, now: "2026-04-21T00:00:02Z" });
			const ctx = () =>
				broker.control.getWorkflow(workflowId)?.workflowContext as { pauseSnapshotRef?: string | null };
			// In-flight accepted handoff: not at the quiesce boundary yet.
			expect(ctx().pauseSnapshotRef).toBeUndefined();

			const result = broker.control.replyWorkflowHandoff({
				handoffId: handoff.handoffId,
				collabId: "collab_c1",
				callerAgent: handoff.targetAgent,
				body: "PAUSED REPLY",
				now: "2026-04-21T00:00:05Z",
			});
			expect(result).toEqual({ ok: true });
			const row = rawRow(broker, handoff.handoffId);
			expect(row.status).toBe("handed_back");
			expect(row.handback_text).toBe("PAUSED REPLY");
			expect(getNoticePathFields(broker.db, handoff.handoffId)?.capturePath).toBe("reply");
			expect(ctx().pauseSnapshotRef).toMatch(/^[0-9a-f]{40}$/);
			expect(
				broker.control
					.listRelayHandoffsPendingOrchestration("collab_c1")
					.some((h) => h.handoffId === handoff.handoffId),
			).toBe(false);
		} finally {
			await broker.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("show and reply refuse a handoff from another collab", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		startCollab(broker, "collab_c2");
		expect(
			broker.control.fetchWorkflowHandoff({
				handoffId: handoff.handoffId,
				collabId: "collab_c2",
				callerAgent: handoff.targetAgent,
				now: "2026-04-21T00:00:02Z",
			}),
		).toMatchObject({ ok: false, reason: "other_collab" });
		expect(
			broker.control.replyWorkflowHandoff({
				handoffId: handoff.handoffId,
				collabId: "collab_c2",
				callerAgent: handoff.targetAgent,
				body: "REPLY",
				now: "2026-04-21T00:00:05Z",
			}),
		).toMatchObject({ ok: false, reason: "other_collab" });
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.fetchedAt).toBeNull();
		expect(rawRow(broker, handoff.handoffId).status).toBe("accepted");
		await broker.stop();
	});

	describe("show and reply refuse a superseded handoff that still says accepted", () => {
		async function expectSuperseded(broker: Broker, handoffId: string, targetAgent: AgentType) {
			expect(rawRow(broker, handoffId).status).toBe("accepted");
			expect(
				broker.control.fetchWorkflowHandoff({
					handoffId,
					collabId: "collab_c1",
					callerAgent: targetAgent,
					now: "2026-04-21T00:00:08Z",
				}),
			).toMatchObject({ ok: false, reason: "superseded" });
			expect(
				broker.control.replyWorkflowHandoff({
					handoffId,
					collabId: "collab_c1",
					callerAgent: targetAgent,
					body: "LATE REPLY",
					now: "2026-04-21T00:00:09Z",
				}),
			).toMatchObject({ ok: false, reason: "superseded" });
			const row = rawRow(broker, handoffId);
			expect(row.status).toBe("accepted");
			expect(row.handback_text).toBeNull();
			const fields = getNoticePathFields(broker.db, handoffId);
			expect(fields?.fetchedAt).toBeNull();
			expect(fields?.repliedAt).toBeNull();
		}

		it("after the workflow is canceled (chain abandoned)", async () => {
			const broker = boot();
			const { workflowId, handoff } = await startWorkflow(broker);
			await runWorkflowCancel({ broker, workflowId, now: "2026-04-21T00:00:07Z" });
			await expectSuperseded(broker, handoff.handoffId, handoff.targetAgent);
			await broker.stop();
		});

		// Clones `handoff` as ho_newer in the same chain and makes it the collab's
		// current handoff, as inserting the next workflow handoff does.
		function insertCurrentChainSibling(broker: Broker, handoffId: string, createdAt: string) {
			const cols = (
				broker.db.prepare("PRAGMA table_info(relay_handoff)").all() as Array<{ name: string }>
			).map((c) => c.name);
			const select = cols
				.map((c) => (c === "handoff_id" ? "'ho_newer'" : c === "created_at" ? "@createdAt" : c))
				.join(", ");
			broker.db
				.prepare(
					`INSERT INTO relay_handoff (${cols.join(", ")}) SELECT ${select} FROM relay_handoff WHERE handoff_id = @id`,
				)
				.run({ id: handoffId, createdAt });
			broker.db
				.prepare("UPDATE relay_turn_state SET unresolved_handoff_id = 'ho_newer' WHERE collab_id = ?")
				.run("collab_c1");
		}

		it("when a newer handoff exists in the same chain", async () => {
			const broker = boot();
			const { handoff } = await startWorkflow(broker);
			// The driver stamps created_at from the wall clock, so derive "newer" from the row.
			const newerCreatedAt = new Date(Date.parse(handoff.createdAt) + 1000).toISOString();
			insertCurrentChainSibling(broker, handoff.handoffId, newerCreatedAt);
			await expectSuperseded(broker, handoff.handoffId, handoff.targetAgent);
			await broker.stop();
		});

		it("when a newer same-chain handoff shares its created_at", async () => {
			const broker = boot();
			const { handoff } = await startWorkflow(broker);
			insertCurrentChainSibling(broker, handoff.handoffId, handoff.createdAt);
			expect(rawRow(broker, "ho_newer").created_at).toBe(rawRow(broker, handoff.handoffId).created_at);
			await expectSuperseded(broker, handoff.handoffId, handoff.targetAgent);
			expect(
				broker.control.fetchWorkflowHandoff({
					handoffId: "ho_newer",
					collabId: "collab_c1",
					callerAgent: handoff.targetAgent,
					now: "2026-04-21T00:00:10Z",
				}),
			).toMatchObject({ ok: true });
			expect(
				broker.control.replyWorkflowHandoff({
					handoffId: "ho_newer",
					collabId: "collab_c1",
					callerAgent: handoff.targetAgent,
					body: "CURRENT REPLY",
					now: "2026-04-21T00:00:11Z",
				}),
			).toEqual({ ok: true });
			await broker.stop();
		});
	});

	it("recordWorkflowReplyRefused is a no-op on a DB without the column", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		broker.db.exec("ALTER TABLE relay_handoff DROP COLUMN reply_refused_at");
		expect(() =>
			broker.control.recordWorkflowReplyRefused({
				handoffId: handoff.handoffId,
				collabId: "collab_c1",
				callerAgent: handoff.targetAgent,
				now: "2026-04-21T00:00:05Z",
			}),
		).not.toThrow();
		await broker.stop();
	});

	it("recordWorkflowReplyRefused sets reply_refused_at only on accepted handoffs", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker, { accept: false });
		const call = (collabId: string, now: string) =>
			broker.control.recordWorkflowReplyRefused({
				handoffId: handoff.handoffId,
				collabId,
				callerAgent: handoff.targetAgent,
				now,
			});

		call("collab_c1", "2026-04-21T00:00:02Z");
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.replyRefusedAt).toBeNull();

		broker.control.acceptRelayHandoff({ handoffId: handoff.handoffId, acceptedAt: "2026-04-21T00:00:03Z" });
		call("collab_other", "2026-04-21T00:00:04Z");
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.replyRefusedAt).toBeNull();

		expect(() =>
			broker.control.recordWorkflowReplyRefused({
				handoffId: "ho_nope",
				collabId: "collab_c1",
				callerAgent: handoff.targetAgent,
				now: "2026-04-21T00:00:04Z",
			}),
		).not.toThrow();

		call("collab_c1", "2026-04-21T00:00:05Z");
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.replyRefusedAt).toBe(
			"2026-04-21T00:00:05Z",
		);
		await broker.stop();
	});

	it("recordWorkflowReplyRefused ignores a caller that is not the target agent", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		broker.control.recordWorkflowReplyRefused({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: otherAgent(handoff.targetAgent),
			now: "2026-04-21T00:00:05Z",
		});
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.replyRefusedAt).toBeNull();
		broker.control.recordWorkflowReplyRefused({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			now: "2026-04-21T00:00:06Z",
		});
		expect(getNoticePathFields(broker.db, handoff.handoffId)?.replyRefusedAt).toBe(
			"2026-04-21T00:00:06Z",
		);
		await broker.stop();
	});

	it("recordSeatTurnDone without a binding row records nothing and reports recorded false", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		broker.db.prepare("DELETE FROM session_binding WHERE collab_id = ?").run("collab_c1");
		broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: handoff.targetAgent,
			now: "2026-04-21T00:00:03Z",
		});
		expect(
			broker.control.recordSeatTurnDone({
				collabId: "collab_c1",
				agent: handoff.targetAgent,
				now: "2026-04-21T00:00:04Z",
			}),
		).toEqual({ recorded: false, fetchedUnrepliedHandoffId: handoff.handoffId });
		const n = (broker.db.prepare("SELECT COUNT(*) AS n FROM session_binding").get() as { n: number }).n;
		expect(n).toBe(0);
		await broker.stop();
	});

	it("recordSeatTurnDone returns the fetched-unreplied handoff, else null", async () => {
		const broker = boot();
		const { handoff } = await startWorkflow(broker);
		const agent = handoff.targetAgent;
		expect(
			broker.control.recordSeatTurnDone({ collabId: "collab_c1", agent, now: "2026-04-21T00:00:02Z" }),
		).toEqual({ recorded: true, fetchedUnrepliedHandoffId: null });

		broker.control.fetchWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: agent,
			now: "2026-04-21T00:00:03Z",
		});
		expect(
			broker.control.recordSeatTurnDone({ collabId: "collab_c1", agent, now: "2026-04-21T00:00:04Z" }),
		).toEqual({ recorded: true, fetchedUnrepliedHandoffId: handoff.handoffId });
		expect(
			broker.db
				.prepare("SELECT turn_done_at FROM session_binding WHERE collab_id = ? AND agent_type = ?")
				.get("collab_c1", agent),
		).toEqual({ turn_done_at: "2026-04-21T00:00:04Z" });

		broker.control.replyWorkflowHandoff({
			handoffId: handoff.handoffId,
			collabId: "collab_c1",
			callerAgent: agent,
			body: "DONE",
			now: "2026-04-21T00:00:05Z",
		});
		expect(
			broker.control.recordSeatTurnDone({ collabId: "collab_c1", agent, now: "2026-04-21T00:00:06Z" }),
		).toEqual({ recorded: true, fetchedUnrepliedHandoffId: null });
		await broker.stop();
	});
});
