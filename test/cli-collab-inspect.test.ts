import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBrokerRuntime,
	getRecoveryState,
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	upsertWorkspace,
} from "../packages/broker/src/index.ts";
import { runCollabInspect } from "../packages/cli/src/commands/collab/inspect.ts";
import {
	buildInspectSnapshot,
	formatInspectSnapshot,
	truncatePreview,
	type InspectSnapshotState,
} from "../packages/cli/src/runtime/operator-inspect.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

function seedCollab(opts: {
	collabId: string;
	port: number;
	displayName: string;
	now: string;
	pidAlive?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-"));
	process.env.AI_WHISPER_STATE_ROOT = root;
	const ws = join(root, "ws");
	mkdirSync(ws);

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(broker.db, { id: wsId, workspaceRoot: ws, now: opts.now });
	broker.db
		.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 'none', NULL, ?, ?)",
		)
		.run(opts.collabId, ws, opts.displayName, wsId, opts.now, opts.now);
	insertBrokerDaemon(broker.db, {
		collabId: opts.collabId,
		host: "127.0.0.1",
		port: opts.port,
		startedAt: opts.now,
		lastHeartbeatAt: opts.now,
	});
	if (opts.pidAlive !== false) {
		updateBrokerDaemonPid(broker.db, {
			collabId: opts.collabId,
			pid: process.pid,
			pidStartTime: null,
			now: opts.now,
		});
	}

	return { ws, broker };
}

describe("collab inspect snapshot", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("renders the active thread snapshot", async () => {
		const now = "2026-04-06T10:00:00.000Z";
		const { ws, broker } = seedCollab({
			collabId: "collab_inspect",
			port: 4450,
			displayName: "inspect",
			now,
		});

		broker.control.registerSession({
			sessionId: "session_codex",
			collabId: "collab_inspect",
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		broker.control.setSessionBinding({
			collabId: "collab_inspect",
			agentType: "codex",
			sessionId: "session_codex",
			bindingSource: "attached",
			now,
		});
		broker.control.createThread({
			threadId: "thread_active",
			collabId: "collab_inspect",
			title: "Review plan",
			createdBySessionId: "session_codex",
			now,
		});
		await broker.stop();

		const output = await runCollabInspect({
			cwd: ws,
			now,
			watch: false,
			assessBroker: () => Promise.resolve({ ok: true as const }),
		});
		expect(output).toContain("Active Thread: Review plan");
		expect(output).toContain("Roles:");
	});
});

describe("inspect broker data access", () => {
	it("lists work items for the active thread in chronological order", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		const now = "2026-04-06T09:00:00.000Z";

		runtime.control.startCollab({
			collabId: "collab_inspect_data",
			workspaceRoot: "/tmp/workspace",
			displayName: "inspect",
			now,
		});
		runtime.control.registerSession({
			sessionId: "session_codex",
			collabId: "collab_inspect_data",
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		runtime.control.registerSession({
			sessionId: "session_claude",
			collabId: "collab_inspect_data",
			agentType: "claude",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		runtime.control.createThread({
			threadId: "thread_active",
			collabId: "collab_inspect_data",
			title: "Review plan",
			createdBySessionId: "session_codex",
			now,
		});
		runtime.control.enqueueWorkItem({
			workItemId: "work_1",
			threadId: "thread_active",
			collabId: "collab_inspect_data",
			senderSessionId: "session_codex",
			targetSessionId: "session_claude",
			requestedAction: "review_plan",
			instruction: "review docs/plan.md",
			contextPacket: {
				kind: "full",
				goal: "review docs/plan.md",
				currentState: "starting",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			now: "2026-04-06T09:00:10.000Z",
		});

		const workItems = runtime.control.listWorkItems("thread_active");
		expect(workItems.map((item) => item.workItemId)).toEqual(["work_1"]);
	});
});

describe("collab inspect watch mode", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("redraws periodically and stops cleanly on interrupt", async () => {
		const now = "2026-04-06T10:30:00.000Z";
		const { ws, broker } = seedCollab({
			collabId: "collab_inspect_watch",
			port: 4451,
			displayName: "inspect watch",
			now,
		});
		await broker.stop();

		const write = vi.fn();
		const sleep = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockImplementation(() => Promise.reject(new Error("stop-watch")));

		await expect(
			runCollabInspect({
				cwd: ws,
				now,
				watch: true,
				write,
				sleep,
				assessBroker: () => Promise.resolve({ ok: true as const }),
			}),
		).rejects.toThrow("stop-watch");

		expect(write).toHaveBeenCalled();
		expect(write.mock.calls.some(([chunk]) => String(chunk).includes("Live Inspect"))).toBe(true);
	});
});

describe("inspect broker-down recovery latch", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("latches recovery_required and throws when broker is down during normal state", async () => {
		const now = "2026-04-06T10:00:00.000Z";
		const { ws, broker } = seedCollab({
			collabId: "collab_inspect_latch",
			port: 4460,
			displayName: "latch",
			now,
		});
		await broker.stop();

		await expect(
			runCollabInspect({
				cwd: ws,
				now,
				watch: false,
				assessBroker: () => Promise.resolve({ ok: false as const }),
			}),
		).rejects.toThrow("Broker is unavailable");

		const db = createBrokerRuntime({
			sqlitePath: getSharedSqlitePath(),
			runWorkflowDriver: false,
			runDiagnosticsSweep: false,
			runDaemonHeartbeat: false,
			runBrokerDaemonSweep: false,
		});
		try {
			const recovery = getRecoveryState(db.db, "collab_inspect_latch");
			expect(recovery?.state).toBe("recovery_required");
		} finally {
			await db.stop();
		}
	});
});

const minimalState = (collabId: string): InspectSnapshotState => ({
	collabId,
	recovery: { state: "normal" },
});

describe("inspect flagged items outside display window", () => {
	it("includes flagged work items that fall outside the last-5 display window", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4461 });
		const collabId = "collab_flagged_window";
		const now = "2026-04-06T09:00:00.000Z";

		runtime.control.startCollab({ collabId, workspaceRoot: "/tmp", displayName: "flagged", now });
		for (const agentType of ["codex", "claude"] as const) {
			runtime.control.registerSession({
				sessionId: `session_${agentType}`,
				collabId,
				agentType,
				capabilities: {
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: true,
					supportsLocalBuffering: true,
					supportsLaunchHooks: false,
					extensions: {},
				},
				now,
			});
		}
		runtime.control.createThread({
			threadId: "thread_flagged",
			collabId,
			title: "Flag test",
			createdBySessionId: "session_codex",
			now,
		});

		// Enqueue 6 work items; work_1 will be marked failed but falls outside the last-5 display window
		for (let i = 1; i <= 6; i++) {
			runtime.control.enqueueWorkItem({
				workItemId: `work_${i}`,
				threadId: "thread_flagged",
				collabId,
				senderSessionId: "session_codex",
				targetSessionId: "session_claude",
				requestedAction: "review_plan",
				instruction: `instruction ${i}`,
				contextPacket: {
					kind: "full",
					goal: "g",
					currentState: "s",
					decisionsMade: [],
					assumptions: [],
					relevantArtifacts: [],
					openQuestions: [],
					successCriteria: [],
				},
				now: `2026-04-06T09:0${i}:00.000Z`,
			});
		}

		runtime.control.postReply({
			replyId: "reply_fail",
			threadId: "thread_flagged",
			collabId,
			workItemId: "work_1",
			sourceSessionId: "session_claude",
			kind: "failure",
			content: "failed",
			transitionIntent: null,
			artifactManifestIds: [],
			now: "2026-04-06T09:01:30.000Z",
		});

		const snapshot = buildInspectSnapshot({
			broker: runtime,
			state: minimalState(collabId),
			now,
		});

		// Display window (last 5) excludes work_1
		expect(snapshot.workItems.map((w) => w.workItemId)).toEqual([
			"work_6",
			"work_5",
			"work_4",
			"work_3",
			"work_2",
		]);
		// But flaggedItems must still surface work_1
		expect(snapshot.flaggedItems).toHaveLength(1);
		const [flagged] = snapshot.flaggedItems;
		expect(flagged?.workItemId).toBe("work_1");
		expect(flagged?.deliveryState).toBe("failed");
	});
});

describe("adopted operator visibility", () => {
	it("renders adopted binding source and tty path in inspect output", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_adopted",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{
					agentType: "codex",
					bindingState: "bound",
					healthState: "healthy",
					bindingSource: "adopted",
					targetTtyPath: "/dev/ttys012",
				},
				{
					agentType: "claude",
					bindingState: "unbound",
					healthState: null,
					bindingSource: null,
					targetTtyPath: null,
				},
			],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-06T17:00:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
		});

		expect(output).toContain("codex: bound (healthy) [adopted]");
		expect(output).toContain("/dev/ttys012");
	});

	it("surfaces adopted binding source in buildInspectSnapshot", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4470 });
		const now = "2026-04-06T17:00:00.000Z";

		runtime.control.startCollab({ collabId: "collab_adopt_snap", workspaceRoot: "/tmp", displayName: "adopt snap", now });
		runtime.control.registerSession({
			sessionId: "session_codex_adopt",
			collabId: "collab_adopt_snap",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now,
		});
		runtime.control.setSessionBinding({
			collabId: "collab_adopt_snap",
			agentType: "codex",
			sessionId: "session_codex_adopt",
			bindingSource: "adopted",
			targetTtyPath: "/dev/ttys012",
			now,
		});

		const snapshot = buildInspectSnapshot({
			broker: runtime,
			state: minimalState("collab_adopt_snap"),
			now,
		});

		const codexRole = snapshot.roles.find((r) => r.agentType === "codex");
		expect(codexRole?.bindingSource).toBe("adopted");
		expect(codexRole?.targetTtyPath).toBe("/dev/ttys012");
	});
});

describe("operator inspect renderer", () => {
	it("truncates long reply content in compact mode", () => {
		expect(truncatePreview("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcdefghi...");
	});

	it("renders compact snapshot sections in a stable order", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_123",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{ agentType: "codex", bindingState: "bound", healthState: "healthy" },
				{ agentType: "claude", bindingState: "bound", healthState: "degraded" },
			],
			activeThread: {
				threadId: "thread_1",
				title: "Review plan",
				threadState: "in_progress",
				currentTurnIndex: 4,
			},
			workItems: [
				{
					workItemId: "work_4",
					turnIndex: 4,
					senderRole: "codex",
					targetRole: "claude",
					requestedAction: "review_plan",
					deliveryState: "queued",
					instructionPreview: "review docs/plan.md",
				},
			],
			replies: [
				{
					replyId: "reply_4",
					sourceRole: "claude",
					kind: "review",
					transitionIntent: "in_progress",
					contentPreview: "Looks good overall...",
				},
			],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-06T09:30:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
		});

		expect(output).toContain("Collab: collab_123");
		expect(output).toContain("Active Thread: Review plan");
		expect(output).toContain("Recent Work Items");
		expect(output).toContain("Recent Replies");
	});
});

describe("turn-owned relay inspect", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("renders turn owner, waiting agent, and handoff state in inspect output", async () => {
		const now = "2026-04-08T00:00:00.000Z";
		const { ws, broker } = seedCollab({
			collabId: "collab_inspect_turn",
			port: 4324,
			displayName: "inspect turn",
			now,
		});
		await broker.stop();

		const output = await runCollabInspect({
			cwd: ws,
			now,
			watch: false,
			assessBroker: () => Promise.resolve({ ok: true as const }),
		});
		expect(output).toContain("Turn owner:");
		expect(output).toContain("Waiting:");
		expect(output).toContain("Handoff state:");
	});
});

describe("handoff age in inspect output", () => {
	it("renders handoff age in seconds when handoffAgeMs is non-null", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_handoff_age",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{ agentType: "codex", bindingState: "bound", healthState: "healthy" },
				{ agentType: "claude", bindingState: "bound", healthState: "healthy" },
			],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-08T00:00:00.000Z",
			turnOwner: "claude",
			waitingAgent: "codex",
			handoffState: "pending",
			handoffAgeMs: 75_000,
		});

		expect(output).toContain("Handoff age: 75s");
	});

	it("omits handoff age line when handoffAgeMs is null", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_no_age",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-08T00:00:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
			handoffAgeMs: null,
		});

		expect(output).not.toContain("Handoff age:");
	});
});

describe("lastCaptureStatus in inspect snapshot", () => {
	it("shows lastCaptureStatus in formatted output after a handback", () => {
		const snapshot = buildInspectSnapshot({
			broker: {
				control: {
					listThreads: () => [],
					listSessionBindings: () => [],
					listSessions: () => [],
					getRelayTurnState: () => ({
						collabId: "collab_inspect_cs",
						turnOwner: "none" as const,
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle" as const,
						handoffAgeMs: null,
					}),
					getLatestHandedBackHandoff: () => ({
						handoffId: "handoff_cs",
						collabId: "collab_inspect_cs",
						senderAgent: "claude" as const,
						targetAgent: "codex" as const,
						requestText: "here is the result",
						status: "handed_back" as const,
						captureStatus: "ok" as const,
						createdAt: "2026-04-10T00:00:00.000Z",
						acceptedAt: "2026-04-10T00:00:05.000Z",
						deferredAt: null,
						resolvedAt: "2026-04-10T00:01:00.000Z",
						lastActivityAt: "2026-04-10T00:01:00.000Z",
					}),
					listWorkItems: () => [],
					listReplies: () => [],
				},
			} as never,
			state: minimalState("collab_inspect_cs"),
			now: "2026-04-10T00:02:00.000Z",
		});

		expect(snapshot.lastCaptureStatus).toBe("ok");

		const formatted = formatInspectSnapshot({ ...snapshot, watch: false });
		expect(formatted).toContain("Last capture: ok");
	});

	it("omits Last capture line when no handed-back handoff exists", () => {
		const snapshot = buildInspectSnapshot({
			broker: {
				control: {
					listThreads: () => [],
					listSessionBindings: () => [],
					listSessions: () => [],
					getRelayTurnState: () => ({
						collabId: "collab_inspect_no_cs",
						turnOwner: "none" as const,
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle" as const,
						handoffAgeMs: null,
					}),
					getLatestHandedBackHandoff: () => null,
					listWorkItems: () => [],
					listReplies: () => [],
				},
			} as never,
			state: minimalState("collab_inspect_no_cs"),
			now: "2026-04-10T00:02:00.000Z",
		});

		expect(snapshot.lastCaptureStatus).toBeNull();

		const formatted = formatInspectSnapshot({ ...snapshot, watch: false });
		expect(formatted).not.toContain("Last capture:");
	});
});

describe("notice path fallback line in inspect output", () => {
	const control = (workflows: Array<{ workflowId: string; status: string }>, count: number) => ({
		listThreads: () => [],
		listSessionBindings: () => [],
		listSessions: () => [],
		getRelayTurnState: () => ({
			collabId: "collab_np",
			turnOwner: "none" as const,
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle" as const,
			handoffAgeMs: null,
		}),
		getLatestHandedBackHandoff: () => null,
		listWorkItems: () => [],
		listReplies: () => [],
		listWorkflowsForCollab: () => workflows,
		countWorkflowFallbacks: (id: string) => (id === "wf_live" ? count : -1),
	});
	const render = (workflows: Array<{ workflowId: string; status: string }>, count = 0) =>
		formatInspectSnapshot({
			...buildInspectSnapshot({
				broker: { control: control(workflows, count) } as never,
				state: minimalState("collab_np"),
				now: "2026-04-10T00:02:00.000Z",
			}),
			watch: false,
		});

	it("prints the fallback count for the active workflow", () => {
		const out = render(
			[
				{ workflowId: "wf_old", status: "done" },
				{ workflowId: "wf_live", status: "running" },
			],
			2,
		);
		expect(out).toContain("notice path: 2 fallback(s) in wf_live\n");
	});

	it("prints zero fallbacks too", () => {
		expect(render([{ workflowId: "wf_live", status: "paused" }], 0)).toContain(
			"notice path: 0 fallback(s) in wf_live",
		);
	});

	it("omits the line when no workflow is active", () => {
		expect(render([{ workflowId: "wf_old", status: "done" }])).not.toContain("notice path:");
		expect(render([])).not.toContain("notice path:");
	});
});

describe("orchestrator fields in inspect output", () => {
	it("renders orchestrator enabled, chain status, and round in formatted output when orchestratorEnabled is true", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_orch_inspect",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{ agentType: "codex", bindingState: "bound", healthState: "healthy" },
				{ agentType: "claude", bindingState: "bound", healthState: "healthy" },
			],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-11T00:00:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
			orchestratorEnabled: true,
			currentRound: 2,
			maxRounds: 5,
			chainStatus: "active",
		});

		expect(output).toContain("Orchestrator: yes");
		expect(output).toContain("Chain status: active");
		expect(output).toContain("Round: 2/5");
	});

	it("renders orchestrator disabled when orchestratorEnabled is false", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_orch_inspect_off",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-11T00:00:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
			orchestratorEnabled: false,
			currentRound: 0,
			maxRounds: 3,
			chainStatus: "done",
		});

		expect(output).toContain("Orchestrator: no");
		expect(output).not.toContain("Chain status:");
		expect(output).not.toContain("Round:");
	});
});

describe("mounted operator visibility", () => {
	it("renders mounted binding source and tty path in inspect output", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_mount",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{
					agentType: "codex",
					bindingState: "bound",
					healthState: "healthy",
					bindingSource: "mounted",
					targetTtyPath: "/dev/ttys031",
				},
			],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-06T09:00:00.000Z",
			turnOwner: "none",
			waitingAgent: null,
			handoffState: "idle",
		});

		expect(output).toContain("[mounted]");
		expect(output).toContain("tty=/dev/ttys031");
	});
});
